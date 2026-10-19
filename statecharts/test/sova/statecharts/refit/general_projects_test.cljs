(ns sova.statecharts.refit.general-projects-test
  "General projects: a project in no organization runs on its own (its own engine, nothing of the org
   layer), at its own setting unless whoever places it contributes a ceiling; the watch's facts
   `ceiling` and `look-hint`; a placement following its project."
  (:require
    [cljs.test :refer [deftest is testing]]
    [clojure.string :as str]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.rules.powers :as pw]
    [sova.statecharts.watch :as w]
    [sova.statecharts.engine.core :as core]))

(def t0 1000000)
(def op {:by "operator"})
(def psid "project/pr1")
(def wsid "watch/pr1")
(def roster-ceiling {:autonomy "L0" :reason "The roster has no active people yet."})

(defn- in? [eng sid s] (contains? (set (core/configuration eng sid)) s))
(defn- refused [r event] (:sentence (:refused (first (filter #(= event (:event %)) (:steps r))))))

;; ---- the brakes and the look text -----------------------------------------------------------------

(deftest paused-then-ceiling-then-the-switches
  (is (nil? (w/brake {})) "nobody caps it: no brake")
  (is (= {:kind "empty-roster" :reason pw/empty-roster-reason} (w/brake {:ceiling roster-ceiling})) "an empty roster brakes it, with its reason")
  (is (nil? (w/brake {:ceiling roster-ceiling :settings {:empty-roster-resumed true}})) "Resume lifted it")
  (is (= {:kind "paused" :reason pw/paused-reason} (w/brake {:paused true :ceiling roster-ceiling})) "paused wins")
  (is (= pw/all-off (w/powers-in-force {:paused true :settings {:powers {:overseer (pw/carry-over "L3")}}})) "under a brake every power is Off")
  (is (= (pw/carry-over "L3") (w/powers-in-force {:settings {:powers {:overseer (pw/carry-over "L3")}}})) "a standalone project runs on its switches"))

(deftest the-refusal-names-the-brake-and-no-level
  (is (= "Nothing happens on its own right now: The roster has no active people yet. File what you would do as an idea (sova_idea) or raise a sova_card card; the operator's click starts a turn in which you may act."
         (:sentence (pw/power-check "sova_project_verbs" "copiesRun" {:by "overseer" :powers (pw/carry-over "L3") :ceiling roster-ceiling}))))
  (is (nil? (pw/power-check "sova_project_verbs" "copiesRun" {:by "overseer" :powers (pw/carry-over "L3")})) "no roster, no ceiling: the switch decides"))

(deftest the-look-text-and-its-hint
  (is (= (str "[project watch] Since your last look:\n- A\n\n"
              "Re-read the project (sova_project). Then act within what you may do on your own (Share a version to try): the tools tell you when a power is off. Keep your reply to a few lines for the operator.")
         (w/watch-text ["A"] "Share a version to try" nil))
      "a project nobody places: no org words")
  (is (= (str "[project watch] Since your last look:\n- A\n\n"
              "Re-read the project (sova_project). Read sova_decisions where it matters. Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…). "
              "Then act within what you may do on your own (nothing on its own: The roster has no active people yet.): the tools tell you when a power is off. Keep your reply to a few lines for the operator.")
         (w/watch-text ["A"] (w/powers-words {:ceiling roster-ceiling}) "Read sova_decisions where it matters. Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…).")))
  (is (= "Start, offer and close gatherings; Message people on WhatsApp; Post owner updates; Fix the pipeline's bookkeeping; Share a version to try"
         (w/powers-words {:settings {:powers {:overseer (pw/carry-over "L1")}}})))
  (let [eng (core/new-engine registry/statecharts {:level-check pw/power-check})]
    (core/start! eng psid "project" {:id "pr1" :name "Site" :root "/r"} t0)
    (core/send! eng wsid :facts/changed {:ceiling roster-ceiling :look-hint "Hint."} {:now (+ t0 1)})
    (let [d (core/data eng wsid)]
      (is (= roster-ceiling (:ceiling d)))
      (is (= "Hint." (:look-hint d)))
      (is (= "empty-roster" (:kind (w/brake d)))))
    (core/send! eng wsid :facts/changed {:ceiling nil} {:now (+ t0 2)})
    (is (nil? (:ceiling (core/data eng wsid))) "taken back (a project leaving an org, later)")
    (is (= "Hint." (:look-hint (core/data eng wsid))) "a fact not named is left alone")))

;; ---- a solo world: a project, its watch and builds, and nothing else --------------------------------

(deftest a-standalone-project-on-its-own-engine
  ;; no :absorb-unknown: a send to any session that does not exist here (an org, a person, a placement)
  ;; would throw and roll the call back
  (let [eng (core/new-engine registry/statecharts {:level-check pw/power-check})
        att {:by "overseer" :attended true :autonomy "L1"}]
    (core/start! eng psid "project" {:id "pr1" :name "Site" :root "/r" :origin "folder" :created-at t0} t0)
    (is (= [psid "runtime/pr1" wsid] (core/session-ids eng)) "born with its watch and its software registry only (no reconciler)")
    (core/send! eng psid :overseer/start (assoc op :conversation-id "c1") {:now (+ t0 1)})
    (testing "unattended at its setting (L1): no roster caps it"
      (is (nil? (refused (core/send! eng psid :services/run {:by "overseer" :autonomy "L3" :invalid nil} {:now (+ t0 2)}) :services/run))
          "services/run taken at L3 with no roster")
      (is (= "A coding session starts only in a turn the operator started: ask with sova_card."
             (refused (core/send! eng psid :build/start {:by "overseer" :autonomy "L3" :session-id "c9"} {:now (+ t0 3)}) :build/start))
          "an unattended build is refused at every level"))
    (testing "sharing a running copy: held unattended with share On, at once in the operator's run, refused with it Off"
      (let [share {:by "overseer" :verb "share" :instance "in_1" :endpoint "web.3000" :branch "sova/pay-3f9a1c" :overseer-id "po1"}]
        (is (re-find #"^Share a version to try is off for the overseer on its own\." (refused (core/send! eng psid :services/share (assoc share :autonomy "L0") {:now (+ t0 2)}) :services/share)))
        (let [r (core/send! eng psid :services/share (assoc share :autonomy "L1" :confirm-kinds ["preview"]) {:now (+ t0 2)})
              h (first (filter #(= ":services/share" (str (:event %))) (core/holds eng)))]
          (is (some? (:held (first (filter #(= :services/share (:event %)) (:steps r))))) "held")
          (is (= "A preview link: web.3000 of a running copy (sova/pay-3f9a1c)" (:what h)))
          (is (nil? (:confirm h)) "al_3 q2: no review wait, the old confirm list ignored")
          (core/send! eng psid :hold/cancel {:by "operator" :id (:id h)} {:now (+ t0 2)}))
        (let [r (core/send! eng psid :services/share (assoc share :autonomy "L0" :attended true) {:now (+ t0 2)})]
          (is (nil? (:held (first (filter #(= :services/share (:event %)) (:steps r))))) "the operator's run goes at once"))))
    (testing "an attended build: a worktree, a merge, and the project knows it"
      (core/send! eng psid :build/start (assoc att :autonomy "L3" :session-id "c1" :title "Pay" :prompt "Build it") {:now (+ t0 4)})
      (let [bs "build/pr1/c1"]
        (is (core/loaded? eng bs))
        (is (= [bs] (map :sid (:started (core/data eng psid)))))
        (core/send! eng bs :effect/done {:kind "make-worktree" :result {:branch "sova/pay" :target "main" :base "b0"}} {:now (+ t0 5)})
        (core/send! eng bs :effect/done {:kind "set-mode"} {:now (+ t0 6)})
        (core/send! eng bs :effect/done {:kind "first-prompt"} {:now (+ t0 7)})
        (core/send! eng bs :build/merge op {:now (+ t0 8)})
        (core/send! eng bs :effect/done {:kind "merge" :result {:commit "c0ffee"}} {:now (+ t0 9)})
        (is (= (+ t0 9) (:last-merged-at (core/data eng psid))) "exported for whoever places it")))
    (testing "archive and unarchive"
      (core/send! eng psid :project/archive op {:now (+ t0 10)})
      (is (in? eng psid :archived))
      (core/send! eng psid :project/unarchive op {:now (+ t0 11)})
      (is (in? eng psid :active)))
    (testing "nothing of the org layer exists or is linked"
      (is (every? #(re-matches #"(project|watch|build|runtime)/pr1(/.*)?" %) (core/session-ids eng)))
      (doseq [sid (core/session-ids eng)
              :let [d (core/data eng sid)]]
        (is (not (contains? d :org-id)) sid)
        (is (every? #(re-matches #"(project|watch|build|runtime)/.*" %) (concat (:sova/watchers d) (vals (:sova/links d)))) sid)))))

;; ---- placed: the placement follows its project --------------------------------------------------------

(deftest a-placed-project-and-its-placement
  (let [eng (core/new-engine registry/statecharts {:level-check pw/power-check :absorb-unknown true})
        pl  "placement/o1/pr1"]
    (core/start! eng "org/o1" "org" {:id "o1" :name "Acme" :slug "acme"} t0)
    (core/start! eng psid "project" {:id "pr1" :name "Site" :root "/r"} t0)
    (core/send! eng "org/o1" :project/place (assoc op :project-id "pr1" :placed-via "born") {:now (+ t0 1)})
    (is (core/loaded? eng pl))
    (is (core/loaded? eng "reconciler/o1/pr1") "the placement spawned the reconciler")
    (is (= "Site" (:project-name (core/data eng pl))) "it watches its project")
    (core/send! eng "org/o1" :project/place (assoc op :project-id "pr1" :placed-via "import") {:now (+ t0 2)})
    (is (= "born" (:via (core/data eng pl))) "placing it again changes nothing")
    (core/send! eng psid :project/archive op {:now (+ t0 3)})
    (is (true? (:archived (core/data eng pl))))
    (is (= "Site is archived. Unarchive it first."
           (refused (core/send! eng pl :baton/start (assoc op :session-id "s1" :to "p1" :public-title "T" :goal "G") {:now (+ t0 4)}) :baton/start)))
    (is (not-any? #(str/starts-with? % "org/") (:sova/watchers (core/data eng psid))) "the project is watched by its placement and watch, never the org")))
