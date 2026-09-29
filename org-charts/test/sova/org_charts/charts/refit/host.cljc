(ns sova.org-charts.charts.refit.host
  "A small deterministic host for unit-testing one refit chart at a time, on the JVM or Node: the
   real v20150901 processor, the flat data model, a virtual clock and queue (delayed sends fire in
   (time, ordinal) order when the clock moves), and the engine's first check (the level, from the
   registry's `:acts`). Cross-session effects are not run: a test reads what the step asked for
   (`:outbox`, `:sova/directives`, sends to other sessions) and sends `link/moved` itself. The
   engine's own suite and the matrix generator cover the rest.

   Errors the library only logs (an expression that threw) fail the test."
  (:require
    [com.fulcrologic.statecharts :as sc]
    [com.fulcrologic.statecharts.algorithms.v20150901 :as alg]
    [com.fulcrologic.statecharts.data-model.working-memory-data-model :as wmdm]
    [com.fulcrologic.statecharts.events :as evts]
    [com.fulcrologic.statecharts.execution-model.lambda :as lambda]
    [com.fulcrologic.statecharts.protocols :as sp]
    [com.fulcrologic.statecharts.registry.local-memory-registry :as lmr]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.engine.dsl :as dsl]
    [taoensso.timbre]))

(defonce problems (atom []))

(taoensso.timbre/set-min-level! :warn)
(taoensso.timbre/merge-config!
  {:appenders {:println {:enabled? false}
               :refit   {:enabled? true :min-level :warn
                         :fn (fn [d] (swap! problems conj (str (:level d) " " (force (:msg_ d)) " " (some-> (:?err d) ex-message))))}}})

(defn- check-problems! []
  (let [[ps _] (reset-vals! problems [])]
    (when (seq ps) (throw (ex-info (str "engine logged: " (first ps)) {:problems ps})))))

