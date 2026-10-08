(ns sova.statecharts.refit.asks-test
  "r14 (coordinator-46/48): every transition that sends the watch a reason declares what it asks of
   the overseer (`:sova/asks-overseer`: true, false, a named rule, or a map of reason kind → one),
   and the declarations are pinned by a golden table (like the feed classes)."
  (:require
    [cljs.test :refer [deftest is]]
    [sova.statecharts.refit.asks-table :as at]
    [sova.statecharts.refit.asks-golden :as ag]))

(deftest every-reason-sending-transition-declares-what-it-asks
  (let [undeclared (for [[k v] (at/table) :when (= ::at/undeclared v)] k)]
    (is (empty? undeclared) (str "no :sova/asks-overseer on " (pr-str undeclared)))))

(deftest every-declaration-is-the-golden-one
  (let [now (at/table)
        ks  (into (set (keys now)) (keys ag/golden))
        bad (for [k (sort ks) :when (not= (get now k ::none) (get ag/golden k ::none))]
              [k :now (get now k ::none) :golden (get ag/golden k ::none)])]
    (is (= 42 (count ag/golden)))
    (is (empty? bad) (str (count bad) " differ: " (pr-str bad)))))
