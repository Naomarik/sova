(ns sova.org-charts.charts.person
  "The person chart (portable, `person/<org>/<pid>`): one person of the roster, proposed → active →
   left, with field writes through field authority (§app.organizations/roster, /field-authority,
   /referrals, /history-and-revert).

   Every status pair the operator's edit allows is exactly one transition per event (W22, C10), and
   the person-left cascade is the entry of `:left`, whatever entered it: the links effect here, and
   every session that watches this person (the org for its owner, a project for its stakeholder, a
   baton for its holder or invitees) reads `:left` from `link/moved` and does its own part.

   Start data (the spawner cleaned and checked it with `rules.person/apply-change`):
   `{:org-id :id :person {...fields, :status} :changed [{:field :from :to}] :by {...}}`."
  (:require
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state transition on-entry script]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.person :as rp]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)

(def status-states {"proposed" :proposed "active" :active "left" :left})
(def fields [:name :contact :role :decides :skills :competence :language :voice :tz :hours :referral])

(defn person-of [data] (assoc (select-keys data fields) :status (:status data)))

(defn writer [data] (or (some-> (get-in (b/evt data) [:by-kind]) name) (let [by (b/by data)] (if (= by "chart") "overseer" by))))

(defn change-by
  "The history line's `by`: `{kind sessionId? entryId? quote? via? overseerId?}` (ChangeBy)."
  [data]
  (let [e (b/evt data)]
    (cond-> {:kind (writer data)}
      (:session-id e) (assoc :session-id (:session-id e))
      (:entry-id e) (assoc :entry-id (:entry-id e))
      (:quote e) (assoc :quote (:quote e))
      (= "overseer" (some-> (:via e) name)) (assoc :via "overseer")
      (:overseer-id e) (assoc :overseer-id (:overseer-id e)))))

;; ---- the change an edit, a status move or a revert makes ------------------------------------------

(defn patch-of
  "The fields an event writes: `person/edit {:patch}`; a status event its status; a revert the
   row's field back to its `from` (empty when it was null)."
  [data]
  (let [e (b/evt data)]
    (case (b/evt-name data)
      :person/edit (:patch e)
      (:person/approve) {:status "active"}
      (:person/decline :person/leave) {:status "left"}
      :person/revert (let [{:keys [field from]} (:row e)
                           f (keyword field)]
                       {f (if (some? from) from (case f (:decides :skills) [] (:contact :competence) {} (:referral :hours) nil ""))})
      {})))

