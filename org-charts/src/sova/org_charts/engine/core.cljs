(ns sova.org-charts.engine.core
  "The engine: fulcrologic/statecharts (v20150901, flat working-memory data model, lambda execution)
   driven synchronously, with owned adapters:

   - a durable delayed-event queue (`engine.queue`) on an injected clock;
   - a WorkingMemoryStore that hands each saved snapshot to a host callback;
   - host-run invocations (`:sova/look`): start/stop call host callbacks;
   - `trial` (a speculative event on a copy) and `enabled-events`;
   - a step limit (`engine.bounded`): an event that takes more than `:max-microsteps` microsteps
     throws a `:sova/step-limit` error, and the whole call is rolled back.

   Everything here is CLJS data; `sova.org-charts.api` does the JS marshalling.
   One engine holds many sessions; one call processes the event and then drains every event that
   became deliverable (cross-session sends included), one at a time in global (time, ordinal) order."
  (:require
    [cljs.tools.reader.edn :as edn]
    [com.fulcrologic.statecharts :as sc]
    [com.fulcrologic.statecharts.algorithms.v20150901-impl :as impl]
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.data-model.working-memory-data-model :as wmdm]
    [com.fulcrologic.statecharts.environment :as env]
    [com.fulcrologic.statecharts.events :as evts]
    [com.fulcrologic.statecharts.execution-model.lambda :as lambda]
    [com.fulcrologic.statecharts.protocols :as sp]
    [com.fulcrologic.statecharts.registry.local-memory-registry :as lmr]
    [com.fulcrologic.statecharts.util]
    [sova.org-charts.engine.bounded :as bounded]
    [sova.org-charts.engine.queue :as q]
    [taoensso.timbre :as log]))

(def snapshot-format 1)
(def ^:private data-key ::wmdm/data-model)

;; ---------------------------------------------------------------------------------------------
;; Adapters

(defrecord CallbackStore [sessions on-save]
  sp/WorkingMemoryStore
  (get-working-memory [_ _env session-id] (get @sessions session-id))
  (save-working-memory! [_ _env session-id wmem]
    (swap! sessions assoc session-id wmem)
    (when on-save (on-save session-id wmem)))
  (delete-working-memory! [_ _env session-id] (swap! sessions dissoc session-id)))

(deftype HostInvocations [types hooks]
  ;; `hooks` is an atom {:on-start f :on-stop f :trial? bool :log (atom [])}.
  sp/InvocationProcessor
  (supports-invocation-type? [_ typ] (contains? types typ))
  (start-invocation! [_ env {:keys [invokeid type params]}]
    (let [{:keys [on-start trial? record]} @hooks
          inv {:session-id (env/session-id env) :invoke-id invokeid :type type :params params}]
      (when record (swap! record conj (assoc inv :op :start)))
      (when (and on-start (not trial?)) (on-start inv))
      true))
  (stop-invocation! [_ env {:keys [invokeid type]}]
    (let [{:keys [on-stop trial? record]} @hooks
          inv {:session-id (env/session-id env) :invoke-id invokeid :type type}]
      (when record (swap! record conj (assoc inv :op :stop)))
      (when (and on-stop (not trial?)) (on-stop inv))
      true))
  (forward-event! [_ _env _] nil))

;; Errors the library logs (an action or cond that threw) are captured per call, not printed.
(defonce ^:private captured (atom []))
(defonce ^:private _log-config
  (log/set-config! {:min-level :warn
                    :appenders {:capture {:enabled?  true
                                          :min-level :warn
                                          :fn        (fn [{:keys [level vargs ?err]}]
                                                       (swap! captured conj
                                                         {:level   (name level)
                                                          :message (str (apply str (interpose " " (map str vargs)))
                                                                     (when ?err (str " — " (ex-message ?err))))}))}}}))

;; ---------------------------------------------------------------------------------------------
;; Engine

(defn- build-env
  "A statecharts env over `queue`. Invocations of `invoke-types` go to `hooks`; each event may take
   at most `max-microsteps` microsteps."
  [registry queue store invoke-types hooks max-microsteps]
  (let [dm (wmdm/new-flat-model)]
    {::sc/statechart-registry   registry
     ::sc/data-model            dm
     ::sc/event-queue           queue
     ::sc/working-memory-store  store
     ::sc/processor             (bounded/new-processor max-microsteps)
     ::sc/invocation-processors [(->HostInvocations invoke-types hooks)]
     ::sc/execution-model       (lambda/new-execution-model dm queue)}))

