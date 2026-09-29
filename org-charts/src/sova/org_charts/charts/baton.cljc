(ns sova.org-charts.charts.baton
  "The baton chart (portable, `baton/<org>/<sid>`): one gathering (hand-off) session
   (§app.baton/hand-off, /offers-and-leases, /goal-and-loadout, /needs-you; §app.organizations/wrap-up).

   ```
   baton ‹compound› → regions ‹parallel›
   ├─ course  open{with-person · with-operator · offered{pool · leased}} · done · closed
   ├─ reply   reply-idle · reply-starting · reply-writing · reply-stopping
   ├─ budget  under · at-limit
   └─ wrapup  wrapup-none · wrapup-due · wrapup-running · wrapup-done · wrapup-failed · wrapup-skipped
   ```

   Moves (the model's hand_to and goal_done; the operator's take back, hand-off, offer, withdraw;
   the person-left cascade) are course transitions. An operator or cascade move checks everything
   first; while a reply runs (or is starting) it then stops the reply (`stop-reply` effect) and is
   held as `pending-move`, applied when the reply ends — checked again, and dropped with its
   sentence if it now fails. The budget stop waits for the reply (eventless on reply-idle). The
   lease lapses on a durable timer, never while a reply runs (the reply's end re-arms it).
   A session done then closed runs its wrap-up once (the region leaves `wrapup-none` once).

   The baton watches its participants and invitees (`person` sessions): their names, and the
   person-left cascade (`link/moved` showing `:left`).

   Start data (from the spawner): BatonSession's fields — `:org-id :project-id :session-id :owner
   :goal :public-title :question :briefing :to (a person id or \"operator\") | :targets [ids ≥ 2]
   :model :thinking :messages-max :abilities :parent :conflict :started-via :mint-link :op-item
   :names {pid name} :operator-name :lease-ms` (+ `:sova/links {:item …}` when a gap's)."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel raise invoke]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.baton :as rb]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.person :as rp]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)
(def default-lease-ms (* 15 60 1000))
(def wrapup-overdue-ms (* 11 60 1000))
(def default-messages-max 60)

(def operator rb/operator)
(def pool rb/pool)

(defn lease-ms [data] (or (:lease-ms data) default-lease-ms))
(defn e [data] (b/evt data))
(defn reply-idle? [data] (= "idle" (:reply data)))

;; ---- moves --------------------------------------------------------------------------------------

(defn- withdraw-ops
  "Withdraw the current offer (in place): `[ops withdrawn-offer]`."
  [data]
  (if-let [o (rb/current-offer data)]
    [[(ops/assign :offers (mapv #(if (= (:id %) (:id o)) (-> % (assoc :state "withdrawn") (dissoc :lease-until)) %) (:offers data)))
      (ops/assign :offer-id nil)]
     o]
    [[(ops/assign :offer-id nil)] nil]))

(defn from-of [data] (or (:holder data) (if (:offer-id data) pool operator)))

(defn move-ops
  "handTo(to, question, briefing): the offer withdrawn, a new numbered hand-off, the holder."
  [data to question briefing]
  (let [[wops _] (withdraw-ops data)
        n        (inc (count (:handoffs data)))]
    (into wops
      [(ops/assign :handoffs (conj (vec (:handoffs data)) {:n n :from (from-of data) :to to :question question :briefing (or briefing "") :at (b/now-ms data)}))
       (ops/assign :holder to)
       (ops/assign :needs-you (= to operator))
       (ops/assign :participants (vec (distinct (conj (vec (:participants data)) to))))])))

(defn offer-ops
  "startOffer: withdraw the current one, a new hand-off to the pool with a new offer."
  [data targets question briefing]
  (let [[wops _] (withdraw-ops data)
        n        (inc (count (:handoffs data)))
        id       (or (:offer-id (e data)) (str "off_" (:session-id data) "_" n))
        q        (if (rb/blank? question) (:public-title data) question)
        offer    {:id id :to (vec targets) :question q :briefing (or briefing "") :state "open" :created-at (b/now-ms data) :n n}]
    (into wops
      [(ops/assign :handoffs (conj (vec (:handoffs data)) {:n n :from (from-of data) :to pool :question q :briefing (or briefing "") :at (b/now-ms data) :offer-id id}))
       (ops/assign :offers (conj (vec (map #(if (= "withdrawn" (:state %)) % %) (:offers data))) offer))
       (ops/assign :offer-id id)
       (ops/assign :holder nil)
       (ops/assign :needs-you false)])))

(defn- entry-effect
  "A transcript entry the host writes through the session's runtime (after a running reply, as today)."
  [type f]
  (dsl/effect :baton-entry (fn [d] (assoc (f d) :type type))))

(defn- handoff-entry []
  (entry-effect "handoff" (fn [d] (let [h (last (:handoffs d))] (select-keys h [:n :from :to :question :briefing])))))

(defn- offer-entry []
  (entry-effect "offer" (fn [d] (let [h (last (:handoffs d)) o (rb/current-offer d)]
                                  {:n (:n h) :offer-id (:id o) :from (:from h) :to (:to o) :question (:question o) :briefing (:briefing o)}))))

(defn- revoke-withdrawn
  "A withdrawn offer's links stop (410 withdrawn) for invitees who never held it."
  []
  (script {:expr (fn [_ d] (when-let [o (rb/current-offer d)]
                             (dsl/effect-ops d (dsl/effect-map :revoke-links (fn [_] {:offer-id (:id o) :why "withdrawn" :never-held true}) d))))}))

(defn- watch-person [pid-fn]
  (script {:expr (fn [_ d] (let [pid (pid-fn d)]
                             (when (and pid (not= pid operator) (not= pid pool) (not (contains? (set (:watching d)) pid)))
                               [(ops/assign :watching (conj (vec (:watching d)) pid))
                                (ops/assign :sova/directives (conj (vec (:sova/directives d)) {:op :watch :target (b/person-sid (:org-id d) pid)}))])))}))

(defn- watch-all [pids-fn]
  (script {:expr (fn [_ d] (let [new (remove (set (:watching d)) (remove #{operator pool} (pids-fn d)))]
                             (when (seq new)
                               [(ops/assign :watching (into (vec (:watching d)) new))
                                (ops/assign :sova/directives (into (vec (:sova/directives d)) (for [p new] {:op :watch :target (b/person-sid (:org-id d) p)})))])))}))

(defn- reason [kind params-fn & {:keys [soon-only-own]}]
  (b/tell-watch (fn [d] (let [params (params-fn d)]
                          (when params
                            {:kind kind :params (assoc params :title (:public-title d) :session-id (:session-id d))
                             :key (str kind ":" (:session-id d) (when-let [k (:key params)] (str ":" k)))})))))

(defn owned-by-overseer? [d] (map? (:owner d)))

;; ---- moves that may interrupt a reply --------------------------------------------------------------

(def interrupting
  "The operator's and the cascade's moves: they stop a reply in flight (after their checks pass)."
  #{:baton/take-back :baton/handoff :baton/offer :baton/withdraw :person/left})

(defn busy? [_ d] (not (reply-idle? d)))
(defn idle? [_ d] (reply-idle? d))

(defn- hold-move
  "The move passed its checks while a reply runs: stop the reply, keep the move for its end."
  [event checks]
  (dsl/act {:event event :checks checks :cond busy?}
    (script {:expr (fn [_ d] [(ops/assign :pending-move {:event event :data (dissoc (e d) :at)})])})
    (dsl/effect :stop-reply (fn [_] {}))
    (raise {:event :reply/stop})))

(defn move-refusal-of
  "The refusal a move gets now (for a pending move re-checked at the reply's end)."
  [event data ev]
  (case event
    :baton/take-back (rb/take-back-refusal data)
    :baton/handoff (rb/handoff-refusal data ev)
    :baton/offer (rb/offer-refusal data ev)
    :baton/withdraw (rb/withdraw-refusal data)
    :person/left nil
    nil))

(defn- mk [f] (fn [d] (f d (e d))))

(def take-back-checks [(fn [d] (rb/take-back-refusal d))])
(def handoff-checks [(mk rb/handoff-refusal)])
(def offer-checks [(mk rb/offer-refusal)])
(def withdraw-checks [(fn [d] (rb/withdraw-refusal d))])

(defn- to-operator-move [event checks question-fn]
  [(hold-move event checks)
   (dsl/act {:event event :target :with-operator :checks checks :cond idle?}
     (revoke-withdrawn)
     (script {:expr (fn [_ d] (move-ops d operator (question-fn d) ""))})
     (handoff-entry))])

(defn- move-transitions
  "The operator's moves, in every open state."
  []
  (concat
    (to-operator-move :baton/take-back take-back-checks (constantly "(taken back)"))
    (to-operator-move :baton/withdraw withdraw-checks (constantly "(offer withdrawn)"))
    [(hold-move :baton/handoff handoff-checks)
     (dsl/act {:event :baton/handoff :target :with-person :checks handoff-checks :cond idle?}
       (revoke-withdrawn)
       (script {:expr (fn [_ d] (let [ev (e d)] (move-ops d (get-in ev [:target :id]) (str/trim (:question ev)) (:briefing ev))))})
       (watch-person #(get-in (e %) [:target :id]))
       (handoff-entry)
       ;; the operator's hand-off returns a link (the route shows it once)
       (dsl/effect :mint-link (fn [d] {:n (count (:handoffs d)) :person-id (get-in (e d) [:target :id])})))
     (hold-move :baton/offer offer-checks)
     (dsl/act {:event :baton/offer :target :pool :checks offer-checks :cond idle?}
       (revoke-withdrawn)
       (script {:expr (fn [_ d] (let [ev (e d)] (offer-ops d (map :id (:targets ev)) (:question ev) (:briefing ev))))})
       (watch-all #(map :id (:targets (e %))))
       (offer-entry)
       (script {:expr (fn [_ d] (when-not (false? (:mint-link (e d)))
                                  (dsl/effect-ops d (dsl/effect-map :mint-links (fn [_] {:n (count (:handoffs d)) :offer-id (:offer-id d)}) d))))}))]))

;; ---- the person-left cascade -------------------------------------------------------------------

(defn left-pid [d]
  (let [m (b/moved d)]
    (when (and (= "person" (:chart m)) (b/moved-in? d :left)) (b/last-part (:from m)))))

(defn left-effect
  "What a person leaving does to this session: `:holder` (they hold it), `:invitee` (an open offer's
   pool includes them), or nil (an offer someone else holds carries on)."
  [d pid]
  (when (and pid (not (rb/ended? d)))
    (let [o (rb/current-offer d)]
      (cond
        (= (:holder d) pid) :holder
        (and o (= "open" (:state o)) (some #{pid} (:to o))) :invitee))))

(defn- left-question [d pid]
  (if (= :holder (left-effect d pid))
    "(left the organization)"
    (str "(" (rb/name-of d pid) " left the organization; offer withdrawn)")))

(defn- person-left-transitions []
  [(transition {:event :link/moved :cond (fn [_ d] (and (left-pid d) (left-effect d (left-pid d))))}
     (raise {:event :person/left :data (fn [_ d] {:person-id (left-pid d)})}))
   (transition {:event :link/moved :cond (fn [_ d] (= "person" (:chart (b/moved d))))}
     (script {:expr (fn [_ d] (when-let [n (get-in (b/moved d) [:exported :name])]
                                [(ops/assign [:names (b/last-part (:from (b/moved d)))] n)]))}))])

(defn- cascade-move []
  [(dsl/act {:event :person/left :cond (fn [env d] (and (busy? env d) (left-effect d (:person-id (e d)))))}
     (script {:expr (fn [_ d] [(ops/assign :pending-move {:event :person/left :data (dissoc (e d) :at)})])})
     (dsl/effect :stop-reply (fn [_] {}))
     (raise {:event :reply/stop}))
   (dsl/act {:event :person/left :target :with-operator :cond (fn [env d] (and (idle? env d) (left-effect d (:person-id (e d)))))}
     (revoke-withdrawn)
     (script {:expr (fn [_ d] (move-ops d operator (left-question d (:person-id (e d))) ""))})
     (handoff-entry))])

;; ---- messages and leases ---------------------------------------------------------------------------

(defn msg-check [d] (let [v (rb/message-verdict d (e d))] (when (r/refusal? v) v)))
(defn claim? [d] (:claim? (rb/message-verdict d (e d))))

(defn note-ops
  "An accepted message: counted, the first one of someone it was sent to recorded (`wrote-at`), the
   operator's answer clears Needs you, the holder's renews the lease. `last-note` lets the host undo
   it when the runtime refuses the message after all (503 busy counts and claims nothing)."
  [d]
  (let [{:keys [from]} (e d)
        before (select-keys d [:budget :wrote-at :needs-you :offers :holder :participants])
        cl?    (claim? d)
        o      (rb/current-offer d)
        offers (if cl?
                 (mapv #(if (= (:id %) (:id o)) (-> % (assoc :state "held" :holder from) (update :held-by (fn [h] (vec (distinct (conj (vec h) from)))))) %) (:offers d))
                 (:offers d))
        offers (if (and o (or cl? (= (:holder o) from)))
                 (mapv #(if (= (:id %) (:id o)) (assoc % :last-activity-at (b/now-ms d) :lease-until (+ (b/now-ms d) (lease-ms d))) %) offers)
                 offers)]
    (cond-> [(ops/assign :last-note {:before before :claimed cl?})
             (ops/assign [:budget :messages-used] (inc (get-in d [:budget :messages-used] 0)))
             (ops/assign :offers offers)]
      (and (nil? (:wrote-at d)) (rb/wrote-for-it? d from)) (conj (ops/assign :wrote-at (b/now-ms d)))
      (= from operator) (conj (ops/assign :needs-you false))
      (and (not= from operator) (nil? (:person-wrote-at d))) (conj (ops/assign :person-wrote-at (b/now-ms d)))
      cl? (conj (ops/assign :holder from) (ops/assign :participants (vec (distinct (conj (vec (:participants d)) from))))))))

(defn undo-ops [d]
  (when-let [{:keys [before]} (:last-note d)]
    (into [(ops/assign :last-note nil)] (for [[k v] before] (ops/assign k v)))))

(defn- lease-entry [event]
  (entry-effect "lease" (fn [d] (let [o (or (rb/current-offer d) (last (:offers d)))]
                                  {:n (:n o) :offer-id (:id o) :event event :by (or (:lapsed-holder d) (:holder d))}))))

(defn lapse-ops [d]
  (let [o (rb/current-offer d)]
    [(ops/assign :lapsed-holder (:holder o))
     (ops/assign :offers (mapv #(if (= (:id %) (:id o)) (-> % (assoc :state "open") (dissoc :holder :lease-until)) %) (:offers d)))
     (ops/assign :holder nil)]))

;; ---- wrap-up ---------------------------------------------------------------------------------------------

(defn wants-wrapup?
  "A roster person was in it (wantsWrapup), and one of them wrote (else skipped, never retried)."
  [d]
  (boolean (some #(not= operator %) (:participants d))))

(defn person-wrote? [d] (some? (:person-wrote-at d)))

(defn- reconcile-when-ended
  "r3 (F8a): a project gathering that ends with decisions recorded asks the reconciler to run, as
   the chart's own act at L1 (a settle session already asks, after 2 s). Once per session."
  []
  (on-entry {}
    (script {:expr (fn [_ d] (when (and (seq (:decisions d)) (nil? (:conflict d)) (not (:reconcile-asked d)))
                               (into [(ops/assign :reconcile-asked true)]
                                 (dsl/directive-ops d {:op :drive :event :reconcile/request
                                                       :target (b/reconciler-sid (:org-id d) (:project-id d))
                                                       :ctx {:project-id (:project-id d)}
                                                       :data {:delay-ms 0 :session (:session-id d)}}))))})))

(defn- set-course [c] (on-entry {} (script {:expr (fn [_ _] [(ops/assign :course c)])})))
(defn- set-reply [c] (script {:expr (fn [_ _] [(ops/assign :reply c)])}))

(defn- ended-ops [d]
  (let [[wops _] (withdraw-ops d)]
    (into wops [(ops/assign :holder nil) (ops/assign :needs-you false) (ops/assign :closed-at (or (:closed-at d) (b/now-ms d)))])))

(def record-checks [(fn [d] (rb/record-decision-refusal (e d)))])

(defn- record-content []
  [(script {:expr (fn [_ d] [(ops/assign :decisions (conj (vec (:decisions d)) (:decision-id (e d))))])})
   (dsl/spawn {:chart "decision" :link :baton
               :id (fn [d] (b/decision-sid (:org-id d) (:project-id d) (:decision-id (e d))))
               :data (fn [d] (let [ev (e d)]
                               (merge (select-keys ev [:area :statement :quote :entry-id :marker-id :area-key])
                                 {:org-id (:org-id d) :project-id (:project-id d) :id (:decision-id ev)
                                  :owner-area (rb/spelled-owner-area ev) :by (or (:holder d) operator)
                                  :name (rb/name-of d (or (:holder d) operator)) :session-id (:session-id d)
                                  :item (get-in d [:sova/links :item]) :resolves (get-in d [:conflict :id])
                                  :shown (not (:hidden-from-owner d))
                                  :recorded-at (b/now-ms d)})))})])

;; ---- the chart ------------------------------------------------------------------------------------------

(defn start-ops
  "The first hand-off (or offer), as createBaton writes it."
  [d]
  (let [targets (:targets d)
        q       (if (rb/blank? (:question d)) (:public-title d) (:question d))
        br      (or (:briefing d) "")
        now     (b/now-ms d)
        base    [(ops/assign :budget {:messages-max (or (:messages-max d) default-messages-max) :messages-used 0})
                 (ops/assign :created-at (or (:created-at d) now))
                 (ops/assign :handoffs [])
                 (ops/assign :offers [])
                 (ops/assign :decisions [])
                 (ops/assign :watching [])
                 (ops/assign :reply "idle")]]
    (if (>= (count targets) 2)
      (let [id (or (:offer-id d) (str "off_" (:session-id d) "_1"))]
        (into base [(ops/assign :handoffs [{:n 1 :from operator :to pool :question q :briefing br :at now :offer-id id}])
                    (ops/assign :offers [{:id id :to (vec targets) :question q :briefing br :state "open" :created-at now :n 1}])
                    (ops/assign :offer-id id)
                    (ops/assign :holder nil)
                    (ops/assign :participants [operator])]))
      (let [to (or (:to d) operator)]
        (into base [(ops/assign :handoffs [{:n 1 :from operator :to to :question q :briefing br :at now}])
                    (ops/assign :holder to)
                    (ops/assign :needs-you (= to operator))
                    (ops/assign :participants (vec (distinct [operator to])))])))))

(def chart
  (statechart {:initial :baton}
    (state {:id :baton :initial :regions}
      (on-entry {}
        (script {:expr (fn [_ d] (start-ops d))})
        (watch-all (fn [d] (concat (when (:to d) [(:to d)]) (:targets d))))
        ;; the session file (the host creates it; the start's link, unless the caller can't show one)
        (dsl/effect :create-session (fn [d] (select-keys d [:session-id :org-id :project-id :public-title :model :thinking])))
        (script {:expr (fn [_ d] (when (and (not (false? (:mint-link d))) (not= operator (:holder d)))
                                   (dsl/effect-ops d (dsl/effect-map :mint-links (fn [_] {:n 1 :offer-id (:offer-id d)}) d))))}))
      (dsl/hold-cancel-correction)

      ;; ── acts that don't move the course ──────────────────────────────────────────────────
      ;; record_decision: the transcript entry is written first (its id is the decision's); a
      ;; settle session's decision is reconciled on its own after 2 s (durable, C4).
      (apply dsl/act {:event :baton/record-decision :checks record-checks :cond (fn [_ d] (some? (:conflict d)))}
        (conj (record-content)
          (Send {:event :reconcile/request :targetexpr (fn [_ d] (b/reconciler-sid (:org-id d) (:project-id d)))
                 :content (fn [_ d] {:delay-ms 2000 :by "sova" :owner (:owner d) :settle (:session-id d)})})))
      (apply dsl/act {:event :baton/record-decision :checks record-checks} (record-content))

      (dsl/act {:event :baton/propose :checks [(fn [d] (when (rb/ended? d) (r/refuse 409 (str "This conversation is " (:course d) "."))))
                                              (fn [d] (rp/referral-refusal (e d) (:same (e d)) (rb/name-of d (or (:holder d) operator))))
                                              (fn [d] (let [c (rp/apply-change nil (merge (select-keys (e d) [:name :role :contact :decides])
                                                                                         {:status "proposed" :referral {:why (:why (e d)) :referred-by (or (:holder d) operator)
                                                                                                                        :session-id (:session-id d) :quote (:quote (e d))}})
                                                                               "referral" (:names-taken (e d)))]
                                                        (when (r/refusal? c) (update c :sentence #(str "Not recorded: " % " Ask " (rb/name-of d (or (:holder d) operator)) " and try again.")))))]}
        (dsl/spawn {:chart "person" :link :referral :watch? false
                    :id (fn [d] (b/person-sid (:org-id d) (:person-id (e d))))
                    :data (fn [d] (let [ev (e d)
                                        {:keys [person changed]} (rp/apply-change nil (merge (select-keys ev [:name :role :contact :decides])
                                                                                             {:status "proposed" :referral {:why (:why ev) :referred-by (or (:holder d) operator)
                                                                                                                            :session-id (:session-id d) :quote (:quote ev)}})
                                                                   "referral" (:names-taken ev))]
                                    {:org-id (:org-id d) :id (:person-id ev) :person person :changed changed
                                     :by {:kind "referral" :session-id (:session-id d) :quote (:quote ev)}}))})
        (entry-effect "proposal" (fn [d] {:person-id (:person-id (e d)) :name (:name (e d)) :role (:role (e d)) :why (:why (e d)) :by (or (:holder d) operator)}))
        (reason "baton/proposal" (fn [d] {:key (:person-id (e d))})))

      ;; sova_send into this gathering session (the overseer's or a chart's text to its agent, which
      ;; reaches the person): L3, held when unattended, counts a prompt; the host's `invalid` carries
      ;; its session checks (archived, delivery)
      (dsl/act {:event :baton/send :checks [(lv/invalid-check b/evt)
                                            (fn [d] (when (lv/blank? (:text (e d))) (r/refuse 400 "text must not be blank.")))
                                            (lv/cap-check "prompt" (constantly 1) b/evt)]}
        (dsl/effect :send-prompt (fn [d] (select-keys (e d) [:text :delivery])))
        (b/ledger :ledger/take "prompt" (constantly 1)))
      (dsl/act {:event :baton/hide :checks [(lv/invalid-check b/evt)]}
        (script {:expr (fn [_ d] [(ops/assign :hidden-from-owner (true? (:hidden (e d))))])}))
      (dsl/act {:event :baton/abilities :checks [(mk rb/abilities-refusal)]}
        (script {:expr (fn [_ d] [(ops/assign :abilities (:abilities (e d)))])}))
      (dsl/act {:event :baton/extend :checks [(mk rb/extend-refusal)]}
        (script {:expr (fn [_ d] [(ops/assign [:budget :messages-max] (+ (get-in d [:budget :messages-max]) (:by (e d))))])}))
      ;; W3: the host counts the transcript at resume and attach; never raises a count
      (transition {:event :budget/recount}
        (script {:expr (fn [_ d] (let [n (:n (e d))]
                                   (when (and (number? n) (< n (get-in d [:budget :messages-used] 0)))
                                     [(ops/assign [:budget :messages-used] n)])))}))
      ;; the runtime refused a message it had let in: as if it never came
      (transition {:event :message/refused} (script {:expr (fn [_ d] (undo-ops d))}))

      (person-left-transitions)

      (parallel {:id :regions}
        ;; ── course ──────────────────────────────────────────────────────────────────────────────
        (state {:id :course :initial :course-born}
          (state {:id :course-born}
            (transition {:cond (fn [_ d] (some? (:offer-id d))) :target :pool})
            (transition {:cond (fn [_ d] (= operator (:holder d))) :target :with-operator})
            (transition {:target :with-person}))

          (state {:id :open :initial :with-person}
            (set-course "open")
            (move-transitions)
            (cascade-move)
            ;; goal_done: the model's own, inside its turn
            (dsl/act {:event :baton/goal-done :target :done :checks [(mk rb/goal-done-refusal)]}
              (revoke-withdrawn)
              (script {:expr (fn [_ d] (ended-ops d))})
              (entry-effect "done" (fn [d] {:summary (str/trim (:summary (e d)))}))
              (reason "baton/done" (fn [d] (when-not (:hidden-from-owner d) {})))
              (Send {:event :milestone/noted :targetexpr (fn [_ d] (b/project-sid (:org-id d) (:project-id d)))
                     :content (fn [_ d] {:kind "baton-done" :shown (not (:hidden-from-owner d))})}))
            (dsl/act {:event :baton/close :target :closed :checks [(mk rb/close-refusal)]}
              (script {:expr (fn [_ d] (ended-ops d))})
              (dsl/effect :revoke-links (fn [_] {:all true :why "closed"}))
              (reason "baton/closed" (fn [_] {})))
            ;; hand_to: the model's own, inside its turn (no link is minted)
            (dsl/act {:event :baton/hand-to :target :with-operator :checks [(mk rb/hand-to-refusal)]
                      :cond (fn [_ d] (= operator (get-in (e d) [:target :id])))}
              (revoke-withdrawn)
              (script {:expr (fn [_ d] (move-ops d operator (str/trim (:question (e d))) (:briefing (e d))))})
              (reason "baton/asked-operator" (fn [d] (when (owned-by-overseer? d) {:question (:question (e d)) :key (count (:handoffs d))}))))
            (dsl/act {:event :baton/hand-to :target :with-person :checks [(mk rb/hand-to-refusal)]}
              (revoke-withdrawn)
              (script {:expr (fn [_ d] (move-ops d (get-in (e d) [:target :id]) (str/trim (:question (e d))) (:briefing (e d))))})
              (watch-person #(get-in (e %) [:target :id])))

            ;; A message (a person's through the share page, or the operator's composer).
            (dsl/act {:event :baton/message :checks [msg-check] :cond (fn [_ d] (claim? d)) :target :leased}
              (script {:expr (fn [_ d] (note-ops d))})
              (lease-entry "claimed"))
            (dsl/act {:event :baton/message :checks [msg-check]}
              (script {:expr (fn [_ d] (note-ops d))}))

            ;; The budget stop: after the reply to the last allowed message, the operator holds it.
            (transition {:cond (fn [_ d] (and (rb/budget-spent? d) (reply-idle? d) (not= operator (:holder d)))) :target :with-operator}
              (revoke-withdrawn)
              (script {:expr (fn [_ d] (move-ops d operator rb/limit-question ""))})
              (handoff-entry))

            (state {:id :with-person})
            (state {:id :with-operator})
            (state {:id :offered :initial :pool}
              (state {:id :pool})
              (state {:id :leased}
                ;; 15 min idle from the later of the holder's message and the reply; never mid-reply
                (on-entry {} (Send {:id :lease-timer :event :lease/lapse :delayexpr (fn [_ d] (lease-ms d))}))
                (on-exit {} (cancel {:sendid :lease-timer}))
                (transition {:event :lease/renew :target :leased})
                (transition {:event :baton/message :cond (fn [_ d] (and (nil? (msg-check d)) (= (:from (e d)) (:holder d)))) :target :leased}
                  (script {:expr (fn [_ d] (note-ops d))}))
                (transition {:event :lease/lapse :cond (fn [_ d] (reply-idle? d)) :target :pool}
                  (script {:expr (fn [_ d] (lapse-ops d))})
                  (lease-entry "expired")))))

          (state {:id :done}
            (set-course "done")
            (reconcile-when-ended)
            (dsl/act {:event :baton/close :target :closed :checks [(mk rb/close-refusal)]}
              (script {:expr (fn [_ d] (ended-ops d))})
              (dsl/effect :revoke-links (fn [_] {:all true :why "closed"}))
              (reason "baton/closed" (fn [_] {}))))
          (state {:id :closed}
            (set-course "closed")
            (reconcile-when-ended)))

        ;; ── reply ─────────────────────────────────────────────────────────────────────────────
        (state {:id :reply :initial :reply-idle}
          (state {:id :reply-idle}
            (on-entry {} (set-reply "idle"))
            (transition {:event :reply/starting :target :reply-starting})
            (transition {:event :reply/writing :target :reply-writing}))
          (state {:id :reply-starting}
            (on-entry {} (set-reply "starting"))
            (transition {:event :reply/writing :target :reply-writing})
            (transition {:event :reply/stop :target :reply-stopping})
            (transition {:event :reply/ended :target :reply-idle}))
          (state {:id :reply-writing}
            (on-entry {} (set-reply "writing"))
            (transition {:event :reply/stop :target :reply-stopping})
            (transition {:event :reply/ended :target :reply-idle}
              ;; the reply's end renews the lease
              (raise {:event :lease/renew})))
          (state {:id :reply-stopping}
            (on-entry {} (set-reply "stopping"))
            ;; The held move, delivered again now: its own transitions check it again, and a move
            ;; that now fails is a refused step (logged with its sentence); the stop stands.
            (transition {:event :reply/ended :target :reply-idle}
              (raise {:event :lease/renew})
              (Send {:eventexpr (fn [_ d] (get-in d [:pending-move :event]))
                     :content (fn [_ d] (assoc (get-in d [:pending-move :data]) :sova/pending true))})
              (script {:expr (fn [_ _] [(ops/assign :pending-move nil)])}))))

        ;; ── budget ─────────────────────────────────────────────────────────────────────────────
        (state {:id :budget :initial :under}
          (state {:id :under} (transition {:cond (fn [_ d] (rb/budget-spent? d)) :target :at-limit}))
          (state {:id :at-limit} (transition {:cond (fn [_ d] (not (rb/budget-spent? d))) :target :under})))

        ;; ── wrap-up ────────────────────────────────────────────────────────────────────────────
        (state {:id :wrapup :initial :wrapup-none}
          (state {:id :wrapup-none}
            (transition {:cond (fn [_ d] (and (rb/ended? d) (wants-wrapup? d) (person-wrote? d))) :target :wrapup-due})
            (transition {:cond (fn [_ d] (and (rb/ended? d) (not (and (wants-wrapup? d) (person-wrote? d))))) :target :wrapup-skipped}))
          (state {:id :wrapup-due}
            (transition {:cond (fn [_ d] (reply-idle? d)) :target :wrapup-running}))
          (state {:id :wrapup-running}
            (on-entry {} (script {:expr (fn [_ d] [(ops/assign :wrapup {:state "running" :at (b/now-ms d)})])})
              (Send {:id :wrapup-timer :event :wrapup/overdue :delay wrapup-overdue-ms}))
            (on-exit {} (cancel {:sendid :wrapup-timer}))
            (invoke {:id :wrapup-run :type :sova/wrapup :params (fn [_ d] {:session-id (:session-id d)})})
            (transition {:event :wrapup/finished :target :wrapup-done}
              (script {:expr (fn [_ d] [(ops/assign :wrapup {:state "done" :at (b/now-ms d) :applied (or (:applied (e d)) 0) :refused (vec (:refused (e d)))})])}))
            (transition {:event :wrapup/stopped :target :wrapup-failed}
              (script {:expr (fn [_ d] [(ops/assign :wrapup (merge (:wrapup d) {:state "failed" :at (b/now-ms d) :error (or (:detail (e d)) "The wrap-up turn ended without an answer.")
                                                                                 :applied (or (:applied (e d)) 0) :refused (vec (:refused (e d)))}))])}))
            (transition {:event :sova/resumed :target :wrapup-failed}
              (script {:expr (fn [_ d] [(ops/assign :wrapup (merge (:wrapup d) {:state "failed" :error rb/wrapup-shut-down}))])}))
            (transition {:event :wrapup/overdue :target :wrapup-failed}
              (script {:expr (fn [_ d] [(ops/assign :wrapup (merge (:wrapup d) {:state "failed" :error rb/wrapup-overdue}))])})))
          (state {:id :wrapup-done})
          (state {:id :wrapup-failed}
            (dsl/act {:event :baton/wrapup-retry :target :wrapup-running
                      :checks [(fn [d] (rb/retry-refusal "failed" (reply-idle? d)))]}))
          (state {:id :wrapup-skipped}
            (on-entry {} (script {:expr (fn [_ d] (when (rb/ended? d) [(ops/assign :wrapup {:state "skipped" :at (b/now-ms d) :applied 0 :refused []})]))}))))))))

;; ---- registry entry ---------------------------------------------------------------------------------

(defn- course-of [config]
  (cond (contains? config :closed) "closed" (contains? config :done) "done" :else "open"))

(defn not-here [event config data]
  (let [c (course-of config)]
    (case event
      :baton/wrapup-retry (:sentence (rb/retry-refusal (cond (contains? config :wrapup-running) "running" (contains? config :wrapup-failed) "failed" :else "other")
                                       (contains? config :reply-idle)))
      (:baton/take-back :baton/handoff :baton/offer :baton/withdraw :baton/extend) (str "This session is " c ".")
      :baton/close (if (= c "closed") "This session is already closed." (str "This session is " c "."))
      (:baton/hand-to :baton/message :baton/propose :baton/abilities) (str "This conversation is " c ".")
      :baton/goal-done (str "This session is already " c ".")
      "That can't be done now.")))

(def acts
  {:baton/hand-to         {:needs nil}
   :baton/goal-done       {:needs nil}
   :baton/record-decision {:needs nil}
   :baton/propose         {:needs nil}
   :baton/message         {:needs nil}
   :baton/send            {:needs "L3" :tool "sova_send" :people-facing true :counts "prompt" :hold true :confirm-kind "message"
                           :what (fn [d] (str "A message into \"" (:public-title d) "\""))}
   :baton/take-back       {:needs nil :people-facing true :card (fn [d] {:sessions [(:session-id d)]})}
   :baton/handoff         {:needs nil :people-facing true :card (fn [d] {:sessions [(:session-id d)] :people [(get-in (e d) [:target :id])]})}
   :baton/offer           {:needs nil :people-facing true :confirm-kind "offer" :card (fn [d] {:sessions [(:session-id d)] :people (mapv :id (:targets (e d)))})}
   :baton/withdraw        {:needs nil}
   :baton/close           {:needs "L1" :tool "sova_close_gathering" :people-facing true :hold true :confirm-kind "close"
                           :what (fn [d] (str "Closing \"" (:public-title d) "\""))
                           :card (fn [d] {:sessions [(:session-id d)]})}
   :baton/extend          {:needs nil}
   :baton/abilities       {:needs nil}
   :baton/hide            {:needs nil}
   :baton/wrapup-retry    {:needs nil}
   :hold/cancel           {:needs "L0" :correction true}})

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:course :holder :needs-you :offer-id :offers :wrote-at :owner :conflict :decisions :public-title :budget
              :hidden-from-owner :wrapup :handoffs :participants :reply :created-at :closed-at]
   :acts     acts
   :not-here not-here
   :cold?    (fn [config _] (and (or (contains? config :done) (contains? config :closed))
                                 (some config [:wrapup-done :wrapup-skipped :wrapup-failed])))})
