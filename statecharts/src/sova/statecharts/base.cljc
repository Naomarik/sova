(ns sova.statecharts.base
  "What every refit statechart shares: the event and its envelope, the event's time, session ids, the
   configuration as a set, and sending a typed reason to the project's watch. Pure; effects are
   `dsl/effect` intents (engine/API.md §2)."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.elements :refer [Send script]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [com.fulcrologic.statecharts.environment :as sc-env]
    [sova.statecharts.rules.hours :as hours]
    [sova.statecharts.rules.started :as st]
    [sova.statecharts.engine.dsl :as dsl]))

;; ---- the event --------------------------------------------------------------------------------

(defn evt "The current event's data: the envelope plus the payload." [data] (get-in data [:_event :data]))
(defn evt-name [data] (get-in data [:_event :name]))

(defn now-ms
  "The event's time (`:at`, stamped by the engine on every delivered event), else the data's `:now`."
  [data]
  (or (:at (evt data)) (:now data) 0))

(defn by
  "Who acts: the envelope's `:by` as a string (operator, overseer, system, model, person, wrapup, statechart)."
  [data]
  (some-> (:by (evt data)) name))

(defn operator-act? [data] (= "operator" (by data)))

(defn at-once?
  "An act that reaches people at once, whatever their hours (r7, r12 clarification): the operator's
   own click, or an overseer turn the operator started (attended)."
  [data]
  (or (operator-act? data) (true? (:attended (evt data)))))

(defn in?
  "The session is in state `id` (its configuration, as the data model's `In` reads it)."
  [env id]
  (let [cfg (some-> env :com.fulcrologic.statecharts/vwmem deref :com.fulcrologic.statecharts/configuration)]
    (contains? (set cfg) id)))

;; ---- session ids --------------------------------------------------------------------------------
;; The project layer (project, watch, build, runtime) carries no org: `<statechart>/<project>[/<id>]`.
;; The org layer keeps its org-scoped grammar `<statechart>/<org>[/<project>]/<id>` and may address
;; project-layer sessions; the project layer never builds an org-layer id.

