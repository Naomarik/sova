(ns sova.statecharts.refit.proj-strip-org-test
  "TEMPORARY, with proj-strip-org: a v1 project snapshot (synthetic, built here) loads as v2 with its
   organization gone. Deleted with the migration after the cutover."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.engine.core :as core]))

(def t0 1000000)
(def psid "project/pr1")
(def dm :com.fulcrologic.statecharts.data-model.working-memory-data-model/data-model)
(def cfg :com.fulcrologic.statecharts/configuration)

(def org-states #{:stake :stakeholder-set :milestone :since-post :cooldown :cooling})

(defn- v1-text
  "A v2 project dumped and dressed as a v1 one: the org's regions entered, its keys, the org's watcher
   and link, a gathering in `started`, a cooldown timer pending."
  []
  (let [eng (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})]
    (core/start! eng psid "project" {:id "pr1" :name "Site" :root "/r"} t0)
    (core/send! eng psid :started/noted {:sid "build/pr1/c1" :kind "coding"} {:now (+ t0 1)})
    (-> (core/read-snapshot (core/dump eng psid))
      (assoc :version 1)
      (update-in [:wmem cfg] into org-states)
      (update-in [:wmem dm] merge
        {:org-id "o1" :stakeholder "p1" :stakeholder-history [{:at 1 :from nil :to "p1" :why "operator"}]
         :owner-hidden true :spec {:frozen true :at 1} :last-post-at (+ t0 1) :milestone true})
      (update-in [:wmem dm :sova/watchers] (fn [ws] (into ["org/o1"] ws)))
      (update-in [:wmem dm :sova/links] assoc :org "org/o1")
      (update-in [:wmem dm :sova/children] (fnil into []) [{:sid "reconciler/o1/pr1" :statechart "reconciler" :link :project}
                                                         {:sid "baton/o1/s1" :statechart "baton" :link :project}])
      (update-in [:wmem dm :started] (fn [rows] (into [{:sid "baton/o1/s1" :kind "gathering" :at 1 :settled false}] rows)))
      (update :queue conj {:event {:name :cooldown/over :data {} :sendid :cooldown-timer} :delivery-time (+ t0 86400000) :ordinal 99})
      core/snapshot-text)))

(deftest a-v1-project-loads-without-its-organization
  (let [text (v1-text)
        eng  (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})]
    (is (= 2 (:version (core/load! eng psid text))))
    (let [c (set (core/configuration eng psid))
          d (core/data eng psid)]
      (is (empty? (filter org-states c)) "the org's regions are gone")
      (is (every? c [:project :regions :shelf :active :overseer :no-overseer]) "its own regions stay")
      (doseq [k [:org-id :stakeholder :stakeholder-history :stakeholder-cleared :owner-hidden :spec :last-post-at :milestone]]
        (is (not (contains? d k)) (str k)))
      (is (= ["build/pr1/c1"] (map :sid (:started d))) "the gatherings leave its list (the placement keeps those)")
      (is (not-any? #{"org/o1"} (:sova/watchers d)))
      (is (not (contains? (:sova/links d) :org)))
      (is (not-any? #(re-find #"^(reconciler|baton)/" (:sid %)) (:sova/children d)))
      (is (= {:name "Site" :id "pr1" :project-id "pr1"} (select-keys d [:name :id :project-id]))))
    (testing "no org timer is left to fire"
      (is (empty? (filter #(= :cooldown/over (get-in % [:event :name])) (:queue (core/read-snapshot (core/dump eng psid)))))))
    (testing "a v2 snapshot is untouched"
      (is (= (core/migrate-text registry/statecharts text) (core/migrate-text registry/statecharts (core/migrate-text registry/statecharts text)))))))
