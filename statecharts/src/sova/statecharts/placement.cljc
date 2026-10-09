(ns sova.statecharts.placement
  "The placement statechart (portable, `placement/<org>/<p>`): a project placed in an organization, and
   every org concern about it (§app.organizations/stakeholder, §app.owner-page/updates, §app.outreach/send).
   The project itself (`project/<p>`) knows nothing of it: the placement watches the project and learns
   its name, whether it is archived and its last merge from its exported data.

   Regions (under one compound):
   - stake ‹none · set · cleared›: the main stakeholder; the person leaving clears it.
   - milestone ‹none · since-post› and cooldown ‹cooling · ready›: the owner-update gates.

   It is where the org's item-less starts happen (the operator's Start form and Send to person…, the
   overseer's gathering or offer with `gap: \"none\"`), where the overseer files gaps (items), and it
   keeps the list of gatherings it and its items started (r11).

   Start data: `{:org-id :project-id :via (born | import) :placed-at}`. It spawns the project's
   reconciler (portable) once."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel raise]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.statecharts.base :as b]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.rules.refusal :as r]
    [sova.statecharts.rules.started :as st]
    [sova.statecharts.engine.dsl :as dsl]))

(def version 1)
(def history-max 50)
(def update-max 2000)
(def update-every-ms (* 24 3600 1000))

(def invalid (lv/invalid-check b/evt))

(defn not-archived
  "The project's own refusal, from its exported facts (the same sentence the project gives)."
  [data]
  (when (:archived data) (r/refuse 409 (str (:project-name data) " is archived. Unarchive it first."))))

(defn via [data] (when (= "overseer" (some-> (:via (b/evt data)) name)) "overseer"))

;; ---- the project, watched ----------------------------------------------------------------------------

(defn project-moved? [_ d] (= "project" (:statechart (b/moved d))))

(defn merged-since-post?
  "A build of the project merged after the last post (the project's exported `last-merged-at`)."
  [data]
  (let [t (:last-merged-at data)] (and (number? t) (> t (or (:last-post-at data) 0)))))

(defn project-facts-ops [d]
  (let [m (b/moved d) x (:exported m) merged (:last-merged-at x)]
    (cond-> [(ops/assign :project-name (:name x))
             (ops/assign :archived (b/moved-in? d :archived))
             (ops/assign :last-merged-at merged)]
      (merged-since-post? (assoc d :last-merged-at merged)) (conj (ops/assign :milestone true)))))

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
    (and (= "person" (:statechart m)) (some? (:stakeholder data))
         (= (:stakeholder data) (b/last-part (:from m))) (b/moved-in? data :left))))

(defn clear-stakeholder-ops [data]
  (let [pid (:stakeholder data)]
    [(ops/assign :stakeholder-history (stake-history data {:at (b/now-ms data) :from pid :to nil :why "left"}))
     (ops/assign :stakeholder nil)
     (ops/assign :stakeholder-cleared {:person-id pid :name (get-in (b/moved data) [:exported :name]) :at (b/now-ms data)})]))

(defn- stake-act [target cnd]
  (dsl/act {:sova/feed :feed :event :stakeholder/set :target target :checks [invalid stakeholder-check] :cond cnd}
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
   promoted, a build merged), or a build of the project that finished a turn after it (not working
   now; the host stamps `build-finished-at`)."
  [data]
  (or (true? (:milestone data))
      (let [t (:build-finished-at (b/evt data))] (and (number? t) (> t (or (:last-post-at data) 0))))))

;; ---- outreach -----------------------------------------------------------------------------------

(def note-max 500)

(defn send-check
  "outreach/send (§app.outreach/send): the host resolved the person (`target`) and the link (`invalid`:
   why that link can't go to them); a link, a note, or both; the note's leak backstop."
  [data]
  (let [e    (b/evt data)
        t    (:target e)
        note (str/trim (or (:note e) ""))]
    (cond
      (nil? (:id t)) (r/refuse 400 "person must be a roster person's id")
      (not= "active" (:status t)) (r/refuse 409 (str (:name t) " is not active."))
      (not (lv/blank? (:invalid e))) (r/refuse 409 (:invalid e))
      (and (nil? (:link e)) (= "" note)) (r/refuse 400 "Send a link, a note, or both.")
      (> (count note) note-max) (r/refuse 400 "A note is at most 500 characters.")
      (not (lv/blank? (:leak e))) (r/refuse 409 (:leak e)))))

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

