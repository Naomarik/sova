(ns sova.org-charts.engine.dsl
  "Authoring helpers the engine gives the charts (API.md §2): acts with ordered named checks,
   corrections (q9), effects with engine-assigned idempotency keys, held effects (q10), spawn and
   links. Everything here is executable content or a transition: data operations on the session's
   own data model. The engine reads the reserved keys after each step (`:outbox`, `:sova/holds`,
   `:sova/directives`) and does the rest: keys, timers, spawns, notifications.

   A check is `(fn [data] nil | sentence | {:sentence s :tail t :status n :code c})`, or a named
   check `{:name :holder-chose :fn f :payload? true}`. `data` is the data model with `:_event`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [com.fulcrologic.statecharts.elements :refer [transition script]]
    [sova.org-charts.engine.hold-policy :as policy]))

;; ---- the event -------------------------------------------------------------------------------

(defn evt "The current event's data (envelope + payload)." [data] (get-in data [:_event :data]))

(defn now-ms "The current event's time, else the chart's last `:now`." [data] (or (:at (evt data)) (:now data)))

(defn blank? [s] (or (nil? s) (and (string? s) (str/blank? s))))

;; ---- checks ----------------------------------------------------------------------------------

(def reason-required "A correction needs a reason: say why.")

(def generic-refusal "That can't be done now.")

(defn check-name
  "A check's name: its `:name`, else `check-<i>` (its position)."
  [c i]
  (if (and (map? c) (:name c)) (let [n (:name c)] (if (keyword? n) (name n) (str n))) (str "check-" i)))

(defn as-refusal
  "A check's answer as a refusal map (`:sentence` always), or nil."
  [r stage check]
  (cond
    (nil? r) nil
    (false? r) nil
    (string? r) (if (str/blank? r) nil {:sentence r :stage stage :check check})
    (map? r) (let [s (or (:sentence r) (:said r))]
               (when-not (blank? s)
                 (cond-> (merge {:stage stage :check check} (dissoc r :said))
                   true (assoc :sentence s))))
    :else {:sentence (str r) :stage stage :check check}))

(defn first-refusal
  "The first refusing check of `checks` over `data`, as a refusal map, or nil. With
   `skip-payload?`, checks marked `:payload? true` are not run (no payload to check)."
  ([checks data stage] (first-refusal checks data stage false))
  ([checks data stage skip-payload?]
   (loop [cs (map-indexed vector checks)]
     (when-let [[i c] (first cs)]
       (if (and skip-payload? (map? c) (:payload? c))
         (recur (rest cs))
         (let [f (if (map? c) (:fn c) c)]
           (or (as-refusal (f data) stage (check-name c i))
               (recur (rest cs)))))))))

(def reason-check
  "A correction's reason: required from anyone but the operator (whose own click, e.g. Cancel on a
   held act, needs none)."
  {:name :reason :payload? true
   :fn   (fn [data]
           (let [e (evt data)]
             (when (and (blank? (:reason e)) (not= "operator" (some-> (:by e) name))) reason-required)))})

;; ---- acts and corrections ------------------------------------------------------------------------

(defn act
  "A transition for an act: taken when every check passes (in order) and `:cond` (a
   `(fn [env data])`, `In` included) holds. The engine's explain reads `:sova/checks` and
   `:sova/cond` in the same order, so the sentence and the guard are one piece of code. Level
   (`:needs`) and the act's `:pre` checks are declared once per act in the registry's `:acts`."
  [{:keys [checks cond] :as attrs} & content]
  (let [checks (vec checks)]
    (apply transition
      (cond-> (-> attrs
                (dissoc :checks)
                (assoc :sova/act true :sova/checks checks)
                (assoc :cond (fn [env data]
                               (and (nil? (first-refusal checks data :check))
                                    (if cond (boolean (cond env data)) true)))))
        cond (assoc :sova/cond cond))
      content)))

