(ns sova.org-charts.charts.refit.world-test
  "Charts together on the real engine (the JVM host records links, it doesn't run them)."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.engine.core :as core]))

(def t0 1000000)
(def psid "project/o1/pr1")
(def wsid "watch/o1/pr1")
(def op {:by "operator"})

(defn- in? [eng sid s] (contains? (set (core/configuration eng sid)) s))

(deftest the-watch-sees-its-projects-overseer
  ;; server-3's replay: the watch never watched its project, so has-overseer was never set
  (let [eng (core/new-engine registry/charts {:level-check lv/level-check :absorb-unknown true})]
    (core/start! eng psid "project" {:org-id "o1" :id "pr1" :name "Site" :root "/r"} t0)
    (is (in? eng wsid :no-overseer) "the project spawned its watch, which sees no overseer yet")
    (is (= "Site" (:project-name (core/data eng wsid))) "the first link/moved came at once")
    (core/send! eng psid :overseer/start (assoc op :conversation-id "c1") {:now (+ t0 1)})
    (is (in? eng psid :has-overseer))
    (is (in? eng wsid :has-overseer) "the watch follows its project")
    (is (true? (:has-overseer (core/data eng wsid))))
    (testing "archive reaches the watch too"
      (core/send! eng psid :project/archive op {:now (+ t0 2)})
      (is (true? (:archived (core/data eng wsid)))))))

(deftest F14-a-clone-attached-on-a-fresh-host-gets-its-watch
  ;; the project is portable, its watch host-local: a clone carries project/o1/pr1 (with the old
  ;; host's watch as its watcher) and no watch. Attach starts the watch, paused (EVENTS.md, watch).
  (let [a     (core/new-engine registry/charts {:level-check lv/level-check :absorb-unknown true})
        _     (core/start! a psid "project" {:org-id "o1" :id "pr1" :name "Site" :root "/r"} t0)
        _     (core/send! a psid :overseer/start (assoc op :conversation-id "c1") {:now (+ t0 1)})
        store {psid (core/dump a psid)}
        b     (core/new-engine registry/charts {:level-check lv/level-check :load-cold #(get store %)})]
    (testing "before attach, a project step on the fresh host drops the missing watcher, never throws"
      (is (some? (core/send! b psid :project/edit (assoc op :name "Site 2") {:now (+ t0 2)}))))
    (core/start! b wsid "watch" {:org-id "o1" :project-id "pr1" :paused true} (+ t0 3))
    (is (in? b wsid :has-overseer) "the new watch watches the cloned project at once")
    (is (= "Site 2" (:project-name (core/data b wsid))))
    (is (true? (:paused (core/data b wsid))) "attach leaves it paused")
    (testing "and it keeps following the project"
      (core/send! b psid :project/archive op {:now (+ t0 4)})
      (is (true? (:archived (core/data b wsid)))))))
