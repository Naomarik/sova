(ns sova.statecharts.refit.runtime-test
  "The software registry (`runtime/<p>`, §app/project-runtime): the standing derived from what the host
   observed, approval (the operator's only), the automatic unconfined conformance, drift, and the Project
   verbs playbook's run (`verbs/onboard` on the project, then its build)."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.rules.runtime :as rr]
    [sova.statecharts.engine.core :as core]))

(def t0 1000000)
(def op {:by "operator"})
(def psid "project/pr1")
(def rsid "runtime/pr1")
(def wsid "watch/pr1")

(def plenty {:gather {:used 0 :max 6} :promote {:used 0 :max 60} :create {:used 0 :max 4} :prompt {:used 0 :max 12}})
(def room {:gatherings-open 0 :gatherings-cap 5 :coding-running 0 :coding-cap 2})
(def l3 {:by "overseer" :autonomy "L3" :paused false :archived false :allowance plenty :at-once room :ledger "day" :hold-ms 0})

(defn- in? [eng sid s] (contains? (set (core/configuration eng sid)) s))
(defn- refused [r event] (:refused (first (filter #(= event (:event %)) (:steps r)))))
(defn- effects [r kind] (filter #(= kind (:kind %)) (mapcat :outbox (:steps r))))
(defn- reasons [eng] (set (map :kind (:reasons (core/data eng wsid)))))

(def files1 [{:path "bb.edn" :sha "a1"} {:path "package.json" :sha "b1"}])
(def files2 [{:path "bb.edn" :sha "a2"} {:path "package.json" :sha "b1"}])
(def software [{:name "web" :kind "process" :scope "checkout" :ports [{:name "http" :port 4000}] :requires [] :isolation {:method "ports" :why "PORT is read"}}])

(defn- facts [& {:keys [hash approved proof files] :or {files files1}}]
  {:commit "c1" :suite 2
   :def (if hash {:state "present" :hash hash} {:state "absent"})
   :software (if hash software [])
   :sources {:paths (mapv :path files) :files files :fingerprint (str "fp:" (apply str (map :sha files)))}
   :approved (when approved {:hash approved :at t0})
   :proof proof})

(defn- eng! []
  (let [eng (core/new-engine registry/statecharts {:level-check lv/level-check})]
    (core/start! eng psid "project" {:id "pr1" :name "Site" :root "/r" :origin "folder" :created-at t0} t0)
    (core/send! eng psid :overseer/start (assoc op :conversation-id "c1") {:now (+ t0 1)})
    eng))

(defn- observe! [eng n f] (core/send! eng rsid :runtime/observed (assoc f :by "system") {:now (+ t0 n)}))

(defn- registered! [eng]
  (observe! eng 2 (facts :hash "h1"))
  (core/send! eng rsid :runtime/approve (assoc op :hash "h1") {:now (+ t0 3)})
  (core/send! eng rsid :effect/done {:kind "approve" :by "system" :result {:hash "h1"}} {:now (+ t0 4)})
  (let [r (observe! eng 5 (facts :hash "h1" :approved "h1"))]
    (core/send! eng rsid :effect/done {:kind "conform" :by "system" :result {:hash "h1" :suite 2 :pass true :confined false :at (+ t0 6)}} {:now (+ t0 6)})
    r))

(deftest born-beside-the-watch
  (let [eng (eng!)]
    (is (core/loaded? eng rsid) "the project spawns its registry at birth")
    (is (= {:project-id "pr1" :root "/r"} (select-keys (core/data eng rsid) [:project-id :root])))
    (is (in? eng rsid :unregistered))
    (is (in? eng rsid :idle))
    (is (not (contains? (core/data eng rsid) :org-id)))))

(deftest from-unregistered-to-registered
  (let [eng (eng!)]
    (observe! eng 2 (facts))
    (is (in? eng rsid :unregistered) "no .sova/project.json on main")
    (is (= rr/nothing-waiting (:sentence (refused (core/send! eng rsid :runtime/approve (assoc op :hash "h1") {:now (+ t0 2)}) :runtime/approve))))
    (observe! eng 3 (facts :hash "h1"))
    (is (in? eng rsid :awaiting-approval))
    (testing "only the operator approves"
      (let [x (refused (core/send! eng rsid :runtime/approve (assoc l3 :hash "h1") {:now (+ t0 4)}) :runtime/approve)]
        (is (= rr/operator-only (:sentence x)))
        (is (= 403 (:status x)))))
    (is (= rr/changed-since (:sentence (refused (core/send! eng rsid :runtime/approve (assoc op :hash "h0") {:now (+ t0 4)}) :runtime/approve)))
        "a hash that is no longer the one shown")
    (let [r (core/send! eng rsid :runtime/approve (assoc op :hash "h1") {:now (+ t0 5)})]
      (is (= [{:hash "h1" :ref "HEAD"}] (map #(select-keys % [:hash :ref]) (effects r "approve")))))
    (core/send! eng rsid :effect/done {:kind "approve" :by "system" :result {:hash "h1"}} {:now (+ t0 6)})
    (is (= "h1" (:hash (:approved-last (core/data eng rsid)))))
    (let [r (observe! eng 7 (facts :hash "h1" :approved "h1"))]
      (is (in? eng rsid :conforming) "approved, not proven yet")
      (is (= [{:hash "h1"}] (map #(select-keys % [:hash]) (effects r "conform"))) "entering conforming runs the unconfined conformance"))
    (testing "a confined pass never registers"
      (observe! eng 8 (facts :hash "h1" :approved "h1" :proof {:hash "h1" :suite 2 :pass true :confined true :at (+ t0 8)}))
      (is (in? eng rsid :conforming)))
    (core/send! eng rsid :effect/done {:kind "conform" :by "system" :result {:hash "h1" :suite 2 :pass true :confined false :at (+ t0 9)}} {:now (+ t0 9)})
    (is (in? eng rsid :registered))
    (is (= {:hash "h1" :suite 2 :fingerprint "fp:a1b1" :commit "c1"} (select-keys (:registered (core/data eng rsid)) [:hash :suite :fingerprint :commit])))
    (is (not (contains? (reasons eng) "runtime/registered")) "a registration asks nothing: it starts no look (r14)")))

(deftest drift-and-back
  (let [eng (eng!)]
    (registered! eng)
    (is (in? eng rsid :registered))
    (observe! eng 10 (facts :hash "h1" :approved "h1" :files files2 :proof {:hash "h1" :suite 2 :pass true :confined false :at (+ t0 6)}))
    (is (in? eng rsid :stale) "a source changed on main")
    (is (= ["bb.edn"] (get-in (core/data eng rsid) [:drift :paths])))
    (is (contains? (reasons eng) "runtime/stale") "the overseer is told")
    (testing "an unattended overseer may start the playbook while stale"
      (is (nil? (refused (core/send! eng psid :verbs/onboard (assoc l3 :session-id "o1" :title "Project verbs" :prompt "Run it" :runtime-standing "stale")
                           {:now (+ t0 11)}) :verbs/onboard))))
    (is (in? eng rsid :running))
    (is (= "overseer" (get-in (core/data eng rsid) [:playbook :started-by])))
    (let [bs "build/pr1/o1"]
      (is (= "onboard" (:kind (core/data eng bs))) "a build of kind onboard")
      (is (= ["build/pr1/o1"] (map :sid (:started (core/data eng psid)))) "listed among the project's builds")
      (core/send! eng bs :effect/done {:kind "make-worktree" :result {:branch "sova/verbs" :target "main" :base "b0"}} {:now (+ t0 12)})
      (core/send! eng bs :effect/done {:kind "set-mode"} {:now (+ t0 13)})
      (core/send! eng bs :effect/done {:kind "first-prompt"} {:now (+ t0 14)})
      (is (in? eng rsid :running) "nothing to say before its turn ends")
      (core/send! eng bs :turn/started {} {:now (+ t0 15)})
      (core/send! eng bs :turn/ended {} {:now (+ t0 16)})
      (is (in? eng rsid :idle) "a turn ended with no commits: no change")
      (is (= "no-change" (get-in (core/data eng rsid) [:playbook :result])))
      (is (in? eng rsid :registered) "nothing to change: main's current sources are the registration's")
      (is (= "fp:a2b1" (get-in (core/data eng rsid) [:registered :fingerprint])))
      (is (contains? (reasons eng) "runtime/playbook-done")))))

(deftest a-run-that-proposes-and-is-merged
  (let [eng (eng!)
        bs  "build/pr1/o2"]
    (observe! eng 2 (facts))
    (core/send! eng psid :verbs/onboard (assoc op :session-id "o2" :title "Project verbs" :prompt "Run it" :why "first time") {:now (+ t0 3)})
    (is (= "first time" (get-in (core/data eng rsid) [:playbook :why])))
    (is (= "operator" (get-in (core/data eng rsid) [:playbook :started-by])))
    (is (some? (:sentence (refused (core/send! eng rsid :runtime/approve (assoc op :hash "hb") {:now (+ t0 4)}) :runtime/approve)))
        "nothing proposed yet")
    (core/send! eng bs :effect/done {:kind "make-worktree" :result {:branch "sova/verbs" :target "main" :base "b0"}} {:now (+ t0 4)})
    (core/send! eng bs :effect/done {:kind "set-mode"} {:now (+ t0 5)})
    (core/send! eng bs :effect/done {:kind "first-prompt"} {:now (+ t0 6)})
    (core/send! eng bs :turn/started {} {:now (+ t0 7)})
    (core/send! eng bs :git/probe {:branch "unmerged" :tree "open"} {:now (+ t0 8)})
    (is (in? eng rsid :running) "still working")
    (core/send! eng bs :turn/ended {} {:now (+ t0 9)})
    (is (in? eng rsid :proposed))
    (is (= "sova/verbs" (get-in (core/data eng rsid) [:playbook :branch])))
    (observe! eng 10 {:branch-facts {:ref "sova/verbs" :def {:state "present" :hash "hb"} :approved false
                                     :proof {:hash "hb" :suite 2 :pass true :confined true :at (+ t0 9)}}})
    (is (= rr/changed-since (:sentence (refused (core/send! eng rsid :runtime/approve (assoc op :hash "hx") {:now (+ t0 11)}) :runtime/approve))))
    (let [r (core/send! eng rsid :runtime/approve (assoc op :hash "hb") {:now (+ t0 11)})]
      (is (= [{:hash "hb" :ref "sova/verbs"}] (map #(select-keys % [:hash :ref]) (effects r "approve"))) "the branch's definition, at its branch"))
    (core/send! eng bs :turn/started {} {:now (+ t0 12)})
    (is (in? eng rsid :running) "it works again")
    (core/send! eng bs :turn/ended {} {:now (+ t0 13)})
    (is (in? eng rsid :proposed))
    (core/send! eng bs :build/merge op {:now (+ t0 14)})
    (core/send! eng bs :effect/done {:kind "merge" :result {:commit "m1"}} {:now (+ t0 15)})
    (core/send! eng bs :git/probe {:branch "merged"} {:now (+ t0 16)})
    (is (in? eng rsid :idle))
    (is (= "merged" (get-in (core/data eng rsid) [:playbook :result])))
    (observe! eng 17 (facts :hash "hb" :approved "hb"))
    (is (in? eng rsid :conforming) "main now declares the approved branch definition: it conforms by itself")))

(deftest a-failure-and-a-retry
  (let [eng (eng!)]
    (observe! eng 2 (facts :hash "h1" :approved "h1"))
    (is (in? eng rsid :conforming))
    (core/send! eng rsid :effect/done {:kind "conform" :by "system" :result {:hash "h1" :suite 2 :pass false :confined false :at (+ t0 3)
                                                                             :failed {:check "ready" :detail "web never listened"}}} {:now (+ t0 3)})
    (is (in? eng rsid :failed))
    (is (contains? (reasons eng) "runtime/failed"))
    (observe! eng 4 (facts :hash "h1" :approved "h1" :proof {:hash "h1" :suite 2 :pass false :confined false :at (+ t0 3) :failed {:check "ready" :detail "x"}}))
    (is (in? eng rsid :failed) "the stamp agrees")
    (testing "approving it again runs conformance again"
      (core/send! eng rsid :runtime/approve (assoc op :hash "h1") {:now (+ t0 5)})
      (let [r (core/send! eng rsid :effect/done {:kind "approve" :by "system" :result {:hash "h1"}} {:now (+ t0 6)})]
        (is (in? eng rsid :conforming))
        (is (seq (effects r "conform")))))
    (testing "an invalid definition is failed"
      (observe! eng 7 {:def {:state "invalid" :error "services.web.cmd is required"}})
      (is (in? eng rsid :failed)))))

(deftest the-overseer-and-the-registry
  (let [eng (eng!)]
    (registered! eng)
    (is (= "The project's software is registered and current: the playbook has nothing to do."
           (:sentence (refused (core/send! eng psid :verbs/onboard (assoc l3 :session-id "o3" :prompt "Run it" :runtime-standing "registered") {:now (+ t0 10)}) :verbs/onboard)))
        "an unattended overseer starts no run while registered and current")
    (is (nil? (refused (core/send! eng psid :verbs/onboard (assoc l3 :attended true :ledger "message" :session-id "o3" :prompt "Run it" :runtime-standing "registered") {:now (+ t0 11)}) :verbs/onboard))
        "in a turn the operator started it may")
    (is (= "This run was not started by the operator, and your autonomy here is L2; sova_project_verbs needs L3. Do not retry it. File what you would do as an idea (sova_idea) or raise a sova_card card that says what and why; the operator's click starts a turn in which you may act."
           (:sentence (refused (core/send! eng psid :verbs/onboard (assoc l3 :autonomy "L2" :session-id "o4" :prompt "Run it") {:now (+ t0 12)}) :verbs/onboard)))
        "below L3 the level refuses")))

(deftest the-standing-rule
  (is (= "unregistered" (rr/standing-of {})))
  (is (= "failed" (rr/standing-of {:def {:state "invalid"}})))
  (is (= "awaiting-approval" (rr/standing-of {:def {:state "present" :hash "h"} :approved {:hash "g"}})))
  (is (= "conforming" (rr/standing-of {:def {:state "present" :hash "h"} :approved {:hash "h"} :suite 2 :proof {:hash "h" :suite 1 :pass true}}))
      "a pass at an older suite does not count")
  (is (= "registered" (rr/standing-of {:def {:state "present" :hash "h"} :approved {:hash "h"} :suite 2 :proof {:hash "h" :suite 2 :pass true}})))
  (is (= "stale" (rr/standing-of {:def {:state "present" :hash "h"} :approved {:hash "h"} :suite 2 :proof {:hash "h" :suite 2 :pass true}
                                  :sources {:fingerprint "f2"} :registered {:hash "h" :suite 2 :fingerprint "f1"}})))
  (is (= ["b" "c"] (rr/changed-paths {:registered {:files [{:path "a" :sha 1} {:path "b" :sha 1} {:path "c" :sha 1}]}
                                      :sources {:files [{:path "a" :sha 1} {:path "b" :sha 2}]}}))
      "changed, then dropped"))

(deftest the-data-resources-and-their-sensitivity
  (let [eng (eng!)]
    (observe! eng 2 (assoc (facts :hash "h1") :data [{:name "db" :kind "dir" :sensitive true} {:name "uploads" :kind "dir" :sensitive false}]))
    (is (= [["db" true] ["uploads" false]] (map (juxt :name :sensitive) (:data (core/data eng rsid)))) "kept as observed, in order")
    (observe! eng 3 (facts :hash "h1"))
    (is (= 2 (count (:data (core/data eng rsid)))) "a read that names no data leaves it as it was")))

(deftest a-run-that-asks-waits-then-resumes
  ;; §app.project-runtime/onboard: a turn that ends on open alignment questions waits, whatever its branch holds;
  ;; the operator's answer is its next turn.
  (let [eng (eng!)
        bs  "build/pr1/o5"]
    (observe! eng 2 (facts))
    (core/send! eng psid :verbs/onboard (assoc op :session-id "o5" :title "Project verbs: Site" :prompt "Run it"
                                          :playbook-id "project-verbs" :label "Project verbs" :approves "definition") {:now (+ t0 3)})
    (is (= {:playbook-id "project-verbs" :label "Project verbs" :approves "definition"}
           (select-keys (:playbook (core/data eng rsid)) [:playbook-id :label :approves])) "keyed by the verb playbook")
    (core/send! eng bs :effect/done {:kind "make-worktree" :result {:branch "sova/verbs" :target "main" :base "b0"}} {:now (+ t0 4)})
    (core/send! eng bs :effect/done {:kind "set-mode"} {:now (+ t0 5)})
    (core/send! eng bs :effect/done {:kind "first-prompt"} {:now (+ t0 6)})
    (core/send! eng bs :turn/started {} {:now (+ t0 7)})
    (core/send! eng bs :git/probe {:branch "unmerged" :tree "open"} {:now (+ t0 8)})
    (core/send! eng bs :turn/ended {:questions 2} {:now (+ t0 9)})
    (is (in? eng rsid :waiting) "commits, but it asked: it waits, never proposed")
    (is (= "waiting" (:playbook-state (core/data eng rsid))))
    (is (= 2 (get-in (core/data eng rsid) [:playbook :questions])))
    (is (not (contains? (reasons eng) "runtime/proposed")) "the overseer hears no proposal")
    (core/send! eng bs :turn/started {} {:now (+ t0 10)})
    (is (in? eng rsid :running) "the answer resumes it")
    (core/send! eng bs :turn/ended {} {:now (+ t0 11)})
    (is (in? eng rsid :proposed) "no questions left: proposed")
    (core/send! eng bs :turn/started {} {:now (+ t0 12)})
    (core/send! eng bs :turn/ended {:questions 1} {:now (+ t0 13)})
    (is (in? eng rsid :waiting) "a proposed run sent more work may ask again")
    (core/send! eng bs :build/remove-worktree op {:now (+ t0 14)})
    (core/send! eng bs :effect/done {:kind "remove-worktree" :result {:branch-deleted false}} {:now (+ t0 15)})
    (is (in? eng rsid :idle) "a waiting run still ends with its worktree")
    (is (= "removed" (get-in (core/data eng rsid) [:playbook :result])))))

(deftest a-plain-onboard-defaults-to-project-verbs
  (let [eng (eng!)]
    (observe! eng 2 (facts))
    (core/send! eng psid :verbs/onboard (assoc op :session-id "o6" :prompt "Run it") {:now (+ t0 3)})
    (is (= {:playbook-id "project-verbs" :label "Project verbs" :approves "definition"}
           (select-keys (:playbook (core/data eng rsid)) [:playbook-id :label :approves])))))

(deftest run-moved-says-waiting-before-the-branch
  (is (= :waiting (rr/run-moved {:states [:unmerged :turn-idle] :exported {:last-turn-at 1 :questions 3 :branch-state "unmerged"}})))
  (is (= :proposed (rr/run-moved {:states [:unmerged :turn-idle] :exported {:last-turn-at 1 :questions 0 :branch-state "unmerged"}})))
  (is (= :working (rr/run-moved {:states [:working] :exported {:running true :last-turn-at 1 :questions 3}})) "working wins")
  (is (= :merged (rr/run-moved {:states [:merged] :exported {:last-turn-at 1 :questions 3}})) "a merge ends it"))
