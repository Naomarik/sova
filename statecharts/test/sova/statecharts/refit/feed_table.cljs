(ns sova.statecharts.refit.feed-table
  "r8a: every authored transition of the registry with its feed class, under a key that survives
   renumbering: `[statechart source-state events target n]` (n: the how-many-th transition with that same
   source, events and target, in document order) → `:feed | :quiet | :correction | nil`."
  (:require
    [com.fulcrologic.statecharts :as sc]
    [sova.statecharts.registry :as registry]))

(defn- events-of [t] (let [e (:event t)] (vec (sort (map str (cond (nil? e) [] (sequential? e) e :else [e]))))))

(defn- class-of [t]
  (cond (:sova/correction t) :correction
        (:sova/feed t) (keyword (name (:sova/feed t)))
        :else nil))

(defn table []
  (into (sorted-map)
    (for [[nm {:keys [statechart]}] registry/statecharts
          :let [els (::sc/elements-by-id statechart)
                ord (::sc/id-ordinals statechart)
                ts  (->> (vals els)
                         (filter #(= :transition (:node-type %)))
                         ;; initial and history defaults (the engine's pseudo-transitions) aren't authored
                         (remove #(let [p (get els (:parent %))] (or (:initial? p) (= :history (:node-type p)))))
                         (sort-by #(get ord (:id %))))]
          [k grp] (group-by (fn [t] [nm (str (:parent t)) (events-of t) (str (vec (:target t)))]) ts)
          [i t]   (map-indexed vector grp)]
      [(conj k i) (class-of t)])))
