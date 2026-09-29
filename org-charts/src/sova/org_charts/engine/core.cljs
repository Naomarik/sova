(ns sova.org-charts.engine.core
  "The engine: fulcrologic/statecharts (v20150901, flat working-memory data model, lambda execution)
   driven synchronously, with owned adapters (API.md):

   - a registry of charts, each with a version, migrations, storage class, exported keys and acts;
   - a durable delayed-event queue (`engine.queue`) on an injected clock;
   - spawn (a step creates sessions in the same call), watchers and `link/moved` notifications;
   - effects keyed for idempotency and kept pending (durable) until the host answers;
   - held effects (q10): a hold is data plus an engine timer; at its end the effect goes out;
   - typed host invocations with run ids (stale results dropped) and resume as cut-off;
   - explain (level → pre → state → checks → cond), enabled events, trial on a copy (the real call,
     rolled back), attended-only set-state (q9);
   - a step limit (`engine.bounded`): an event that takes more than `:max-microsteps` microsteps
     throws `:sova/step-limit`, and the whole call is rolled back.

   Everything here is CLJS data; `sova.org-charts.api` does the JS marshalling. One engine holds one
   org's sessions; one call processes its event and then drains every event that became deliverable
   (cross-session sends, link notifications, hold releases), one at a time in global
   (time, ordinal) order. A call is atomic: it commits, or it throws and nothing changed."
  (:require
    [clojure.string :as str]
    [cljs.tools.reader.edn :as edn]
    [com.fulcrologic.statecharts :as sc]
    [com.fulcrologic.statecharts.algorithms.v20150901-impl :as impl]
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.data-model.working-memory-data-model :as wmdm]
    [com.fulcrologic.statecharts.elements :as elements]
    [com.fulcrologic.statecharts.environment :as env]
    [com.fulcrologic.statecharts.events :as evts]
    [com.fulcrologic.statecharts.execution-model.lambda :as lambda]
    [com.fulcrologic.statecharts.protocols :as sp]
    [com.fulcrologic.statecharts.registry.local-memory-registry :as lmr]
    [com.fulcrologic.statecharts.util]
    [sova.org-charts.engine.bounded :as bounded]
    [sova.org-charts.engine.dsl :as dsl]
    [sova.org-charts.engine.hold-policy :as policy]
    [sova.org-charts.engine.queue :as q]
    [taoensso.timbre :as log]))

(def snapshot-format 1)
(def ^:private data-key ::wmdm/data-model)

(def unknown-session-type :sova/unknown-session)
(def session-exists-type :sova/session-exists)

(def attended-only
  "Setting a chart's state directly is allowed only to the project overseer in a turn the operator started. Use one of its declared corrections.")

;; ---------------------------------------------------------------------------------------------
;; Adapters

(defrecord CallbackStore [sessions]
  sp/WorkingMemoryStore
  (get-working-memory [_ _env session-id] (get @sessions session-id))
  (save-working-memory! [_ _env session-id wmem] (swap! sessions assoc session-id wmem))
  (delete-working-memory! [_ _env session-id] (swap! sessions dissoc session-id)))

