(ns sova.org-charts.charts.base
  "What every refit chart shares: the event and its envelope, the event's time, session ids, the
   configuration as a set, and sending a typed reason to the project's watch. Pure; effects are
   `dsl/effect` intents (engine/API.md §2)."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.elements :refer [Send script]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.engine.dsl :as dsl]))

;; ---- the event --------------------------------------------------------------------------------

(defn evt "The current event's data: the envelope plus the payload." [data] (get-in data [:_event :data]))
(defn evt-name [data] (get-in data [:_event :name]))

(defn now-ms
  "The event's time (`:at`, stamped by the engine on every delivered event), else the data's `:now`."
  [data]
  (or (:at (evt data)) (:now data) 0))

(defn by
  "Who acts: the envelope's `:by` as a string (operator, overseer, system, model, person, wrapup, chart)."
  [data]
  (some-> (:by (evt data)) name))

(defn operator-act? [data] (= "operator" (by data)))

(defn in?
  "The session is in state `id` (its configuration, as the data model's `In` reads it)."
  [env id]
  (let [cfg (some-> env :com.fulcrologic.statecharts/vwmem deref :com.fulcrologic.statecharts/configuration)]
    (contains? (set cfg) id)))

;; ---- session ids --------------------------------------------------------------------------------
;; `<chart>/<org>[/<project>]/<id>`: one engine per org, so the org id is in every id.

(defn start-card
  "A gathering start's confirm-card targets (sova_gather start): its project and every person it goes
   to (`:to` or `:targets`), never the operator."
  [project-id data]
  (let [e (evt data)]
    {:projects [project-id]
     :people   (vec (remove #{"operator"} (map #(if (map? %) (:id %) %) (or (seq (:targets e)) (some-> (:to e) vector)))))}))

(defn org-sid [org] (str "org/" org))
(defn residence-sid [org] (str "residence/" org))
(defn person-sid [org pid] (str "person/" org "/" pid))
(defn project-sid [org p] (str "project/" org "/" p))
(defn watch-sid [org p] (str "watch/" org "/" p))
(defn baton-sid [org sid] (str "baton/" org "/" sid))
(defn decision-sid [org p did] (str "decision/" org "/" p "/" did))
(defn conflict-sid [org p cid] (str "conflict/" org "/" p "/" cid))
(defn reconciler-sid [org p] (str "reconciler/" org "/" p))
(defn item-sid [org p gid] (str "item/" org "/" p "/" gid))
(defn build-sid [org p sid] (str "build/" org "/" p "/" sid))

(defn chart-of-sid [sid] (first (str/split (str sid) #"/")))
(defn last-part [sid] (last (str/split (str sid) #"/")))

;; ---- link notifications (engine/API.md §2) --------------------------------------------------------

(defn moved
  "The `link/moved` data of the current event: `{:from :chart :states :running :exported}`."
  [data]
  (evt data))

(defn moved-from? [chart] (fn [_ data] (= chart (:chart (moved data)))))
(defn moved-in?
  "The watched session that moved is in state `id` now."
  [data id]
  (contains? (set (:states (moved data))) id))

;; ---- reasons to look (the watch loop) ----------------------------------------------------------------

(defn tell-watch
  "Send a typed reason `{:kind :params :key :by}` to the project's watch session. `f` gives the
   reason from the data (nil sends nothing: the send's target is then no session, so we guard
   with `:cond`-free content by returning an empty batch)."
  [f]
  (Send {:event      :reason/noted
         :targetexpr (fn [_ data] (watch-sid (:org-id data) (:project-id data)))
         :content    (fn [_ data] (let [r (f data)] (if r (merge {:by "system" :at (now-ms data)} r) {:reasons []})))}))

(defn ledger
  "Send `ledger/take` (or `ledger/give-back`) `{kind n ledger}` to the project's watch: the
   allowance a counted act took (design §3.5; r5)."
  [event kind n-fn]
  (Send {:event      event
         :targetexpr (fn [_ data] (watch-sid (:org-id data) (:project-id data)))
         :content    (fn [_ data] (let [e (evt data)]
                                    {:kind kind :n (n-fn data) :by (by data)
                                     :ledger (or (some-> (:ledger e) name) (if (true? (:attended e)) "message" "day"))}))}))

(defn relink
  "Executable content: stop watching `(old-fn data)` and watch `(new-fn data)` (either may be nil;
   the same session is left alone)."
  [old-fn new-fn]
  (script {:expr (fn [_ data]
                   (let [o (old-fn data) n (new-fn data)]
                     (when (not= o n)
                       [(ops/assign :sova/directives
                          (cond-> (vec (:sova/directives data))
                            o (conj {:op :unwatch :target o})
                            n (conj {:op :watch :target n})))])))}))

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


(defn utc-minute
  "`YYYY-MM-DD HH:MM` in UTC (the holder sentence's since)."
  [ms]
  #?(:clj  (let [t (str (java.time.Instant/ofEpochMilli ms))] (subs (clojure.string/replace t "T" " ") 0 16))
     :cljs (subs (clojure.string/replace (.toISOString (js/Date. ms)) "T" " ") 0 16)))

;; ---- sends decided at run time ------------------------------------------------------------------------
;; A `Send` always sends (and a send to a session that exists nowhere rolls the call back). A send
;; that depends on the data is queued in `:sova.charts/sends` by `send-if` and delivered one per
;; microstep by the chart's `flush-transition` (place it on the top state).

(defn queue-sends
  "Ops queueing `sends` (`[{:target sid :event kw :data {}}]`), then a raise of `:sova.charts/flush`."
  [data sends]
  (when (seq sends)
    [(ops/assign :sova.charts/sends (into (vec (:sova.charts/sends data)) sends))]))

(defn send-if
  "Executable content: send `(event)` to `(target-fn data)` with `(content-fn data)` when the target
   is not nil."
  [event target-fn content-fn]
  [(script {:expr (fn [_ data] (let [t (target-fn data)]
                                 (when t (queue-sends data [{:target t :event event :data (content-fn data)}]))))})
   (com.fulcrologic.statecharts.elements/raise {:event :sova.charts/flush})])

(defn send-all
  "Executable content: queue every send `(sends-fn data)` returns."
  [sends-fn]
  [(script {:expr (fn [_ data] (queue-sends data (vec (sends-fn data))))})
   (com.fulcrologic.statecharts.elements/raise {:event :sova.charts/flush})])

(defn flush-transition
  "The top state's transition delivering queued sends, one per microstep."
  []
  (com.fulcrologic.statecharts.elements/transition
    {:event :sova.charts/flush :cond (fn [_ d] (seq (:sova.charts/sends d)))}
    (Send {:eventexpr (fn [_ d] (:event (first (:sova.charts/sends d))))
           :targetexpr (fn [_ d] (:target (first (:sova.charts/sends d))))
           :content (fn [_ d] (:data (first (:sova.charts/sends d))))})
    (script {:expr (fn [_ d] [(ops/assign :sova.charts/sends (vec (rest (:sova.charts/sends d))))])})
    (com.fulcrologic.statecharts.elements/raise {:event :sova.charts/flush})))