(defrecord Queue [state]
  sp/EventQueue
  (send! [_ _env {:keys [event data target source-session-id send-id delay]}]
    (swap! state (fn [{:keys [now ordinal] :as s}]
                   (-> s
                     (update :pending conj {:target (or target source-session-id) :source source-session-id :send-id send-id
                                            :time (+ now (or delay 0)) :ordinal ordinal
                                            :event (cond-> {:name event :data (or data {})} send-id (assoc :sendid send-id))})
                     (update :ordinal inc))))
    true)
  (cancel! [_ _env session-id send-id]
    (swap! state update :pending (fn [p] (vec (remove #(and (= session-id (:source %)) (= send-id (:send-id %))) p)))))
  (receive-events! [_ _ _] nil)
  (receive-events! [_ _ _ _] nil))

(defrecord Invocations [log]
  sp/InvocationProcessor
  (supports-invocation-type? [_ _] true)
  (start-invocation! [_ _env {:keys [invokeid type params]}] (swap! log conj {:op :start :type type :invokeid invokeid :params params}) true)
  (stop-invocation! [_ _env {:keys [invokeid type]}] (swap! log conj {:op :stop :type type :invokeid invokeid}) true)
  (forward-event! [_ _ _] nil))

(defn new-host
  ([] (new-host 1700000000000))
  ([now]
   (let [dm  (wmdm/new-flat-model)
         q   (->Queue (atom {:now now :ordinal 0 :pending []}))
         inv (->Invocations (atom []))
         reg (lmr/new-registry)]
     (doseq [[nm {:keys [chart]}] registry/charts] (sp/register-statechart! reg (keyword nm) chart))
     {:env {::sc/statechart-registry reg ::sc/data-model dm ::sc/event-queue q
            ::sc/processor (alg/new-processor) ::sc/invocation-processors [inv]
            ::sc/execution-model (lambda/new-execution-model dm q)}
      :queue q :invocations inv :sessions (atom {}) :charts (atom {}) :refused (atom []) :delivered (atom [])})))

(defn now [h] (:now @(:state (:queue h))))

(defn fork
  "A new host holding `h`'s sessions, pending events and records as they are now: the two go on
   independently (hosts are mutable; a test that branches forks first)."
  [h]
  (let [q  (->Queue (atom @(:state (:queue h))))
        dm (::sc/data-model (:env h))]
    (-> h
      (assoc :queue q :sessions (atom @(:sessions h)) :charts (atom @(:charts h))
             :refused (atom @(:refused h)) :delivered (atom @(:delivered h))
             :invocations (->Invocations (atom @(:log (:invocations h)))))
      (assoc-in [:env ::sc/event-queue] q)
      (assoc-in [:env ::sc/execution-model] (lambda/new-execution-model dm q)))))

(declare run-due!)

(defn start!
  "Start session `sid` of `chart` (a registry name) with `data`."
  [{:keys [env sessions charts] :as h} chart sid data]
  (let [wm (sp/start! (::sc/processor env) env (keyword chart) {::sc/session-id sid ::sc/invocation-data (assoc data :now (now h))})]
    (swap! sessions assoc sid wm)
    (swap! charts assoc sid chart)
    (check-problems!)
    (run-due! h)))

(defn wmem [h sid] (get @(:sessions h) sid))
(defn config [h sid] (set (::sc/configuration (wmem h sid))))
(defn data [h sid] (::wmdm/data-model (wmem h sid)))
(defn in? [h sid state] (contains? (config h sid) state))

(defn- level-refusal
  "The engine's first checks: the level (from the act's `:needs`), then the act's `:pre` checks."
  [h sid event data]
  (let [chart (get @(:charts h) sid)
        {:keys [needs tool pre]} (get-in registry/charts [chart :acts event])
        wm (get @(:sessions h) sid)
        dm (assoc (::wmdm/data-model wm) :_event {:name event :data data})]
    (or (when needs ((:level-check registry/options) (or tool (str (namespace event) "/" (name event))) needs data))
        (:sentence (dsl/first-refusal (vec pre) dm :pre)))))

(defn- deliver! [{:keys [env sessions delivered refused] :as h} {:keys [target event time]}]
  (when-let [wm (get @sessions target)]
    (when (::sc/running? wm)
      (let [d (merge {:at time} (:data event))]
        (if-let [why (level-refusal h target (:name event) d)]
          (swap! refused conj {:sid target :event (:name event) :sentence why})
          (let [wm2 (sp/process-event! (::sc/processor env) env wm (evts/new-event (assoc event :data d)))]
            (swap! delivered conj {:sid target :event (:name event) :data d})
            (swap! sessions assoc target wm2)))))))

(defn run-due! [{:keys [queue] :as h}]
  (loop [n 0]
    (let [{:keys [now pending]} @(:state queue)
          due (first (sort-by (juxt :time :ordinal) (filter #(<= (:time %) now) pending)))]
      (when (and due (< n 10000))
        (swap! (:state queue) update :pending (fn [p] (vec (remove #(identical? % due) p))))
        (if (contains? @(:sessions h) (:target due))
          (deliver! h due)
          (swap! (:state queue) update :elsewhere (fnil conj []) due))
        (recur (inc n)))))
  (check-problems!)
  h)

(defn send!
  "Send `event` with `data` to `sid` now and run to quiescence, on a fork: the result is a new host
   (hosts are values to the tests)."
  ([h sid event] (send! h sid event {}))
  ([h0 sid event data]
   (let [{:keys [queue env] :as h} (fork h0)]
     (sp/send! queue env {:event event :data data :target sid :source-session-id sid})
     (run-due! h))))

(defn advance! [h0 ms]
  (let [{:keys [queue] :as h} (fork h0)
        end (+ (now h) ms)]
    (loop []
      (let [nxt (first (sort (map :time (filter #(<= (:time %) end) (:pending @(:state queue))))))]
        (if nxt
          (do (swap! (:state queue) assoc :now (max (now h) nxt)) (run-due! h) (recur))
          (swap! (:state queue) assoc :now end))))
    h))

(defn elsewhere
  "Events sent to sessions this host does not hold (another chart's): `[{:target :event :data}]`."
  [{:keys [queue]}]
  (let [out (:elsewhere @(:state queue))]
    (vec (for [e out] {:target (:target e) :event (get-in e [:event :name]) :data (get-in e [:event :data])}))))

(defn outbox [h sid] (vec (:outbox (data h sid))))
(defn kinds [h sid] (mapv :kind (outbox h sid)))
(defn directives [h sid] (vec (:sova/directives (data h sid))))
(defn clear! "Drop the outbox and directives (as the engine does after a step), on a fork." [h0 sid]
  (let [h (fork h0)]
    (swap! (:sessions h) update sid update ::wmdm/data-model dissoc :outbox :sova/directives)
    (swap! (:state (:queue h)) assoc :elsewhere [])
    h))

(defn pending [h sid]
  (vec (for [p (:pending @(:state (:queue h))) :when (= sid (:target p))] [(get-in p [:event :name]) (:time p)])))

(defn taken?
  "Send `event` on a copy: whether anything changed (configuration or data), and the copy's result."
  [h sid event d]
  (let [before (wmem h sid)
        h2     (assoc h :sessions (atom @(:sessions h)) :queue (->Queue (atom @(:state (:queue h))))
                 :refused (atom []) :delivered (atom []))
        h2     (assoc-in h2 [:env ::sc/event-queue] (:queue h2))
        h2     (assoc-in h2 [:env ::sc/execution-model] (lambda/new-execution-model (::sc/data-model (:env h)) (:queue h2)))
        _      (send! h2 sid event d)
        after  (wmem h2 sid)
        strip  #(dissoc (::wmdm/data-model %) :now :_event :_x)]
    {:taken? (or (not= (::sc/configuration before) (::sc/configuration after)) (not= (strip before) (strip after)))
     :host h2
     :refused @(:refused h2)}))

(defn refusal
  "Why the chart would not take `event` from here: the level, else the first failing check of any
   transition of that event in the active states (the engine's explain order, roughly), else not-here."
  [h sid event d]
  (let [chart (get @(:charts h) sid)
        entry (get registry/charts chart)
        d     (merge {:at (now h)} d)]
    (or (level-refusal h sid event d)
        (let [cfg  (config h sid)
              data (assoc (data h sid) :_event {:name event :data d})
              c    (:chart entry)
              ts   (for [s cfg t (com.fulcrologic.statecharts.chart/transitions c s)
                         :let [el (com.fulcrologic.statecharts.chart/element c t)]
                         :when (let [ev (:event el)] (if (keyword? ev) (= ev event) (some #{event} ev)))]
                     el)]
          (if (empty? ts)
            ((:not-here entry) event cfg data)
            (some (fn [el] (:sentence (dsl/first-refusal (:sova/checks el) data :check))) ts))))))
