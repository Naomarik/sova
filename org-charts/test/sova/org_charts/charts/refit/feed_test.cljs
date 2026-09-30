(ns sova.org-charts.charts.refit.feed-test
  "r8a: per chart, a quiet step and a feed step as the log records them (the engine's step `:feed`,
   from the classes the transitions declare). The enumeration is registry-test's."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.org-charts.charts.refit.feed-golden :as fg]
    [sova.org-charts.charts.refit.feed-table :as ft]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.engine.core :as core]))

(def t0 1000000)
(def op {:by "operator"})

(defn- eng [] (core/new-engine registry/charts {:level-check lv/level-check :absorb-unknown true}))

(defn- feed-of
  "The class of `sid`'s own step for `event` (sent with `payload`)."
  [e sid event payload]
  (let [r (core/send! e sid event payload {:now (+ t0 1)})]
    (:feed (first (filter #(and (= sid (:session-id %)) (= event (:event %))) (:steps r))))))

(defn- started [chart sid data] (let [e (eng)] (core/start! e sid chart data t0) e))

(deftest org
  (let [sid "org/o1" mk #(started "org" sid {:id "o1" :name "Acme" :slug "acme"})]
    (is (= :quiet (feed-of (mk) sid :holder/claim {:host-id "h1" :host-name "me" :since 1})))
    (is (= :feed (feed-of (mk) sid :org/rename (assoc op :name "Acme 2"))))))

(deftest residence
  (let [sid "residence/o1"
        mk  #(let [e (started "residence" sid {:org-id "o1" :org-name "Acme" :host-id "h_me" :host-name "me" :mode "create"})] e)]
    (is (= :quiet (feed-of (mk) sid :store/written {})))
    (is (= :feed (feed-of (mk) sid :org/detach op)))))

(deftest person
  (let [sid "person/o1/p1" mk #(started "person" sid {:org-id "o1" :id "p1" :person {:name "Ana" :status "active"} :changed [] :by {:kind "operator"}})]
    (is (= :feed (feed-of (mk) sid :person/edit (assoc op :patch {:role "CFO"}))))
    (is (= :feed (feed-of (mk) sid :person/leave op)))))

(deftest project
  (let [sid "project/o1/pr1" mk #(started "project" sid {:org-id "o1" :id "pr1" :name "Site" :root "/r"})]
    (is (= :quiet (feed-of (mk) sid :milestone/noted {:kind "baton-done" :shown true})))
    (is (= :feed (feed-of (mk) sid :project/edit (assoc op :name "Site 2"))))))

(deftest watch
  (let [sid "watch/o1/pr1" mk #(started "watch" sid {:org-id "o1" :project-id "pr1"})]
    (is (= :quiet (feed-of (mk) sid :facts/changed {:roster-active true})))
    (is (= :quiet (feed-of (mk) sid :turn/started {:look true})))
    (is (= :feed (feed-of (mk) sid :operator/run-now op)) "an act (taken or refused) is feed")))

(deftest baton
  (let [sid "baton/o1/s1"
        mk  #(started "baton" sid {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "T" :goal "G" :to "p1"
                                   :owner {:overseer-of "pr1"} :names {"p1" "Ana"} :operator-name "Omar"})]
    (is (= :quiet (feed-of (mk) sid :reply/writing {})))
    (is (= :quiet (feed-of (mk) sid :budget/recount {:n 0})))
    (is (= :feed (feed-of (mk) sid :baton/message {:by "person" :from "p1" :active true})))))

(deftest decision
  (let [sid "decision/o1/pr1/d1" mk #(started "decision" sid {:org-id "o1" :project-id "pr1" :id "d1" :area "A" :owner-area "none" :statement "S"})]
    (is (= :quiet (feed-of (mk) sid :spec/facts {:record-present true})))
    (is (= :feed (feed-of (mk) sid :reconcile/result {:state "drafted" :record-id "§r/x"})))))

(deftest reconciler
  (let [sid "reconciler/o1/pr1" mk #(started "reconciler" sid {:org-id "o1" :project-id "pr1"})]
    (is (= :quiet (feed-of (mk) sid :decision/recorded {:id "d1"})))
    (is (= :quiet (feed-of (mk) sid :settings/reconcile {:on true})))))

(deftest conflict
  (let [sid "conflict/o1/pr1/cf1"
        mk  #(started "conflict" sid {:org-id "o1" :project-id "pr1" :id "cf1" :area "Pay" :routed-to "operator" :baton-session-id "s9"
                                      :a {:id "d1" :name "Ana" :statement "M" :quote "m" :at 0} :b {:id "d2" :name "Bob" :statement "W" :quote "w" :at 0}})]
    (let [e (mk)]
      (core/send! e sid :conflict/settle (assoc op :keep "a") {:now t0})
      (is (= :quiet (feed-of e sid :effect/done {:kind "settle"})) "the settle effect's answer: bookkeeping"))
    (is (= :feed (feed-of (mk) sid :conflict/settle (assoc op :keep "a"))))))

(deftest item
  (let [sid "item/o1/pr1/g_1" mk #(started "item" sid {:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/x"})]
    (is (= :quiet (feed-of (mk) sid :link/moved {:from "watch/o1/pr1" :chart "watch" :states [:watch] :exported {:settings {:autonomy "L0"}}})))
    (is (= :feed (feed-of (mk) sid :gap/drop op)))))

(deftest build
  (let [sid "build/o1/pr1/c1" mk #(started "build" sid {:org-id "o1" :project-id "pr1" :session-id "c1" :kind "coding" :title "T" :prompt "P"})]
    (is (= :quiet (feed-of (mk) sid :workers/changed {:n 0})))
    (is (= :feed (feed-of (mk) sid :effect/failed {:kind "make-worktree" :detail "x"})))))

(deftest every-transitions-class-is-the-golden-one
  (let [now (ft/table)
        ks  (into (set (keys now)) (keys fg/golden))
        bad (for [k (sort ks) :when (not= (get now k ::none) (get fg/golden k ::none))]
              [k :now (get now k ::none) :golden (get fg/golden k ::none)])]
    (is (= 436 (count fg/golden)))
    (is (empty? bad) (str (count bad) " differ: " (pr-str (take 20 bad))))))
