(ns sova.org-charts.charts.project
  "The project chart: one session per org project whose overseer conversation exists. Five
   orthogonal regions: whether an attach on this host paused it, whether the project is archived,
   the operator's Watch switch, the watch loop (quiet → waiting → due → held | running, the look
   bound to :running as the :sova/look invocation), and the day clock (local midnight: the looks
   per day reset, held items released).

   Mirrors server/project-overseer.ts: noteReason/withReason (reasons, soonAt), watchDecision (the
   gates), lookNow (Run Now, skipped runs, held looks), recordRunEnd/sweepCutOffRuns (how a run
   ended), releaseHeld/releaseRaised (held items). Differences are listed in CHARTS.md."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel raise invoke In]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.common :as c :refer [evt all? none?]]
    [sova.org-charts.charts.guards :as g]
    [sova.org-charts.charts.reasons :as r]))

(def version
  "Bumped when a state id changes: a snapshot of another version needs a migration."
  1)

(def watch-prefix "[project watch]")
(def cut-off-detail "The server restarted during the run.")
(def tick-ms 20000)
(def held-max 10)
(def pending-max 50)

(def default-settings
  {:autonomy "L1" :watch true :watch-gap-min 10 :soon-look-sec 60
   :caps {:gather-per-turn 3 :promote-per-turn 20 :create-per-turn 2 :prompts-per-turn 5
          :gather-per-day 6 :promote-per-day 60 :create-per-day 4 :prompts-per-day 12
          :unattended-per-day 12 :gatherings-open 5 :coding-running 2}})

