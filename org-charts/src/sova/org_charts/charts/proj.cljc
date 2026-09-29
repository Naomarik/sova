(ns sova.org-charts.charts.proj
  "The project chart (portable, `project/<org>/<p>`): one project of the org
   (§app.organizations/projects, /archive, /stakeholder; §app.project-overseer/identity;
   §app.owner-page/updates).

   Regions (under one compound):
   - shelf ‹active · archived›: archive is refused while anything is open (\"Stop these first: …\",
     the host stamps what is open, `blockers`); while archived nothing new starts in it.
   - overseer ‹none · present›: its conversation (current + at most 20 earlier ones).
   - stake ‹none · set · cleared›: the main stakeholder; the person leaving clears it.
   - milestone ‹none · since-post› and cooldown ‹cooling · ready›: the owner-update gates.

   The project is also where item-less starts happen: the operator's Start form and Send to
   person… (a baton owned by the operator), the overseer's gathering or offer with `gap: \"none\"`,
   and coding sessions that build no gap (New Coding Session, Start Coding Session from an item, the
   global Overseer's `code`, and the overseer's `sova_create_session gap: \"none\"`, attended only, q7).

   Start data: `{:org-id :id :name :root :created-at :origin}`. It spawns its reconciler (portable)
   and its watch (host-local) at birth."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel raise]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)
(def history-max 50)
(def conversations-max 20)
(def update-max 2000)
(def update-every-ms (* 24 3600 1000))

(def invalid (lv/invalid-check b/evt))

(defn archived-refusal [data] (r/refuse 409 (str (:name data) " is archived. Unarchive it first.")))
(defn archived-overseer-refusal [data] (r/refuse 409 (str (:name data) " is archived. Unarchive it to use its overseer.")))

(defn not-archived [data] (when (:archived data) (archived-refusal data)))

(defn- plural [n one many] (str n " " (if (= 1 n) one many)))

(defn blockers-sentence
  "archiveBlockers: what is open, in the refusal's words (the host stamps the titles)."
  [{:keys [gatherings coding overseer-working]}]
  (let [parts (cond-> []
                (seq gatherings) (conj (str (plural (count gatherings) "gathering session" "gathering sessions") " open (" (str/join ", " gatherings) ")"))
                (seq coding) (conj (str (plural (count coding) "coding session" "coding sessions") " running (" (str/join ", " coding) ")"))
                overseer-working (conj "its overseer is working"))]
    (when (seq parts) (str "Stop these first: " (str/join "; " parts) "."))))

(defn archive-check [data]
  (some->> (blockers-sentence (:blockers (b/evt data))) (r/refuse 409)))

(defn via [data] (when (= "overseer" (some-> (:via (b/evt data)) name)) "overseer"))

;; ---- stakeholder ------------------------------------------------------------------------------

(defn stakeholder-check
  "Only an active person (the host stamps `target`), or null for none."
  [data]
  (let [e (b/evt data)]
    (when (and (some? (:person-id e)) (not= "active" (get-in e [:target :status])))
      (r/refuse 400 "Only an active person on the roster can be a project's main stakeholder."))))

(defn- stake-history [data row] (vec (take-last history-max (conj (vec (:stakeholder-history data)) row))))

(defn set-stakeholder-ops [data]
  (let [to (:person-id (b/evt data))]
    ;; a save that changes nothing adds no line (noteStakeholder), but it answers Needs you
    (cond-> [(ops/assign :stakeholder to) (ops/assign :stakeholder-cleared nil)]
      (not= to (:stakeholder data))
      (conj (ops/assign :stakeholder-history (stake-history data (cond-> {:at (b/now-ms data) :from (:stakeholder data) :to to :why "operator"}
                                                                   (via data) (assoc :via "overseer"))))))))

(defn stakeholder-left? [_ data]
  (let [m (b/moved data)]
    (and (= "person" (:chart m)) (some? (:stakeholder data))
         (= (:stakeholder data) (b/last-part (:from m))) (b/moved-in? data :left))))

(defn clear-stakeholder-ops [data]
  (let [pid (:stakeholder data)]
    [(ops/assign :stakeholder-history (stake-history data {:at (b/now-ms data) :from pid :to nil :why "left"}))
     (ops/assign :stakeholder nil)
     (ops/assign :stakeholder-cleared {:person-id pid :name (get-in (b/moved data) [:exported :name]) :at (b/now-ms data)})]))

(defn- stake-act [target cnd]
  (dsl/act {:event :stakeholder/set :target target :checks [invalid stakeholder-check] :cond cnd}
    (b/relink (fn [d] (some->> (:stakeholder d) (b/person-sid (:org-id d))))
              (fn [d] (some->> (:person-id (b/evt d)) (b/person-sid (:org-id d)))))
    (script {:expr (fn [_ d] (set-stakeholder-ops d))})))

(defn- to-someone? [_ d] (some? (:person-id (b/evt d))))

;; ---- owner updates ---------------------------------------------------------------------------------

(defn hours-ago [at now]
  (let [h (quot (- now at) 3600000)]
    (cond (< h 1) "less than an hour ago" (= h 1) "1 hour ago" :else (str h " hours ago"))))

(defn cooling? [_ d] (and (number? (:last-post-at d)) (< (- (b/now-ms d) (:last-post-at d)) update-every-ms)))

(defn milestone?
  "A milestone since the last post: a standing one (a shown conversation done, a decision
   promoted, a build merged: `milestone/noted`), or a build of the project that finished a turn
   after it (not working now; the host stamps `build-finished-at`)."
  [data]
  (or (true? (:milestone data))
      (let [t (:build-finished-at (b/evt data))] (and (number? t) (> t (or (:last-post-at data) 0))))))

