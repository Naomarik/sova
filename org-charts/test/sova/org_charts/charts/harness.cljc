(ns sova.org-charts.charts.harness
  "A deterministic test host for the charts: the real v20150901 processor, the flat data model and
   the lambda execution model, with a virtual-clock event queue shared by every session (delayed
   sends fire in (time, ordinal) order when the clock is advanced), cross-session delivery, and a
   recording :sova/look invocation processor. Independent of the engine's module on purpose: the
   chart tests pin chart semantics, the engine's tests pin its Node behaviour. The one exception is
   the engine's step limit: under Node (the suite of record) the processor is the engine's bounded
   one, so an eventless cycle fails its test instead of hanging the suite. The JVM has no such
   bound (the library only logs after 1,000 × 1,000 iterations)."
  (:require
    [com.fulcrologic.statecharts :as sc]
    [com.fulcrologic.statecharts.algorithms.v20150901 :as alg]
    [com.fulcrologic.statecharts.data-model.working-memory-data-model :as wmdm]
    [com.fulcrologic.statecharts.events :as evts]
    [com.fulcrologic.statecharts.execution-model.lambda :as lambda]
    [com.fulcrologic.statecharts.protocols :as sp]
    [com.fulcrologic.statecharts.registry.local-memory-registry :as lmr]
    [sova.org-charts.charts.project :as project]
    [sova.org-charts.charts.work-item :as work-item]
    #?(:cljs [sova.org-charts.engine.bounded :as bounded])
    [taoensso.timbre]))

;; ---- errors fail the test ----------------------------------------------------------------------------
;; An expression that throws inside the engine becomes :error.execution and a logged error, never an
;; exception: the harness turns every logged error or warning into a thrown one.

(defonce problems (atom []))

(taoensso.timbre/set-min-level! :warn)
(taoensso.timbre/merge-config!
  {:appenders {:println {:enabled? false}
               :harness {:enabled? true :min-level :warn
                         :fn (fn [d] (swap! problems conj (str (:level d) " " (force (:msg_ d)) " " (some-> (:?err d) ex-message))))}}})

(defn- check-problems! []
  (let [[ps _] (reset-vals! problems [])]
    (when (seq ps) (throw (ex-info (str "engine logged: " (first ps)) {:problems ps})))))

;; ---- the virtual queue ------------------------------------------------------------------------------

