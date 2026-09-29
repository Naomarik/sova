(ns sova.org-charts.charts.common
  "Helpers shared by the project and work-item charts: the event envelope, time, the outbox, and
   stall clocks. Pure: nothing here performs an effect; an effect is an intent appended to the
   `:outbox` in the data model, which the host runs after the snapshot is saved."
  (:require
    [com.fulcrologic.statecharts.elements :refer [on-entry on-exit script Send cancel raise]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]))

;; ---- the event -------------------------------------------------------------------------------

(defn evt
  "The current event's data (the envelope plus payload)."
  [data]
  (get-in data [:_event :data]))

(defn evt-name [data] (get-in data [:_event :name]))

(defn wall-ms []
  #?(:clj (System/currentTimeMillis) :cljs (.now js/Date)))

(defn now-ms
  "The time of the event being processed: its `:at` (the host's or the replay's clock), else the
   last one the chart saw (`:now`), else the wall clock."
  [data]
  (or (:at (evt data)) (:now data) (wall-ms)))

(defn stamp-now
  "Ops keeping `:now` at the event's time (scripts call it first)."
  [data]
  [(ops/assign :now (now-ms data))])

;; ---- local time, as Sova's server computes it --------------------------------------------------

(defn next-midnight
  "Epoch ms of the next local midnight after `ms` (project-overseer-store.ts nextMidnight)."
  [ms]
  #?(:clj  (let [zone (java.time.ZoneId/systemDefault)
                 d    (.toLocalDate (.atZone (java.time.Instant/ofEpochMilli ms) zone))]
             (.toEpochMilli (.toInstant (.atStartOfDay (.plusDays d 1) zone))))
     :cljs (let [d (js/Date. ms)]
             (.getTime (js/Date. (.getFullYear d) (.getMonth d) (inc (.getDate d)))))))

(defn day-key
  "`YYYY-MM-DD` in local time (project-overseer-store.ts dayKey)."
  [ms]
  (let [pad (fn [n] (if (< n 10) (str "0" n) (str n)))]
    #?(:clj  (let [d (.toLocalDate (.atZone (java.time.Instant/ofEpochMilli ms) (java.time.ZoneId/systemDefault)))]
               (str (.getYear d) "-" (pad (.getMonthValue d)) "-" (pad (.getDayOfMonth d))))
       :cljs (let [d (js/Date. ms)]
               (str (.getFullYear d) "-" (pad (inc (.getMonth d))) "-" (pad (.getDate d)))))))

(defn clock-time
  "\"1:43 PM\" in local time (pi-config/extensions/stamp/format.ts clockTime)."
  [ms]
  (if-not (number? ms)
    ""
  (let [[h m] #?(:clj  (let [t (.toLocalTime (.atZone (java.time.Instant/ofEpochMilli ms) (java.time.ZoneId/systemDefault)))]
                         [(.getHour t) (.getMinute t)])
                 :cljs (let [d (js/Date. ms)] [(.getHours d) (.getMinutes d)]))]
    (str (let [h12 (mod h 12)] (if (zero? h12) 12 h12)) ":" (if (< m 10) (str "0" m) m) " " (if (< h 12) "AM" "PM")))))

;; ---- guards combinators ------------------------------------------------------------------------

(defn all?
  "A guard true when every guard is."
  [& gs]
  (fn [env data] (every? #(% env data) gs)))

(defn none?
  "A guard true when no guard is."
  [& gs]
  (fn [env data] (not-any? #(% env data) gs)))

;; ---- the outbox ---------------------------------------------------------------------------------

(defn effect-ops
  "Ops appending one effect intent to the outbox, keyed for idempotency by item, kind and a
   per-session sequence number."
  [data kind m]
  (let [n (:seq data 0)]
    [(ops/assign :outbox (conj (vec (:outbox data))
                           (merge {:kind (name kind)
                                   :key  (str (or (:item-id data) (:project-sid data)) "/" (name kind) "/" n)
                                   :at   (now-ms data)}
                             m)))
     (ops/assign :seq (inc n))]))

(defn effect
  "Executable content: append an effect intent (`(f data)` is merged into it)."
  [kind f]
  (script {:expr (fn [_ data] (effect-ops data kind (f data)))}))

;; ---- transition log -------------------------------------------------------------------------------

(def log-max 200)

(defn log-ops
  "Ops appending a row to the transition log (the owned `{entity, from, event, to, by}` record)."
  [data row]
  [(ops/assign :log (vec (take-last log-max (conj (vec (:log data)) (merge {:at (now-ms data)} row)))))])

;; ---- telling the project ---------------------------------------------------------------------------

(defn tell-project
  "Send a typed reason to this item's project chart (only when it has one)."
  [kind params-fn]
  (Send {:event      :reason/noted
         :targetexpr (fn [_ data] (:project-sid data))
         :content    (fn [_ data] {:kind   (subs (str kind) 1)
                                   :params (merge {:item (:item-id data)} (params-fn data))
                                   :by     "system"
                                   :at     (now-ms data)})}))

;; ---- stall clocks ----------------------------------------------------------------------------------

(def default-stall-ms (* 3 24 3600 1000))

(defn stall-ms [data phase]
  (or (get (:stall-after-ms data) phase)
      (get (:stall-after-ms data) (name phase))
      (get (:stall-after-ms data) (keyword (name phase)))
      default-stall-ms))

(defn stall-clock
  "On entry arm a delayed `:item/stalled` for this phase and note since when; on exit cancel it and
   raise `:item/moved` for the attention region. Returns a vector (elements flatten it)."
  [phase]
  (let [timer (keyword (str "stall-" (name phase)))]
  [(on-entry {}
     (script {:expr (fn [_ data] [(ops/assign :phase-since (now-ms data))])})
     (Send {:id        timer
            :event     :item/stalled
            :delayexpr (fn [_ data] (stall-ms data phase))
            :content   (fn [_ data] {:phase (name phase) :since (:phase-since data)})}))
   (on-exit {}
     (cancel {:sendid timer})
     (raise {:event :item/moved}))]))