(defn- writer-for [data]
  (let [ev (b/evt-name data)]
    (cond
      ;; approve/decline: the operator's, or the overseer's one status write (decidePerson).
      (#{:person/approve :person/decline} ev) "operator"
      (= :person/revert ev) "operator"
      (= :person/leave ev) "operator"
      :else (writer data))))

(defn change
  "The cleaned change, or a refusal (rules.person/apply-change against the stamped `names-taken`)."
  [data]
  (rp/apply-change (person-of data) (patch-of data) (writer-for data) (:names-taken (b/evt data))))

(defn change-check [data] (let [c (change data)] (when (r/refusal? c) c)))

(defn target-status
  "The status the event moves to (nil: none, or the current one)."
  [data]
  (let [s (get (patch-of data) :status)]
    (when (and s (not= s (:status data))) s)))

(defn moves-to? [status] (fn [_ data] (= status (target-status data))))
(defn stays? [_ data] (nil? (target-status data)))

(defn write-ops
  "Ops writing the change into the data (status is the configuration's: entry sets it)."
  [data]
  (let [{:keys [person changed]} (change data)]
    (into [(ops/assign :now (b/now-ms data))]
      (for [f fields :when (some #(= f (:field %)) changed)]
        (ops/assign f (get person f))))))

(defn history-effect
  "roster-history.jsonl lines, one per changed field (the host stamps `at`, unique per org)."
  []
  (script {:expr (fn [_ data]
                   (let [{:keys [changed]} (change data)]
                     ;; A change that changes nothing writes nothing (applyChange).
                     (when (seq changed)
                       (dsl/effect-ops data (dsl/effect-map :roster-history
                                              (fn [_] {:person-id (:id data) :lines changed :by (change-by data)
                                                       :revert-of (when (= :person/revert (b/evt-name data)) (get-in (b/evt data) [:row :at]))})
                                              data)))))}))

(defn write [] (script {:expr (fn [_ data] (write-ops data))}))

;; ---- checks ---------------------------------------------------------------------------------------

(defn name-of [data] (or (:name data) "Someone"))

(defn not-waiting
  "approve/decline outside `proposed`: the operator's route, or the overseer's tool (its own words)."
  [data]
  (when-not (= "proposed" (:status data))
    (if (= "overseer" (b/by data))
      (r/refuse 409 (str (name-of data) " is " (:status data) ", not proposed."))
      (r/refuse 409 (str (name-of data) " is not waiting for approval.")))))

(defn decider-check
  "decidePerson: only the operator or the project overseer approves or declines."
  [data]
  (let [by (b/by data)]
    (when-not (contains? #{"operator" "overseer"} by)
      (r/refuse 409 (str "A " (or (some-> (:by-kind (b/evt data)) name) by) " change may not approve or decline people.")))))

(def revert-creation "A person's creation can't be reverted; set their status to left instead.")

(defn revert-check
  "A revert needs its row; a person's creation can't be reverted; and (C6) the field must still hold
   the row's `to`, or reverting it would undo a later change."
  [data]
  (let [{:keys [field from to] :as row} (:row (b/evt data))
        f (some-> field keyword)]
    (cond
      (nil? row) (r/refuse 404 "No such change")
      (and (nil? from) (= f :name)) (r/refuse 409 revert-creation)
      (not= (if (= f :status) (:status data) (get data f)) to)
      (r/refuse 409 (str (name-of data) "'s " (name f) " has changed since then, so reverting this would undo a later change. Revert the latest change instead.")))))

(defn- person-act
  "One transition of `event` from here: to `status`'s state, or staying (`nil`)."
  [event status extra-checks]
  (dsl/act (cond-> {:sova/feed :feed :event event
                    :checks (into (vec extra-checks) [change-check])
                    :cond (if status (moves-to? status) stays?)}
             status (assoc :target (status-states status)))
    (history-effect)
    (write)))

(defn- status-transitions
  "From a status state: every event that may move it, one transition each, then the edits that stay."
  [here]
  (let [others (remove #{here} ["proposed" "active" "left"])]
    (concat
      (for [s others] (person-act :person/edit s []))
      (for [s others] (person-act :person/revert s [revert-check]))
      [(person-act :person/edit nil [])
       (person-act :person/revert nil [revert-check])])))

(defn- entered [status]
  (on-entry {} (script {:expr (fn [_ data] [(ops/assign :status status)])})))

(def chart
  (statechart {:initial :person}
    (state {:id :person :initial :born}
      (dsl/hold-cancel-correction)
      (b/hold-review)
      (state {:id :born}
        (on-entry {}
          (script {:expr (fn [_ d] (into [(ops/assign :status (get-in d [:person :status] "active"))]
                                     (for [f fields :when (contains? (:person d) f)] (ops/assign f (get-in d [:person f])))))})
          (dsl/effect :roster-history (fn [d] {:person-id (:id d) :lines (:changed d) :by (:by d)})))
        (transition {:sova/feed :feed :cond (fn [_ d] (= "proposed" (:status d))) :target :proposed})
        (transition {:sova/feed :feed :cond (fn [_ d] (= "left" (:status d))) :target :left})
        (transition {:sova/feed :feed :target :active}))

      (state {:id :proposed}
        (entered "proposed")
        (dsl/act {:sova/feed :feed :event :person/approve :target :active :checks [decider-check not-waiting change-check]}
          (history-effect) (write))
        (dsl/act {:sova/feed :feed :event :person/decline :target :left :checks [decider-check not-waiting change-check]}
          (history-effect) (write))
        (dsl/act {:sova/feed :feed :event :person/leave :target :left :checks [change-check]}
          (history-effect) (write))
        (status-transitions "proposed"))

      (state {:id :active}
        (entered "active")
        (dsl/act {:sova/feed :feed :event :person/approve :checks [decider-check not-waiting]})
        (dsl/act {:sova/feed :feed :event :person/decline :checks [decider-check not-waiting]})
        (dsl/act {:sova/feed :feed :event :person/leave :target :left :checks [change-check]}
          (history-effect) (write))
        (status-transitions "active"))

      (state {:id :left}
        (entered "left")
        ;; The cascade's own part: every hand-off and owner link of theirs answers 410 at once.
        (on-entry {} (dsl/effect :revoke-person-links (fn [d] {:person-id (:id d)})))
        (dsl/act {:sova/feed :feed :event :person/approve :checks [decider-check not-waiting]})
        (dsl/act {:sova/feed :feed :event :person/decline :checks [decider-check not-waiting]})
        (status-transitions "left")))))

;; ---- the registry entry (engine/API.md §1) --------------------------------------------------------

(def acts
  "Acts and their metadata. `sova_roster` approve/decline is L2 for the overseer (never checked for
   the operator); the overseer's unattended approve reaches a person, so it is held (r4)."
  {:person/edit    {:needs nil}
   :person/approve {:needs "L2" :tool "sova_roster" :people-facing true :hold true :confirm-kind "roster-approve"
                    :what (fn [d] (str "Approving " (name-of d)))}
   :person/decline {:needs "L2" :tool "sova_roster" :people-facing true :hold true :confirm-kind "roster-decline"
                    :what (fn [d] (str "Declining " (name-of d)))}
   :person/leave   {:needs nil :people-facing true
                    :card (fn [d] {:people [(:id d)]})}
   :person/revert  {:needs nil :people-facing true
                    ;; a revert that sets left needs the global Overseer's card (F-033, F-185)
                    :card (fn [d] (let [{:keys [field from]} (:row (b/evt d))]
                                    (when (and (= "status" (some-> field name)) (= "left" from)) {:people [(:id d)]})))}
   :hold/cancel    {:needs "L0" :correction true}
   :hold/approve   {:needs "L0" :correction true}})

(defn not-here
  "An act with no transition in this configuration."
  [event config data]
  (case event
    (:person/approve :person/decline) (:sentence (not-waiting (assoc data :_event {:name event :data {}})))
    :person/leave (str (name-of data) " has already left.")
    "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:name :decides :referral :status :tz :hours]
   :acts     acts
   :not-here not-here
   :redact   {:contact :contact}})