(defn update-check
  "sova_owner_update in today's order: an owner, the text, the leak backstop, then (unattended
   only) the 24 h gate and the milestone gate."
  [data]
  (let [e    (b/evt data)
        text (str/trim (or (:text e) ""))]
    (cond
      (not (:owner-active e)) (r/refuse 409 "This organization has no owner, so there is no page to post to.")
      (= "" text) (r/refuse 400 "Write the update first.")
      (> (count text) update-max) (r/refuse 400 "An update is at most 2,000 characters.")
      (not (lv/blank? (:leak e))) (r/refuse 409 (:leak e))
      (true? (:attended e)) nil
      (and (:last-post-at data) (< (- (b/now-ms data) (:last-post-at data)) update-every-ms))
      (r/refuse 409 (str "An update was posted " (hours-ago (:last-post-at data) (b/now-ms data)) ": at most one a day."))
      (not (milestone? data))
      (r/refuse 409 "Nothing new since the last update: post one when a conversation finishes, a decision is agreed, or a coding session finishes or is merged."))))

;; ---- starts ----------------------------------------------------------------------------------------

(defn gap-none-build-check
  "q7: an overseer build with no gap only in a turn the operator started."
  [data]
  (let [e (b/evt data)]
    (when (and (= "overseer" (some-> (:by e) name)) (not (true? (:attended e))))
      (r/refuse 409 "Without a gap, a coding session starts only in a turn the operator started: name the gap whose promoted decisions it builds (gap), or ask with sova_confirm."))))