(defn start-card
  "A gathering start's confirm-card targets (sova_gather start): its project and every person it goes
   to (`:to` or `:targets`), never the operator."
  [project-id data]
  (let [e (evt data)]
    {:projects [project-id]
     :people   (vec (remove #{"operator"} (map #(if (map? %) (:id %) %) (or (seq (:targets e)) (some-> (:to e) vector)))))}))

(defn start-kind
  "A gathering start's confirm kind (r8(4)): an offer to two or more people (an open pool) is
   \"offer\", a start to one person or the operator \"gather\"."
  [data]
  (if (>= (count (:targets (evt data))) 2) "offer" "gather"))

(defn hours-window
  "Act meta `:hours` (r7) for an act that reaches people: the envelope's person records (`target`,
   one person; `target-people`, an offer's invitees — `targets` holds their ids), stamped by the host
   with tz/hours → when their next window opens, or nil (go now)."
  [data]
  (let [e (evt data)]
    (hours/reach-window (filter map? (concat [(:target e)] (:targets e) (:target-people e))) (now-ms data))))

(defn- sid-of
  "A session id from its parts; a blank part is a statechart bug (a send to `watch/o1/` would reach no
   session), so it throws and the call rolls back instead of going nowhere."
  [statechart & parts]
  (when (some #(str/blank? (some-> % str)) parts)
    (throw (ex-info (str "Incomplete session id: " statechart "/" (str/join "/" parts)) {:statechart statechart :parts parts})))
  (str/join "/" (cons statechart parts)))

(defn org-sid [org] (sid-of "org" org))
(defn residence-sid [org] (sid-of "residence" org))
(defn person-sid [org pid] (sid-of "person" org pid))
(defn project-sid [p] (sid-of "project" p))
(defn watch-sid [p] (sid-of "watch" p))
(defn build-sid [p sid] (sid-of "build" p sid))
(defn runtime-sid [p] (sid-of "runtime" p))
(defn placement-sid [org p] (sid-of "placement" org p))
(defn baton-sid [org sid] (sid-of "baton" org sid))
(defn decision-sid [org p did] (sid-of "decision" org p did))
(defn conflict-sid [org p cid] (sid-of "conflict" org p cid))
(defn reconciler-sid [org p] (sid-of "reconciler" org p))
(defn item-sid [org p gid] (sid-of "item" org p gid))

(defn statechart-of-sid [sid] (first (str/split (str sid) #"/")))
(defn last-part [sid] (last (str/split (str sid) #"/")))

;; ---- link notifications (engine/API.md §2) --------------------------------------------------------

(defn moved
  "The `link/moved` data of the current event: `{:from :statechart :states :running :exported}`."
  [data]
  (evt data))

(defn moved-from? [statechart] (fn [_ data] (= statechart (:statechart (moved data)))))
(defn moved-in?
  "The watched session that moved is in state `id` now."
  [data id]
  (contains? (set (:states (moved data))) id))

;; ---- reasons to look (the watch loop) ----------------------------------------------------------------

(defn tell-watch
  "Send a typed reason `{:kind :params :key :by}` to the project's watch session. `f` gives the
   reason from the data (nil sends nothing: the send's target is then no session, so we guard
   with `:cond`-free content by returning an empty batch). News of the statechart's own act (an event
   `by` statechart, r3) says so: the watch never looks for it (R3)."
  [f]
  (Send {:event      :reason/noted
         :targetexpr (fn [_ data] (watch-sid (:project-id data)))
         :content    (fn [_ data] (let [r (f data)
                                        by (if (= "statechart" (some-> (:by (evt data)) name)) "statechart" "system")]
                                    (if r (merge {:by by :at (now-ms data)} r) {:reasons []})))}))

(defn ledger
  "Send `ledger/take` (or `ledger/give-back`) `{kind n ledger}` to the project's watch: the
   allowance a counted act took (design §3.5; r5)."
  [event kind n-fn]
  (Send {:event      event
         :targetexpr (fn [_ data] (watch-sid (:project-id data)))
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
;; that depends on the data is queued in `:sova.statecharts/sends` by `send-if` and delivered one per
;; microstep by the statechart's `flush-transition` (place it on the top state).

(defn queue-sends
  "Ops queueing `sends` (`[{:target sid :event kw :data {}}]`), then a raise of `:sova.statecharts/flush`."
  [data sends]
  (when (seq sends)
    [(ops/assign :sova.statecharts/sends (into (vec (:sova.statecharts/sends data)) sends))]))

(defn send-if
  "Executable content: send `(event)` to `(target-fn data)` with `(content-fn data)` when the target
   is not nil."
  [event target-fn content-fn]
  [(script {:expr (fn [_ data] (let [t (target-fn data)]
                                 (when t (queue-sends data [{:target t :event event :data (content-fn data)}]))))})
   (com.fulcrologic.statecharts.elements/raise {:event :sova.statecharts/flush})])

(defn send-all
  "Executable content: queue every send `(sends-fn data)` returns."
  [sends-fn]
  [(script {:expr (fn [_ data] (queue-sends data (vec (sends-fn data))))})
   (com.fulcrologic.statecharts.elements/raise {:event :sova.statecharts/flush})])

(defn hold-review
  "r8 (q12), on the top state of a statechart with held acts: the approve-early correction
   (`:hold/approve {:id :reason}`, declared in `:acts`) and, when a confirm-required hold ends
   unreviewed (`:hold/waiting {:id :event :kind :what :project-id?}`), a soon `hold/review` reason to
   the project's watch, so the overseer looks and approves or cancels it (it waits until then)."
  []
  [(dsl/hold-approve-correction)
   ;; F19: a hold id is per session, so the reason names the hold as `<session-id>:<hold-id>`
   (com.fulcrologic.statecharts.elements/transition {:sova/feed :feed :sova/asks-overseer true :event :hold/waiting}
     (script {:sova/reason true
              :expr (fn [env d]
                      (when-let [p (or (:project-id (evt d)) (:project-id d))]
                        (let [e    (evt d)
                              hold (str (sc-env/session-id env) ":" (:id e))]
                          (queue-sends d [{:target (watch-sid p) :event :reason/noted
                                           :data {:kind "hold/review" :by "system" :at (now-ms d) :key (str "hold/review:" hold)
                                                  :asks true :params {:id (:id e) :hold hold :what (:what e) :act (some-> (:event e) name)}}}]))))})
     (com.fulcrologic.statecharts.elements/raise {:event :sova.statecharts/flush}))])

(defn flush-transition
  "The top state's transition delivering queued sends, one per microstep."
  []
  (com.fulcrologic.statecharts.elements/transition
    {:sova/feed :quiet :event :sova.statecharts/flush :cond (fn [_ d] (seq (:sova.statecharts/sends d)))}
    (Send {:eventexpr (fn [_ d] (:event (first (:sova.statecharts/sends d))))
           :targetexpr (fn [_ d] (:target (first (:sova.statecharts/sends d))))
           :content (fn [_ d] (:data (first (:sova.statecharts/sends d))))})
    (script {:expr (fn [_ d] [(ops/assign :sova.statecharts/sends (vec (rest (:sova.statecharts/sends d))))])})
    (com.fulcrologic.statecharts.elements/raise {:event :sova.statecharts/flush})))

;; ---- the sessions it started (r11: one list, 200, the oldest settled retired) ---------------------------
;; A project lists its builds, a placement its gatherings; each watches what it lists.

(defn started-ops
  "Note a row (`:row`, and `:watch` it when an item started it) or mark one settled from its link
   (`:mark [sid settled?]`), then trim past the cap: the oldest settled rows leave, each sent
   `session/retire` and unwatched."
  [d {:keys [row watch mark]}]
  (let [rows (cond-> (vec (:started d)) row (st/note row) mark (st/mark (first mark) (second mark)))
        {:keys [rows retire]} (st/trim rows)
        dirs (concat (when watch [{:op :watch :target watch}]) (for [s retire] {:op :unwatch :target s}))]
    (cond-> [(ops/assign :started rows)]
      (seq dirs)   (conj (ops/assign :sova/directives (into (vec (:sova/directives d)) dirs)))
      (seq retire) (into (queue-sends d (for [s retire] {:target s :event :session/retire :data {}}))))))

(defn started-content [f]
  [(script {:expr (fn [_ d] (started-ops d (f d)))})
   (com.fulcrologic.statecharts.elements/raise {:event :sova.statecharts/flush})])

(defn started-row [d kind sid] {:sid sid :kind kind :at (now-ms d)})

(defn from-started? [_ d] (let [m (moved d)] (some #(= (:from m) (:sid %)) (:started d))))
