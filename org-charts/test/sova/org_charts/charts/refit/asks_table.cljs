(ns sova.org-charts.charts.refit.asks-table
  "r14: every authored transition that sends the watch a reason (a `Send` of `:reason/noted`, or a
   script marked `:sova/reason`), keyed as the feed table, → its `:sova/asks-overseer` declaration:
   true, false, a named rule (`:unwritten-false`, `:unless-auto-promoted`), or a map of reason kind →
   one of those; `::undeclared` when it has none."
  (:require
    [com.fulcrologic.statecharts :as sc]
    [sova.org-charts.charts.registry :as registry]))

(defn- events-of [t] (let [e (:event t)] (vec (sort (map str (cond (nil? e) [] (sequential? e) e :else [e]))))))

(defn- descendants-of [els id]
  (mapcat (fn [c] (cons (get els c) (descendants-of els c))) (:children (get els id))))

(defn- sends-reason? [els t]
  (some #(or (and (= :send (:node-type %)) (= :reason/noted (:event %))) (:sova/reason %)) (descendants-of els (:id t))))

(defn table []
  (into (sorted-map)
    (for [[nm {:keys [chart]}] registry/charts
          :let [els (::sc/elements-by-id chart)
                ord (::sc/id-ordinals chart)
                ts  (->> (vals els)
                         (filter #(= :transition (:node-type %)))
                         (remove #(let [p (get els (:parent %))] (or (:initial? p) (= :history (:node-type p)))))
                         (sort-by #(get ord (:id %))))]
          [k grp] (group-by (fn [t] [nm (str (:parent t)) (events-of t) (str (vec (:target t)))]) ts)
          [i t]   (map-indexed vector grp)
          :when   (or (sends-reason? els t) (contains? t :sova/asks-overseer))]
      [(conj k i) (if (contains? t :sova/asks-overseer) (:sova/asks-overseer t) ::undeclared)])))
