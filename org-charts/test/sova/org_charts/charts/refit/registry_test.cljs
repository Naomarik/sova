(ns sova.org-charts.charts.refit.registry-test
  "Registry-wide lints over the eleven charts."
  (:require
    [cljs.test :refer [deftest is]]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.engine.core :as core]))

(deftest no-transition-re-enters-a-whole-parallel
  (is (empty? (core/reentry-hazards registry/charts))
    "an external transition to its own source's descendant under a parallel re-enters every region (use :type :internal)"))
