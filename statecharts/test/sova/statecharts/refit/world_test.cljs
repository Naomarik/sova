(ns sova.statecharts.refit.world-test
  "Statecharts together on the real engine (the JVM host records links, it doesn't run them)."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.engine.core :as core]))

(def t0 1000000)
(def psid "project/o1/pr1")
(def wsid "watch/o1/pr1")
(def op {:by "operator"})

(defn- in? [eng sid s] (contains? (set (core/configuration eng sid)) s))

(deftest the-watch-sees-its-projects-overseer
  ;; server-3's replay: the watch never watched its project, so has-overseer was never set
  (let [eng (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})]
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
  (let [a     (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})
        _     (core/start! a psid "project" {:org-id "o1" :id "pr1" :name "Site" :root "/r"} t0)
        _     (core/send! a psid :overseer/start (assoc op :conversation-id "c1") {:now (+ t0 1)})
        store {psid (core/dump a psid)}
        b     (core/new-engine registry/statecharts {:level-check lv/level-check :load-cold #(get store %)})]
    (testing "before attach, a project step on the fresh host drops the missing watcher, never throws"
      (is (some? (core/send! b psid :project/edit (assoc op :name "Site 2") {:now (+ t0 2)}))))
    (core/start! b wsid "watch" {:org-id "o1" :project-id "pr1" :paused true} (+ t0 3))
    (is (in? b wsid :has-overseer) "the new watch watches the cloned project at once")
    (is (= "Site 2" (:project-name (core/data b wsid))))
    (is (true? (:paused (core/data b wsid))) "attach leaves it paused")
    (testing "and it keeps following the project"
      (core/send! b psid :project/archive op {:now (+ t0 4)})
      (is (true? (:archived (core/data b wsid)))))))

(deftest server-3-4-a-held-offer-refuses-others-with-todays-sentences
  (let [e   (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})
        sid "baton/o1/s1"
        msg (fn [from active] (core/send! e sid :baton/message {:by "person" :from from :active active} {:now (+ t0 1)}))
        why (fn [r] (:sentence (:refused (first (filter #(= :baton/message (:event %)) (:steps r))))))]
    (core/start! e sid "baton" {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "T" :goal "G" :targets ["p1" "p2"]
                                :owner {:overseer-of "pr1"} :names {"p1" "Ana" "p2" "Bob"} :operator-name "Omar"} t0)
    (msg "p1" true)
    (is (in? e sid :leased))
    (is (= "Someone else is answering right now." (why (msg "p2" true))))
    (is (= "Someone else is answering right now." (:sentence (core/explain e sid :baton/message {:by "person" :from "p2" :active true} {:now (+ t0 1)}))))
    (is (= "You are no longer taking part in this conversation." (why (msg "p2" false))) "an invitee who left")
    (is (= "Ana holds the baton. Take it back to write." (why (core/send! e sid :baton/message {:by "operator" :from "operator"} {:now (+ t0 1)}))))))

(deftest F-133-on-the-engine-a-folded-reason-never-pushes-the-soon-look-back
  (let [e       (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})
        settled {:by "system" :kind "coding/settled" :params {:title "Pay" :session-id "c1"} :key "coding/settled:c1:ok"}
        t       (+ t0 3600000)]
    (core/start! e psid "project" {:org-id "o1" :id "pr1" :name "Site" :root "/r"} t0)
    (core/send! e psid :overseer/start (assoc op :conversation-id "c1") {:now t0})
    ;; it looked a minute before t, so only the soon look can bring the next one inside the gap
    (core/send! e wsid :operator/run-now op {:now (- t 60000)})
    (core/send! e wsid :look/finished {} {:now (- t 59000)})
    (is (contains? (set (core/configuration e wsid)) :quiet))
    (core/send! e wsid :reason/noted settled {:now t})
    (let [soon (:soon-at (core/data e wsid))]
      (is (= (+ t 60000) soon))
      (core/send! e wsid :reason/noted settled {:now (+ t 30000)})
      (is (= 1 (count (:reasons (core/data e wsid)))))
      (is (= soon (:soon-at (core/data e wsid))) "the folded second one leaves it")
      (is (<= (core/next-due-at e) (+ t 80000)) "the look is due on the first tick after t+60 s"))))

(deftest server-3-p3-1-reconcile-off-answers-its-sentence
  (let [e   (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})
        sid "reconciler/o1/pr1"]
    (core/start! e sid "reconciler" {:org-id "o1" :project-id "pr1"} t0)
    (core/send! e sid :settings/reconcile {:on false} {:now t0})
    (is (in? e sid :off))
    (is (= "Turn on Reconcile decisions in Settings → Decisions."
           (:sentence (core/explain e sid :reconcile/request {:by "operator" :delay-ms 0} {:now (+ t0 1)}))))
    (is (= "Turn on Reconcile decisions in Settings → Decisions."
           (:sentence (:refused (first (filter #(= :reconcile/request (:event %)) (:steps (core/send! e sid :reconcile/request {:by "operator" :delay-ms 0} {:now (+ t0 1)}))))))))
    (testing "an automatic one is recorded, not refused"
      (core/send! e sid :reconcile/request {:by "sova" :delay-ms 0} {:now (+ t0 2)})
      (is (= "Turn on Reconcile decisions in Settings → Decisions." (get-in (core/data e sid) [:last-run :error]))))))
