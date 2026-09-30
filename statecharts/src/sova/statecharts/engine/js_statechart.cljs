(ns sova.statecharts.engine.js-statechart
  "A statechart written in JS, for statecharts registered at runtime (`createEngine({statecharts})`): the engine's TS
   tests register their probe this way, so they run the shipped bundle itself. A node is an array
   `[tag, attrs, ...children]` that mirrors the CLJS element call: `[\"state\", {id: \"a\"}, ...]` is
   `(state {:id :a} ...)`. The root is `[\"statechart\", attrs, ...]`; `[\"history\", attrs, \"a\"]` takes
   its default target as the third item.

   Attrs: keys become keywords (\"sova/needs\" → :sova/needs, camelCase → kebab). The values of `id`,
   `initial`, `target`, `event`, `sendid` and `type` become keywords (an array: a vector of them), and a
   `cond` of `[\"In\", \"open\"]` is `(In :open)`. A function is called with the data model as JS (the
   API's marshalling) and its result comes back as CLJS; a `cond`'s result is a boolean, and a
   `script`'s `expr` returns an array of operations such as `{op: \"assign\", data: {fired: 1}}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.elements
     :refer [state parallel transition on-entry on-exit script Send cancel history invoke In final raise]]))

(def ^:private keyword-attrs #{:id :initial :target :event :sendid :type})

(defn- attr-key [k]
  (keyword (if (re-matches #"[a-z][a-zA-Z0-9]*" k)
             (str/replace k #"[A-Z]" #(str "-" (str/lower-case %)))
             k)))

(defn- js-fn
  "`f` as an element expression: `(fn [env data])` over the data model as JS."
  [tag k f ->js ->clj]
  (cond
    (= :cond k) (fn [_ data] (boolean (f (->js data))))
    (and (= "script" tag) (= :expr k))
    (fn [_ data]
      (let [ops (f (->js data))]
        (when (array? ops) (mapv #(update (->clj %) :op keyword) ops))))
    :else (fn [_ data] (->clj (f (->js data))))))

(defn- attrs [tag o ->js ->clj]
  (into {}
    (map (fn [k]
           (let [kw (attr-key k)
                 v  (unchecked-get o k)]
             [kw (cond
                   (fn? v) (js-fn tag kw v ->js ->clj)
                   (and (= :cond kw) (array? v) (= "In" (aget v 0))) (In (keyword (aget v 1)))
                   (keyword-attrs kw) (if (array? v) (mapv keyword v) (keyword v))
                   :else (->clj v))])))
    (js-keys (or o #js {}))))

(def ^:private constructors
  {"state" state, "parallel" parallel, "final" final, "transition" transition,
   "onEntry" on-entry, "onExit" on-exit, "script" script, "send" Send, "cancel" cancel,
   "raise" raise, "invoke" invoke})

(defn build
  "The statechart for the JS tree `node`. `->js` / `->clj` are the API's marshalling."
  [node ->js ->clj]
  (letfn [(el [n]
            (when-not (array? n) (throw (ex-info (str "A statechart node is an array [tag, attrs, ...children], got " n) {})))
            (let [tag  (aget n 0)
                  as   (attrs tag (aget n 1) ->js ->clj)
                  more (.slice n 2)]
              (case tag
                "statechart" (apply chart/statechart as (map el more))
                "history"    (history as (keyword (aget more 0)))
                (if-let [f (constructors tag)]
                  (if (#{"script" "send" "cancel" "raise" "invoke"} tag)
                    (f as)
                    (apply f as (map el more)))
                  (throw (ex-info (str "Unknown statechart node " tag) {}))))))]
    (el node)))
