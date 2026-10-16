(ns sova.statecharts.refit.residence-test
  "The residence's hourly committer on the real engine (§app.organizations/workspace-repo): a look that
   would find nothing due never happens, so an idle org's calls produce no step and no snapshot (the
   host writes no file, journal or log row for them); a due look commits; a restart keeps the due time."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.engine.core :as core]))

(def t0 1000000000)
(def hour 3600000)
(def sid "residence/o1")

(defn- eng [] (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true}))
(defn- in? [e s] (contains? (set (core/configuration e sid)) s))
(defn- commit-key [r] (:key (first (filter #(= "commit" (:kind %)) (:outbox r)))))
(defn- answer! [e r head-at now]
  (core/send! e sid :effect/done {:key (commit-key r) :by "system" :result {:head-at head-at}} {:now now}))
(defn- nothing-written? [r] (and (empty? (filter :saved (:steps r))) (empty? (:snapshots r))))

(defn- created
  "A created org whose first commit (HEAD) is at `head-at`."
  [head-at]
  (let [e (eng)
        r (core/start! e sid "residence" {:org-id "o1" :org-name "Acme" :host-id "h_me" :host-name "me" :mode "create" :commit-every-ms hour} t0)]
    (answer! e r head-at (+ t0 5))
    e))

(defn- minutes
  "fire-due! once a minute from `from` to `to` (exclusive): every call's result."
  [e from to]
  (mapv #(core/fire-due! e %) (range from to 60000)))

(deftest an-idle-org-persists-nothing-until-its-commit-is-due
  (let [e (created t0)]
    (is (in? e :clean))
    (is (every? nothing-written? (minutes e (+ t0 60000) (+ t0 hour)))
      "no minute before the hour takes a step or rewrites a snapshot")
    (testing "a write makes it dirty (saved); the dirty wait persists nothing either"
      (let [w (core/send! e sid :store/written {:by "system"} {:now (+ t0 hour -600000)})]
        (is (seq (:snapshots w)))
        (is (in? e :dirty))
        (is (every? nothing-written? (minutes e (+ t0 hour -540000) (+ t0 hour))))))
    (testing "the due look commits on the hour"
      (let [r (core/fire-due! e (+ t0 hour))]
        (is (= [:commit/look] (mapv :event (filter :saved (:steps r)))))
        (is (in? e :committing))
        (is (some? (commit-key r)))))))

(deftest a-restart-keeps-the-due-time
  (let [e  (created t0)
        e2 (eng)]
    (core/fire-due! e (+ t0 600000))
    (core/load! e2 sid (core/dump e sid))
    (is (= (+ t0 hour) (core/next-due-at e2)) "the snapshot holds the look at the due instant")
    (is (nothing-written? (core/fire-due! e2 (+ t0 hour -1))))
    (core/fire-due! e2 (+ t0 hour))
    (is (contains? (set (core/configuration e2 sid)) :committing))))

(deftest the-look-follows-head
  (testing "a HEAD older than the hour: a look within a minute, as before"
    (let [e (created (- t0 (* 2 hour)))]
      (is (= (+ t0 5 60000) (core/next-due-at e)))
      (core/fire-due! e (+ t0 5 60000))
      (is (in? e :committing))))
  (testing "a commit answered while clean moves the waiting look to HEAD's new hour"
    (let [e (created t0)]
      (is (= (+ t0 hour) (core/next-due-at e)))
      ;; the create's commit, answered again later (as an attach's or detach's commit would be)
      (let [e2 (eng)
            r  (core/start! e2 sid "residence" {:org-id "o1" :host-id "h_me" :host-name "me" :mode "create" :commit-every-ms hour} t0)]
        (is (= (+ t0 60000) (core/next-due-at e2)) "no HEAD known yet: a look in a minute")
        (answer! e2 r (+ t0 1800000) (+ t0 1000))
        (is (= (+ t0 1800000 hour) (core/next-due-at e2)) "re-armed at HEAD + the hour")
        (is (every? nothing-written? (minutes e2 (+ t0 60000) (+ t0 1800000 hour))))))))

(deftest re-arming-the-look-rewrites-no-other-snapshot
  ;; the create's commit is answered after git committed the org's snapshot: re-arming the residence's
  ;; look (a cancel and a send) must leave the org's snapshot as committed (a cancel touches only its queue)
  (let [e (eng)
        _ (core/start! e "org/o1" "org" {:id "o1" :name "Acme" :slug "acme" :created-at t0} t0)
        r (core/start! e sid "residence" {:org-id "o1" :org-name "Acme" :host-id "h_me" :host-name "me" :mode "create" :commit-every-ms hour} t0)
        _ (is (= #{"org/o1" sid} (set (keys (:snapshots r)))) "the create holds the org: both saved")
        a (answer! e r t0 (+ t0 5))]
    (is (= [sid] (keys (:snapshots a))) "the answer saves the residence alone")
    (is (= (+ t0 hour) (core/next-due-at e)))))
