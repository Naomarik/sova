(ns sova.org-charts.charts.refit.acts-table
  "Every act of the registry with the metadata the engine and the tools act on: `[chart event]` →
   `{:needs :tool :hold :counts :people-facing :code-facing :correction :card? :hours? :what? :confirm?}`
   (fns only as present/absent). The golden copy is acts-golden."
  (:require [sova.org-charts.charts.registry :as registry]))

(defn table []
  (into (sorted-map)
    (for [[nm {:keys [acts]}] registry/charts
          [ev m] acts]
      [[nm (str ev)]
       (into (sorted-map)
         (remove (comp nil? val)
           {:needs (:needs m) :tool (:tool m) :hold (:hold m) :counts (:counts m)
            :people-facing (:people-facing m) :code-facing (:code-facing m) :correction (:correction m)
            :card? (when (:card m) true) :hours? (when (:hours m) true) :what? (when (:what m) true)
            :confirm? (when (:confirm-kind m) true)}))])))