(defn settings [data] (merge-with #(if (map? %1) (merge %1 %2) %2) default-settings (:settings data)))
(defn per-day [data] (get-in (settings data) [:caps :unattended-per-day]))

(defn watch-text
  "watchText(reasons, autonomy), verbatim."
  [reasons autonomy]
  (let [lst (if (seq reasons)
              (str/join "\n" (map #(str "- " %) (take-last 20 reasons)))
              "- (the operator asked for a look)")]
    (str watch-prefix " Since your last look:\n" lst "\n\n"
      "Re-read the project (sova_project, and sova_decisions where it matters). Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…). "
      "Then act within your autonomy (" autonomy "): the tools tell you when something needs a higher level. Keep your reply to a few lines for the operator.")))

(defn effective [data]
  (g/effective-autonomy {:autonomy (:autonomy (settings data)) :paused (:paused data) :roster-active (:roster-active data)}))

;; ---- reasons -------------------------------------------------------------------------------------

(defn incoming
  "The reasons an event carries: one (`{:kind :params :text :key :by}`) or a batch (`:reasons`)."
  [data]
  (let [e (evt data)]
    (if (contains? e :reasons) (vec (:reasons e)) [e])))

(defn dropped-own?
  "noteReason's `own && isStreaming`: a reconciler event dropped while the overseer's session
   streams. When the reason names who acted (`:by`), only the overseer's own act is dropped (R3)."
  [data reason]
  (and (r/own? reason)
       (true? (:streaming data))
       (contains? #{nil "overseer"} (:by reason))))

(defn kept [data] (remove #(dropped-own? data %) (incoming data)))

(defn keep-reason? [_ data] (boolean (seq (kept data))))

(defn with-reason
  "withReason: the reason waiting (deduped), and `soon-at` set by the first reason to look soon
   since the last look (unless the soon look is Off)."
  [data reason now]
  (let [pending (vec (:reasons data))
        k       (r/dedupe-key reason)
        row     {:kind (:kind reason) :text (r/text reason) :key k :at now :soon (boolean (r/soon? reason))
                 :params (:params reason) :by (:by reason)}
        pending (if (some #(= k (:key %)) pending) pending (vec (take-last pending-max (conj pending row))))
        soon-s  (:soon-look-sec (settings data))
        soon-at (if (and (r/soon? reason) (some? soon-s) (nil? (:soon-at data))) (+ now (* 1000 soon-s)) (:soon-at data))]
    (assoc data :reasons pending :soon-at soon-at)))

(defn add-reasons-ops [data]
  (let [now (c/now-ms data)
        d   (reduce #(with-reason %1 %2 now) data (kept data))]
    [(ops/assign :now now) (ops/assign :reasons (:reasons d)) (ops/assign :soon-at (:soon-at d))]))

(defn add-reasons [] (script {:expr (fn [_ data] (add-reasons-ops data))}))

(defn log-dropped-ops [data]
  (let [gone (filter #(dropped-own? data %) (incoming data))]
    (when (seq gone)
      (c/log-ops data {:event "reason/noted" :dropped (vec (map r/text gone)) :why "own act while busy"}))))

(defn texts [rows] (vec (map :text rows)))

;; ---- the gates (watchDecision) ---------------------------------------------------------------------

(defn idle?
  "lookNow's idle: the overseer's session is not streaming and has nothing queued."
  [_ data]
  (and (not (:streaming data)) (zero? (or (:queued data) 0))))
(defn looks-left? [_ data] (let [cap (per-day data)] (or (nil? cap) (< (:looks-today data 0) cap))))
(def live? (In :live))
(def active? (In :active))
(def watch-on? (In :watch-on))

(def may-look
  "An unattended look now: not paused, not archived, watching on, an idle overseer, looks left."
  (all? live? active? watch-on? idle? looks-left?))

(def looks-used
  "Everything but the looks per day allows a look."
  (all? live? active? watch-on? idle? (none? looks-left?)))

(defn on-tick
  "The first watch tick at or after `t`: today's loop looks only on its 20 s ticker
   (WATCH_TICK_MS, phased from the server's start: `:tick-origin`), so reasons noted within a tick
   join one look. `:tick-ms` 0 looks at the exact due time."
  [data t]
  (let [tick   (get data :tick-ms tick-ms)
        origin (or (:tick-origin data) 0)]
    (if (and tick (pos? tick))
      (let [k (quot (- t origin) tick)
            b (+ origin (* k tick))]
        (if (< b t) (+ b tick) b))
      t)))

(defn due-at
  "When the next look on its own may start: `soon-at`, else the gap after the last look started;
   never before a failed start's retry; on the tick at or after that."
  [data]
  (let [gap  (+ (or (:last-run-at data) 0) (* 60000 (:watch-gap-min (settings data))))
        soon (:soon-at data)]
    (on-tick data (max (if soon (min soon gap) gap) (or (:retry-at data) 0) (c/now-ms data)))))

(defn due-in [_ data] (max 0 (- (due-at data) (c/now-ms data))))

(defn daily-why [data] (str "the daily limit of " (per-day data) " unattended runs is reached"))

(defn run-now-refusal
  "lookNow(force)'s refusals, in its order: archived, busy, the daily limit."
  [env data]
  (cond
    ((In :archived) env data) "the project is archived"
    ((In :running) env data) "busy"
    (not (idle? env data)) "busy"
    (not (looks-left? env data)) (daily-why data)
    :else nil))

(defn- looks-held-item [data now]
  {:key "looks" :what "looks" :why (str "Today's " (per-day data) " looks on its own are used.")
   :since now :retry-at (c/next-midnight now)})

(defn hold-item
  "holdItem: add or replace the item with this key (the first refusal's time kept); at most 10."
  [held item]
  (let [prev (some #(when (= (:key item) (:key %)) %) held)]
    (vec (take-last held-max (conj (vec (remove #(= (:key item) (:key %)) held))
                               (assoc item :since (or (:since prev) (:since item))))))))

(defn skip-ops
  "A skipped run recorded (lastRun skipped), with the looks held until midnight when the daily
   limit refused it."
  [env data why]
  (let [now   (c/now-ms data)
        daily (= why (daily-why data))]
    (cond-> [(ops/assign :now now)
             (ops/assign :last-run {:at now :reasons (texts (:reasons data)) :outcome "skipped" :detail why})]
      daily (conj (ops/assign :held (hold-item (:held data) (looks-held-item data now)))))))

;; ---- runs -----------------------------------------------------------------------------------------

(defn start-run-ops [data]
  (let [now (c/now-ms data)]
    [(ops/assign :now now)
     (ops/assign :run-reasons (:reasons data))
     (ops/assign :before-run (select-keys data [:last-run-at :looks-today :soon-at]))
     (ops/assign :reasons [])
     (ops/assign :soon-at nil)
     (ops/assign :retry-at nil)
     (ops/assign :last-run-at now)
     (ops/assign :looks-today (inc (:looks-today data 0)))
     (ops/assign :last-run {:at now :reasons (texts (:reasons data)) :outcome "started"})]))

(defn requeue
  "The run's reasons back in front of those noted since (a stopped or cut-off run loses none, R2)."
  [data]
  (let [later (:reasons data)
        keys  (set (map :key later))]
    (vec (take-last pending-max (concat (remove #(keys (:key %)) (:run-reasons data)) later)))))

(defn end-run-ops [data outcome detail]
  (let [now (c/now-ms data)]
    (cond-> [(ops/assign :now now)
             (ops/assign :last-run (cond-> (assoc (:last-run data) :outcome outcome) detail (assoc :detail detail)))]
      (not= outcome "finished") (conj (ops/assign :reasons (requeue data)))
      true (conj (ops/assign :run-reasons [])))))

(defn not-started-ops
  "lookNow's catch: the run never started; lastRun skipped with why, nothing counted, retried at
   the next tick at the earliest."
  [data]
  (let [now (c/now-ms data)
        b   (:before-run data)]
    [(ops/assign :now now)
     (ops/assign :last-run {:at now :reasons (texts (:run-reasons data)) :outcome "skipped" :detail (:detail (evt data))})
     (ops/assign :last-run-at (:last-run-at b))
     (ops/assign :looks-today (:looks-today b 0))
     (ops/assign :soon-at (:soon-at b))
     (ops/assign :retry-at (+ now 1))
     (ops/assign :reasons (requeue data))
     (ops/assign :run-reasons [])]))

;; ---- held items and the day clock ---------------------------------------------------------------------

(defn released-reason
  "releaseHeld's reason for a held item whose time came."
  [{:keys [key what since]}]
  (let [[ledger kind] (str/split key #":")]
    (cond
      (= key "looks") {:kind "held/looks" :params {:at since} :by "system"}
      (= ledger "day") {:kind "held/day" :params {:kind kind :at since} :by "system"}
      (= ledger "message") {:kind "held/message" :params {:what what} :by "system"}
      :else nil)))

(defn release-due-ops
  "Held items whose time has come leave the list; their reasons wait in `:releasing`. Only while
   the project is neither paused nor archived (`open?`): today's tick skips those, so what they
   hold waits until the pause or the archive ends."
  [data now open?]
  (let [due (if open? (filter #(and (some? (:retry-at %)) (<= (:retry-at %) now)) (:held data)) [])]
    [(ops/assign :held (vec (remove (set due) (:held data))))
     (ops/assign :releasing (vec (keep released-reason due)))]))

(defn open?
  "Neither paused by an attach nor archived."
  [env data]
  (and ((In :live) env data) ((In :active) env data)))

(def tool-kind
  {"sova_start_gathering" "gather" "sova_offer" "gather" "sova_promote" "promote"
   "sova_create_session" "create" "sova_send" "prompt"})

(defn act-refusal
  "An item-less tool call (`overseer/act {tool, op?, n?}`): the level (TOOL_NEEDS, roster ops at
   L2), the tool's own argument refusal (`:invalid`), then the at-once limit and the allowance for
   the kind it counts, in the tool's order. Nil when it may run."
  [envelope]
  (let [{:keys [tool op n invalid]} envelope
        kind (tool-kind tool)]
    (or (g/tool-refusal tool envelope op)
        (when-not (g/blank? invalid) invalid)
        (when kind
          (or (when (#{"gather" "create"} kind) (some-> (g/at-once-refusal envelope kind) ((fn [{:keys [said tail]}] (str said " " tail)))))
              (some-> (g/over-allowance envelope kind (or n 1)) g/over-refusal ((fn [{:keys [said tail]}] (str said " " tail)))))))))

(defn raise-released []
  (raise {:event :reason/noted :data (fn [_ d] {:reasons (:releasing d) :by "system"})}))

(defn refused-item
  "A tool's allowance refusal as the held item overRefusal records."
  [e now]
  (let [what (g/limit-what (:kind e))]
    (if (= "day" (:ledger e))
      {:key (str "day:" (:kind e)) :what what :why (str "Today's allowance is used: " (:used e) " of " (:max e) " " what " on its own.")
       :since now :retry-at (c/next-midnight now)}
      {:key (str "message:" (:kind e)) :what what :why (str "This message's allowance is used: " (:used e) " of " (:max e) " " what ".")
       :since now :retry-at now})))

(def per-day-key {"gather" :gather-per-day "promote" :promote-per-day "create" :create-per-day "prompt" :prompts-per-day})
(def per-turn-key {"gather" :gather-per-turn "promote" :promote-per-turn "create" :create-per-turn "prompt" :prompts-per-turn})

(defn raised-keys
  "releaseRaised: the held keys a settings change raised (a larger number, or Unlimited)."
  [before after]
  (let [raised? (fn [a b] (and (some? a) (or (nil? b) (> b a))))
        cb      (:caps before) ca (:caps after)]
    (into {}
      (concat
        (for [[k dk] per-day-key :when (and (contains? ca dk) (raised? (get cb dk) (get ca dk)))] [(str "day:" k) (g/limit-what k)])
        (for [[k tk] per-turn-key :when (and (contains? ca tk) (raised? (get cb tk) (get ca tk)))] [(str "message:" k) (g/limit-what k)])
        (when (and (contains? ca :unattended-per-day) (raised? (:unattended-per-day cb) (:unattended-per-day ca))) [["looks" "looks"]])))))

(defn settings-ops [data]
  (let [e      (evt data)
        before (settings data)
        patch  (select-keys e [:autonomy :watch :watch-gap-min :soon-look-sec :caps])
        after  (merge-with #(if (map? %1) (merge %1 %2) %2) before patch)
        keys   (raised-keys before after)
        freed  (filter #(contains? keys (:key %)) (:held data))]
    [(ops/assign :now (c/now-ms data))
     (ops/assign :settings after)
     (ops/assign :held (vec (remove (set freed) (:held data))))
     (ops/assign :releasing (vec (for [h freed] {:kind "held/raised" :params {:what (get keys (:key h))} :by "system"})))]))

(defn ms-to-midnight [_ data] (let [now (c/now-ms data)] (max 0 (- (c/next-midnight now) now))))

;; ---- the chart -------------------------------------------------------------------------------------

(def chart
  (statechart {:initial :project}
    (parallel {:id :project}
      ;; Facts, from anywhere (targetless; each region reads them).
      (transition {:event :overseer/busy} (script {:expr (fn [_ d] [(ops/assign :streaming true) (ops/assign :now (c/now-ms d))])}))
      (transition {:event :overseer/idle} (script {:expr (fn [_ d] [(ops/assign :streaming false) (ops/assign :queued 0) (ops/assign :now (c/now-ms d))])}))
      ;; An item-less tool call, judged by the same rules (recorded; its effect is the tool's own).
      ;; A refused one is not taken (trial answers with explain's sentence).
      (transition {:event :overseer/act :cond (fn [_ d] (nil? (act-refusal (evt d))))}
        (script {:expr (fn [_ d] (c/log-ops d {:event "overseer/act" :tool (:tool (evt d)) :verdict "ok"}))}))
      (transition {:event :org/attached-here} (script {:expr (fn [_ _] [(ops/assign :paused true)])}))
      (transition {:event :operator/level-set}
        (script {:expr (fn [_ d] [(ops/assign :paused false)
                                  (ops/assign :settings (assoc (:settings d) :autonomy (or (:autonomy (evt d)) (:autonomy (settings d)))))])}))
      (transition {:event :project/archived} (script {:expr (fn [_ _] [(ops/assign :archived true)])}))
      (transition {:event :project/unarchived} (script {:expr (fn [_ _] [(ops/assign :archived false)])}))
      (transition {:event :facts/changed}
        (script {:expr (fn [_ d] (let [e (evt d)]
                                   (cond-> [(ops/assign :now (c/now-ms d))]
                                     (contains? e :roster-active) (conj (ops/assign :roster-active (:roster-active e)))
                                     (contains? e :streaming) (conj (ops/assign :streaming (:streaming e)))
                                     (contains? e :queued) (conj (ops/assign :queued (:queued e))))))}))
      (transition {:event :settings/changed}
        (script {:expr (fn [_ d] (settings-ops d))})
        (raise-released))
      (transition {:event :limit/refused}
        (script {:expr (fn [_ d] (let [now (c/now-ms d)]
                                   (into [(ops/assign :now now)
                                          (ops/assign :held (hold-item (:held d) (refused-item (evt d) now)))]
                                     ;; the message allowance's item is due at once
                                     [])))})
        (script {:expr (fn [env d] (release-due-ops d (c/now-ms d) (open? env d)))})
        (raise-released))

      ;; ── Region 1: paused by an attach on this host ───────────────────────────────────────────
      ;; Leaving a pause or an archive releases what came due meanwhile (today's next tick).
      (state {:id :attach :initial :live}
        (state {:id :live} (transition {:cond (fn [_ d] (true? (:paused d))) :target :paused}))
        (state {:id :paused}
          (transition {:cond (fn [_ d] (not (:paused d))) :target :live}
            (script {:expr (fn [env d] (release-due-ops d (c/now-ms d) ((In :active) env d)))})
            (raise-released))))

      ;; ── Region 2: archived ────────────────────────────────────────────────────────────────────
      (state {:id :archive :initial :active}
        (state {:id :active} (transition {:cond (fn [_ d] (true? (:archived d))) :target :archived}))
        (state {:id :archived}
          (transition {:cond (fn [_ d] (not (:archived d))) :target :active}
            (script {:expr (fn [env d] (release-due-ops d (c/now-ms d) ((In :live) env d)))})
            (raise-released))))

      ;; ── Region 3: the Watch switch ──────────────────────────────────────────────────────────────
      (state {:id :switch :initial :watch-on}
        (state {:id :watch-on} (transition {:cond (fn [_ d] (false? (:watch (settings d)))) :target :watch-off}))
        (state {:id :watch-off} (transition {:cond (fn [_ d] (not (false? (:watch (settings d))))) :target :watch-on})))

      ;; ── Region 4: the watch loop ────────────────────────────────────────────────────────────────
      (state {:id :watch :initial :quiet}
        ;; A reason while due, held or running: it waits for the next look.
        (transition {:event :reason/noted :cond keep-reason?} (add-reasons))
        (transition {:event :reason/noted :cond (none? keep-reason?)} (script {:expr (fn [_ d] (log-dropped-ops d))}))
        ;; Run Now: skips the reasons, the gap and the Watch switch, never the looks per day, a busy
        ;; overseer or an archived project; a refusal is recorded as a skipped run.
        (transition {:event :operator/run-now :cond (fn [env d] (nil? (run-now-refusal env d))) :target :running})
        (transition {:event :operator/run-now}
          (script {:expr (fn [env d] (skip-ops env d (run-now-refusal env d)))}))

        (state {:id :quiet}
          (transition {:event :reason/noted :cond keep-reason? :target :waiting} (add-reasons)))

        (state {:id :waiting}
          (on-entry {} (Send {:id :due-timer :event :watch/due :delayexpr due-in}))
          (on-exit {} (cancel {:sendid :due-timer}))
          ;; External self-transitions: the exit cancels the timer, the entry re-arms it.
          (transition {:event :reason/noted :cond keep-reason? :target :waiting} (add-reasons))
          (transition {:event :settings/changed :target :waiting})
          (transition {:event :watch/due :target :due}))

        ;; Eventless: re-checked after every event (pause, archive, the switch, busy, the looks).
        (state {:id :due}
          (transition {:cond may-look :target :running})
          (transition {:cond looks-used :target :held}))

        ;; Left by the reason that frees it (midnight's "Today's looks are back", a raised limit), so
        ;; that reason is in the look, as releaseHeld runs before lookNow in today's tick.
        (state {:id :held}
          (on-entry {} (script {:expr (fn [env d] (skip-ops env d (daily-why d)))}))
          (transition {:event :reason/noted :cond (all? keep-reason? looks-left?) :target :due} (add-reasons)))

        (state {:id :running}
          (on-entry {} (script {:expr (fn [_ d] (start-run-ops d))}))
          (invoke {:id     :look
                   :type   :sova/look
                   :params (fn [_ d] (let [eff (effective d)]
                                       {:reasons  (texts (:run-reasons d))
                                        :autonomy (:autonomy eff)
                                        :text     (watch-text (texts (:run-reasons d)) (:autonomy eff))
                                        :project  (:project-sid d)}))})
          (transition {:event :look/finished :cond (fn [_ d] (empty? (:reasons d))) :target :quiet}
            (script {:expr (fn [_ d] (end-run-ops d "finished" nil))}))
          (transition {:event :look/finished :target :waiting}
            (script {:expr (fn [_ d] (end-run-ops d "finished" nil))}))
          (transition {:event :look/stopped :target :waiting}
            (script {:expr (fn [_ d] (end-run-ops d "stopped" (:detail (evt d))))}))
          (transition {:event :sova/resumed :target :waiting}
            (script {:expr (fn [_ d] (end-run-ops d "cut-off" cut-off-detail))}))
          (transition {:event :look/not-started :target :waiting}
            (script {:expr (fn [_ d] (not-started-ops d))}))))

      ;; ── Region 5: the day clock ─────────────────────────────────────────────────────────────────
      (state {:id :clock :initial :day}
        (state {:id :day}
          (on-entry {} (Send {:id :rollover-timer :event :day/rollover :delayexpr ms-to-midnight}))
          (on-exit {} (cancel {:sendid :rollover-timer}))
          (transition {:event :day/rollover :target :day}
            (script {:expr (fn [env d] (let [now (c/now-ms d)]
                                         (into [(ops/assign :now now) (ops/assign :looks-today 0) (ops/assign :day (c/day-key now))]
                                           (release-due-ops d now (open? env d)))))})
            (raise-released)))))))

(def acts
  "Events the operator (or the host for them) fires at a project, and the item-less tool call."
  [:operator/run-now :operator/level-set :settings/changed :overseer/act])

(def host-events
  [:reason/noted :overseer/busy :overseer/idle :look/finished :look/stopped :look/not-started :sova/resumed
   :org/attached-here :project/archived :project/unarchived :limit/refused :facts/changed
   :watch/due :day/rollover])

(def all-events (into acts host-events))

;; ---- explain ---------------------------------------------------------------------------------------------

(defmethod g/explain* :project [_ event data envelope]
  (let [config (set (:sova/configuration data))
        env    {:com.fulcrologic.statecharts/vwmem (volatile! {:com.fulcrologic.statecharts/configuration config})}]
    (case event
      :overseer/act (act-refusal envelope)
      :operator/run-now (run-now-refusal env data)
      nil)))
