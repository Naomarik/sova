(ns sova.statecharts.engine.probe-parity-test
  "The probe exists twice: probe.cljs here, and a JS copy the TS engine tests register at runtime
   (server/fixtures/statecharts-engine/probe-statechart.ts). Both must have the shape in probe_shape.json
   (states, transitions, history defaults, timers, raises, sends, invocations, in document order):
   this test checks probe.cljs, server/statecharts.test.ts checks the JS copy, with the same lines
   (probe-statechart.ts's probeShape)."
  (:require
    [cljs.test :refer [deftest is]]
    [com.fulcrologic.statecharts :as sc]
    [sova.statecharts.engine.probe :as probe]))

(defn- nm [k] (if (keyword? k) (subs (str k) 1) (str k)))
(defn- lst [v] (cond (nil? v) "-" (and (coll? v) (empty? v)) "-" (coll? v) (apply str (interpose "," (map nm v))) :else (nm v)))

(defn- own-id
  "An element's id as its author wrote it, or \"-\" for a generated one (`genid`: send1317)."
  [e]
  (let [s (nm (:id e))] (if (or (nil? (:id e)) (re-matches #"(send|history)\d+" s)) "-" s)))

(defn shape [statechart]
  (let [by-id (::sc/elements-by-id statechart)
        out   (volatile! [])
        emit  #(vswap! out conj %)]
    (letfn [(walk [id state]
              (let [e (get by-id id)
                    t (when-not (:initial? e) (:node-type e)) ; the library's initial pseudo-states are not written
                    here (if (#{:state :parallel :final} t) (nm (:id e)) state)]
                (case t
                  (:state :parallel :final) (emit (str (name t) " " (nm (:id e)) " in " state))
                  :history (emit (str "history " (nm (:id e)) " " (nm (or (:type e) :shallow)) " in " state " default "
                                   (lst (some #(:target (get by-id %)) (:children e)))))
                  :transition (emit (str "transition in " state " on " (lst (:event e)) " to " (lst (:target e))
                                      (when (:cond e) " guarded")))
                  :send (emit (str "send in " state " " (nm (:event e)) " id " (own-id e) " delay "
                                (or (:delay e) (when (:delayexpr e) "expr") "-") (when (:targetexpr e) " targeted")))
                  :cancel (emit (str "cancel in " state " " (nm (:sendid e))))
                  :raise (emit (str "raise in " state " " (nm (:event e))))
                  :invoke (emit (str "invoke in " state " " (nm (:type e)) " id " (nm (:id e))))
                  nil)
                (when-not (or (= :history t) (:initial? e))
                  (doseq [c (:children e)] (walk c here)))))]
      (doseq [c (:children statechart)] (walk c "ROOT")))
    @out))

(deftest probe-matches-its-js-copy
  (let [fs   (js/require "fs")
        want (js->clj (js/JSON.parse (.readFileSync fs "src/sova/statecharts/engine/probe_shape.json" "utf8")))
        got  (shape probe/statechart)]
    (is (= want got) (str "probe.cljs and probe_shape.json differ; first difference at line "
                          (count (take-while true? (map = want got)))))))
