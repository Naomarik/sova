(ns sova.org-charts.charts.work-item
  "The work-item chart: one session per gap (`§gap/<name>`), from open to done.

   The item's position is derived from facts (its linked baton, decisions and build, projected by
   the host on `facts/changed`): every forward move is an eventless transition on a fact, so a
   restart re-derives where the item is. Acts (the LLM's event tools, the operator's clicks) only
   append effect intents to the outbox, behind the same guards and refusal sentences as today's
   tool wrapper, and move the item into a `…-starting` state until the facts catch up.

   Cross-cutting concerns are declared once: drop on :live, hold on :pipeline with deep
   history for resume, reopen on :promoted, and a stall clock per waiting phase feeding the
   orthogonal attention region."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :as chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel final history transition script on-entry In]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.common :as c :refer [evt all? none? effect effect-ops stall-clock tell-project]]
    [sova.org-charts.charts.facts :as f]
    [sova.org-charts.charts.guards :as g]))

;; ---- act checks: one list per act, used by the chart's :cond and by explain ----------------------

(def version
  "Bumped when a state id changes: a snapshot of another version needs a migration.
   2: :closed removed (an idea's done status no longer closes the item).
   3: the follow-up region (a gathering once the gap is deciding or promoted)."
  3)

(defn- level-check [tool need] (fn [data] (g/level-refusal tool need (evt data))))

(defn- invalid-check
  "The tool's own argument refusal (fields, roster, abilities, mode, folder…), which stays in the
   tool: the host passes its sentence as `:invalid`, checked where the tool checks it (after the level)."
  [data]
  (let [v (:invalid (evt data))] (when-not (g/blank? v) v)))

(defn- cap-check
  "An allowance/at-once check; never for the operator's own click (the caps bind the overseer's tools)."
  [kind n-fn]
  (fn [data]
    (let [e (evt data)]
      (when-not (g/operator-act? e) (g/cap-refusal kind e (n-fn data))))))

(defn- operator-check [what]
  (fn [data] (when-not (g/operator-act? (evt data)) (g/operator-only-refusal what))))

(defn promote-ids [data] (vec (distinct (map str (:ids (evt data))))))

(defn promote-verdicts
  "promoteDecisions' per-id refusals for this item's decisions: `[[id reason-or-nil] …]`. The
   overseer always promotes as `by: \"overseer\"`; the operator's page as explicit or bulk."
  [data]
  (let [e        (evt data)
        by       (cond (not (g/operator-act? e)) "overseer" (:bulk e) "operator-bulk" :else "operator-explicit")
        by-id    (into {} (map (juxt :id identity)) (:decisions data))]
    (for [id (promote-ids data)
          :let [row (by-id id)]]
      [id (cond
            (nil? row) "unknown decision"
            (not= "drafted" (:state row)) (str "it is " (:state row) "; only a reconciled (drafted) decision can be promoted")
            (and (not (:author-owns-area row)) (not= by "operator-explicit")) (str "outside " (or (:name row) "its author") "'s decision area: promote it explicitly by id")
            :else nil)])))

(defn- promote-check [data]
  (let [ids (promote-ids data)]
    (cond
      (empty? ids) "Give the ids to promote."
      :else
      (let [vs      (promote-verdicts data)
            refused (filter second vs)]
        (when (= (count refused) (count vs))
          (str "Promoted 0, refused " (count refused) ": "
            (str/join "; " (map (fn [[id why]] (str id " (" why ")")) refused)) "."))))))

(defn- close-check [data]
  (let [e (evt data) b (:baton data)]
    (cond
      (and (not (g/operator-act? e)) (g/blank? (:reason e))) "Say why you close it (reason)."
      (nil? b) "Not one of your gathering sessions."
      (g/operator-act? e) (when (= "closed" (:state b)) "This session is already closed.")
      (not (:own b)) "Not one of your gathering sessions."
      (:settle b) "That is a settle session: the conflict ends when it is settled."
      (f/baton-ended? data) (str "It is already " (:state b) ".")
      (:wrote b) "Someone it went to has already written in it."
      :else nil)))

(defn- prompt-check [data]
  (let [e (evt data) b (:build data)]
    (cond
      (nil? b) "No coding session for this item."
      (:live b) (str "\"" (:title b) "\" is open in a terminal, so it is read-only.")
      (= "removed" (:state b)) "Its worktree was removed, so it has no folder to work in."
      (g/blank? (:text e)) "text must not be blank."
      :else nil)))

(defn- merge-check [data]
  (let [b (:build data)]
    (cond
      (nil? b) "Unknown coding session of this project"
      (= "root" (:state b)) "It runs in the project root."
      (:running b) "The session is working."
      (pos? (or (:workers b) 0)) "Its workers are running."
      :else nil)))

(def checks
  "Per act, the checks in today's order; the first sentence refuses it."
  {:gap/status          [(level-check "sova_idea" "L0") invalid-check]
   :gather/start        [(level-check "sova_start_gathering" "L1") invalid-check (cap-check "gather" (constantly 1))]
   :gather/close        [(level-check "sova_close_gathering" "L1") invalid-check close-check]
   :decision/reconcile  [(level-check "sova_reconcile" "L1") invalid-check]
   :decision/promote    [(level-check "sova_promote" "L2") invalid-check
                         (fn [data] (when (empty? (promote-ids data)) "Give the ids to promote."))
                         (cap-check "promote" (comp count promote-ids)) promote-check]
   :decision/settle-text [(operator-check "keeps or restores a decision's words")]
   :build/start         [(level-check "sova_create_session" "L3") invalid-check
                         (fn [data] (when (and (not (g/operator-act? (evt data))) (g/blank? (:prompt (evt data)))) "prompt must not be blank."))
                         (cap-check "create" (constantly 1))]
   :build/prompt        [(level-check "sova_send" "L3") invalid-check prompt-check (cap-check "prompt" (constantly 1))]
   :build/merge         [(operator-check "merges a branch") invalid-check merge-check]
   :item/hold           [(operator-check "holds an item")]
   :item/resume         [(operator-check "resumes an item")]})

(defn refusal
  "The first refusal of act `event` under the current data, or nil."
  [event data]
  (some #(% data) (get checks event)))

(defn ok [event] (fn [_ data] (nil? (refusal event data))))

;; ---- small conditions -----------------------------------------------------------------------------

(defn status= [s] (fn [_ data] (= s (:status (evt data)))))
(defn effect-kind= [k] (fn [_ data] (= (name k) (:kind (evt data)))))
(defn- has-decisions? [_ data] (not= "none" (f/phase-of data)))
(defn- no-decisions? [_ data] (= "none" (f/phase-of data)))
(defn- baton-live? [_ data] (f/baton-live? data))
(defn- baton-ended? [_ data] (f/baton-ended? data))
(defn- no-baton? [_ data] (nil? (:baton data)))
(defn- has-build? [_ data] (some? (:build data)))
(defn- running? [_ data] (f/running? data))
(defn- failed? [_ data] (f/last-failed? data))
(defn- landed? [_ data] (f/landed? data))
(defn- all-built? [_ data] (boolean (f/all-built? (:decisions data))))
(defn- covers? [_ data] (f/covers? data))
(defn- new-build? [_ data] (and (some? (:build data)) (not= (get-in data [:build :session-id]) (:build-before data))))

(defn- attempt-ops [data] [(ops/assign :attempts (inc (:attempts data 0)))])

(defn- ended-without-decisions
  "The baton ended with no decision: back to open, one attempt used; a goal reached with nothing
   decided is news the project has no reason for today."
  [target-cond]
  (transition {:cond (all? target-cond baton-ended? no-decisions?) :target :open}
    (script {:expr (fn [_ data] (attempt-ops data))})
    (tell-project :item/answered-nothing (fn [data] {:session-id (get-in data [:baton :id]) :state (get-in data [:baton :state])}))))

(defn- dphase-routes
  "The eventless routes between the deciding children, except to `self`."
  [self]
  (for [[phase target] [["pending" :unreconciled] ["conflict" :conflicted] ["drafted" :drafted] ["edited" :spec-edited]]
        :when (not= target self)]
    (transition {:cond (f/dphase= phase) :target target})))

(defn- prompt-transition []
  (transition {:event :build/prompt :cond (ok :build/prompt)}
    (effect :prompt (fn [d] {:session-id (get-in d [:build :session-id]) :text (:text (evt d))}))))

(defn- gather-transition
  "gather/start: a gathering for this gap (the first, a follow-up, or one replacing a live one);
   the facts of the baton it had are not the new one's."
  []
  (transition {:event :gather/start :cond (ok :gather/start) :target :gather-starting}
    (script {:expr (fn [_ data] [(ops/assign :baton-before (get-in data [:baton :id]))])})
    (effect :start-gathering (fn [d] (let [e (evt d)]
                                       {:gap (:item-id d) :to (:to e) :public-title (:public-title e)
                                        :question (:question e) :goal (:goal e)})))))

(def follow-up-lane
  "A gathering started once the gap is deciding or promoted is a follow-up: the lane keeps following
   the decisions and the build (real-26: a follow-up gathering ran while the build merged)."
  (fn [env data] (boolean (or ((In :deciding) env data) ((In :promoted) env data)))))

(defn- follow-up-transition
  "gather/start as a follow-up (or one replacing a live follow-up). Its effect is the lane's: the
   host starts a gathering the same way, and the chart alone knows it is a follow-up."
  []
  (transition {:event :gather/start :cond (all? follow-up-lane (ok :gather/start)) :target :follow-up-starting}
    (script {:expr (fn [_ data] [(ops/assign :baton-before (get-in data [:baton :id]))])})
    (effect :start-gathering (fn [d] (let [e (evt d)]
                                       {:gap (:item-id d) :to (:to e) :public-title (:public-title e)
                                        :question (:question e) :goal (:goal e)})))))

(defn- follow-up-close
  "gather/close on the follow-up's session; not while the item is on hold (only the operator's
   resume, and the idea status, apply then)."
  []
  (transition {:event :gather/close :cond (all? (none? (In :on-hold)) (ok :gather/close))}
    (effect :close-gathering (fn [d] {:session-id (get-in d [:baton :id]) :reason (:reason (evt d))}))))

(defn- landed-transition []
  ;; Not while it works: a branch merged by hand mid-turn waits for the turn to end.
  (transition {:cond (all? landed? (none? running?)) :target :merged}))

;; ---- the chart ---------------------------------------------------------------------------------------

(def pipeline-phases
  "The atomic states of the lane, in document order (the tests enumerate them)."
  [:open :gather-starting :asking :needs-operator
   :unreconciled :conflicted :drafted :spec-edited
   :awaiting-build :build-starting :working :idle :failed :merged :done
   :on-hold])

(def stall-phases
  "The phases with a stall clock: every waiting phase (not working, done or on hold)."
  #{:open :gather-starting :asking :needs-operator :unreconciled :conflicted :drafted :spec-edited
    :awaiting-build :build-starting :idle :failed :merged
    :follow-up-asking :follow-up-needs-operator})

(def follow-up-states
  [:no-follow-up :follow-up-starting :follow-up-asking :follow-up-needs-operator])

(defn- mark
  "On entry, note the lane's phase (read by transitions that leave it, after it is exited)."
  [phase]
  (on-entry {} (script {:expr (fn [_ _] [(ops/assign :phase (name phase))])})))

(defn- dropped-from-ops
  "Where the pipeline was when the gap was dropped."
  [_ data]
  [(ops/assign :dropped-from (:phase data))])

(def chart
  (statechart {:initial :item}
    (state {:id :item :initial :live}
      (parallel {:id :live}
        ;; Facts land first, from anywhere live (targetless: nothing is exited).
        (transition {:event :facts/changed}
          (script {:expr (fn [_ data] (f/take-facts data))}))
        ;; Idea status (sova_idea status, L0). Dropped is final. Every other status is the idea
        ;; list's own and is only recorded: a gap is "a decision the project needs that nobody has
        ;; made" (§app.project-overseer/gaps), so done means answered, and the work built on its
        ;; decisions goes on; the item ends only at :done (built) or :dropped.
        (transition {:event :gap/status :cond (all? (status= "dropped") (ok :gap/status)) :target :dropped}
          (script {:expr dropped-from-ops})
          (effect :idea-status (fn [_] {:status "dropped"})))
        (transition {:event :gap/status :cond (ok :gap/status)}
          (script {:expr (fn [_ data] [(ops/assign :idea-status (:status (evt data)))])})
          (effect :idea-status (fn [d] {:status (:status (evt d))})))

        ;; ── Region 1: where the gap is ─────────────────────────────────────────────────────────
        (state {:id :lane :initial :pipeline}
          (state {:id :pipeline :initial :open}
            (history {:id :pipeline-h :type :deep} :open)
            (transition {:event :item/hold :cond (ok :item/hold) :target :on-hold})
            ;; Reconcile and promote wherever the item is in its pipeline: a drafted decision is
            ;; promotable while a follow-up gathering is in flight (real-26). Promote's own check
            ;; refuses when none of the ids is a drafted decision of this item.
            (transition {:event :decision/reconcile :cond (ok :decision/reconcile)}
              (effect :reconcile (constantly {})))
            (transition {:event :decision/promote :cond (ok :decision/promote)}
              (effect :promote (fn [d] {:ids (vec (keep (fn [[id why]] (when-not why id)) (promote-verdicts d)))
                                        :by  (if (g/operator-act? (evt d)) (if (:bulk (evt d)) "operator-bulk" "operator-explicit") "overseer")})))

            (state {:id :open} (mark :open)
              (stall-clock :open)
              ;; A gathering linked to the gap by any path (the tool, Send to person…) moves it.
              (transition {:cond (f/baton= "open") :target :asking})
              (transition {:cond (f/baton= "needs-you") :target :needs-operator})
              (transition {:cond (all? (none? baton-live?) has-decisions?) :target :deciding})
              (gather-transition))

            (state {:id :gathering :initial :gather-starting}
              (transition {:event :gather/close :cond (ok :gather/close)}
                (effect :close-gathering (fn [d] {:session-id (get-in d [:baton :id]) :reason (:reason (evt d))})))

              (state {:id :gather-starting} (mark :gather-starting)
                (stall-clock :gather-starting)
                (transition {:event :effect/failed :cond (effect-kind= :start-gathering) :target :open})
                (transition {:cond (all? f/new-baton? (f/baton= "open")) :target :asking})
                (transition {:cond (all? f/new-baton? (f/baton= "needs-you")) :target :needs-operator})
                (transition {:cond (all? f/new-baton? baton-ended? has-decisions?) :target :deciding})
                (ended-without-decisions f/new-baton?))

              (state {:id :asking} (mark :asking)
                (stall-clock :asking)
                (gather-transition)
                (transition {:cond (f/baton= "needs-you") :target :needs-operator})
                (transition {:cond (all? baton-ended? has-decisions?) :target :deciding})
                (ended-without-decisions (constantly true))
                (transition {:cond no-baton? :target :open}))

              (state {:id :needs-operator} (mark :needs-operator)
                (stall-clock :needs-operator)
                (gather-transition)
                (transition {:cond (f/baton= "open") :target :asking})
                (transition {:cond (all? baton-ended? has-decisions?) :target :deciding})
                (ended-without-decisions (constantly true))
                (transition {:cond no-baton? :target :open})))

            (state {:id :deciding :initial :unreconciled}
              (transition {:cond (f/dphase= "promoted") :target :promoted})
              (state {:id :unreconciled} (mark :unreconciled) (stall-clock :unreconciled) (dphase-routes :unreconciled))
              (state {:id :conflicted} (mark :conflicted) (stall-clock :conflicted) (dphase-routes :conflicted))
              (state {:id :drafted} (mark :drafted) (stall-clock :drafted) (dphase-routes :drafted))
              (state {:id :spec-edited} (mark :spec-edited)
                (stall-clock :spec-edited)
                (dphase-routes :spec-edited)
                (transition {:event :decision/settle-text :cond (ok :decision/settle-text)}
                  (effect :settle-text (fn [d] {:action (:action (evt d))
                                                :ids    (vec (map :id (filter :edited-in-spec (:decisions d))))})))))

            (state {:id :promoted :initial :awaiting-build}
              ;; A superseding or new decision, or a spec edit, reopens the item from any promoted child.
              (transition {:cond (f/dphase= "pending" "conflict" "drafted" "edited") :target :deciding}
                (tell-project :item/reopened (fn [d] {:dphase (f/phase-of d)})))

              (state {:id :awaiting-build} (mark :awaiting-build)
                (stall-clock :awaiting-build)
                ;; A build linked to the gap that covers its promoted decisions (any path: the tool,
                ;; Start coding session…) moves it.
                (transition {:cond (all? has-build? covers?) :target :building}
                  (script {:expr (fn [_ _] [(ops/assign :build-before nil)])}))
                (transition {:event :build/start :cond (ok :build/start) :target :build-starting}
                  (script {:expr (fn [_ data] [(ops/assign :build-before (get-in data [:build :session-id]))])})
                  (effect :start-coding (fn [d] {:gap       (:item-id d) :prompt (:prompt (evt d)) :title (:title (evt d))
                                                 :decisions (vec (map :id (filter #(= "promoted" (:state %)) (:decisions d))))}))))

              (state {:id :building :initial :build-starting}
                (transition {:event :build/merge :cond (ok :build/merge)}
                  (effect :merge (fn [d] {:session-id (get-in d [:build :session-id])})))

                (state {:id :build-starting} (mark :build-starting)
                  (stall-clock :build-starting)
                  (transition {:event :effect/failed :cond (effect-kind= :start-coding) :target :awaiting-build})
                  (transition {:cond (all? new-build? running?) :target :working})
                  (transition {:cond (all? new-build? (none? running?) failed?) :target :failed})
                  (transition {:cond (all? new-build? (none? running?)) :target :idle}))

                (state {:id :working} (mark :working)
                  (landed-transition)
                  (transition {:cond (all? (none? running?) failed?) :target :failed})
                  (transition {:cond (none? running?) :target :idle})
                  (prompt-transition))

                (state {:id :idle} (mark :idle)
                  (stall-clock :idle)
                  (landed-transition)
                  (transition {:cond running? :target :working})
                  (transition {:cond failed? :target :failed})
                  (prompt-transition))

                (state {:id :failed} (mark :failed)
                  (stall-clock :failed)
                  (landed-transition)
                  (transition {:cond running? :target :working})
                  (transition {:cond (none? failed?) :target :idle})
                  (prompt-transition)))

              (state {:id :merged} (mark :merged)
                (stall-clock :merged)
                (transition {:cond all-built? :target :done}
                  (tell-project :item/built (fn [_] {})))
                ;; A decision promoted since that this build does not cover: it needs its own.
                (transition {:cond (all? has-build? (none? covers?)) :target :awaiting-build})
                (transition {:cond running? :target :working})
                (transition {:cond (all? has-build? (none? landed?) failed?) :target :failed})
                (transition {:cond (all? has-build? (none? landed?)) :target :idle})
                (transition {:event :build/start :cond (ok :build/start) :target :build-starting}
                  (script {:expr (fn [_ data] [(ops/assign :build-before (get-in data [:build :session-id]))])})
                  (effect :start-coding (fn [d] {:gap       (:item-id d) :prompt (:prompt (evt d)) :title (:title (evt d))
                                                 :decisions (vec (map :id (filter #(= "promoted" (:state %)) (:decisions d))))}))))

              (state {:id :done} (mark :done)
                (transition {:cond (none? all-built?) :target :merged}))))

          (state {:id :on-hold} (mark :on-hold)
            (transition {:event :item/resume :cond (ok :item/resume) :target :pipeline-h})))

        ;; ── Region 2: a follow-up gathering, beside the lane ──────────────────────────────────
        ;; Its baton is the item's latest (the facts' :baton); its decisions join the item's and
        ;; move the lane through the facts (reopen, promote), whatever the gathering does.
        (state {:id :follow-up :initial :no-follow-up}
          (state {:id :no-follow-up}
            (follow-up-transition))
          (state {:id :follow-up-starting}
            (transition {:event :effect/failed :cond (effect-kind= :start-gathering) :target :no-follow-up})
            (transition {:cond (all? f/new-baton? (f/baton= "open")) :target :follow-up-asking})
            (transition {:cond (all? f/new-baton? (f/baton= "needs-you")) :target :follow-up-needs-operator})
            (transition {:cond (all? f/new-baton? baton-ended?) :target :no-follow-up}))
          (state {:id :follow-up-asking}
            (stall-clock :follow-up-asking)
            (follow-up-transition)
            (follow-up-close)
            (transition {:cond (f/baton= "needs-you") :target :follow-up-needs-operator})
            (transition {:cond (none? baton-live?) :target :no-follow-up}))
          (state {:id :follow-up-needs-operator}
            (stall-clock :follow-up-needs-operator)
            (follow-up-transition)
            (follow-up-close)
            (transition {:cond (f/baton= "open") :target :follow-up-asking})
            (transition {:cond (none? baton-live?) :target :no-follow-up})))

        ;; ── Region 3: attention: any phase that sits too long ─────────────────────────────────
        (state {:id :attention :initial :calm}
          (state {:id :calm}
            (transition {:event :item/stalled
                         :cond  (fn [env data] (let [p (keyword (:phase (evt data)))]
                                                 (and (contains? stall-phases p) ((In p) env data))))
                         :target :stalled}
              (tell-project :item/stalled (fn [d] {:phase (:phase (evt d)) :since (:since (evt d))}))))
          (state {:id :stalled}
            (transition {:event :item/moved :target :calm}))))

      ;; Final, but nested: the session keeps running with [:item :dropped] so it can be shown.
      (final {:id :dropped}))))

;; ---- what the LLM and the operator may fire ------------------------------------------------------------

(def acts
  "The act events (LLM event tools and operator clicks), in the order the tests enumerate them."
  [:gap/status :gather/start :gather/close :decision/reconcile :decision/promote :decision/settle-text
   :build/start :build/prompt :build/merge :item/hold :item/resume])

(def host-events
  [:facts/changed :effect/failed :item/stalled :item/moved])

(def all-events (into acts host-events))

;; ---- explain: why an act would not be taken ------------------------------------------------------------

(defn declared-events
  "The events some transition of an active state (or its ancestors) names: the acts this
   configuration can take at all, guards aside."
  [config]
  (set (for [s  (if (some #{:deciding :promoted} config) config (remove (set follow-up-states) config))
             t  (chart/transitions chart s)
             :let [ev (:event (chart/element chart t))]
             :when ev
             e  (if (keyword? ev) [ev] ev)]
         e)))

(def where
  {:gap/status "anywhere until it is dropped"
   :gather/start "while the gap is open or gathering, and once it is deciding or promoted as a follow-up (not while one is starting)"
   :gather/close "while its gathering (or follow-up) session is open or waiting on the operator"
   :decision/reconcile "anywhere in its pipeline (not on hold)"
   :decision/promote "anywhere in its pipeline (not on hold), for its drafted decisions"
   :decision/settle-text "when a promoted decision was edited in the spec"
   :build/start "once its decisions are promoted, before a build or after a merge"
   :build/prompt "while its coding session exists"
   :build/merge "while its coding session is building"
   :item/hold "while it is in the pipeline"
   :item/resume "while it is on hold"})

(defn phase
  "The lane's atomic state, or :dropped."
  [config]
  (or (some #(when (contains? config %) %) pipeline-phases)
      (when (contains? config :dropped) :dropped)))

(def dropped-refusal "This idea was dropped; dropped is final. File a new idea instead.")

(defn explain
  "The sentence an act gets when the chart would not take it: dropped (final), not an act this
   phase has, or the first failing guard (today's wording). `config` the active states, `data` the
   session's data model, `envelope` the act's event data; nil when the guards pass."
  [{:keys [config data running?]} event envelope]
  (cond
    (or (false? running?) (contains? config :dropped)) dropped-refusal
    (and (contains? config :on-hold) (not (#{:gap/status :item/resume} event)))
    (str (:item-id data) " is on hold: only the operator resumes it.")
    (not (contains? (declared-events config) event))
    (str (:item-id data) " is " (name (phase config)) ": " (namespace event) "/" (name event)
      " applies " (get where event "elsewhere") ".")
    :else (refusal event (assoc data :_event {:name event :data envelope}))))

(defmethod g/explain* :work-item [_ event data envelope]
  (explain {:config (:sova/configuration data) :data data :running? (:sova/running? data true)} event envelope))