(defn baton-data
  "A gathering the placement starts (no gap): the start data the baton statechart reads."
  [data]
  (let [e (b/evt data)]
    (merge (select-keys e [:to :public-title :goal :question :briefing :model :thinking :messages-max :abilities
                           :targets :op-item :parent :mint-link :started-via :started :lease-ms :operator-name :offer-id :target-people :names])
      {:org-id (:org-id data) :project-id (:project-id data) :session-id (:session-id e)
       :owner (if (contains? #{"overseer" "statechart"} (some-> (:by e) name)) {:overseer-of (:project-id data)} "operator")
       :at-once (b/at-once? data)
       :created-at (b/now-ms data)})))

(def gather-cap (lv/cap-check "gather" (constantly 1) b/evt))

(defn baton-kind [d] (if (>= (count (:targets (b/evt d))) 2) "offer" "gathering"))

(def statechart
  (chart/statechart {:initial :placement}
    (state {:id :placement :initial :regions}
      (dsl/hold-cancel-correction)
      (b/hold-review)
      (b/flush-transition)
      (on-entry {}
        (dsl/watch (fn [d] (b/project-sid (:project-id d))))
        (dsl/spawn {:statechart "reconciler" :link :placement :watch? false :if-exists :skip
                    :id (fn [d] (b/reconciler-sid (:org-id d) (:project-id d)))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:project-id d)})}))

      ;; the project's name, shelf and last merge (a merge since the last post is a milestone)
      (transition {:sova/feed :quiet :event :link/moved :cond project-moved?}
        (script {:expr (fn [_ d] (project-facts-ops d))}))
      ;; r11: an item's gathering joins the list (and the placement watches it); a link says when one settled
      (apply transition {:sova/feed :quiet :event :started/noted}
        (b/started-content (fn [d] (let [e (b/evt d)] {:row (b/started-row d (:kind e) (:sid e)) :watch (:sid e)}))))
      (apply transition {:sova/feed :quiet :event :link/moved :cond b/from-started?}
        (b/started-content (fn [d] (let [m (b/moved d)] {:mark [(:from m) (st/settled? (:statechart m) (:states m))]}))))

      ;; §app.outreach/send: a link and/or a note to a roster person outside Sova. The host resolves the
      ;; link and sends in the effect; its result names the outcome only.
      (dsl/act {:sova/feed :feed :event :outreach/send :checks [send-check]}
        (dsl/effect :outreach-send (fn [d] (let [e (b/evt d)]
                                             (cond-> {:person-id (get-in e [:target :id]) :by (or (:sent-by e) "operator")}
                                               (:link e) (assoc :link (:link e))
                                               (not= "" (str/trim (or (:note e) ""))) (assoc :note (str/trim (:note e))))))))

      ;; Hidden from the owner's page (the operator's).
      (dsl/act {:sova/feed :feed :event :placement/edit :checks [invalid]}
        (script {:expr (fn [_ d] (let [e (b/evt d)]
                                   (cond-> []
                                     (contains? e :owner-hidden) (conj (ops/assign :owner-hidden (true? (:owner-hidden e)))))))}))
      (dsl/act {:sova/feed :feed :event :spec/freeze :checks [invalid]}
        ;; the spec's hash at the freeze: "edited outside" compares the spec with the later of this and
        ;; the last promotion's hash (server-3 P3 2)
        (script {:expr (fn [_ d] (let [ev (b/evt d)]
                                   [(ops/assign :spec (cond-> {:frozen (true? (:frozen ev)) :at (b/now-ms d)}
                                                        (:spec-hash ev) (assoc :spec-hash (:spec-hash ev))))]))}))

      ;; A gap the overseer files (`sova_idea add §gap/…`, L0) is an item; the operator's ideas never are.
      (dsl/act {:sova/feed :feed :event :gap/file :checks [invalid]}
        (dsl/spawn {:statechart "item" :link :placement :watch? false
                    :id (fn [d] (b/item-sid (:org-id d) (:project-id d) (:gap-id (b/evt d))))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:project-id d) :id (:gap-id (b/evt d)) :idea-id (:idea-id (b/evt d))})}))

      ;; An item-less gathering.
      (dsl/act {:sova/feed :feed :event :baton/start :checks [not-archived invalid gather-cap]}
        (dsl/spawn {:statechart "baton" :link :placement :id (fn [d] (b/baton-sid (:org-id d) (:session-id (b/evt d)))) :data baton-data})
        (b/ledger :ledger/take "gather" (constantly 1))
        (b/started-content (fn [d] {:row (b/started-row d (baton-kind d) (b/baton-sid (:org-id d) (:session-id (b/evt d))))})))

      (parallel {:id :regions}
        (state {:id :stake :initial :no-stakeholder}
          (state {:id :no-stakeholder}
            (transition {:sova/feed :feed :cond (fn [_ d] (some? (:stakeholder d))) :target :stakeholder-set})
            (stake-act :stakeholder-set to-someone?)
            (stake-act :no-stakeholder (fn [e d] (not (to-someone? e d)))))
          (state {:id :stakeholder-set}
            (transition {:sova/feed :feed :event :link/moved :cond stakeholder-left? :target :stakeholder-cleared}
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
            (transition {:sova/feed :quiet :cond (fn [_ d] (true? (:milestone d))) :target :since-post}))
          (state {:id :since-post}
            (transition {:sova/feed :quiet :cond (fn [_ d] (not (:milestone d))) :target :no-milestone})))

        (state {:id :cooldown :initial :ready}
          (state {:id :ready}
            (transition {:sova/feed :quiet :cond cooling? :target :cooling}))
          (state {:id :cooling}
            (on-entry {} (Send {:id :cooldown-timer :event :cooldown/over
                                :delayexpr (fn [_ d] (max 0 (- (+ (or (:last-post-at d) 0) update-every-ms) (b/now-ms d))))}))
            (on-exit {} (cancel {:sendid :cooldown-timer}))
            (transition {:sova/feed :quiet :event :cooldown/over :cond (fn [e d] (not (cooling? e d))) :target :ready})
            ;; an attended post while cooling restarts the 24 h
            (transition {:sova/feed :quiet :event :cooldown/restart :target :cooling}))))

      ;; A shown conversation done, a decision promoted (their statecharts send it).
      (transition {:sova/feed :quiet :event :milestone/noted :cond (fn [_ d] (not (false? (:shown (b/evt d)))))}
        (script {:expr (fn [_ d] [(ops/assign :milestone true)])}))

      ;; The post, held when unattended (r4). The 24 h and milestone gates bind unattended runs only.
      (dsl/act {:sova/feed :feed :event :owner-update/post :checks [update-check]}
        (dsl/effect :owner-update (fn [d] {:text (str/trim (:text (b/evt d)))
                                           :run (if (true? (:attended (b/evt d))) "operator" "auto")}))
        (script {:expr (fn [_ d] [(ops/assign :last-post-at (b/now-ms d)) (ops/assign :milestone false)])})
        (raise {:event :cooldown/restart})))))

