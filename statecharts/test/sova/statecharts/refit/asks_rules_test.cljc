(ns sova.statecharts.refit.asks-rules-test
  "r14 (coordinator-46/48): the overseer is woken only when something is asked of it, even when the
   statechart drove the act. Both branches of each named rule, the resolved `:asks` against the declaration,
   and the watch waking (or not) on it."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.refit.host :as h]))

(def statechart {:by "statechart" :attended false :hold-ms 0})
(defn reasons-to-watch [x]
  (vec (mapcat (fn [s] (let [d (:data s)] (if (contains? d :reasons) (:reasons d) [d])))
               (filter #(= :reason/noted (:event %)) (h/elsewhere x)))))
(defn of-kind [x kind] (first (filter #(= kind (:kind %)) (reasons-to-watch x))))

;; ---- the watch: statechart news wakes it only when it asks ------------------------------------------------

(def wsid "watch/pr1")
(defn watch [] (-> (h/start! (h/new-host) "watch" wsid {:project-id "pr1" :tick-ms 0 :last-run-at 1700000000000})
                   (h/send! wsid :link/moved {:from "project/pr1" :statechart "project" :states [:project :has-overseer :active] :exported {:name "Site"}})))

(deftest the-watch-wakes-for-statechart-news-that-asks
  (let [r {:kind "baton/closed" :params {:title "T" :session-id "s1"} :key "baton/closed:s1" :by "statechart"}]
    (is (h/in? (h/send! (watch) wsid :reason/noted (assoc r :asks true)) wsid :waiting) "it asks: a look reason, as on master")
    (is (h/in? (h/send! (watch) wsid :reason/noted (assoc r :asks false)) wsid :quiet) "it asks nothing: feed only")
    (is (h/in? (h/send! (watch) wsid :reason/noted r) wsid :quiet) "undeclared statechart news asks nothing")
    (is (h/in? (h/send! (watch) wsid :reason/noted (assoc r :by "system" :asks false)) wsid :waiting) "not the statechart's: a reason, as always")))

;; ---- :unwritten-false (a gathering closed) ------------------------------------------------------------

(def bsid "baton/o1/s1")
(defn baton [] (h/start! (h/new-host) "baton" bsid {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "T" :goal "G"
                                                     :owner {:overseer-of "pr1"} :to "p1" :names {"p1" "Ana"} :operator-name "Omar"}))
(def close (merge statechart {:reason "A newer gathering on §gap/x to the same person covers it." :owner-project "pr1" :autonomy "L1"}))

(deftest unwritten-false
  (testing "the statechart closes its own unwritten gathering: feed only"
    (let [r (of-kind (h/send! (baton) bsid :baton/close close) "baton/closed")]
      (is (= "statechart" (:by r)))
      (is (false? (:asks r)))))
  (testing "someone wrote in it: the close asks the overseer (it wakes); the statechart may not close it (refused), so it is someone else's"
    (let [x (-> (baton) (h/send! bsid :baton/message {:by "person" :from "p1" :active true}) (h/send! bsid :reply/ended {}))
          r (of-kind (h/send! x bsid :baton/close {:by "operator" :reason "Done."}) "baton/closed")]
      (is (some? (h/refusal x bsid :baton/close close)) "the statechart's close of a written gathering is refused")
      (is (true? (:asks r)))
      (is (h/in? (h/send! (watch) wsid :reason/noted (assoc r :by "statechart")) wsid :waiting) "asks: it would wake even as the statechart's news"))))

;; ---- :unless-auto-promoted (a run's drafted decisions) --------------------------------------------------

(def rsid "reconciler/o1/pr1")
(defn rec [] (h/start! (h/new-host) "reconciler" rsid {:org-id "o1" :project-id "pr1"}))
(defn index [x id owns?]
  (h/send! x rsid :link/moved {:from (str "decision/o1/pr1/" id) :statechart "decision" :states [:decision :drafted]
                               :exported {:state "drafted" :author-owns-area owns? :name "Ana"}}))
(defn run [x level ids]
  (-> x (h/send! rsid :reconcile/request (assoc statechart :autonomy level))
        (h/send! rsid :reconcile/finished {:decisions [] :drafted-ids ids :conflicts [{:id "cf1" :routed-to "operator" :baton-session-id "s9"}]
                                           :resolved [{:id "cf0"}]})))

(deftest unless-auto-promoted
  (let [x (-> (rec) (index "d1" true) (index "d2" false))]
    (is (false? (:asks (of-kind (run x "L2" ["d1"]) "reconcile/drafted"))) "L2, in its author's area: the statechart promotes it itself; feed only")
    (is (true? (:asks (of-kind (run x "L2" ["d1" "d2"]) "reconcile/drafted"))) "L2 with one out of area: it asks")
    (is (true? (:asks (of-kind (run x "L1" ["d1"]) "reconcile/drafted"))) "L1: the statechart won't promote; it asks")
    (testing "a conflict to route and a resolved conflict always ask"
      (let [y (run x "L2" ["d1"])]
        (is (true? (:asks (of-kind y "reconcile/conflict"))))
        (is (true? (:asks (of-kind y "reconcile/resolved"))))
        (is (every? #(= "statechart" (:by %)) (reasons-to-watch y)))))
    (testing "the statechart's own promotion is feed only"
      (let [p (h/send! x rsid :decision/promote (merge statechart {:autonomy "L2" :ids ["d1"] :ledger "day" :allowance {:promote {:used 0 :max 60}}}))
            e (last (h/outbox p rsid))
            r (of-kind (h/send! p rsid :effect/done {:kind "promote" :effect e :result {:promoted ["d1"]}}) "reconcile/promoted")]
        (is (= "statechart" (:by r)))
        (is (false? (:asks r)))))))