(deftype HostInvocations [types record]
  ;; `record` is an atom of the current step's starts and stops; the engine gives each start a run
  ;; id and hands them to the host only once the call committed.
  sp/InvocationProcessor
  (supports-invocation-type? [_ typ] (contains? types typ))
  (start-invocation! [_ env {:keys [invokeid type params]}]
    (swap! record conj {:op :start :session-id (env/session-id env) :invoke-id invokeid :type type :params params})
    true)
  (stop-invocation! [_ env {:keys [invokeid type]}]
    (swap! record conj {:op :stop :session-id (env/session-id env) :invoke-id invokeid :type type})
    true)
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

(def default-invoke-types #{:sova/look :sova/reply :sova/wrapup :sova/reconcile})

(defn- build-env
  [registry queue store invoke-types record max-microsteps]
  (let [dm (wmdm/new-flat-model)]
    {::sc/statechart-registry   registry
     ::sc/data-model            dm
     ::sc/event-queue           queue
     ::sc/working-memory-store  store
     ::sc/processor             (bounded/new-processor max-microsteps)
     ::sc/invocation-processors [(->HostInvocations invoke-types record)]
     ::sc/execution-model       (lambda/new-execution-model dm queue)}))

(defn new-engine
  "`charts` is {name entry} (API.md §1; at least {:chart c :version n}).
   `opts`: :on-save (fn [sid snapshot-map]) and :on-invoke-start / :on-invoke-stop (fn [inv]), all
   called only after a call committed; :load-cold (fn [sid] → EDN text | nil) for sessions not loaded;
   :level-check (fn [tool need envelope] → sentence | nil); :stamp (fn [sid event payload ctx] →
   envelope), the host's fresh envelope for a held act's release and a chart-driven act (`ctx`: the
   original act's `:by :overseer-id :project-id`, or the driving session's `:project-id`); :clock (0-arity fn, default Date.now);
   :invoke-types; :max-microsteps (per event)."
  [charts {:keys [on-save on-invoke-start on-invoke-stop clock invoke-types max-microsteps load-cold level-check stamp]}]
  (let [now      (atom nil)
        clock-fn (fn [] (or @now (if clock (clock) (js/Date.now))))
        sends    (atom [])
        queue    (q/new-queue clock-fn (fn [req] (swap! sends conj req)))
        registry (lmr/new-registry)
        meta*    (atom {})                                   ; sid -> {:chart name :generation n}
        store    (->CallbackStore (atom {}))
        record   (atom [])
        types    (or invoke-types default-invoke-types)
        limit    (or max-microsteps bounded/default-max-microsteps)
        env      (build-env registry queue store types record limit)]
    (doseq [[nm {:keys [chart]}] charts]
      (sp/register-statechart! registry (keyword nm) chart))
    (atom {:charts charts :env env :queue queue :store store :now now :clock clock-fn :sends sends
           :meta meta* :record record :types types :registry registry :limit limit
           :on-save on-save :on-invoke-start on-invoke-start :on-invoke-stop on-invoke-stop
           :load-cold load-cold :level-check level-check :stamp stamp :cx (atom nil)})))

(defn- engine [eng] @eng)
(defn- sessions* [eng] (:sessions (:store (engine eng))))
(defn- wmem-of [eng sid] (get @(sessions* eng) sid))
(defn loaded? [eng sid] (some? (wmem-of eng sid)))
(defn session-ids [eng] (vec (sort (keys @(sessions* eng)))))
(defn- chart-name-of [eng sid] (:chart (get @(:meta (engine eng)) sid)))
(defn- entry-of [eng sid] (get (:charts (engine eng)) (chart-name-of eng sid)))

(defn- chart-of [eng sid]
  (sp/get-statechart (:registry (engine eng)) (keyword (chart-name-of eng sid))))

(defn- id-str [k] (cond (keyword? k) (subs (str k) 1) (nil? k) nil :else (str k)))

(defn configuration
  "Active state ids of `sid` in document order (ancestors included), or nil if not loaded."
  [eng sid]
  (when-let [wm (wmem-of eng sid)]
    (chart/in-document-order (chart-of eng sid) (::sc/configuration wm))))

(defn data [eng sid] (some-> (wmem-of eng sid) (get data-key)))

(defn running?
  "False once the session reached a top-level final state."
  [eng sid]
  (boolean (some-> (wmem-of eng sid) ::sc/running?)))

(defn- with-now [wmem now] (assoc-in wmem [data-key :now] now))

(declare dump load! process-one explain-refusal)

(defn- cx [eng] (:cx (engine eng)))
(defn- cx! [eng k v] (swap! (cx eng) update k (fnil conj []) v))

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

;; ---------------------------------------------------------------------------------------------
;; Loading sessions on demand (cold sessions, API.md §3)

(defn- unknown-session! [sid]
  (throw (ex-info (str "Unknown session: " sid) {:type unknown-session-type :session-id sid})))

(defn- ensure-loaded!
  "True when `sid` is loaded (loading it through :load-cold if needed). Without :load-cold an
   unloaded session is false (the spike's contract: undelivered). With it, an id that exists
   nowhere throws `:sova/unknown-session` (the call rolls back); a load-cold that throws (a broken
   snapshot) rolls the call back with its error."
  [eng sid]
  (cond
    (loaded? eng sid) true
    (nil? (:load-cold (engine eng))) false
    :else (if-let [text ((:load-cold (engine eng)) sid)]
            (do (load! eng sid text) (cx! eng :loaded sid) true)
            (unknown-session! sid))))

(defn- session-exists? [eng sid]
  (or (loaded? eng sid)
      (boolean (when-let [lc (:load-cold (engine eng))]
                 (when-let [text (lc sid)] (load! eng sid text) (cx! eng :loaded sid) true)))))

;; ---------------------------------------------------------------------------------------------
;; After a step: effects, holds, invocations, directives, notifications

(def ^:private diff-skip #{:now :_event :_sessionid :outbox :sova/pending :sova/invocations :sova/directives :seq})

(defn- diff
  "`{path [from to]}` for every data key that changed (maps one level deep: \"a.b\")."
  [a b]
  (let [ks (distinct (concat (keys a) (keys b)))]
    (into (sorted-map)
      (mapcat (fn [k]
                (let [x (get a k) y (get b k)]
                  (cond
                    (or (diff-skip k) (= x y)) nil
                    (and (map? x) (map? y))
                    (for [kk (distinct (concat (keys x) (keys y)))
                          :let [xx (get x kk) yy (get y kk)]
                          :when (not= xx yy)]
                      [(str (id-str k) "." (id-str kk)) [xx yy]])
                    :else [[(id-str k) [x y]]]))))
      ks)))

(defn- hold-send-id [id] (str "sova-hold/" id))

(defn- track-invocations
  "Give each start of this step a run id, drop the runs this step stopped. Returns
   [invocations-map records]."
  [eng sid invs records now]
  (let [queue (:queue (engine eng))]
    (reduce (fn [[m out] {:keys [op invoke-id] :as r}]
              (if (= op :start)
                (let [run (str sid "#" (id-str invoke-id) "#" (q/next-ordinal! queue))]
                  [(assoc m run {:type (:type r) :invoke-id invoke-id :since now})
                   (conj out (assoc r :run-id run))])
                (let [run (some (fn [[k v]] (when (= invoke-id (:invoke-id v)) k)) m)]
                  [(dissoc m run) (conj out (assoc r :run-id run))])))
      [(or invs {}) []]
      records)))

(defn- settle
  "`wm1` after the chart ran: effects keyed and pending, holds armed / cancelled, invocations
   tracked, directives taken out. Returns [wm2 info]."
  [eng sid wm0 wm1 records]
  (let [{:keys [queue env meta clock]} (engine eng)
        now     (clock)
        d0      (get wm0 data-key)
        d1      (get wm1 data-key)
        gen     (inc (or (get-in @meta [sid :generation]) 0))
        keyed   (vec (map-indexed (fn [i e]
                                    (let [ck (:key e)]
                                      (cond-> (assoc e :key (str sid "@" gen "." i))
                                        ck (assoc :chart-key ck))))
                       (:outbox d1)))
        pending (into (or (:sova/pending d1) {}) (map (juxt :key identity)) keyed)
        holds0  (or (:sova/holds d0) {})
        holds1  (or (:sova/holds d1) {})
        added   (vec (remove #(contains? holds0 %) (keys holds1)))
        removed (vec (remove #(contains? holds1 %) (keys holds0)))
        [invs recs] (track-invocations eng sid (:sova/invocations d1) records now)
        d2      (-> d1
                  (assoc :outbox [] :sova/pending pending :sova/invocations invs)
                  (dissoc :sova/directives))]
    (doseq [id added]
      (sp/send! queue env {:event :sova/hold-due :data {:id id} :target sid :source-session-id sid
                           :send-id (hold-send-id id) :delay (max 0 (- (:until (get holds1 id)) now))}))
    (doseq [id removed]
      (let [h (get holds0 id)]
        (sp/cancel! queue env sid (hold-send-id id))
        (sp/send! queue env {:event :hold/cancelled :data {:id id :kind (:kind h) :event (:event h) :by "system"}
                             :target sid :source-session-id sid})))
    [(assoc wm1 data-key d2)
     {:effects keyed :directives (vec (:sova/directives d1)) :invocations recs
      :holds (mapv #(assoc (get holds1 %) :session-id sid) added) :released removed :changed (diff d0 d2)}]))

(defn- link-payload [eng sid]
  (let [exported (:exported (entry-of eng sid))]
    {:from     sid
     :chart    (chart-name-of eng sid)
     :states   (configuration eng sid)
     :running  (running? eng sid)
     :exported (select-keys (data eng sid) exported)}))

(defn- notify!
  "Queue `link/moved` from `sid` to each of `watchers` (now, in ordinal order)."
  [eng sid watchers]
  (let [{:keys [queue env]} (engine eng)]
    (when (seq watchers)
      (let [payload (link-payload eng sid)]
        (doseq [w watchers]
          (sp/send! queue env {:event :link/moved :data payload :target w :source-session-id sid}))))
    (boolean (seq watchers))))

(defn- moved? [eng sid before-config before-running before-data]
  (let [exported (:exported (entry-of eng sid))]
    (or (not= before-config (configuration eng sid))
        (not= before-running (running? eng sid))
        (not= (select-keys before-data exported) (select-keys (data eng sid) exported)))))

(declare start-session! run-directives!)

(defn- envelope-tags [d]
  (let [e (or d {})]
    (cond-> {}
      (contains? e :by) (assoc :by (some-> (:by e) id-str))
      (contains? e :via) (assoc :via (some-> (:via e) id-str))
      (not (dsl/blank? (:reason e))) (assoc :reason (:reason e)))))

(defn- base-step [eng sid event]
  (merge {:session-id sid :chart (chart-name-of eng sid) :at ((:clock (engine eng)))
          :event (:name event) :data (:data event) :invoke-id (:invokeid event)}
    (envelope-tags (:data event))))

(defn- refused-step [eng sid event refusal]
  (let [c (configuration eng sid)]
    (assoc (base-step eng sid event)
      :before c :after c :changed {} :effects [] :outbox [] :refused refusal :saved false
      :running (running? eng sid) :microsteps 0)))

(defn- run-step!
  "Run `event` on `sid` through the chart (or `src`, a variant chart) and settle it. Returns the
   steps it produced (this one, then any its directives started)."
  ([eng sid event] (run-step! eng sid event nil))
  ([eng sid event {:keys [src]}]
   (let [{:keys [env clock record]} (engine eng)
         processor (::sc/processor env)
         wm0       (wmem-of eng sid)
         before    (configuration eng sid)
         brunning  (running? eng sid)
         bdata     (get wm0 data-key)
         now       (clock)
         _         (reset! record [])
         wm-in     (cond-> (with-now wm0 now) src (assoc ::sc/statechart-src src))
         wm1       (cond-> (sp/process-event! processor env wm-in event)
                     src (assoc ::sc/statechart-src (::sc/statechart-src wm0)))
         ms        (bounded/microsteps processor)
         records   @record
         quiet?    (and (zero? ms) (empty? records)
                     (= (apply dissoc (get wm1 data-key) diff-skip) (apply dissoc bdata diff-skip)))]
     (if quiet?
       ;; nothing happened: no save, no generation; an act that no transition took is refused
       (let [act? (contains? (:acts (entry-of eng sid)) (:name event))]
         [(if act?
            (refused-step eng sid event (or (explain-refusal eng sid (:name event) (:data event) {})
                                            {:sentence dsl/generic-refusal :stage :state}))
            (assoc (refused-step eng sid event nil) :refused nil :ignored true))])
       (let [[wm2 info] (settle eng sid wm0 wm1 records)
             _          (save! eng sid wm2)
             _          (doseq [r (:invocations info)] (cx! eng :invocations r))
             notified   (when (moved? eng sid before brunning bdata)
                          (notify! eng sid (:sova/watchers (data eng sid))))
             step       (assoc (base-step eng sid event)
                          :before before :after (configuration eng sid) :changed (:changed info)
                          :effects (mapv :key (:effects info)) :outbox (:effects info)
                          :holds (:holds info) :holds-ended (:released info)
                          :running (running? eng sid) :microsteps ms :saved true
                          :notified (boolean notified))]
         (into [step] (run-directives! eng sid (:directives info))))))))

(defn- start-session!
  "Start `sid` of `chart-name` with `data`: the steps (its start, then its directives')."
  [eng sid chart-name init]
  (let [{:keys [env charts meta clock record]} (engine eng)]
    (when-not (contains? charts chart-name)
      (throw (ex-info (str "Unknown chart " chart-name) {:chart chart-name :known (vec (keys charts))})))
    (when (loaded? eng sid)
      (throw (ex-info (str "Session already exists: " sid) {:type session-exists-type :session-id sid})))
    (swap! meta assoc sid {:chart chart-name :generation 0})
    (reset! record [])
    (let [now        (clock)
          processor  (::sc/processor env)
          wm1        (sp/start! processor env (keyword chart-name)
                       {::sc/session-id sid ::sc/invocation-data (assoc (or init {}) :now now)})
          ms         (bounded/microsteps processor)
          [wm2 info] (settle eng sid {} wm1 @record)]
      (save! eng sid wm2)
      (doseq [r (:invocations info)] (cx! eng :invocations r))
      (let [watchers (:sova/watchers (data eng sid))
            notified (notify! eng sid watchers)
            step     {:session-id sid :chart chart-name :at now :event :sova/started :data init
                      :before [] :after (configuration eng sid) :changed (:changed info)
                      :effects (mapv :key (:effects info)) :outbox (:effects info) :holds (:holds info)
                      :holds-ended [] :running (running? eng sid) :microsteps ms :saved true :notified notified}]
        (into [step] (run-directives! eng sid (:directives info)))))))

(defn- watch! [eng watcher target add?]
  (when-not (ensure-loaded! eng target) (unknown-session! target))
  (let [wm  (wmem-of eng target)
        ws  (vec (get-in wm [data-key :sova/watchers]))
        ws' (if add? (vec (distinct (conj ws watcher))) (vec (remove #{watcher} ws)))
        c   (configuration eng target)]
    (if (= ws ws')
      (do (when add? (notify! eng target [watcher])) [])
      (do
        (save! eng target (assoc-in wm [data-key :sova/watchers] ws'))
        (when add? (notify! eng target [watcher]))
        [{:session-id target :chart (chart-name-of eng target) :at ((:clock (engine eng)))
          :event (if add? :sova/watched :sova/unwatched) :data {:watcher watcher} :by "system"
          :before c :after c :changed {"sova/watchers" [ws ws']} :effects [] :outbox [] :holds []
          :holds-ended [] :running (running? eng target) :microsteps 0 :saved true}]))))

(defn- run-directives! [eng sid dirs]
  (vec
    (mapcat
      (fn [{:keys [op] :as d}]
        (case op
          :spawn (let [cid (:id d)]
                   (when (dsl/blank? cid)
                     (throw (ex-info (str "Spawn from " sid " has no session id") {:directive d})))
                   (if (session-exists? eng cid)
                     (if (= "skip" (id-str (:if-exists d)))
                       []
                       (throw (ex-info (str "Session already exists: " cid) {:type session-exists-type :session-id cid})))
                     (do
                       (cx! eng :spawned {:session-id cid :chart (:chart d) :by sid :link (:link d)})
                       (start-session! eng cid (:chart d)
                         (merge (:data d)
                           {:sova/links     (if (:link d) {(:link d) sid} {})
                            :sova/watchers  (if (:watch? d) [sid] [])
                            :sova/spawned-by sid})))))
          :drive (let [{:keys [queue env stamp]} (engine eng)
                       target (or (:target d) sid)
                       ctx    (:ctx d)
                       fresh  (when stamp (stamp target (:event d) (:data d) (assoc ctx :by "chart")))]
                   (sp/send! queue env {:event (:event d) :target target :source-session-id sid
                                        :data (merge (:data d) fresh {:by "chart" :attended false})})
                   [])
          :watch (watch! eng sid (:target d) true)
          :unwatch (watch! eng sid (:target d) false)
          (throw (ex-info (str "Unknown directive " op) {:directive d}))))
      dirs)))

;; ---------------------------------------------------------------------------------------------
;; Engine-handled events: hold releases and effect answers

(declare process-one)

(defn- release-act-hold!
  "An act's hold ended: re-deliver the act under a fresh envelope (never held again), then tell the
   session `:hold/released` or, when it is refused now, `:hold/dropped {:id :sentence …}`."
  [eng sid hold]
  (let [{:keys [stamp clock]} (engine eng)
        id      (:id hold)
        payload (:data hold)
        fresh   (when stamp (stamp sid (:event hold) payload (select-keys hold [:by :overseer-id :project-id])))
        steps   (process-one eng sid (evts/new-event {:name (:event hold)
                                                      :data (merge payload fresh {:sova/released id})}))
        refused (:refused (first steps))
        follow  (run-step! eng sid (evts/new-event
                                     {:name (if refused :hold/dropped :hold/released)
                                      :data (cond-> {:id id :event (:event hold) :kind (:kind hold) :what (:what hold)
                                                     :at (clock) :by "system"}
                                              refused (assoc :sentence (:sentence refused) :stage (:stage refused)
                                                        :check (:check refused)))}))
        all     (into (vec steps) follow)]
    ;; the hold's removal must reach the snapshot even when nothing else was saved
    (if (some #(and (:saved %) (= sid (:session-id %))) all)
      all
      (do (save! eng sid (wmem-of eng sid)) (conj all (assoc (last follow) :saved true))))))

(defn- release-hold! [eng sid event]
  (let [id   (get-in event [:data :id])
        wm   (wmem-of eng sid)
        hold (get-in wm [data-key :sova/holds id])]
    (cond
      (not hold) []                                         ; cancelled meanwhile: nothing to do
      (:act hold)
      (do (swap! (sessions* eng) update-in [sid data-key :sova/holds] dissoc id)
          (release-act-hold! eng sid hold))
      :else
      (let [ok?  (or (nil? (:while-in hold)) (contains? (::sc/configuration wm) (:while-in hold)))
            wm'  (-> wm
                   (update-in [data-key :sova/holds] dissoc id)
                   (cond-> ok? (update-in [data-key :outbox] (fnil conj []) (:effect hold))))
            ;; the step starts without the hold (so `settle` cancels no timer: this one fired)
            _    (swap! (sessions* eng) assoc sid wm')]
        (run-step! eng sid (evts/new-event {:name (if ok? :hold/released :hold/lapsed)
                                            :data {:id id :kind (:kind hold) :what (:what hold)
                                                   :at ((:clock (engine eng))) :by "system"}}))))))

(defn- answer-effect! [eng sid event]
  (let [k    (get-in event [:data :key])
        wm   (wmem-of eng sid)
        eff  (when k (get-in wm [data-key :sova/pending k]))]
    (cond
      (nil? k) (run-step! eng sid event)                    ; not keyed (spike charts): as is
      (nil? eff) (do (cx! eng :stale {:session-id sid :event (:name event) :key k}) [])
      :else (do
              (swap! (sessions* eng) update-in [sid data-key :sova/pending] dissoc k)
              (run-step! eng sid (update event :data #(merge {:kind (:kind eff)} % {:effect eff})))))))

(defn- scope-of
  "Whose ledger an act draws on: its project (`:project-id`, stamped by the host), else `:scope`."
  [envelope]
  (or (:project-id envelope) (:scope envelope)))

(defn- reserved
  "Units of `kind` the pending act holds of `scope` reserve (F2)."
  [eng scope kind]
  (reduce + 0 (for [sid (session-ids eng)
                    h   (vals (:sova/holds (data eng sid)))
                    :when (and (:act h) (= kind (:counts h)) (= scope (:scope h)))]
                (or (:reserve h) 1))))

(defn with-reservations
  "`envelope` with the pending holds of its scope counted as used (F2): the allowance of the act's
   `:counts` kind and its at-once count. A hold that passed its checks is then dropped at release
   only by a real change of facts."
  [eng act envelope]
  (let [kind (:counts act)
        n    (if kind (reserved eng (scope-of envelope) kind) 0)
        f    (get policy/at-once-field kind)]
    (if (zero? n)
      envelope
      (cond-> envelope
        (get-in envelope [:allowance (keyword kind)]) (update-in [:allowance (keyword kind) :used] (fnil + 0) n)
        (and f (get-in envelope [:at-once f])) (update-in [:at-once f] (fnil + 0) n)
        (and f (:at-once envelope) (nil? (get-in envelope [:at-once f]))) (assoc-in [:at-once f] n)))))

(defn- hold-act!
  "Put act `event` on hold: no transition now; the engine re-delivers it at the hold's end."
  [eng sid event orig act]
  (let [now    ((:clock (engine eng)))
        wm0    (wmem-of eng sid)
        d0     (get wm0 data-key)
        n      (:sova/hold-seq d0 0)
        ename  (:name event)
        id     (str (id-str ename) "#" n)
        payload (dissoc orig :at)
        view   (assoc d0 :_event {:name ename :data payload})
        hold   (cond-> {:id id :act true :event ename :data payload :kind (id-str ename)
                        :since now :until (+ now (policy/hold-ms payload d0))
                        :by (id-str (:by payload)) :scope (scope-of payload)}
                 (:overseer-id payload) (assoc :overseer-id (:overseer-id payload))
                 (:project-id payload) (assoc :project-id (:project-id payload))
                 (:counts act) (assoc :counts (:counts act)
                                 :reserve (if-let [f (:count act)] (f view) 1))
                 (:what act) (assoc :what (let [w (:what act)] (if (fn? w) (w view) w))))
        wm1    (-> wm0
                 (assoc-in [data-key :sova/hold-seq] (inc n))
                 (assoc-in [data-key :sova/holds id] hold))
        [wm2 info] (settle eng sid wm0 wm1 [])
        c      (configuration eng sid)]
    (save! eng sid wm2)
    [(assoc (base-step eng sid event)
       :before c :after c :changed (:changed info) :effects [] :outbox [] :holds (:holds info)
       :holds-ended [] :held hold :running (running? eng sid) :microsteps 0 :saved true)]))

(defn- process-one
  "Deliver `event` (an event map) to `sid`: the steps it produced. An act is gated first (final,
   level, the act's pre checks) with the pending holds reserved (F2); an act the hold policy holds
   is checked in full and then held instead of taken."
  [eng sid event]
  (let [{:keys [clock]} (engine eng)
        event (assoc-in event [:data :at] (clock))
        ename (:name event)
        act   (get-in (entry-of eng sid) [:acts ename])]
    (cond
      (= ename :sova/hold-due) (release-hold! eng sid event)
      (#{:effect/done :effect/failed} ename) (answer-effect! eng sid event)
      (nil? act) (run-step! eng sid event)
      :else
      (let [orig  (:data event)
            event (update event :data #(with-reservations eng act %))
            d     (:data event)]
        (if-let [r (explain-refusal eng sid ename d {:stages #{:final :level :pre}})]
          [(refused-step eng sid event r)]
          (if (and (not (:sova/released d)) (policy/held? act d (data eng sid)))
            (if-let [r (explain-refusal eng sid ename d {:stages #{:state :check}})]
              [(refused-step eng sid event r)]
              (hold-act! eng sid event orig act))
            (run-step! eng sid event)))))))

;; ---------------------------------------------------------------------------------------------
;; Calls

(defn- begin-call! [eng now]
  (let [{:keys [sends record] n :now} (engine eng)]
    (reset! n now)
    (reset! sends [])
    (reset! record [])
    (reset! (cx eng) {})
    (reset! captured [])))

(defn- drain!
  "Deliver every deliverable event (restricted to `pred-event` when given), one at a time in
   (time, ordinal) order. Events for sessions this engine cannot load are reported undelivered."
  [eng log pred-event]
  (let [{:keys [queue]} (engine eng)]
    (loop [log log undelivered [] guard 0]
      (if (> guard 10000)
        (throw (ex-info "drain did not settle (a send loop?)" {:processed guard}))
        (if-let [evt (q/take-due! queue (constantly true) pred-event)]
          (let [target (:target evt)]
            (if (ensure-loaded! eng target)
              (recur (into log (process-one eng target evt)) undelivered (inc guard))
              (recur log (conj undelivered target) (inc guard))))
          [log undelivered])))))

(defn- save-state [eng]
  (let [{:keys [meta queue]} (engine eng)]
    [@(sessions* eng) @meta @(:session-queues queue) @(:next-ordinal queue)]))

(defn- restore! [eng [sessions m qs ord]]
  (let [{:keys [meta queue]} (engine eng)]
    (reset! (sessions* eng) sessions)
    (reset! meta m)
    (reset! (:session-queues queue) qs)
    (reset! (:next-ordinal queue) ord)))

(defn- end-call! [eng log undelivered [_ _ qs0 _] self-sends?]
  (let [{:keys [sends queue]} (engine eng)
        undelivered (set undelivered)
        qs1     @(:session-queues queue)
        stepped (set (map :session-id (filter :saved log)))
        queued  (set (filter (fn [sid] (and (loaded? eng sid) (not (identical? (get qs0 sid) (get qs1 sid)))))
                       (distinct (concat (keys qs0) (keys qs1)))))
        touched (sort (into stepped queued))
        c       @(cx eng)]
    {:steps       log
     :outbox      (vec (mapcat (fn [{:keys [session-id outbox]}] (map #(assoc % :session-id session-id) outbox)) log))
     :holds       (vec (mapcat :holds log))
     :sends       (->> @sends
                    (remove (fn [{:keys [target source-session-id event]}]
                              (or (and (not self-sends?) (= target source-session-id))
                                  (= "sova" (namespace event)))))
                    (mapv (fn [{:keys [event data target source-session-id delay delivery-time send-id]}]
                            {:from source-session-id :to target :event event :data data
                             :delay (or delay 0) :due-at delivery-time :send-id send-id
                             :delivered (and (not (contains? undelivered target)) (loaded? eng target))})))
     :invocations (vec (:invocations c))
     :spawned     (vec (:spawned c))
     :loaded      (vec (distinct (:loaded c)))
     :stale       (vec (:stale c))
     :errors      @captured
     ;; One snapshot per session this call moved (a step, or a pending event added or removed):
     ;; the host writes them together (one journal per call).
     :snapshots   (into (sorted-map) (map (fn [sid] [sid (dump eng sid)])) touched)}))

(defn- fire-callbacks! [eng res]
  (let [{:keys [on-save on-invoke-start on-invoke-stop]} (engine eng)]
    (when on-save
      (doseq [sid (keys (:snapshots res))]
        (on-save sid (snapshot-of eng sid (wmem-of eng sid)))))
    (doseq [inv (:invocations res)]
      (case (:op inv)
        :start (when on-invoke-start (on-invoke-start inv))
        :stop (when on-invoke-stop (on-invoke-stop inv))))))

(defn- call
  "Run `f` (the call's own steps; returns them), then drain. opts: `:due-first` (deliver what is due
   before `f`: W5), `:rollback` (a trial: compute the result, then put everything back),
   `:own-only` (drain only events this call queued: resume). A call that throws changes nothing:
   sessions, generations and the queue are put back; no callback has run."
  [eng now {:keys [due-first rollback own-only]} f]
  (begin-call! eng now)
  (let [saved (save-state eng)
        mark  (q/ordinal (:queue (engine eng)))]
    (try
      (let [[log0 u0] (if due-first (drain! eng [] nil) [[] []])
            log1      (into log0 (f))
            [log2 u1] (drain! eng log1 (when own-only (fn [e] (> (q/event-ordinal e) mark))))
            res       (end-call! eng log2 (into u0 u1) saved (boolean rollback))]
        (if rollback (restore! eng saved) (fire-callbacks! eng res))
        res)
      (catch :default e
        (restore! eng saved)
        (throw e)))))

(defn start!
  "Start chart `chart-name` as session `sid` with initial `data` (merged into the root data model)."
  [eng sid chart-name data now]
  (call eng now {:due-first true}
    (fn []
      (when (session-exists? eng sid)
        (throw (ex-info (str "Session already exists: " sid) {:type session-exists-type :session-id sid})))
      (start-session! eng sid chart-name data))))

(defn- resolve-invoke-id
  "The library's invoke id for run `run` of `sid` (a run id, or a bare invoke id of an active run),
   or ::stale."
  [eng sid run]
  (let [invs (:sova/invocations (data eng sid))]
    (cond
      (contains? invs run) (:invoke-id (get invs run))
      :else (or (some (fn [[_ v]] (when (= (id-str (:invoke-id v)) (id-str run)) (:invoke-id v))) invs)
                ::stale))))

(defn- external-event [eng sid event-name data invoke-id]
  (let [iid (when invoke-id (resolve-invoke-id eng sid invoke-id))]
    (if (= iid ::stale)
      (do (cx! eng :stale {:session-id sid :event event-name :invoke-id invoke-id}) nil)
      (cond-> (evts/new-event {:name event-name :data (or data {})})
        iid (assoc :invokeid iid)))))

(defn send!
  "Process event `event-name` (a keyword) with `data` on `sid`, then drain. What is due at `now` is
   delivered first. `invoke-id`: the run id of the invocation this reports on (stale → dropped)."
  [eng sid event-name data {:keys [now invoke-id]}]
  (call eng now {:due-first true}
    (fn []
      (when-not (ensure-loaded! eng sid)
        (throw (ex-info (str "Session not loaded: " sid) {:type unknown-session-type :session-id sid})))
      (if-let [ev (external-event eng sid event-name data invoke-id)]
        (process-one eng sid ev)
        []))))

(defn next-due-at
  "Earliest delivery time of a pending event for a loaded session, or nil."
  [eng]
  (first (q/next-due (:queue (engine eng)) #(loaded? eng %))))

(defn fire-due!
  "Advance the clock to `now` and deliver everything due by then."
  [eng now]
  (call eng now {} (fn [] [])))

;; ---------------------------------------------------------------------------------------------
;; Explain, trial, enabled events

(defn- event-names-of [t]
  (let [e (:event t)] (cond (nil? e) [] (keyword? e) [e] :else (vec e))))

(defn- processing-env-for [env wmem event]
  (let [src   (::sc/statechart-src wmem)
        penv  (impl/processing-env env src wmem)
        vwmem (::sc/vwmem penv)
        chart (::sc/statechart penv)]
    (vswap! vwmem assoc
      ::sc/enabled-transitions (chart/document-ordered-set chart)
      ::sc/states-to-invoke (chart/document-ordered-set chart)
      ::sc/internal-queue (com.fulcrologic.statecharts.util/queue))
    (env/assign! penv [:ROOT :_event] event)
    penv))

(defn- candidate-transitions
  "For `event` on `wmem`, the transitions SCXML selection visits, each with its cond result:
   deepest state first, stopping per atomic state at the first taken one."
  [env wmem event]
  (let [penv  (processing-env-for env wmem event)
        vwmem (::sc/vwmem penv)
        chart (::sc/statechart penv)
        seen  (volatile! [])
        taken (impl/select-transitions* chart (::sc/configuration @vwmem)
                (fn [t]
                  (if (and (contains? t :event) (evts/name-match? (:event t) event))
                    (let [ok (impl/condition-match penv t)]
                      (vswap! seen conj {:transition t :cond ok})
                      ok)
                    false)))]
    {:taken (vec taken) :seen @seen :chart chart}))

(defn- plain-tags [t]
  (into {}
    (keep (fn [[k v]]
            (when (and (keyword? k) (= "sova" (namespace k)))
              (cond
                (= k :sova/checks) [k (vec (map-indexed (fn [i c] (dsl/check-name c i)) v))]
                (fn? v) nil
                :else [k v]))))
    t))

(defn- describe [chart {:keys [transition cond]}]
  (merge {:source (chart/get-parent chart transition)
          :target (vec (:target transition))
          :event  (event-names-of transition)
          :cond   cond}
    (plain-tags transition)))

(defn- cond-holds? [penv c]
  (if (nil? c) true (impl/condition-match penv {:id ::probe-cond :node-type :transition :cond c})))

(defn- transition-refusal
  "Why transition `t` is not taken (its checks in order, then its cond), or nil when it would be."
  [penv data t skip-payload?]
  (if (:sova/act t)
    (or (dsl/first-refusal (:sova/checks t) data :check skip-payload?)
        (when-not (cond-holds? penv (:sova/cond t))
          {:sentence (or (:sova/refusal t) dsl/generic-refusal) :stage :cond}))
    (when-not (cond-holds? penv (:cond t))
      {:sentence (or (:sova/refusal t) dsl/generic-refusal) :stage :cond})))

(defn explain-refusal
  "Why act `event-name` with `envelope` (+ payload) would be refused on `sid`, as a refusal map
   `{:sentence :stage :check :tail :status :code}`, or nil. Stages in order: :final, :level (the
   act's `:needs`), :pre (the act's pre checks), :state (no transition for it here: the chart's
   `:not-here`), then the transitions' :check and :cond. opts: `:stages` (a subset to run),
   `:skip-payload?` (skip checks marked `:payload?`)."
  [eng sid event-name envelope {:keys [stages skip-payload?]}]
  (let [{:keys [env level-check]} (engine eng)
        entry  (entry-of eng sid)
        wm     (wmem-of eng sid)
        d      (get wm data-key)
        config (::sc/configuration wm)
        run?   (running? eng sid)
        stage? (fn [s] (or (nil? stages) (contains? stages s)))
        act    (get-in entry [:acts event-name])
        edata  (assoc d :_event {:name event-name :data envelope})]
    (if-let [legacy (:explain entry)]
      (when (or (nil? stages) (stage? :state))
        (dsl/as-refusal (legacy event-name (assoc d :sova/configuration (set config) :sova/running? run?) envelope) :legacy nil))
      (or
        (when (and (stage? :final) (not run?))
          {:sentence (or (:final-refusal entry) "This has ended.") :stage :final})
        (when (and (stage? :level) act (:needs act) level-check)
          (dsl/as-refusal (level-check (:tool act) (:needs act) envelope) :level nil))
        (when (stage? :pre) (dsl/first-refusal (:pre act) edata :pre skip-payload?))
        (when (or (stage? :state) (stage? :check))
          (let [event (evts/new-event {:name event-name :data envelope})
                penv  (processing-env-for env wm event)
                chart (::sc/statechart penv)
                cands (volatile! [])
                _     (impl/select-transitions* chart (::sc/configuration @(::sc/vwmem penv))
                        (fn [t]
                          (when (and (contains? t :event) (evts/name-match? (:event t) event))
                            (vswap! cands conj t))
                          false))
                cands (distinct @cands)
                data  (sp/current-data (::sc/data-model penv) penv)]
            (cond
              (empty? cands)
              (when (stage? :state)
                {:sentence (or (when-let [f (:not-here entry)] (f event-name config d))
                               dsl/generic-refusal)
                 :stage :state})
              :else
              (when (stage? :check)
                (let [rs (map #(transition-refusal penv data % skip-payload?) cands)]
                  (when (every? some? rs) (first rs)))))))))))

(defn explain
  "The refusal (a map) act `event-name` with `envelope` would get on `sid` now, or nil."
  [eng sid event-name envelope {:keys [now]}]
  (when-not (loaded? eng sid) (throw (ex-info (str "Session not loaded: " sid) {:session-id sid})))
  (reset! (:now (engine eng)) now)
  (reset! captured [])
  (let [act (get-in (entry-of eng sid) [:acts event-name])]
    (explain-refusal eng sid event-name (if act (with-reservations eng act envelope) envelope) {})))

(defn trial
  "Would `event-name` with `data` be taken on `sid`? The real call (what is due first, then the
   event and everything it drains) on the engine, then rolled back: nothing is saved, sent, invoked
   or called back. Returns the call result plus :taken, :refusal (a map), :transitions, :refused,
   :before, :configuration."
  [eng sid event-name data {:keys [now invoke-id]}]
  (let [cap (atom nil)
        res (call eng now {:due-first true :rollback true}
              (fn []
                (when-not (ensure-loaded! eng sid)
                  (throw (ex-info (str "Session not loaded: " sid) {:type unknown-session-type :session-id sid})))
                (let [{:keys [env clock]} (engine eng)
                      before (configuration eng sid)
                      ev     (external-event eng sid event-name data invoke-id)
                      cands  (when ev (candidate-transitions env (with-now (wmem-of eng sid) (clock))
                                        (assoc-in ev [:data :at] (clock))))
                      steps  (if ev (process-one eng sid ev) [])
                      step   (first steps)
                      taken  (boolean (and step (:saved step) (not (:refused step))))
                      refusal (when-not taken
                                (or (:refused step)
                                    (when ev (explain-refusal eng sid event-name data {}))
                                    (when-not ev {:sentence "That result is for a run that has ended." :stage :stale})))]
                  (reset! cap {:taken taken :refusal refusal :before before
                               :configuration (configuration eng sid)
                               :transitions (if cands (mapv #(describe (:chart cands) {:transition (chart/element (:chart cands) %) :cond true}) (:taken cands)) [])
                               :refused (if (and cands (not taken)) (mapv #(describe (:chart cands) %) (remove :cond (:seen cands))) [])})
                  steps)))]
    (merge res @cap)))

(defn enabled-events
  "Per act the chart declares (sorted by name): `{:event :enabled :refusal?}` under `envelope`
   (payload checks skipped). A chart without `:acts`: the events on active transitions whose guard
   passes, as `{:event :enabled true}`."
  [eng sid envelope {:keys [now]}]
  (when-not (loaded? eng sid)
    (throw (ex-info (str "Session not loaded: " sid) {:session-id sid})))
  (let [{:keys [clock env] n :now} (engine eng)
        _     (reset! n now)
        _     (reset! captured [])
        acts  (:acts (entry-of eng sid))]
    (if (seq acts)
      (mapv (fn [e]
              (let [r (explain-refusal eng sid e (with-reservations eng (get acts e) envelope) {:skip-payload? true})]
                (cond-> {:event e :enabled (nil? r)} r (assoc :refusal r))))
        (sort-by id-str (keys acts)))
      (let [wm0   (with-now (wmem-of eng sid) (clock))
            chart (chart-of eng sid)
            names (->> (::sc/configuration wm0)
                    (chart/in-document-order chart)
                    (mapcat #(chart/transitions chart %))
                    (mapcat #(event-names-of (chart/element chart %)))
                    (distinct))]
        (vec (keep (fn [nm]
                     (when (seq (:taken (candidate-transitions env wm0 (evts/new-event {:name nm :data (assoc (or envelope {}) :at (clock))}))))
                       {:event nm :enabled true}))
               names))))))

;; ---------------------------------------------------------------------------------------------
;; Holds

(defn holds
  "Every held act of every loaded session (or of `sid`), by end time."
  ([eng] (vec (sort-by (juxt :until :session-id :id) (mapcat #(holds eng %) (session-ids eng)))))
  ([eng sid] (mapv #(assoc % :session-id sid) (vals (:sova/holds (data eng sid))))))

;; ---------------------------------------------------------------------------------------------
;; Set-state (q9: attended turns only, a reason required)

(defn- top-state [chart]
  (let [tops (filter #(let [e (chart/element chart %)]
                        (and (#{:state :parallel :final} (:node-type e)) (not (:initial? e))))
               (:children chart))]
    (when (and (= 1 (count tops)) (= :state (:node-type (chart/element chart (first tops)))))
      (first tops))))

(defn- states-refusal [chart states]
  (let [ids (set (keys (::sc/elements-by-id chart)))
        bad (first (remove #(and (contains? ids %) (#{:state :parallel :final} (:node-type (chart/element chart %)))) states))]
    (cond
      (empty? states) {:sentence "Name the states to set." :stage :invalid}
      bad {:sentence (str "This chart has no state " (id-str bad) ".") :stage :invalid}
      :else
      (first
        (for [a states b states
              :when (and (not= a b)
                      (not (chart/descendant? chart a b)) (not (chart/descendant? chart b a)))
              :let [lca (chart/find-least-common-compound-ancestor chart [a b])]
              :when (not= :parallel (:node-type lca))]
          {:sentence (str "Those states can't be active together: " (id-str a) " and " (id-str b) ".") :stage :invalid})))))

(defn- set-state-src
  "Register a copy of `sid`'s chart with one more transition on its top state: `:sova/set-state`
   to `states` (internal: the top state itself is neither exited nor entered)."
  [eng sid states]
  (let [{:keys [registry]} (engine eng)
        cname (chart-name-of eng sid)
        c     (chart-of eng sid)
        top   (top-state c)
        tid   :sova.engine/set-state
        t     (assoc (elements/transition {:id tid :event :sova/set-state :target (vec states) :type :internal}) :parent top)
        c'    (-> c
                (assoc-in [::sc/elements-by-id tid] t)
                (update-in [::sc/elements-by-id top :children] (fnil conj []) tid)
                (update ::sc/id-ordinals assoc tid (count (::sc/id-ordinals c)))
                (update ::sc/ids-in-document-order conj tid))
        k     (keyword "sova.set-state" cname)]
    (sp/register-statechart! registry k c')
    k))

(defn set-state!
  "Put `sid` in `states` (state ids; unnamed parallel regions take their defaults), merging `patch`
   into its data first, with exits and entries run (timers, invocations). Refused unless the
   envelope is the operator's or an attended turn's, and `reason` is given."
  [eng sid {:keys [states patch reason]} envelope {:keys [now]}]
  (call eng now {:due-first true}
    (fn []
      (when-not (ensure-loaded! eng sid) (unknown-session! sid))
      (let [states (vec (distinct (map keyword states)))
            ev     (evts/new-event {:name :sova/set-state
                                    :data (merge (select-keys envelope [:by :via :attended])
                                            {:states (mapv id-str states) :reason reason :at ((:clock (engine eng)))})})
            c      (chart-of eng sid)
            r      (cond
                     (not (and (= "overseer" (some-> (:by envelope) id-str)) (true? (:attended envelope))
                               (not= "overseer" (some-> (:via envelope) id-str))))
                     {:sentence attended-only :stage :level}
                     (dsl/blank? reason) {:sentence dsl/reason-required :stage :invalid}
                     (nil? (top-state c)) {:sentence "This chart has no single top state to set from." :stage :invalid}
                     :else (states-refusal c states))]
        (if r
          [(refused-step eng sid ev r)]
          (let [src (set-state-src eng sid states)]
            (when (seq patch) (swap! (sessions* eng) update-in [sid data-key] merge patch))
            (run-step! eng sid ev {:src src})))))))

;; ---------------------------------------------------------------------------------------------
;; Resume

(defn resume!
  "After loading an org's sessions: `sova/resumed {:cut-off [runs]}` to each of `sids` (every
   invocation it held is cut off), then one `link/moved` to each watcher of each (unless its
   resumed step already sent them). Only what this call queues is delivered: past-due timers wait
   for `fire-due!`, which the host calls once every chunk has resumed."
  [eng sids {:keys [now]}]
  (call eng now {:own-only true}
    (fn []
      (vec
        (mapcat
          (fn [sid]
            (when-not (ensure-loaded! eng sid) (unknown-session! sid))
            (let [invs (:sova/invocations (data eng sid))
                  cut  (mapv (fn [[run v]] {:run-id run :type (id-str (:type v)) :invoke-id (id-str (:invoke-id v))}) (sort-by key invs))
                  _    (swap! (sessions* eng) assoc-in [sid data-key :sova/invocations] {})
                  steps (process-one eng sid (evts/new-event {:name :sova/resumed :data {:cut-off cut :by "system"}}))
                  mine  (first steps)]
              (when-not (:notified mine)
                (notify! eng sid (:sova/watchers (data eng sid))))
              (if (and (seq invs) (not (:saved mine)))
                ;; the cleared runs must reach the snapshot even when the chart ignored the event
                (do (save! eng sid (wmem-of eng sid))
                    (into [(assoc mine :saved true :ignored false)] (rest steps)))
                steps)))
          sids)))))

;; ---------------------------------------------------------------------------------------------
;; Durability and migrations

(defn dump
  "EDN text of `sid`'s snapshot: working memory + its pending queue + chart version + generation."
  [eng sid]
  (when-let [wm (wmem-of eng sid)]
    (binding [*print-namespace-maps* false *print-length* nil *print-level* nil]
      (pr-str (snapshot-of eng sid wm)))))

(defn snapshot-text [snap]
  (binding [*print-namespace-maps* false *print-length* nil *print-level* nil]
    (pr-str snap)))

(defn read-snapshot [text]
  ;; plain EDN: snapshots hold no tagged literal but, possibly, a uuid
  (edn/read-string {:readers {'uuid uuid}} text))

(defn- ->shape [{:keys [wmem queue]}]
  {:config  (set (::sc/configuration wmem))
   :data    (get wmem data-key)
   :history (::sc/history-value wmem)
   :queue   (vec queue)})

(defn- <-shape [snap {:keys [config data history queue]}]
  (-> snap
    (update :wmem #(-> %
                     (assoc ::sc/configuration (set config) data-key data)
                     (assoc ::sc/history-value (or history {}))
                     (update ::sc/initialized-states (fn [s] (into (set s) config)))))
    (assoc :queue (vec queue))))

(defn migrate-snapshot
  "`snap` (read) brought to its chart's current version by chaining `:migrate` (vN → vN+1)."
  [charts snap]
  (let [{:keys [chart version]} snap
        entry (get charts chart)
        cur   (:version entry)]
    (when-not (= snapshot-format (::format snap))
      (throw (ex-info "Unknown snapshot format" {:format (::format snap)})))
    (when-not entry
      (throw (ex-info (str "Snapshot of unknown chart " chart) {:chart chart})))
    (cond
      (= version cur) snap
      (> version cur)
      (throw (ex-info (str "Snapshot is chart " chart " v" version ", newer than this build's v" cur)
               {:chart chart :snapshot-version version :version cur}))
      :else
      (loop [s snap v version]
        (if (= v cur)
          s
          (let [f (get-in entry [:migrate v])]
            (when-not f
              (throw (ex-info (str "Snapshot is chart " chart " v" version ", this build has v" cur " and no migration from v" v)
                       {:chart chart :snapshot-version version :version cur})))
            (recur (assoc (<-shape s (f (->shape s))) :version (inc v)) (inc v))))))))

(defn migrate-text
  "EDN snapshot `text` at its chart's current version (tests load every shipped version)."
  [charts text]
  (snapshot-text (migrate-snapshot charts (read-snapshot text))))

(defn load!
  "Replace (or add) session `sid` from snapshot `text`, migrating an older chart version. Nothing
   runs: resume afterwards."
  [eng sid text]
  (let [{:keys [charts meta queue]} (engine eng)
        snap (migrate-snapshot charts (read-snapshot text))
        {:keys [chart version wmem generation ordinal]} snap
        wm   (assoc wmem ::sc/session-id sid ::sc/statechart-src (keyword chart))]
    (swap! meta assoc sid {:chart chart :generation (or generation 0)})
    (swap! (sessions* eng) assoc sid wm)
    (q/restore-session! queue sid (mapv (fn [e] (assoc-in e [:event :target] sid)) (:queue snap)) ordinal)
    {:session-id sid :chart chart :version version :generation (or generation 0)
     :configuration (configuration eng sid) :pending (count (:queue snap))}))

(defn unload!
  "Forget `sid` and its pending events (after the host saved it)."
  [eng sid]
  (let [{:keys [meta queue]} (engine eng)]
    (swap! (sessions* eng) dissoc sid)
    (swap! meta dissoc sid)
    (q/drop-session! queue sid)
    nil))

(defn generation [eng sid] (get-in @(:meta (engine eng)) [sid :generation]))

(defn snapshot-meta [eng sid] (get @(:meta (engine eng)) sid))

;; ---------------------------------------------------------------------------------------------
;; Registry info (tools, docs, the visualizer export)

(defn- plain [v]
  (cond
    (fn? v) nil
    (keyword? v) v
    (map? v) (into {} (keep (fn [[k x]] (let [p (plain x)] (when (some? p) [k p])))) v)
    (coll? v) (vec (keep plain v))
    :else v))

(defn chart-info
  "What a chart declares: version, storage, exported keys, acts (checks by name), states,
   transitions (with their `:sova/*` tags), invocations and corrections."
  [charts nm]
  (when-let [{:keys [chart version storage exported acts]} (get charts nm)]
    (let [els (vals (::sc/elements-by-id chart))
          ord (::sc/id-ordinals chart)
          by  (fn [t] (sort-by #(get ord (:id %)) (filter #(= t (:node-type %)) els)))
          sts (sort-by #(get ord (:id %)) (filter #(#{:state :parallel :final :history} (:node-type %)) els))]
      {:name        nm
       :version     version
       :storage     (or storage :portable)
       :exported    (vec exported)
       :acts        (into (sorted-map)
                      (map (fn [[e m]]
                             [e (-> (plain (dissoc m :pre))
                                  (assoc :pre (vec (map-indexed (fn [i c] (dsl/check-name c i)) (:pre m)))))]))
                      acts)
       :states      (mapv (fn [s] {:id (:id s) :kind (:node-type s) :parent (or (:parent s) :ROOT)}) sts)
       :transitions (mapv (fn [t] (merge {:id (:id t) :source (or (:parent t) :ROOT) :event (event-names-of t)
                                          :target (vec (:target t)) :type (:type t) :guarded (some? (:cond t))}
                                    (plain-tags t)))
                      (by :transition))
       :invocations (mapv (fn [i] {:state (:parent i) :type (:type i) :id (:id i)}) (by :invoke))
       :corrections (vec (sort-by id-str (keep (fn [[e m]] (when (:correction m) e)) acts)))})))
