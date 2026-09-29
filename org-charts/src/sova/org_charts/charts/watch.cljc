(ns sova.org-charts.charts.watch
  "The watch chart (host-local, `watch/<org>/<p>`): the project overseer's watch loop, its looks,
   its ledgers and held items (§app.project-overseer/watch-loop, /limits, /autonomy-levels;
   §app.organizations/portability's pause). The spike's project chart, split from the portable
   project and made exact:

   - attach ‹live · paused›: an attach on this host pauses it; any level set here resumes it.
   - shelf ‹on-shelf · archived-fact›, exists ‹no-overseer · has-overseer›: facts from the watched
     project (`link/moved`).
   - switch ‹watch-on · watch-off›: the Watch setting.
   - turn ‹idle · look-turn · run-turn · operator-turn›: the overseer conversation's runtime
     (W20): every run starts unattended; the operator's message entering its context makes it the
     operator's turn until it ends.
   - loop ‹quiet · waiting · due · held · running›: running invokes `:sova/look`.
   - clock ‹day›: local midnight resets looks and the day ledger and releases day holds.

   Changed on purpose: a stopped or cut-off look's reasons are re-queued in front (C1); the own-act
   filter drops a reason only when the overseer made it while it runs (C2); reasons dedupe by typed
   key (C3); a held message allowance is released at the refusal (C12).

   Start data: `{:org-id :project-id :paused? :settings? :tick-origin? :tick-ms?}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel raise invoke In]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.reasons :as rs]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)

(def watch-prefix "[project watch]")
(def cut-off-detail "The server restarted during the run.")
(def tick-ms 20000)
(def held-max 10)
(def pending-max 50)
(def look-text-max 20)

(def default-settings
  {:autonomy "L1" :watch true :watch-gap-min 10 :soon-look-sec 60 :hold-min 10
   :caps {:gather-per-turn 3 :promote-per-turn 20 :create-per-turn 2 :prompts-per-turn 5
          :gather-per-day 6 :promote-per-day 60 :create-per-day 4 :prompts-per-day 12
          :unattended-per-day 12 :gatherings-open 5 :coding-running 2}})

(defn settings [data] (merge-with #(if (map? %1) (merge %1 %2) %2) default-settings (:settings data)))
(defn per-day [data] (get-in (settings data) [:caps :unattended-per-day]))

(def per-day-key {"gather" :gather-per-day "promote" :promote-per-day "create" :create-per-day "prompt" :prompts-per-day})
(def per-turn-key {"gather" :gather-per-turn "promote" :promote-per-turn "create" :create-per-turn "prompt" :prompts-per-turn})
(def kinds ["gather" "promote" "create" "prompt"])

(defn allowance
  "What each allowance has used of its max, per ledger (the host stamps the one a turn draws on)."
  [data ledger]
  (let [caps (:caps (settings data))
        k    (if (= ledger "message") per-turn-key per-day-key)]
    (into {} (for [kind kinds] [(keyword kind) {:used (get-in data [:ledgers (keyword ledger) (keyword kind)] 0) :max (get caps (k kind))}]))))

(defn effective [data]
  (lv/effective-autonomy {:autonomy (:autonomy (settings data)) :paused (:paused data) :roster-active (:roster-active data)}))

(defn watch-text
  "watchText(reasons, autonomy), verbatim; the last 20 reasons."
  [reasons autonomy]
  (let [lst (if (seq reasons)
              (str/join "\n" (map #(str "- " %) (take-last look-text-max reasons)))
              "- (the operator asked for a look)")]
    (str watch-prefix " Since your last look:\n" lst "\n\n"
      "Re-read the project (sova_project, and sova_decisions where it matters). Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…). "
      "Then act within your autonomy (" autonomy "): the tools tell you when something needs a higher level. Keep your reply to a few lines for the operator.")))

;; ---- reasons -------------------------------------------------------------------------------------

(defn incoming [data]
  (let [e (b/evt data)]
    (if (contains? e :reasons) (vec (:reasons e)) [e])))

(defn running-turn? [env] (or (b/in? env :look-turn) (b/in? env :run-turn) (b/in? env :operator-turn)))

(defn own-act?
  "C2: its own acts, made while it runs: a reason whose `by` is the overseer, noted while one of its
   turns runs, is not a reason to look (it knows)."
  [env reason]
  (and (= "overseer" (some-> (:by reason) name)) (running-turn? env)))

(defn kept [env data]
  (->> (incoming data)
    (remove #(own-act? env %))
    (filter #(some? (:kind %)))))

(defn keep-reason? [env data] (and (b/in? env :has-overseer) (boolean (seq (kept env data)))))

(defn with-reason
  "withReason: deduped by typed key (C3), at most 50 waiting; the first soon reason since the last
   look sets `soon-at` (unless the soon look is Off)."
  [data reason now]
  (let [pending (vec (:reasons data))
        k       (rs/dedupe-key reason)
        row     {:kind (:kind reason) :text (rs/text reason) :key k :at now :soon (boolean (rs/soon? reason))
                 :params (:params reason) :by (some-> (:by reason) name)}
        pending (if (some #(= k (:key %)) pending) pending (vec (take-last pending-max (conj pending row))))
        soon-s  (:soon-look-sec (settings data))
        soon-at (if (and (rs/soon? reason) (some? soon-s) (nil? (:soon-at data))) (+ now (* 1000 soon-s)) (:soon-at data))]
    (assoc data :reasons pending :soon-at soon-at)))

(defn add-reasons [] (script {:expr (fn [env data]
                                      (let [now (b/now-ms data)
                                            d   (reduce #(with-reason %1 %2 now) data (kept env data))]
                                        [(ops/assign :reasons (:reasons d)) (ops/assign :soon-at (:soon-at d))]))}))

(defn texts [rows] (vec (map :text rows)))

;; ---- the gates -----------------------------------------------------------------------------------

(defn looks-left? [_ data] (let [cap (per-day data)] (or (nil? cap) (< (:looks-today data 0) cap))))

(defn may-look [env data]
  (and (b/in? env :live) (b/in? env :on-shelf) (b/in? env :watch-on) (b/in? env :idle) (b/in? env :has-overseer) (looks-left? env data)))

(defn looks-used [env data]
  (and (b/in? env :live) (b/in? env :on-shelf) (b/in? env :watch-on) (b/in? env :idle) (b/in? env :has-overseer) (not (looks-left? env data))))

(defn on-tick
  "The first 20 s tick at or after `t` (looks start on ticks, D10)."
  [data t]
  (let [tick (get data :tick-ms tick-ms) origin (or (:tick-origin data) 0)]
    (if (and tick (pos? tick))
      (let [k (quot (- t origin) tick) bb (+ origin (* k tick))] (if (< bb t) (+ bb tick) bb))
      t)))

(defn due-at [data]
  (let [gap  (+ (or (:last-run-at data) 0) (* 60000 (:watch-gap-min (settings data))))
        soon (:soon-at data)]
    (on-tick data (max (if soon (min soon gap) gap) (or (:retry-at data) 0) (b/now-ms data)))))

(defn due-in [_ data] (max 0 (- (due-at data) (b/now-ms data))))

(defn daily-why [data] (str "the daily limit of " (per-day data) " unattended runs is reached"))

(defn run-now-refusal
  "lookNow(force)'s refusals, in its order: archived (its own sentence), no conversation, busy, the
   daily limit (`Not started: …`). Reads the states the chart mirrors into data."
  [data]
  (let [why (cond
              (not (:has-overseer data)) "no conversation yet"
              (:loop-running data) "busy"
              (not= "idle" (:turn-state data)) "busy"
              (not (looks-left? nil data)) (daily-why data)
              :else nil)]
    (cond
      (:archived data) (r/refuse 409 (str (:project-name data) " is archived. Unarchive it to use its overseer."))
      why (r/refuse 409 (str "Not started: " why ".")))))

(defn- looks-held-item [data now]
  {:key "looks" :what "looks" :why (str "Today's " (per-day data) " looks on its own are used.")
   :since now :retry-at (b/next-midnight now)})

(defn hold-item [held item]
  (let [prev (some #(when (= (:key item) (:key %)) %) held)]
    (vec (take-last held-max (conj (vec (remove #(= (:key item) (:key %)) held))
                               (assoc item :since (or (:since prev) (:since item))))))))

(defn skip-ops [data why]
  (let [now (b/now-ms data)]
    (cond-> [(ops/assign :last-run {:at now :reasons (texts (:reasons data)) :outcome "skipped" :detail why})]
      (= why (daily-why data)) (conj (ops/assign :held (hold-item (:held data) (looks-held-item data now)))))))

;; ---- runs ------------------------------------------------------------------------------------------

(defn start-run-ops [data]
  (let [now (b/now-ms data)]
    [(ops/assign :run-reasons (:reasons data))
     (ops/assign :before-run (select-keys data [:last-run-at :looks-today :soon-at]))
     (ops/assign :reasons [])
     (ops/assign :soon-at nil)
     (ops/assign :retry-at nil)
     (ops/assign :last-run-at now)
     (ops/assign :looks-today (inc (:looks-today data 0)))
     (ops/assign :last-run {:at now :reasons (texts (:reasons data)) :outcome "started"})]))

(defn requeue
  "C1: the run's reasons back in front of those noted since."
  [data]
  (let [later (:reasons data) ks (set (map :key later))]
    (vec (take-last pending-max (concat (remove #(ks (:key %)) (:run-reasons data)) later)))))

(defn end-run-ops [data outcome detail]
  (cond-> [(ops/assign :last-run (cond-> (assoc (:last-run data) :outcome outcome) detail (assoc :detail detail)))]
    (not= outcome "finished") (conj (ops/assign :reasons (requeue data)))
    true (conj (ops/assign :run-reasons []))))

(defn not-started-ops [data]
  (let [now (b/now-ms data) bf (:before-run data)]
    [(ops/assign :last-run {:at now :reasons (texts (:run-reasons data)) :outcome "skipped" :detail (:detail (b/evt data))})
     (ops/assign :last-run-at (:last-run-at bf))
     (ops/assign :looks-today (:looks-today bf 0))
     (ops/assign :soon-at (:soon-at bf))
     (ops/assign :retry-at (+ now 1))
     (ops/assign :reasons (requeue data))
     (ops/assign :run-reasons [])]))

;; ---- held items, releases, the day ------------------------------------------------------------------

(defn released-reason [{:keys [key what since]}]
  (let [[ledger kind] (str/split key #":")]
    (cond
      (= key "looks") {:kind "held/looks" :params {:at since} :by "system" :key (str "held/looks@" since)}
      (= ledger "day") {:kind "held/day" :params {:kind kind :at since} :by "system" :key (str "held/day:" kind "@" since)}
      (= ledger "message") {:kind "held/message" :params {:what what} :by "system" :key (str "held/message:" kind "@" since)}
      :else nil)))

(defn open? [env] (and (b/in? env :live) (b/in? env :on-shelf)))

(defn release-due-ops
  "Held items whose time came leave the list; their reasons wait in `:releasing` (only while it is
   neither paused nor archived: what they hold waits until then)."
  [data now open]
  (let [due (if open (filter #(and (some? (:retry-at %)) (<= (:retry-at %) now)) (:held data)) [])]
    [(ops/assign :held (vec (remove (set due) (:held data))))
     (ops/assign :releasing (vec (keep released-reason due)))]))

(defn raise-released []
  (raise {:event :reason/noted :data (fn [_ d] {:reasons (:releasing d) :by "system"})}))

(defn refused-item
  "An allowance refusal as the held item overRefusal records: day items wait for midnight; a
   message item is released at once (C12)."
  [e now]
  (let [kind (:kind e) what (lv/limit-what kind)]
    (if (= "day" (:ledger e))
      {:key (str "day:" kind) :what what :why (str "Today's allowance is used: " (:used e) " of " (:max e) " " what " on its own.")
       :since now :retry-at (b/next-midnight now)}
      {:key (str "message:" kind) :what what :why (str "This message's allowance is used: " (:used e) " of " (:max e) " " what ".")
       :since now :retry-at now})))

(defn raised-keys
  "releaseRaised: the held keys a settings change raised (a larger number, or Unlimited)."
  [before after]
  (let [raised? (fn [a bb] (and (some? a) (or (nil? bb) (> bb a))))
        cb (:caps before) ca (:caps after)]
    (into {}
      (concat
        (for [[k dk] per-day-key :when (and (contains? ca dk) (raised? (get cb dk) (get ca dk)))] [(str "day:" k) (lv/limit-what k)])
        (for [[k tk] per-turn-key :when (and (contains? ca tk) (raised? (get cb tk) (get ca tk)))] [(str "message:" k) (lv/limit-what k)])
        (when (and (contains? ca :unattended-per-day) (raised? (:unattended-per-day cb) (:unattended-per-day ca))) [["looks" "looks"]])))))

(defn settings-ops [data]
  (let [before (settings data)
        after  (merge-with #(if (map? %1) (merge %1 %2) %2) before (:settings (b/evt data)))
        ks     (raised-keys before after)
        freed  (filter #(contains? ks (:key %)) (:held data))]
    [(ops/assign :settings after)
     (ops/assign :held (vec (remove (set freed) (:held data))))
     (ops/assign :releasing (vec (for [h freed] {:kind "held/raised" :params {:what (get ks (:key h))} :by "system"
                                                 :key (str "held/raised:" (:key h) "@" (b/now-ms data))})))]))

(defn ms-to-midnight [_ data] (let [now (b/now-ms data)] (max 0 (- (b/next-midnight now) now))))

(defn ledger-ops
  "`ledger/take {kind n ledger by}`: the overseer's (or the chart's own) act counted on its ledger;
   the operator's clicks count nothing."
  [data]
  (let [{:keys [kind n ledger by]} (b/evt data)]
    (when (contains? #{"overseer" "chart"} (some-> by name))
      [(ops/assign [:ledgers (keyword ledger) (keyword kind)] (+ (get-in data [:ledgers (keyword ledger) (keyword kind)] 0) (or n 1)))])))

(defn project-moved? [_ d] (= "project" (:chart (b/moved d))))

(def chart
  (statechart {:initial :watch}
    (state {:id :watch :initial :regions}
      ;; Facts from the host (the roster's active people, the settings file as read) and the project.
      (transition {:event :facts/changed}
        (script {:expr (fn [_ d] (let [e (b/evt d)]
                                   (cond-> []
                                     (contains? e :roster-active) (conj (ops/assign :roster-active (:roster-active e))))))}))
      (transition {:event :link/moved :cond project-moved?}
        (script {:expr (fn [_ d] (let [m (b/moved d)]
                                   [(ops/assign :archived (b/moved-in? d :archived))
                                    (ops/assign :has-overseer (b/moved-in? d :has-overseer))
                                    (ops/assign :project-name (get-in m [:exported :name]))]))}))
      (transition {:event :org/attached-here} (script {:expr (fn [_ _] [(ops/assign :paused true)])}))
      (transition {:event :operator/level-set}
        (script {:expr (fn [_ d] [(ops/assign :paused false)
                                  (ops/assign :settings (assoc (:settings d) :autonomy (or (:autonomy (b/evt d)) (:autonomy (settings d)))))])}))
      (transition {:event :settings/changed}
        (script {:expr (fn [_ d] (settings-ops d))})
        (raise-released))
      (transition {:event :ledger/take} (script {:expr (fn [_ d] (ledger-ops d))}))
      (transition {:event :ledger/reset-message} (script {:expr (fn [_ _] [(ops/assign [:ledgers :message] {})])}))
      (transition {:event :limit/refused}
        (script {:expr (fn [_ d] [(ops/assign :held (hold-item (:held d) (refused-item (b/evt d) (b/now-ms d))))])})
        (script {:expr (fn [env d] (release-due-ops d (b/now-ms d) (open? env)))})
        (raise-released))

      (parallel {:id :regions}
        (state {:id :attach :initial :live}
          (state {:id :live} (transition {:cond (fn [_ d] (true? (:paused d))) :target :paused}))
          (state {:id :paused}
            (transition {:cond (fn [_ d] (not (:paused d))) :target :live}
              (script {:expr (fn [env d] (release-due-ops d (b/now-ms d) (b/in? env :on-shelf)))})
              (raise-released))))

        (state {:id :shelf :initial :on-shelf}
          (state {:id :on-shelf} (transition {:cond (fn [_ d] (true? (:archived d))) :target :archived-fact}))
          (state {:id :archived-fact}
            (transition {:cond (fn [_ d] (not (:archived d))) :target :on-shelf}
              (script {:expr (fn [env d] (release-due-ops d (b/now-ms d) (b/in? env :live)))})
              (raise-released))))

        ;; Reasons are noted only while the overseer exists.
        (state {:id :exists :initial :no-overseer}
          (state {:id :no-overseer} (transition {:cond (fn [_ d] (true? (:has-overseer d))) :target :has-overseer}))
          (state {:id :has-overseer} (transition {:cond (fn [_ d] (not (:has-overseer d))) :target :no-overseer})))

        (state {:id :switch :initial :watch-on}
          (state {:id :watch-on} (transition {:cond (fn [_ d] (false? (:watch (settings d)))) :target :watch-off}))
          (state {:id :watch-off} (transition {:cond (fn [_ d] (not (false? (:watch (settings d))))) :target :watch-on})))

        ;; The overseer conversation's runtime (W20). A look's run is the look-turn; another run
        ;; that is not the operator's (a queued follow-up, Run Now's own) is a run-turn; the
        ;; operator's message entering its context makes it the operator's until the run ends.
        (state {:id :turn :initial :idle}
          (transition {:event :turn/user-entered :target :operator-turn}
            (script {:expr (fn [_ _] [(ops/assign [:ledgers :message] {})])}))
          (transition {:event :turn/ended :target :idle})
          (state {:id :idle}
            (on-entry {} (script {:expr (fn [_ _] [(ops/assign :turn-state "idle")])}))
            (transition {:event :turn/started :cond (fn [_ d] (true? (:look (b/evt d)))) :target :look-turn})
            (transition {:event :turn/started :target :run-turn}))
          (state {:id :look-turn} (on-entry {} (script {:expr (fn [_ _] [(ops/assign :turn-state "look")])})))
          (state {:id :run-turn} (on-entry {} (script {:expr (fn [_ _] [(ops/assign :turn-state "run")])})))
          (state {:id :operator-turn} (on-entry {} (script {:expr (fn [_ _] [(ops/assign :turn-state "operator")])}))))

        (state {:id :loop :initial :quiet}
          (transition {:event :reason/noted :cond keep-reason?} (add-reasons))
          ;; Run Now skips the reasons, the gap and the Watch switch, never the looks per day, a busy
          ;; overseer or an archived project. A refused one is recorded as a skipped run by the host's
          ;; `look/skipped {detail}` (a refusal takes nothing).
          (dsl/act {:event :operator/run-now :target :running :checks [run-now-refusal]})
          (transition {:event :look/skipped}
            (script {:expr (fn [_ d] (skip-ops d (:detail (b/evt d))))}))

          (state {:id :quiet}
            (transition {:event :reason/noted :cond keep-reason? :target :waiting} (add-reasons)))
          (state {:id :waiting}
            (on-entry {} (Send {:id :due-timer :event :watch/due :delayexpr due-in}))
            (on-exit {} (cancel {:sendid :due-timer}))
            (transition {:event :reason/noted :cond keep-reason? :target :waiting} (add-reasons))
            (transition {:event :settings/changed :target :waiting})
            (transition {:event :watch/due :target :due}))
          (state {:id :due}
            (transition {:cond may-look :target :running})
            (transition {:cond looks-used :target :held}))
          (state {:id :held}
            (on-entry {} (script {:expr (fn [_ d] (skip-ops d (daily-why d)))}))
            (transition {:event :reason/noted :cond (fn [env d] (and (keep-reason? env d) (looks-left? env d))) :target :due} (add-reasons)))
          (state {:id :running}
            (on-entry {} (script {:expr (fn [_ d] (conj (start-run-ops d) (ops/assign :loop-running true)))}))
            (on-exit {} (script {:expr (fn [_ _] [(ops/assign :loop-running false)])}))
            (invoke {:id :look :type :sova/look
                     :params (fn [_ d] (let [eff (effective d)]
                                         {:reasons (texts (:run-reasons d)) :autonomy (:autonomy eff)
                                          :text (watch-text (texts (:run-reasons d)) (:autonomy eff))
                                          :project-id (:project-id d)}))})
            (transition {:event :look/finished :cond (fn [_ d] (empty? (:reasons d))) :target :quiet}
              (script {:expr (fn [_ d] (end-run-ops d "finished" nil))}))
            (transition {:event :look/finished :target :waiting}
              (script {:expr (fn [_ d] (end-run-ops d "finished" nil))}))
            (transition {:event :look/stopped :target :waiting}
              (script {:expr (fn [_ d] (end-run-ops d "stopped" (:detail (b/evt d))))}))
            (transition {:event :sova/resumed :target :waiting}
              (script {:expr (fn [_ d] (end-run-ops d "cut-off" cut-off-detail))}))
            (transition {:event :look/not-started :target :waiting}
              (script {:expr (fn [_ d] (not-started-ops d))}))))

        (state {:id :clock :initial :day}
          (state {:id :day}
            (on-entry {} (Send {:id :rollover-timer :event :day/rollover :delayexpr ms-to-midnight}))
            (on-exit {} (cancel {:sendid :rollover-timer}))
            (transition {:event :day/rollover :target :day}
              (script {:expr (fn [env d] (let [now (b/now-ms d)]
                                           (into [(ops/assign :looks-today 0) (ops/assign [:ledgers :day] {}) (ops/assign :day (b/day-key now))]
                                             (release-due-ops d now (open? env)))))})
              (raise-released))))))))

(def acts
  {:operator/run-now   {:needs nil}
   :operator/level-set {:needs nil}})

(defn not-here [_ _ _] "That can't be done now.")

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :host-local
   :exported [:paused :looks-today :last-run :held :reasons :ledgers :settings]
   :acts     acts
   :not-here not-here})
