(ns sova.org-charts.api
  "The narrow JS API (design §6.3). Keywords cross as strings, data as plain JSON: object keys are
   camelCase in JS and kebab keywords in CLJS (rosterActive ↔ :roster-active); values are untouched,
   except that keyword values come out as \"ns/name\" strings. Event names become keywords
   (\"gather/start\" → :gather/start). Session ids are strings. Snapshots are EDN text."
  (:require
    [clojure.string :as str]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.charts.rules.hours :as hours]
    [sova.org-charts.engine.bounded :as bounded]
    [sova.org-charts.engine.core :as core]
    [sova.org-charts.engine.js-chart :as js-chart]
    [sova.org-charts.engine.rebuild :as rebuild]))

(def charts
  "The shipped charts: the refit's registry (charts/registry.cljc). The engine's test chart
   (`engine-probe`) is not here: its TS tests register a JS copy of it at runtime
   (`createEngine({charts})`, `engine/js_chart.cljs`)."
  registry/charts)

;; ---------------------------------------------------------------------------------------------
;; Marshalling

(defn- camel->kebab [s]
  (if (re-matches #"[a-z][a-zA-Z0-9]*" s)
    (str/replace s #"[A-Z]" #(str "-" (str/lower-case %)))
    s))

(defn- kebab->camel [s]
  (if (re-matches #"[a-z][a-z0-9]*(-[a-z0-9]+)+" s)
    (str/replace s #"-([a-z0-9])" #(str/upper-case (second %)))
    s))

(defn- kw->str [k] (if-let [n (namespace k)] (str n "/" (name k)) (name k)))

(defn- key->js [k]
  (cond
    (keyword? k) (if-let [n (namespace k)] (str n "/" (kebab->camel (name k))) (kebab->camel (name k)))
    (string? k) k
    :else (str k)))

(defn ->js [x]
  (cond
    (nil? x) nil
    (keyword? x) (kw->str x)
    (map? x) (let [o #js {}]
               (doseq [[k v] x] (unchecked-set o (key->js k) (->js v)))
               o)
    (coll? x) (into-array (map ->js x))
    (uuid? x) (str x)
    (or (string? x) (number? x) (boolean? x)) x
    (instance? js/Error x) (ex-message x)
    (fn? x) nil
    :else (str x)))

(defn ->clj [x]
  (cond
    (nil? x) nil
    (array? x) (mapv ->clj x)
    (and (object? x) (not (fn? x)))
    (persistent! (reduce (fn [m k] (assoc! m (keyword (camel->kebab k)) (->clj (unchecked-get x k))))
                   (transient {}) (js-keys x)))
    :else x))

(defn- now-of [opts] (some-> opts (unchecked-get "now")))
(defn- event-kw [s] (if (keyword? s) s (keyword s)))

;; ---------------------------------------------------------------------------------------------
;; Errors

(defn- js-error
  "A step limit crosses as a JS Error named \"OrgChartsStepLimitError\" with `code`
   \"sova/step-limit\" and its details (`limit`, `microsteps`, `sessionId`, `event`,
   `configuration`, `transitions`); any other typed engine error (`sova/unknown-session`,
   `sova/session-exists`) as an \"OrgChartsError\" with its `code` and details; anything else (a
   host callback's own error, e.g. a broken snapshot from loadCold) is rethrown as it is."
  [e]
  (let [typ (:type (ex-data e))]
    (if (keyword? typ)
      (let [err (js/Error. (ex-message e))]
        (set! (.-name err) (if (bounded/step-limit-error? e) "OrgChartsStepLimitError" "OrgChartsError"))
        (unchecked-set err "code" (str (namespace typ) "/" (name typ)))
        (doseq [[k v] (dissoc (ex-data e) :type)] (unchecked-set err (key->js k) (->js v)))
        err)
      e)))

(defn- guarded [f]
  (fn [& args]
    (try (apply f args) (catch :default e (throw (js-error e))))))

;; ---------------------------------------------------------------------------------------------
;; The engine object

(declare create-engine*)

(defn- runtime-charts
  "`opts.charts`, {name: {version, chart, storage?, exported?, acts?}} with each chart a JS tree
   (`engine/js_chart.cljs`) and `acts` {\"ns/event\": {needs, tool, hold, counts, …}} (no checks: JS
   charts guard with `cond`), over `charts`. A shipped chart's name is refused."
  [charts opts]
  (if-let [extra (some-> opts (unchecked-get "charts"))]
    (reduce (fn [cs nm]
              (when (contains? cs nm) (throw (js/Error. (str "Chart " nm " is already registered"))))
              (let [c    (unchecked-get extra nm)
                    meta (->clj (js-obj "storage" (unchecked-get c "storage") "exported" (unchecked-get c "exported")
                                  "acts" (unchecked-get c "acts")))]
                (assoc cs nm (cond-> {:chart   (js-chart/build (unchecked-get c "chart") ->js ->clj)
                                      :version (unchecked-get c "version")}
                               (:storage meta) (assoc :storage (keyword (:storage meta)))
                               (:exported meta) (assoc :exported (mapv keyword (:exported meta)))
                               (:acts meta) (assoc :acts (into {} (map (fn [[k v]]
                                                                         [(keyword (subs (str k) 1))
                                                                          ;; a JS `hours` (r7) reads the data model as JS
                                                                          (cond-> v (fn? (:hours v)) (update :hours (fn [f] (fn [view] (f (->js view))))))]))
                                                               (:acts meta)))
                               (fn? (unchecked-get c "cold")) (assoc :cold? (let [f (unchecked-get c "cold")]
                                                                              (fn [config data] (boolean (f (->js (vec config)) (->js data))))))))))
      charts (js-keys extra))
    charts))

(defn create-engine
  "opts (all optional): onSave(sessionId, snapshotText, info), onInvokeStart(inv), onInvokeStop(inv)
   (called only once a call committed), loadCold(sessionId) → snapshot text | null,
   stamp(sessionId, event, payload) → a fresh envelope (a held act's release, a chart-driven act), clock() → epoch
   ms (the default when a call passes no `now`), maxMicrosteps (per event), charts (more charts,
   written in JS: see `runtime-charts`)."
  ([] (create-engine* charts #js {}))
  ([opts] (create-engine* (runtime-charts charts opts) opts)))

(defn- opt [opts k] (some-> opts (unchecked-get k)))

(defn create-engine*
  "`create-engine` over `charts` ({name entry})."
  [charts opts]
  (let [opts      (or opts #js {})
        on-save   (opt opts "onSave")
        on-start  (opt opts "onInvokeStart")
        on-stop   (opt opts "onInvokeStop")
        load-cold (opt opts "loadCold")
        stamp     (opt opts "stamp")
        eng       (core/new-engine charts
                    {:on-save         (when on-save
                                        (fn [sid snap]
                                          (on-save sid (core/snapshot-text snap)
                                            (->js (select-keys snap [:chart :version :generation])))))
                     :on-invoke-start (when on-start (fn [inv] (on-start (->js inv))))
                     :on-invoke-stop  (when on-stop (fn [inv] (on-stop (->js inv))))
                     :load-cold       (when load-cold (fn [sid] (let [t (load-cold sid)] (when (string? t) t))))
                     :level-check     (:level-check registry/options)
                     :stamp           (when stamp (fn [sid event payload ctx] (->clj (stamp sid (->js event) (->js payload) (->js ctx)))))
                     :clock           (opt opts "clock")
                     :max-microsteps  (opt opts "maxMicrosteps")})
        with-config (fn [sid r] (->js (assoc r :configuration (core/configuration eng sid))))
        call-opts   (fn [o] {:now (now-of o) :invoke-id (opt o "invokeId")})]
    #js {:start         (guarded
                          (fn [sid chart data opts]
                            (with-config sid (core/start! eng sid chart (->clj data) (now-of opts)))))
         :send          (guarded
                          (fn [sid event data opts]
                            (with-config sid (core/send! eng sid (event-kw event) (->clj data) (call-opts opts)))))
         :trial         (guarded
                          (fn [sid event data opts]
                            (let [r (core/trial eng sid (event-kw event) (->clj data) (call-opts opts))]
                              (->js (assoc r :refusal (:sentence (:refusal r)) :refusal-info (:refusal r))))))
         :explain       (guarded
                          (fn [sid event data opts]
                            (->js (core/explain eng sid (event-kw event) (->clj data) (call-opts opts)))))
         :setState      (guarded
                          (fn [sid req envelope opts]
                            (let [{:keys [states patch reason]} (->clj req)]
                              (with-config sid (core/set-state! eng sid {:states states :patch patch :reason reason}
                                                 (->clj envelope) (call-opts opts))))))
         :resume        (guarded (fn [sids opts] (->js (core/resume! eng (vec sids) (call-opts opts)))))
         :configuration (fn [sid] (->js (core/configuration eng sid)))
         :running       (fn [sid] (core/running? eng sid))
         :data          (fn [sid] (->js (core/data eng sid)))
         :chartOf       (fn [sid] (:chart (core/snapshot-meta eng sid)))
         :enabledEvents (fn [sid envelope opts] (->js (core/enabled-events eng sid (->clj envelope) (call-opts opts))))
         :holds         (fn [sid] (->js (if (some? sid) (core/holds eng sid) (core/holds eng))))
         :nextDueAt     (fn [except] (core/next-due-at eng (when except (set except))))
         :dueSessions   (fn [now] (->js (core/due-sessions eng now)))
         :setAside      (fn [sids] (core/set-aside! eng (vec sids)))
         :fireDue       (guarded (fn [now opts]
                                   (let [only (opt opts "only") except (opt opts "except")]
                                     (->js (core/fire-due! eng now (cond-> {}
                                                                     only (assoc :only (set only))
                                                                     except (assoc :except (set except))))))))
         :dump          (fn [sid] (core/dump eng sid))
         :load          (guarded (fn [sid text] (->js (core/load! eng sid text))))
         :unload        (fn [sid] (core/unload! eng sid))
         :coldSessions  (fn [now minAge] (->js (if (some? minAge) (core/cold-sessions eng now minAge) (core/cold-sessions eng now))))
         :sessions      (fn [] (->js (core/session-ids eng)))
         :peek          (guarded (fn [text] (->js (core/peek-snapshot charts text))))
         :generation    (fn [sid] (core/generation eng sid))}))

(defn chart-list*
  [charts]
  (->js (mapv (fn [[nm {:keys [version storage]}]] {:name nm :version version :storage (or storage :portable)}) (sort-by key charts))))

(defn chart-list [] (chart-list* charts))

(defn chart-info
  "What chart `name` declares (registry, states, transitions, acts): for tools, docs, the visualizer."
  [nm]
  (->js (core/chart-info charts nm)))

(defn peek-snapshot
  "A snapshot text's {chart, configuration, data, running} without loading it (cold reads)."
  [text]
  (->js (core/peek-snapshot charts text)))

(defn migrate-text
  "A snapshot's EDN text at its chart's current version (throws when it can't be migrated)."
  [text]
  (core/migrate-text charts text))

(defn next-window
  "r7: when an act that reaches `person` ({tz, hours: {days, from, to}}) may go: null when now (`now-ms`)
   is inside their hours or they have none, else the instant (ms) their next window opens. The charts'
   own fn (rules.hours), so the server never re-implements zones and DST."
  [person now-ms]
  (hours/next-window (->clj person) now-ms))

(defn verify-session
  "`org-charts rebuild --verify`: replay session `sid`'s log `rows` (as the host's log reader gives
   them) on a scratch engine and compare with its snapshot text (null: none). opts: `charts` (JS
   charts, as `createEngine`). → {session, chart, rows, same, differences: [{what, replayed,
   snapshot, why}], divergence}. Writes nothing."
  ([sid rows snapshot-text] (verify-session sid rows snapshot-text nil))
  ([sid rows snapshot-text opts]
   ((guarded (fn [] (->js (rebuild/verify-session (runtime-charts charts opts) sid (->clj rows) snapshot-text)))))))
