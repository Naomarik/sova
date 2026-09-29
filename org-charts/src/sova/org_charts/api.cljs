(ns sova.org-charts.api
  "The narrow JS API (design §6.3). Keywords cross as strings, data as plain JSON: object keys are
   camelCase in JS and kebab keywords in CLJS (rosterActive ↔ :roster-active); values are untouched,
   except that keyword values come out as \"ns/name\" strings. Event names become keywords
   (\"gather/start\" → :gather/start). Session ids are strings. Snapshots are EDN text."
  (:require
    [clojure.string :as str]
    [sova.org-charts.charts.project :as project]
    [sova.org-charts.charts.work-item :as work-item]
    [sova.org-charts.charts.guards :as guards]
    [sova.org-charts.engine.bounded :as bounded]
    [sova.org-charts.engine.core :as core]
    [sova.org-charts.engine.js-chart :as js-chart]))

(def charts
  "The shipped charts. The engine's test chart (`engine-probe`) is not here: its TS tests register a JS
   copy of it at runtime (`createEngine({charts})`, `engine/js_chart.cljs`)."
  {"project"   {:chart project/chart :version project/version}
   "work-item" {:chart work-item/chart :version work-item/version}})

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

(defn- refusal
  "The charts' refusal sentence for an event the trial did not take. `explain` reads the session's
   data plus its active states (:sova/configuration) and whether it still runs (:sova/running?)."
  [eng sid event-name data result]
  (when-not (:taken result)
    (let [chart (keyword (:chart (core/snapshot-meta eng sid)))
          d     (assoc (core/data eng sid)
                  :sova/configuration (set (core/configuration eng sid))
                  :sova/running? (core/running? eng sid))]
      (guards/explain chart event-name d data))))

;; ---------------------------------------------------------------------------------------------
;; Errors

(defn- js-error
  "A step limit crosses as a JS Error named \"OrgChartsStepLimitError\" with `code`
   \"sova/step-limit\" and its details (`limit`, `microsteps`, `sessionId`, `event`,
   `configuration`, `transitions`); anything else is rethrown as it is."
  [e]
  (if (bounded/step-limit-error? e)
    (let [err (js/Error. (ex-message e))]
      (set! (.-name err) "OrgChartsStepLimitError")
      (unchecked-set err "code" "sova/step-limit")
      (doseq [[k v] (dissoc (ex-data e) :type)] (unchecked-set err (key->js k) (->js v)))
      err)
    e))

(defn- guarded [f]
  (fn [& args]
    (try (apply f args) (catch :default e (throw (js-error e))))))

;; ---------------------------------------------------------------------------------------------
;; The engine object

(declare create-engine*)

(defn- runtime-charts
  "`opts.charts`, {name: {version, chart}} with each chart a JS tree (`engine/js_chart.cljs`), over
   `charts`. A shipped chart's name is refused."
  [charts opts]
  (if-let [extra (some-> opts (unchecked-get "charts"))]
    (reduce (fn [cs nm]
              (when (contains? cs nm) (throw (js/Error. (str "Chart " nm " is already registered"))))
              (let [c (unchecked-get extra nm)]
                (assoc cs nm {:chart   (js-chart/build (unchecked-get c "chart") ->js ->clj)
                              :version (unchecked-get c "version")})))
      charts (js-keys extra))
    charts))

(defn create-engine
  "opts (all optional): onSave(sessionId, snapshotText, info), onInvokeStart(inv), onInvokeStop(inv),
   clock() → epoch ms (the default when a call passes no `now`), maxMicrosteps (per event), charts
   (more charts, written in JS: see `runtime-charts`)."
  ([] (create-engine* charts #js {}))
  ([opts] (create-engine* (runtime-charts charts opts) opts)))

(defn create-engine*
  "`create-engine` over `charts` ({name {:chart c :version n}})."
  [charts opts]
   (let [opts     (or opts #js {})
         on-save  (unchecked-get opts "onSave")
         on-start (unchecked-get opts "onInvokeStart")
         on-stop  (unchecked-get opts "onInvokeStop")
         clock    (unchecked-get opts "clock")
         limit    (unchecked-get opts "maxMicrosteps")
         eng      (core/new-engine charts
                    {:on-save         (when on-save
                                        (fn [sid snap]
                                          (on-save sid (core/snapshot-text snap)
                                            (->js (select-keys snap [:chart :version :generation])))))
                     :on-invoke-start (when on-start (fn [inv] (on-start (->js inv))))
                     :on-invoke-stop  (when on-stop (fn [inv] (on-stop (->js inv))))
                     :clock           clock
                     :max-microsteps  limit})
         with-config (fn [sid r] (->js (assoc r :configuration (core/configuration eng sid))))]
     #js {:start         (guarded
                           (fn [sid chart data opts]
                             (with-config sid (core/start! eng sid chart (->clj data) (now-of opts)))))
          :send          (guarded
                           (fn [sid event data opts]
                             (with-config sid (core/send! eng sid (event-kw event) (->clj data)
                                                {:now (now-of opts) :invoke-id (some-> opts (unchecked-get "invokeId"))}))))
          :trial         (guarded
                           (fn [sid event data opts]
                             (let [ev (event-kw event)
                                   d  (->clj data)
                                   r  (core/trial eng sid ev d {:now (now-of opts) :invoke-id (some-> opts (unchecked-get "invokeId"))})]
                               (->js (assoc r :refusal (refusal eng sid ev d r))))))
          :configuration (fn [sid] (->js (core/configuration eng sid)))
          :data          (fn [sid] (->js (core/data eng sid)))
          :enabledEvents (fn [sid envelope opts] (->js (core/enabled-events eng sid (->clj envelope) {:now (now-of opts)})))
          :nextDueAt     (fn [] (core/next-due-at eng))
          :fireDue       (guarded (fn [now] (->js (core/fire-due! eng now))))
          :dump          (fn [sid] (core/dump eng sid))
          :load          (fn [sid text] (->js (core/load! eng sid text)))
          :unload        (fn [sid] (core/unload! eng sid))
          :sessions      (fn [] (->js (core/session-ids eng)))
          :generation    (fn [sid] (core/generation eng sid))}))

(defn chart-list*
  [charts]
  (->js (mapv (fn [[nm {:keys [version]}]] {:name nm :version version}) charts)))

(defn chart-list [] (chart-list* charts))