(defn baton-data
  "A gathering the project starts (no gap): the start data the baton chart reads."
  [data]
  (let [e (b/evt data)]
    (merge (select-keys e [:to :public-title :goal :question :briefing :model :thinking :messages-max :abilities
                           :targets :op-item :parent :mint-link :started-via])
      {:org-id (:org-id data) :project-id (:id data) :session-id (:session-id e)
       :owner (if (contains? #{"overseer" "chart"} (some-> (:by e) name)) {:overseer-of (:id data)} "operator")
       :created-at (b/now-ms data)})))

(defn build-data [data]
  (let [e (b/evt data)]
    (merge (select-keys e [:title :prompt :model :thinking :mode :op-item :folder])
      {:org-id (:org-id data) :project-id (:id data) :session-id (:session-id e)
       :kind (if (= "overseer" (some-> (:by e) name)) "coding" "operator-coding")
       :started-by (if (= "overseer" (some-> (:by e) name)) "overseer" "operator")
       :via (via data) :gap "none" :decisions [] :created-at (b/now-ms data)})))

(def gather-cap (lv/cap-check "gather" (constantly 1) b/evt))
(def create-cap (lv/cap-check "create" (constantly 1) b/evt))


(def chart
  (statechart {:initial :project}
    (state {:id :project :initial :regions}
      (dsl/hold-cancel-correction)
      (on-entry {}
        (dsl/spawn {:chart "reconciler" :link :project :if-exists :skip
                    :id (fn [d] (b/reconciler-sid (:org-id d) (:id d)))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:id d)})})
        (dsl/spawn {:chart "watch" :link :project :watch? false :if-exists :skip
                    :id (fn [d] (b/watch-sid (:org-id d) (:id d)))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:id d)})}))

      (dsl/act {:event :project/edit :checks [invalid]}
        (script {:expr (fn [_ d] (let [e (b/evt d)]
                                   (cond-> []
                                     (:name e) (conj (ops/assign :name (str/trim (:name e))))
                                     (:root e) (conj (ops/assign :root (:root e)))
                                     (contains? e :owner-hidden) (conj (ops/assign :owner-hidden (true? (:owner-hidden e)))))))}))
      (dsl/act {:event :spec/freeze :checks [invalid]}
        (script {:expr (fn [_ d] [(ops/assign :spec {:frozen (true? (:frozen (b/evt d)))})])}))

      ;; A gap the overseer files (`sova_idea add §gap/…`, L0) is an item; the operator's ideas never are.
      (dsl/act {:event :gap/file :checks [invalid]}
        (dsl/spawn {:chart "item" :link :project :watch? false
                    :id (fn [d] (b/item-sid (:org-id d) (:id d) (:gap-id (b/evt d))))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:id d) :id (:gap-id (b/evt d)) :idea-id (:idea-id (b/evt d))})}))

      ;; Item-less starts (the gap-less ones): a gathering…
      (dsl/act {:event :baton/start :checks [not-archived invalid gather-cap]}
        (dsl/spawn {:chart "baton" :link :project :id (fn [d] (b/baton-sid (:org-id d) (:session-id (b/evt d)))) :data baton-data})
        (b/ledger :ledger/take "gather" (constantly 1)))
      ;; …and a coding session.
      (dsl/act {:event :build/start :checks [not-archived invalid gap-none-build-check create-cap]}
        (dsl/spawn {:chart "build" :link :project :id (fn [d] (b/build-sid (:org-id d) (:id d) (:session-id (b/evt d)))) :data build-data})
        (b/ledger :ledger/take "create" (constantly 1)))

      (parallel {:id :regions}
        (state {:id :shelf :initial :active}
          (state {:id :active}
            (transition {:cond (fn [_ d] (some? (:archived d))) :target :archived})
            (dsl/act {:event :project/archive :target :archived :checks [archive-check]}
              (script {:expr (fn [_ d] [(ops/assign :archived (cond-> {:at (b/now-ms d)} (via d) (assoc :via "overseer")))])}))
            ;; unarchiving an active project writes nothing
            (dsl/act {:event :project/unarchive}))
          (state {:id :archived}
            (dsl/act {:event :project/archive})
            (dsl/act {:event :project/unarchive :target :active}
              (script {:expr (fn [_ d] [(ops/delete :archived)])}))))

        (state {:id :overseer :initial :no-overseer}
          (state {:id :no-overseer}
            (transition {:cond (fn [_ d] (some? (:overseer d))) :target :has-overseer})
            (dsl/act {:event :overseer/start :target :has-overseer :checks [invalid]}
              (script {:expr (fn [_ d] [(ops/assign :overseer {:id (:conversation-id (b/evt d)) :history []})])})))
          (state {:id :has-overseer}
            ;; Clear never refuses; it resets the per-message allowance.
            (dsl/act {:event :overseer/clear :checks [invalid]}
              (script {:expr (fn [_ d] (let [o (:overseer d)]
                                         [(ops/assign :overseer {:id (:conversation-id (b/evt d))
                                                                 :history (vec (take conversations-max (cons (:id o) (:history o))))})]))})
              (Send {:event :ledger/reset-message :targetexpr (fn [_ d] (b/watch-sid (:org-id d) (:id d))) :content (fn [_ _] {})}))
            (dsl/act {:event :overseer/start})))

        (state {:id :stake :initial :no-stakeholder}
          (state {:id :no-stakeholder}
            (transition {:cond (fn [_ d] (some? (:stakeholder d))) :target :stakeholder-set})
            (stake-act :stakeholder-set to-someone?)
            (stake-act :no-stakeholder (fn [e d] (not (to-someone? e d)))))
          (state {:id :stakeholder-set}
            (transition {:event :link/moved :cond stakeholder-left? :target :stakeholder-cleared}
              (script {:expr (fn [_ d] (clear-stakeholder-ops d))}))
            (stake-act :stakeholder-set to-someone?)
            (stake-act :no-stakeholder (fn [e d] (not (to-someone? e d)))))
          ;; Needs you asks for a new one; a save of the select (someone or none) leaves it.
          (state {:id :stakeholder-cleared}
            (stake-act :stakeholder-set to-someone?)
            (stake-act :no-stakeholder (fn [e d] (not (to-someone? e d))))))

        ;; The owner-update gates, shown as states: a standing milestone since the last post, and
        ;; the 24 h since it (the checks read the same data).
        (state {:id :milestone :initial :no-milestone}
          (state {:id :no-milestone}
            (transition {:cond (fn [_ d] (true? (:milestone d))) :target :since-post}))
          (state {:id :since-post}
            (transition {:cond (fn [_ d] (not (:milestone d))) :target :no-milestone})))

        (state {:id :cooldown :initial :ready}
          (state {:id :ready}
            (transition {:cond cooling? :target :cooling}))
          (state {:id :cooling}
            (on-entry {} (Send {:id :cooldown-timer :event :cooldown/over
                                :delayexpr (fn [_ d] (max 0 (- (+ (or (:last-post-at d) 0) update-every-ms) (b/now-ms d))))}))
            (on-exit {} (cancel {:sendid :cooldown-timer}))
            (transition {:event :cooldown/over :cond (fn [e d] (not (cooling? e d))) :target :ready})
            ;; an attended post while cooling restarts the 24 h
            (transition {:event :cooldown/restart :target :cooling}))))

      ;; A shown conversation done, a decision promoted, a build merged (their charts send it).
      (transition {:event :milestone/noted :cond (fn [_ d] (not (false? (:shown (b/evt d)))))}
        (script {:expr (fn [_ d] [(ops/assign :milestone true)])}))

      ;; The post, held when unattended (r4). The 24 h and milestone gates bind unattended runs only.
      (dsl/act {:event :owner-update/post :checks [update-check]}
        (dsl/effect :owner-update (fn [d] {:text (str/trim (:text (b/evt d)))
                                           :run (if (true? (:attended (b/evt d))) "operator" "auto")}))
        (script {:expr (fn [_ d] [(ops/assign :last-post-at (b/now-ms d)) (ops/assign :milestone false)])})
        (raise {:event :cooldown/restart})))))

