(ns sova.statecharts.refit.general-projects-test
  "General projects: a project in no organization runs on its own (its own engine, nothing of the org
   layer), at its own setting unless whoever places it contributes a ceiling; the watch's facts
   `ceiling` and `look-hint`; a placement following its project."
  (:require
    [cljs.test :refer [deftest is testing]]
    [clojure.string :as str]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.watch :as w]
    [sova.statecharts.engine.core :as core]))

(def t0 1000000)
(def op {:by "operator"})
(def psid "project/pr1")
(def wsid "watch/pr1")
(def roster-ceiling {:autonomy "L0" :reason "The roster has no active people yet, so the overseer only proposes (L0)."})

(defn- in? [eng sid s] (contains? (set (core/configuration eng sid)) s))
(defn- refused [r event] (:sentence (:refused (first (filter #(= event (:event %)) (:steps r))))))

;; ---- the level in force ---------------------------------------------------------------------------

(deftest paused-then-ceiling-then-setting
  (is (= {:autonomy "L1"} (lv/effective-autonomy {})) "nobody caps it: the default setting")
  (is (= {:autonomy "L3"} (lv/effective-autonomy {:autonomy "L3"})) "a standalone project runs at its setting")
  (is (= roster-ceiling (lv/effective-autonomy {:autonomy "L3" :ceiling roster-ceiling})) "a ceiling below the setting caps it, with its reason")
  (is (= {:autonomy "L1"} (lv/effective-autonomy {:autonomy "L1" :ceiling {:autonomy "L2" :reason "x"}})) "a ceiling never raises it")
  (is (= {:autonomy "L2"} (lv/effective-autonomy {:autonomy "L2" :ceiling {:autonomy "L2" :reason "x"}})) "at the ceiling: no reason")
  (is (= {:autonomy "L0" :reason lv/paused-reason} (lv/effective-autonomy {:autonomy "L3" :paused true :ceiling roster-ceiling})) "paused wins"))

(deftest the-refusal-names-the-ceiling-and-no-gap
  (is (= "This run was not started by the operator, and your autonomy here is L0 (The roster has no active people yet, so the overseer only proposes (L0).); sova_project_verbs needs L3. Do not retry it. File what you would do as an idea (sova_idea) or raise a sova_card card that says what and why; the operator's click starts a turn in which you may act."
         (lv/level-check "sova_project_verbs" "L3" {:by "overseer" :autonomy "L3" :ceiling roster-ceiling})))
  (is (nil? (lv/level-check "sova_project_verbs" "L3" {:by "overseer" :autonomy "L3"})) "no roster, no ceiling: L3 is L3"))

;; ---- the watch's facts -----------------------------------------------------------------------------

(deftest the-look-text-and-its-hint
  (is (= (str "[project watch] Since your last look:\n- A\n\n"
              "Re-read the project (sova_project). Then act within your autonomy (L1): the tools tell you when something needs a higher level. Keep your reply to a few lines for the operator.")
         (w/watch-text ["A"] "L1" nil))
      "a project nobody places: no org words")
  (is (= (str "[project watch] Since your last look:\n- A\n\n"
              "Re-read the project (sova_project). Read sova_decisions where it matters. Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…). "
              "Then act within your autonomy (L0): the tools tell you when something needs a higher level. Keep your reply to a few lines for the operator.")
         (w/watch-text ["A"] "L0" "Read sova_decisions where it matters. Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…).")))
  (let [eng (core/new-engine registry/statecharts {:level-check lv/level-check})]
    (core/start! eng psid "project" {:id "pr1" :name "Site" :root "/r"} t0)
    (core/send! eng wsid :facts/changed {:ceiling roster-ceiling :look-hint "Hint."} {:now (+ t0 1)})
    (let [d (core/data eng wsid)]
      (is (= roster-ceiling (:ceiling d)))
      (is (= "Hint." (:look-hint d)))
      (is (= "L0" (:autonomy (w/effective (assoc d :settings {:autonomy "L3"}))))))
    (core/send! eng wsid :facts/changed {:ceiling nil} {:now (+ t0 2)})
    (is (nil? (:ceiling (core/data eng wsid))) "taken back (a project leaving an org, later)")
    (is (= "Hint." (:look-hint (core/data eng wsid))) "a fact not named is left alone")))

;; ---- a solo world: a project, its watch and builds, and nothing else --------------------------------

(deftest a-standalone-project-on-its-own-engine
  ;; no :absorb-unknown: a send to any session that does not exist here (an org, a person, a placement)
  ;; would throw and roll the call back
  (let [eng (core/new-engine registry/statecharts {:level-check lv/level-check})
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
    (testing "sharing a running copy: held unattended at L1, at once in the operator's run, never above the level"
      (let [share {:by "overseer" :verb "share" :instance "in_1" :endpoint "web.3000" :branch "sova/pay-3f9a1c" :overseer-id "po1"}]
        (is (re-find #"sova_project_verbs needs L1" (refused (core/send! eng psid :services/share (assoc share :autonomy "L0") {:now (+ t0 2)}) :services/share)))
        (let [r (core/send! eng psid :services/share (assoc share :autonomy "L1" :confirm-kinds ["preview"]) {:now (+ t0 2)})
              h (first (filter #(= ":services/share" (str (:event %))) (core/holds eng)))]
          (is (some? (:held (first (filter #(= :services/share (:event %)) (:steps r))))) "held")
          (is (= "A preview link: web.3000 of a running copy (sova/pay-3f9a1c)" (:what h)))
          (is (true? (:confirm h)) "confirm kind preview")
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
  (let [eng (core/new-engine registry/statecharts {:level-check lv/level-check :absorb-unknown true})
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
