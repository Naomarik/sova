(ns sova.statecharts.refit.decision-results-test
  "The reconciler's results to a decision (server-3 P3): a promoted one stays promoted on a run's
   \"drafted\" fields; a superseded one keeps collecting the restatements folded into it."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.refit.host :as h]))

(def dsid "decision/o1/pr1/s1:e1")
(defn decision [] (h/start! (h/new-host) "decision" dsid {:org-id "o1" :project-id "pr1" :id "s1:e1" :area "Pay" :owner-area "none" :statement "S"}))
(defn promoted []
  (-> (decision)
      (h/send! dsid :reconcile/result {:state "drafted" :record-id "§requirements.pay/s"})
      (h/send! dsid :promote/done {:text-hash "h1" :commit "abc"})))

(deftest P3-6-a-run-never-demotes-a-promoted-decision
  (let [p (promoted)
        y (h/send! p dsid :reconcile/result {:state "drafted" :record-id "§requirements.pay/s2" :checked-with ["d2"]})]
    (is (h/in? p dsid :promoted))
    (is (h/in? y dsid :promoted) "a promoted one's fields come as drafted: it stays promoted")
    (is (= "promoted" (:state (h/data y dsid))))
    (is (= "§requirements.pay/s2" (:record-id (h/data y dsid))) "and takes the fields")
    (is (= "Its words in the spec are as they were promoted." (h/refusal y dsid :decision/settle-text {:by "operator" :action "keep"}))
      "Keep/Restore still answer as for a promoted decision")
    (testing "it leaves promoted only for conflict or superseded"
      (is (h/in? (h/send! p dsid :reconcile/result {:state "conflict"}) dsid :conflicted))
      (is (h/in? (h/send! p dsid :reconcile/result {:state "superseded" :superseded-by "d9"}) dsid :superseded)))))

(deftest P3-5-a-superseded-decision-keeps-its-folded-restatements
  (let [s (h/send! (decision) dsid :reconcile/result {:state "superseded" :superseded-by "d9"})
        y (h/send! s dsid :reconcile/result {:state "superseded" :superseded-by "d9" :folded ["d3" "d4"]})]
    (is (h/in? y dsid :superseded))
    (is (= ["d3" "d4"] (:folded (h/data y dsid))))))

;; ---- P3 3: a re-route carries the conflict's new owner area ------------------------------------------

(def csid "conflict/o1/pr1/cf1")
(defn conflict [d]
  (h/start! (h/new-host) "conflict" csid
    (merge {:org-id "o1" :project-id "pr1" :id "cf1" :area "Pay" :owner-area "payroll" :baton-session-id "s9"
            :a {:id "d1" :name "Ana" :statement "Monthly" :quote "monthly" :at 0} :b {:id "d2" :name "Bob" :statement "Weekly" :quote "weekly" :at 0}} d)))

(deftest P3-3-an-owner-area-change-re-routes-and-changes-the-area
  (let [x (conflict {:routed-to "p3" :route-reason "Cy decides pay."})]
    (testing "to someone else: a new session, and the new area"
      (let [y (h/send! x csid :conflict/reroute {:by "operator" :to "operator" :session-id "s10" :operator-name "Omar" :owner-area "finance"})]
        (is (h/in? y csid :routed-to-operator))
        (is (= "finance" (:owner-area (h/data y csid))))))
    (testing "to the same person (keepIfSame): no new session, the area still changes"
      (let [y (h/send! x csid :conflict/reroute {:by "operator" :to "p3" :target {:status "active"} :keep-if-same true :owner-area "finance"})]
        (is (= "s9" (:baton-session-id (h/data y csid))))
        (is (= "finance" (:owner-area (h/data y csid))))))
    (testing "a re-route without one keeps the area"
      (is (= "payroll" (:owner-area (h/data (h/send! x csid :conflict/reroute {:by "operator" :to "operator" :session-id "s10" :operator-name "Omar"}) csid)))))))