(def acts
  {:project/edit      {:needs nil}
   :spec/freeze       {:needs nil}
   :project/archive   {:needs nil :people-facing true :card (fn [d] {:projects [(:id d)]})}
   :project/unarchive {:needs nil}
   :overseer/start    {:needs nil}
   :overseer/clear    {:needs nil :people-facing true :card (fn [d] {:projects [(:id d)]})}
   :stakeholder/set   {:needs nil}
   :gap/file          {:needs "L0" :tool "sova_idea"}
   :baton/start       {:needs "L1" :tool "sova_start_gathering" :people-facing true :counts "gather" :hold true
                       :card (fn [d] (b/start-card (:id d) d))
                       :what (fn [d] (str "A gathering session \"" (:public-title (b/evt d)) "\""))}
   :build/start       {:needs "L3" :tool "sova_create_session" :code-facing true :counts "create" :hold true
                       :what (fn [d] (str "A coding session \"" (or (:title (b/evt d)) "untitled") "\""))}
   :owner-update/post {:needs "L1" :tool "sova_owner_update" :people-facing true :hold true
                       :what (fn [_] "An owner update")}
   :hold/cancel       {:needs "L0" :correction true}})

(defn not-here [event config data]
  (case event
    :owner-update/post "That can't be done now."
    "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:name :root :archived :stakeholder :stakeholder-cleared :owner-hidden :overseer :spec :last-post-at]
   :acts     acts
   :not-here not-here})