(def acts
  {:placement/edit    {:needs nil}
   :spec/freeze       {:needs nil}
   :stakeholder/set   {:needs nil}
   :gap/file          {:needs "L0" :tool "sova_idea"}
   :baton/start       {:needs "L1" :tool "sova_start_gathering" :people-facing true :counts "gather" :hold true :confirm-kind b/start-kind :hours b/hours-window
                       :card (fn [d] (b/start-card (:project-id d) d))
                       :what (fn [d] (str "A gathering session \"" (:public-title (b/evt d)) "\""))}
   :owner-update/post {:needs "L1" :tool "sova_owner_update" :people-facing true :hold true :confirm-kind "owner-update"
                       :what (fn [_] "An owner update")}
   :outreach/send     {:needs "L1" :tool "sova_send_to_person" :people-facing true :hold true :confirm-kind "send" :hours b/hours-window :outage true
                       :card (fn [d] (let [e (b/evt d)] {:people [(get-in e [:target :id])] :sessions (vec (keep identity [(get-in e [:link :session])]))}))
                       :what (fn [d] (str "A WhatsApp message to " (get-in (b/evt d) [:target :name])))}
   :hold/cancel       {:needs "L0" :correction true}
   :hold/approve      {:needs "L0" :correction true}})

(defn not-here [_event _config _data] "That can't be done now.")

(def entry
  {:statechart statechart
   :version    version
   :migrate    {}
   :storage    :portable
   :exported   [:org-id :project-id :project-name :archived :stakeholder :stakeholder-cleared :owner-hidden :spec
                :last-post-at :milestone :started :via :placed-at]
   :acts       acts
   :not-here   not-here})