(defn correction
  "A declared correction (q9): an act tagged `:sova/correction`, refused without a `:reason`.
   Declare it in the registry's `:acts` with its `:needs` like any act."
  [attrs & content]
  (apply act (-> attrs
               (assoc :sova/correction true)
               (update :checks #(into [reason-check] %)))
    content))

;; ---- effects -----------------------------------------------------------------------------------

(defn effect-map [kind f data]
  (merge {:kind (if (keyword? kind) (name kind) (str kind)) :at (now-ms data)} (when f (f data))))

(defn effect-ops
  "Ops appending one effect intent to the outbox (the engine assigns its `:key`)."
  [data e]
  [(ops/assign :outbox (conj (vec (:outbox data)) e))])

(defn effect
  "Executable content: an effect intent of `kind`, `(f data)` merged in. The engine keys it
   (`<sid>@<generation>.<n>`), keeps it pending in `:sova/pending` until the host answers
   `effect/done` / `effect/failed`, and delivers that answer with `:effect` and `:kind`."
  ([kind] (effect kind nil))
  ([kind f] (script {:expr (fn [_ data] (effect-ops data (effect-map kind f data)))})))

;; ---- holds (q10) ---------------------------------------------------------------------------------

(def default-hold-ms (* 10 60 1000))

(defn default-hold?
  "The hold policy (engine/hold_policy.cljc) for an effect-only hold."
  [data]
  (policy/held-by? (evt data)))

(defn hold-ms
  "The hold's length: the helper's `:ms` (a number or fn [data]), else the policy's (envelope
   `:hold-ms`, data `:sova/hold-ms`, 10 min). 0 means no hold: the effect goes straight out."
  [data ms]
  (let [v (if (fn? ms) (ms data) ms)]
    (if (number? v) v (policy/hold-ms (evt data) data))))

(defn hold-ops
  "Ops putting effect `e` on hold (or straight in the outbox when not held)."
  [data e {:keys [ms hold? while-in what]}]
  (let [ms (hold-ms data ms)]
  (if-not (and (pos? ms) (if hold? (hold? data) (default-hold? data)))
    (effect-ops data e)
    (let [n     (:sova/hold-seq data 0)
          id    (str (:kind e) "#" n)
          now   (now-ms data)
          hold  (cond-> {:id id :kind (:kind e) :effect e :since now :until (+ now ms)
                         :by (some-> (:by (evt data)) name)}
                  while-in (assoc :while-in while-in)
                  what (assoc :what (if (fn? what) (what data) what)))]
      [(ops/assign :sova/hold-seq (inc n))
       (ops/assign :sova/holds (assoc (or (:sova/holds data) {}) id hold))]))))

(defn held
  "Executable content: an effect held for `:ms` (default data `:sova/hold-ms`, else 10 min) before
   it reaches the outbox. opts: `:hold?` (fn [data]; default `default-hold?`), `:while-in` (a state
   id: at the hold's end the effect goes ahead only while the session is in it, else
   `:hold/lapsed`), `:what` (a string or fn [data]: the words Needs you shows)."
  ([kind f] (held kind f {}))
  ([kind f opts] (script {:expr (fn [_ data] (hold-ops data (effect-map kind f data) opts))})))

(defn approve-hold
  "Executable content (q12 approve-early): release hold `(id-fn data)` now; the engine re-delivers
   the act and re-checks it in full, like a timed release."
  [id-fn]
  (script {:expr (fn [_ data] [(ops/assign :sova/directives (conj (vec (:sova/directives data)) {:op :release-hold :id (id-fn data)}))])}))

(defn cancel-hold-ops [data id]
  [(ops/assign :sova/holds (dissoc (or (:sova/holds data) {}) id))])

(defn cancel-hold
  "Executable content: drop hold `(id-fn data)`; its timer is cancelled and nothing is sent."
  [id-fn]
  (script {:expr (fn [_ data] (cancel-hold-ops data (id-fn data)))}))

(def no-such-hold "No held act has that id.")

(defn hold-approve-correction
  "The `:hold/approve {:id :reason}` correction (q12 approve-early), ready to place on the chart's top
   state (declare `:hold/approve` in `:acts` with its `:needs`)."
  ([] (hold-approve-correction {}))
  ([attrs]
   (correction (merge {:event :hold/approve
                       :checks [{:name :hold-exists
                                 :fn   (fn [data] (when-not (contains? (:sova/holds data) (:id (evt data))) no-such-hold))}]}
                 attrs)
     (approve-hold #(:id (evt %))))))

(defn hold-cancel-correction
  "The `:hold/cancel {:id :reason}` correction, ready to place on the chart's top state (declare
   `:hold/cancel` in `:acts` with its `:needs`)."
  ([] (hold-cancel-correction {}))
  ([attrs]
   (correction (merge {:event :hold/cancel
                       :checks [{:name :hold-exists
                                 :fn   (fn [data] (when-not (contains? (:sova/holds data) (:id (evt data))) no-such-hold))}]}
                 attrs)
     (cancel-hold #(:id (evt %))))))

;; ---- spawn and links -------------------------------------------------------------------------------

(defn directive-ops [data d]
  [(ops/assign :sova/directives (conj (vec (:sova/directives data)) d))])

(defn spawn-ops
  [data {:keys [chart id link watch? if-exists] :as opts}]
  (let [cid  (id data)
        init (if-let [f (:data opts)] (f data) {})
        kids (vec (:sova/children data))]
    (into (directive-ops data {:op :spawn :chart chart :id cid :data init :link link
                               :watch? (not (false? watch?))
                               :if-exists (if (fn? if-exists) (if-exists data) if-exists)})
      [(ops/assign :sova/children (if (some #(= cid (:sid %)) kids) kids (conj kids {:sid cid :chart chart :link link})))])))

(defn spawn
  "Executable content: after this step, in the same call, start session `(id data)` of `chart` with
   `(data data)`, `:sova/links {link <this sid>}` and `:sova/watchers [<this sid>]` (unless
   `:watch? false`). `:if-exists :skip` (or a fn [data] returning it) makes an existing id a no-op
   (else the call throws)."
  [opts]
  (script {:expr (fn [_ data] (spawn-ops data opts))}))

(defn watch
  "Executable content: watch session `(target-fn data)` (it notifies this session with
   `link/moved`; one is sent at once)."
  [target-fn]
  (script {:expr (fn [_ data] (directive-ops data {:op :watch :target (target-fn data)}))}))

(defn unwatch
  [target-fn]
  (script {:expr (fn [_ data] (directive-ops data {:op :unwatch :target (target-fn data)}))}))

(defn drive
  "Executable content (r3, a chart-started act): after this step the engine delivers `event` to
   `(target data)` (default: this session) with payload `(data data)` under a fresh envelope from
   the host's `stamp`, `by` chart and not attended, through the normal path (checks, holds)."
  [{:keys [event target] :as opts}]
  (script {:expr (fn [_ d]
                   (directive-ops d {:op :drive :event event
                                     :target (when target (target d))
                                     :ctx (let [e (evt d)]
                                            (cond-> {}
                                              (:project-id e) (assoc :project-id (:project-id e))
                                              (:project-id d) (assoc :project-id (:project-id d))))
                                     :data (if-let [f (:data opts)] (f d) {})}))}))

(defn linked "The session this one links as `link` (from its spawn)." [data link] (get (:sova/links data) link))