(defrecord VirtualQueue [state]
  sp/EventQueue
  (send! [_ _env {:keys [event data target source-session-id send-id delay invoke-id]}]
    (swap! state (fn [{:keys [now ordinal] :as s}]
                   (-> s
                     (update :pending conj {:target  (or target source-session-id)
                                            :source  source-session-id
                                            :send-id send-id
                                            :time    (+ now (or delay 0))
                                            :ordinal ordinal
                                            :event   (cond-> {:name event :data (or data {})}
                                                       send-id (assoc :sendid send-id)
                                                       invoke-id (assoc :invokeid invoke-id))})
                     (update :ordinal inc))))
    true)
  (cancel! [_ _env session-id send-id]
    (swap! state update :pending (fn [p] (vec (remove #(and (= session-id (:source %)) (= send-id (:send-id %))) p)))))
  (receive-events! [_ _ _] nil)
  (receive-events! [_ _ _ _] nil))

(defrecord LookProcessor [started stopped]
  sp/InvocationProcessor
  (supports-invocation-type? [_ t] (= t :sova/look))
  (start-invocation! [_ _env {:keys [invokeid params]}] (swap! started conj {:invokeid invokeid :params params}) true)
  (stop-invocation! [_ _env {:keys [invokeid]}] (swap! stopped conj invokeid) true)
  (forward-event! [_ _ _] nil))

;; ---- the host ------------------------------------------------------------------------------------------

(defn new-host
  "A host at virtual time `now` (epoch ms)."
  ([] (new-host 1700000000000))
  ([now]
   (let [dm       (wmdm/new-flat-model)
         q        (->VirtualQueue (atom {:now now :ordinal 0 :pending []}))
         look     (->LookProcessor (atom []) (atom []))
         registry (lmr/new-registry)
         env      {::sc/statechart-registry   registry
                   ::sc/data-model            dm
                   ::sc/event-queue           q
                   ::sc/processor             #?(:clj (alg/new-processor) :cljs (bounded/new-processor))
                   ::sc/invocation-processors [look]
                   ::sc/execution-model       (lambda/new-execution-model dm q)}]
     (sp/register-statechart! registry :project project/chart)
     (sp/register-statechart! registry :work-item work-item/chart)
     {:env env :queue q :look look :sessions (atom {}) :log (atom [])})))

(defn now [{:keys [queue]}] (:now @(:state queue)))

(defn fork
  "A new host holding `h`'s sessions and pending events as they are now (values: the two go on
   independently). Placing a state once and forking it per cell is what keeps the matrix fast."
  [h]
  (let [h2 (new-host (now h))]
    (reset! (:state (:queue h2)) @(:state (:queue h)))
    (reset! (:sessions h2) @(:sessions h))
    h2))

(defn start!
  "Start `chart` as session `sid` with `data` (plus `:now`)."
  [{:keys [env sessions] :as h} chart sid data]
  (let [wm (sp/start! (::sc/processor env) env chart {::sc/session-id      sid
                                                       ::sc/invocation-data (assoc data :now (now h))})]
    (swap! sessions assoc sid wm)
    (check-problems!)
    h))

(defn wmem [h sid] (get @(:sessions h) sid))
(defn config [h sid] (::sc/configuration (wmem h sid)))
(defn data [h sid] (::wmdm/data-model (wmem h sid)))
(defn in? [h sid state] (contains? (config h sid) state))
(defn running? [h sid] (true? (::sc/running? (wmem h sid))))

(defn- deliver! [{:keys [env sessions log] :as h} {:keys [target event time]}]
  (when-let [wm (get @sessions target)]
    (when (::sc/running? wm)
      (let [ev  (evts/new-event (update event :data #(merge {:at time} %)))
            wm2 (sp/process-event! (::sc/processor env) env wm ev)]
        (swap! log conj {:sid target :event (:name event) :from (::sc/configuration wm) :to (::sc/configuration wm2)})
        (swap! sessions assoc target wm2)))))

(defn run-due!
  "Deliver every event due at the current virtual time, in (time, ordinal) order, until none is."
  [{:keys [queue] :as h}]
  (loop [n 0]
    (let [{:keys [now pending]} @(:state queue)
          due (first (sort-by (juxt :time :ordinal) (filter #(<= (:time %) now) pending)))]
      (when (and due (< n 10000))
        (swap! (:state queue) update :pending (fn [p] (vec (remove #(identical? % due) p))))
        (deliver! h due)
        (recur (inc n)))))
  (check-problems!)
  h)

(defn send!
  "Send `event` with `data` to `sid` now and run to quiescence."
  ([h sid event] (send! h sid event {}))
  ([{:keys [queue] :as h} sid event data]
   (sp/send! queue (:env h) {:event event :data data :target sid :source-session-id sid})
   (run-due! h)))

(defn advance!
  "Move the virtual clock by `ms`, firing what comes due in order (each at its own time)."
  [{:keys [queue] :as h} ms]
  (let [end (+ (now h) ms)]
    (loop []
      (let [nxt (first (sort (map :time (filter #(<= (:time %) end) (:pending @(:state queue))))))]
        (if nxt
          (do (swap! (:state queue) assoc :now (max (now h) nxt)) (run-due! h) (recur))
          (swap! (:state queue) assoc :now end))))
    h))

(defn pending-sends
  "Delayed events waiting for `sid`, as `[event-name due-time]`."
  [{:keys [queue]} sid]
  (vec (for [p (:pending @(:state queue)) :when (= sid (:target p))] [(get-in p [:event :name]) (:time p)])))

(defn outbox [h sid] (:outbox (data h sid)))

(defn trial
  "Process `event` on a copy of `sid`'s working memory with a scratch queue: what the event would do,
   with nothing delivered. Returns {:taken? :config :outbox}."
  [{:keys [env] :as h} sid event data]
  (let [scratch (->VirtualQueue (atom {:now (now h) :ordinal 0 :pending []}))
        env'    (assoc env ::sc/event-queue scratch
                  ::sc/execution-model (lambda/new-execution-model (::sc/data-model env) scratch))
        wm      (wmem h sid)
        wm2     (sp/process-event! (::sc/processor env') env' wm (evts/new-event {:name event :data (merge {:at (now h)} data)}))]
    {:taken?  (or (not= (::sc/configuration wm) (::sc/configuration wm2))
                  (not= (:outbox (::wmdm/data-model wm)) (:outbox (::wmdm/data-model wm2)))
                  (not= (::wmdm/data-model wm) (::wmdm/data-model wm2)))
     :config  (::sc/configuration wm2)
     :outbox  (:outbox (::wmdm/data-model wm2))
     :wmem    wm2}))

