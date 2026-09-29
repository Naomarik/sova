(ns sova.org-charts.charts.facts
  "What a work item knows from the stores: its linked baton, its decisions and its build, as the
   host projects them (`facts/changed`). The chart owns none of these; it only reads them. Derived
   values (the decision phase, whether the build landed, whether everything is built) are defined
   here, once, so the chart's conditions and the tests agree."
  (:require
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.common :as c]))

(defn live-decisions
  "Decisions not superseded (a superseded one was replaced; its replacement counts)."
  [decisions]
  (remove #(= "superseded" (:state %)) decisions))

(defn dphase
  "The item's decision phase, from its decisions (shared/decisions.ts DecisionState):
   \"none\" (no live decision), \"conflict\" (any in an open conflict), \"pending\" (any not
   compared), \"drafted\" (any promotable), \"edited\" (all promoted, one edited in the spec since),
   \"promoted\" (all promoted)."
  [decisions]
  (let [live   (live-decisions decisions)
        states (set (map :state live))]
    (cond
      (empty? live) "none"
      (states "conflict") "conflict"
      (states "pending") "pending"
      (states "drafted") "drafted"
      (some :edited-in-spec live) "edited"
      :else "promoted")))

(defn all-built?
  "Every live decision is promoted and its spec record says built (DecisionRow.build)."
  [decisions]
  (let [live (live-decisions decisions)]
    (and (seq live) (every? #(and (= "promoted" (:state %)) (= "built" (:build %))) live))))

(defn baton-state [data] (get-in data [:baton :state]))
(defn baton-live? [data] (contains? #{"open" "needs-you"} (baton-state data)))
(defn baton-ended? [data] (contains? #{"done" "closed"} (baton-state data)))

(defn build [data] (:build data))
(defn running? [data] (true? (get-in data [:build :running])))
(defn last-failed? [data] (true? (get-in data [:build :last-failed])))

(defn landed?
  "The build's work is where it belongs: its branch is merged into its target (CodingWorktree
   .merged, by Merge Branch or by hand), or it runs in the project root and is not working."
  [data]
  (let [b (build data)]
    (boolean (and b (or (:merged b) (and (= "root" (:state b)) (not (:running b))))))))

(defn phase-of [data] (dphase (:decisions data)))

(defn covers?
  "The linked build covers the item's promoted decisions: it names them (`:decision-ids`, the
   new decisions → coding edge), or it names none (no edge recorded: taken as covering)."
  [data]
  (let [b (build data)]
    (boolean
      (and b (or (nil? (:decision-ids b))
                 (let [ids (set (:decision-ids b))]
                   (every? #(contains? ids (:id %)) (filter #(= "promoted" (:state %)) (live-decisions (:decisions data))))))))))

(defn take-facts
  "Ops recording the facts in the event: each key present replaces that fact (nil clears it)."
  [data]
  (let [e (c/evt data)]
    (into (c/stamp-now data)
      (for [k [:baton :decisions :build] :when (contains? e k)]
        (ops/assign k (get e k))))))

;; ---- conditions over facts (fn [env data]) ---------------------------------------------------------

(defn dphase= [& phases]
  (let [ps (set phases)] (fn [_ data] (contains? ps (phase-of data)))))

(defn baton= [& states]
  (let [ss (set states)] (fn [_ data] (contains? ss (baton-state data)))))

(defn new-baton?
  "The linked baton is not the one the item had before its last gather/start (stale facts must
   not move a new attempt)."
  [_ data]
  (and (some? (:baton data)) (not= (get-in data [:baton :id]) (:baton-before data))))