(declare snapshot-of dump)

(defn new-engine
  "`charts` is {name {:chart c :version n}}.
   `opts`: :on-save (fn [session-id snapshot-map]), :on-invoke-start / :on-invoke-stop (fn [inv]),
   :clock (0-arity fn, default Date.now), :invoke-types (default #{:sova/look}),
   :max-microsteps (per event; default `bounded/default-max-microsteps`)."
  [charts {:keys [on-save on-invoke-start on-invoke-stop clock invoke-types max-microsteps]}]
  (let [now      (atom nil)
        clock-fn (fn [] (or @now (if clock (clock) (js/Date.now))))
        sends    (atom [])
        queue    (q/new-queue clock-fn (fn [req] (swap! sends conj req)))
        registry (lmr/new-registry)
        meta*    (atom {})                                   ; sid -> {:chart name :generation n}
        eng      (atom nil)
        store    (->CallbackStore (atom {}) (fn [sid wmem] (when on-save (on-save sid ((:snapshot-of @eng) sid wmem)))))
        hooks    (atom {:on-start on-invoke-start :on-stop on-invoke-stop :record (atom [])})
        types    (or invoke-types #{:sova/look})
        limit    (or max-microsteps bounded/default-max-microsteps)
        env      (build-env registry queue store types hooks limit)]
    ;; Registered as they are: the charts are fixed at build time, and the tests check them with the
    ;; library's validation (what `simple/register!` would do here at every start, ~4 KB with its env).
    (doseq [[nm {:keys [chart]}] charts]
      (sp/register-statechart! registry (keyword nm) chart))
    (reset! eng {:charts charts :env env :queue queue :store store :now now :clock clock-fn
                 :sends sends :meta meta* :hooks hooks :types types :registry registry :limit limit})
    (swap! eng assoc :snapshot-of (fn [sid wmem] (snapshot-of eng sid wmem)))
    eng))

(defn- engine [eng] @eng)
(defn- wmem-of [eng sid] (get @(:sessions (:store (engine eng))) sid))
(defn loaded? [eng sid] (some? (wmem-of eng sid)))
(defn session-ids [eng] (vec (keys @(:sessions (:store (engine eng))))))

(defn- chart-of [eng sid]
  (let [src (::sc/statechart-src (wmem-of eng sid))]
    (sp/get-statechart (:registry (engine eng)) src)))

(defn configuration
  "Active state ids of `sid` in document order (ancestors included), or nil if not loaded."
  [eng sid]
  (when-let [wm (wmem-of eng sid)]
    (chart/in-document-order (chart-of eng sid) (::sc/configuration wm))))

(defn data [eng sid] (some-> (wmem-of eng sid) (get data-key)))

(defn- with-now [wmem now] (assoc-in wmem [data-key :now] now))

(defn- drain-outbox
  "Take the chart's effect intents out of the data model: returns [wmem outbox]."
  [wmem]
  (let [ob (get-in wmem [data-key :outbox])]
    [(if (seq ob) (assoc-in wmem [data-key :outbox] []) wmem) (vec ob)]))

(defn- snapshot-of [eng sid wmem]
  (let [{:keys [charts meta queue]} (engine eng)
        {:keys [chart generation]} (get @meta sid)]
    {::format     snapshot-format
     :session-id  sid
     :chart       chart
     :version     (get-in charts [chart :version] 0)
     :generation  (or generation 0)
     :wmem        wmem
     :queue       (q/snapshot-session queue sid)
     :ordinal     (q/ordinal queue)}))

(defn- save! [eng sid wmem]
  (let [{:keys [store env meta]} (engine eng)]
    (swap! meta update-in [sid :generation] (fnil inc 0))
    (sp/save-working-memory! store env sid wmem)))

(defn- process-one
  "Run `event` (an event map) on `sid`, save, and return a log entry."
  [eng sid event]
  (let [{:keys [env clock]} (engine eng)
        wm0      (wmem-of eng sid)
        before   (configuration eng sid)
        event    (assoc-in event [:data :at] (clock))
        wm1      (sp/process-event! (::sc/processor env) env (with-now wm0 (clock)) event)
        [wm2 ob] (drain-outbox wm1)]
    (save! eng sid wm2)
    {:session-id sid :at (clock) :event (:name event) :data (:data event) :invoke-id (:invokeid event)
     :before before :after (configuration eng sid) :outbox ob :running (boolean (::sc/running? wm2))
     :microsteps (bounded/microsteps (::sc/processor env))}))

(defn- begin-call! [eng now]
  (let [{:keys [sends hooks] n :now} (engine eng)]
    (reset! n now)
    (reset! sends [])
    (reset! (:record @hooks) [])
    (reset! captured [])))

(defn- drain!
  "Deliver every deliverable event to loaded sessions, one at a time in (time, ordinal) order.
   Events due for sessions this engine does not hold are removed and reported undelivered."
  [eng log]
  (let [{:keys [queue]} (engine eng)]
    (loop [log log undelivered [] guard 0]
      (if (> guard 10000)
        (throw (ex-info "drain did not settle (a send loop?)" {:processed guard}))
        (if-let [evt (q/take-due! queue (constantly true))]
          (let [target (:target evt)]
            (if (loaded? eng target)
              (recur (conj log (process-one eng target evt)) undelivered (inc guard))
              (recur log (conj undelivered target) (inc guard))))
          [log undelivered])))))

(defn- end-call! [eng log undelivered]
  (let [{:keys [sends hooks]} (engine eng)
        undelivered (set undelivered)]
    {:steps       log
     :outbox      (vec (mapcat (fn [{:keys [session-id outbox]}] (map #(assoc % :session-id session-id) outbox)) log))
     :sends       (->> @sends
                    (remove (fn [{:keys [target source-session-id]}] (= target source-session-id)))
                    (mapv (fn [{:keys [event data target source-session-id delay delivery-time send-id]}]
                            {:from source-session-id :to target :event event :data data
                             :delay (or delay 0) :due-at delivery-time :send-id send-id
                             :delivered (and (not (contains? undelivered target)) (loaded? eng target))})))
     :invocations @(:record @hooks)
     :errors      @captured
     ;; One snapshot per session this call moved, so the host can write them together (one atomic
     ;; write per call): an item's reason and the project step that took it are then durable at once.
     :snapshots   (into {} (map (fn [sid] [sid (dump eng sid)])) (distinct (map :session-id log)))}))

(defn- call
  "Run `f` (the call's own steps), then drain. A call that throws (a step limit, a chart that
   cannot be found…) changes nothing: sessions, their generations and the queue are put back as
   they were, so the host's last written snapshots stay the truth. `onSave` and invocation
   callbacks already made for earlier steps of the call are not taken back."
  [eng now f]
  (begin-call! eng now)
  (let [{:keys [store meta queue]} (engine eng)
        saved [@(:sessions store) @meta @(:session-queues queue) @(:next-ordinal queue)]]
    (try
      (let [log (f)
            [log undelivered] (drain! eng log)]
        (end-call! eng log undelivered))
      (catch :default e
        (let [[sessions m qs ord] saved]
          (reset! (:sessions store) sessions)
          (reset! meta m)
          (reset! (:session-queues queue) qs)
          (reset! (:next-ordinal queue) ord))
        (throw e)))))

(defn start!
  "Start chart `chart-name` as session `sid` with initial `data` (merged into the root data model)."
  [eng sid chart-name data now]
  (let [{:keys [env charts meta clock]} (engine eng)]
    (when-not (contains? charts chart-name)
      (throw (ex-info (str "Unknown chart " chart-name) {:chart chart-name :known (keys charts)})))
    (when (loaded? eng sid)
      (throw (ex-info (str "Session already loaded: " sid) {:session-id sid})))
    (call eng now
      (fn []
        (swap! meta assoc sid {:chart chart-name :generation 0})
        (let [wm1      (sp/start! (::sc/processor env) env (keyword chart-name)
                         {::sc/session-id sid ::sc/invocation-data (assoc (or data {}) :now (clock))})
              [wm2 ob] (drain-outbox wm1)]
          (save! eng sid wm2)
          [{:session-id sid :at (clock) :event :sova/started :before [] :after (configuration eng sid)
            :outbox ob :running (boolean (::sc/running? wm2))}])))))

(defn send!
  "Process event `event-name` (a keyword) with `data` on `sid`, then drain."
  [eng sid event-name data {:keys [now invoke-id]}]
  (when-not (loaded? eng sid)
    (throw (ex-info (str "Session not loaded: " sid) {:session-id sid})))
  (call eng now
    (fn []
      [(process-one eng sid (cond-> (evts/new-event {:name event-name :data (or data {})})
                              invoke-id (assoc :invokeid invoke-id)))])))

(defn next-due-at
  "Earliest delivery time of a pending event for a loaded session, or nil."
  [eng]
  (first (q/next-due (:queue (engine eng)) #(loaded? eng %))))

(defn fire-due!
  "Advance the clock to `now` and deliver everything due by then."
  [eng now]
  (call eng now (fn [] [])))

;; ---------------------------------------------------------------------------------------------
;; Trial and enabled events

(defn- event-names-of [t]
  (let [e (:event t)] (cond (nil? e) [] (keyword? e) [e] :else (vec e))))

(defn- candidate-transitions
  "For `event` on `wmem`, the transitions SCXML selection visits, each with its cond result:
   deepest state first, stopping per atomic state at the first taken one."
  [env wmem event]
  (let [src    (::sc/statechart-src wmem)
        penv   (impl/processing-env env src wmem)
        vwmem  (::sc/vwmem penv)
        chart  (::sc/statechart penv)
        seen   (volatile! [])]
    (vswap! vwmem assoc
      ::sc/enabled-transitions (chart/document-ordered-set chart)
      ::sc/states-to-invoke (chart/document-ordered-set chart)
      ::sc/internal-queue (com.fulcrologic.statecharts.util/queue))
    (env/assign! penv [:ROOT :_event] event)
    (let [taken (impl/select-transitions* chart (::sc/configuration @vwmem)
                  (fn [t]
                    (if (and (contains? t :event) (evts/name-match? (:event t) event))
                      (let [ok (impl/condition-match penv t)]
                        (vswap! seen conj {:transition t :cond ok})
                        ok)
                      false)))]
      {:taken (vec taken) :seen @seen :chart chart})))

(defn- tags-of [t]
  (into {} (filter (fn [[k _]] (and (keyword? k) (= "sova" (namespace k))))) t))

(defn- describe [chart {:keys [transition cond]}]
  (merge {:source (chart/get-parent chart transition)
          :target (vec (:target transition))
          :event  (event-names-of transition)
          :cond   cond}
    (tags-of transition)))

(defn- scratch-env
  "An env for speculation: same registry, a fresh queue on the same clock, invocations recorded only."
  [eng]
  (let [{:keys [registry clock types limit]} (engine eng)
        sent  (atom [])
        sq    (q/new-queue clock (fn [req] (swap! sent conj req)))
        hooks (atom {:trial? true :record (atom [])})]
    [(build-env registry sq (->CallbackStore (atom {}) nil) types hooks limit) sent hooks]))

(defn trial
  "Would `event-name` with `data` be taken on `sid`? Runs the real step on a copy of working memory
   with a scratch queue: nothing is saved, sent or invoked."
  [eng sid event-name data {:keys [now invoke-id]}]
  (let [{:keys [clock] n :now} (engine eng)]
    (when-not (loaded? eng sid)
      (throw (ex-info (str "Session not loaded: " sid) {:session-id sid})))
    (reset! n now)
    (reset! captured [])
    (let [[senv sent hooks] (scratch-env eng)
          wm0    (with-now (wmem-of eng sid) (clock))
          event  (cond-> (evts/new-event {:name event-name :data (assoc (or data {}) :at (clock))})
                   invoke-id (assoc :invokeid invoke-id))
          {:keys [taken seen chart]} (candidate-transitions senv wm0 event)
          wm1    (sp/process-event! (::sc/processor senv) senv wm0 event)
          [_ ob] (drain-outbox wm1)
          before (chart/in-document-order chart (::sc/configuration wm0))
          after  (chart/in-document-order chart (::sc/configuration wm1))]
      {:taken         (boolean (seq taken))
       :transitions   (mapv #(describe chart {:transition (chart/element chart %) :cond true}) taken)
       :refused       (if (seq taken) [] (mapv #(describe chart %) (remove :cond seen)))
       :before        before
       :configuration after
       :outbox        ob
       :sends         (mapv (fn [{:keys [event target delay data]}] {:to target :event event :delay (or delay 0) :data data})
                        @sent)
       :invocations   @(:record @hooks)
       :errors        @captured})))

(defn enabled-events
  "Event names on transitions of the active configuration (and ancestors) whose cond passes with
   `envelope` as the event data, in document order of their first transition."
  [eng sid envelope {:keys [now]}]
  (when-not (loaded? eng sid)
    (throw (ex-info (str "Session not loaded: " sid) {:session-id sid})))
  (let [{:keys [clock env] n :now} (engine eng)
        _     (reset! n now)
        wm0   (with-now (wmem-of eng sid) (clock))
        chart (chart-of eng sid)
        names (->> (::sc/configuration wm0)
                (chart/in-document-order chart)
                (mapcat #(chart/transitions chart %))
                (mapcat #(event-names-of (chart/element chart %)))
                (distinct))]
    (reset! captured [])
    (vec (filter (fn [nm]
                   (seq (:taken (candidate-transitions env wm0 (evts/new-event {:name nm :data (assoc (or envelope {}) :at (clock))})))))
           names))))

;; ---------------------------------------------------------------------------------------------
;; Durability

(defn dump
  "EDN text of `sid`'s snapshot: working memory + its pending queue + chart version + generation."
  [eng sid]
  (when-let [wm (wmem-of eng sid)]
    (binding [*print-namespace-maps* false *print-length* nil *print-level* nil]
      (pr-str (snapshot-of eng sid wm)))))

(defn snapshot-text [snap]
  (binding [*print-namespace-maps* false *print-length* nil *print-level* nil]
    (pr-str snap)))

(defn load!
  "Replace (or add) session `sid` from snapshot `text`. Refuses any chart version mismatch: there is
   no snapshot migration (a chart change starts sessions fresh). Nothing runs: send a resume event
   afterwards."
  [eng sid text]
  (let [{:keys [charts meta queue]} (engine eng)
        ;; plain EDN: snapshots hold no tagged literal but, possibly, a uuid (cljs.reader's other tag
        ;; readers, #inst #queue #js, are 3 KB the charts' data never needs; an unknown tag throws)
        snap (edn/read-string {:readers {'uuid uuid}} text)
        {:keys [chart version wmem generation ordinal]} snap
        cur  (get-in charts [chart :version])]
    (when-not (= snapshot-format (::format snap))
      (throw (ex-info "Unknown snapshot format" {:format (::format snap)})))
    (when-not (contains? charts chart)
      (throw (ex-info (str "Snapshot of unknown chart " chart) {:chart chart})))
    (when (not= version cur)
      (throw (ex-info (str "Snapshot is chart " chart " v" version ", this build has v" cur)
               {:chart chart :snapshot-version version :version cur})))
    (let [wm (assoc wmem ::sc/session-id sid)]
      (swap! meta assoc sid {:chart chart :generation (or generation 0)})
      (swap! (:sessions (:store (engine eng))) assoc sid wm)
      (q/restore-session! queue sid (mapv (fn [e] (assoc-in e [:event :target] sid)) (:queue snap)) ordinal)
      {:session-id sid :chart chart :version cur :generation (or generation 0)
       :configuration (configuration eng sid) :pending (count (:queue snap))})))

(defn unload!
  "Forget `sid` and its pending events (after the host saved it)."
  [eng sid]
  (let [{:keys [store meta queue]} (engine eng)]
    (swap! (:sessions store) dissoc sid)
    (swap! meta dissoc sid)
    (q/drop-session! queue sid)
    nil))

(defn generation [eng sid] (get-in @(:meta (engine eng)) [sid :generation]))

(defn snapshot-meta [eng sid] (get @(:meta (engine eng)) sid))

(defn running?
  "False once the session reached a top-level final state."
  [eng sid]
  (boolean (some-> (wmem-of eng sid) ::sc/running?)))
