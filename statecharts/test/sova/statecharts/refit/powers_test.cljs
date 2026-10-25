(ns sova.statecharts.refit.powers-test
  "al_3: the powers replace the levels. Every act of a power is refused exactly when that power is Off in
   the caller's column (the one-power-per-act test); the operator is never restricted; a brake turns
   every power Off; the Project Assistant has its own column; the drives follow the overseer column."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.powers :as pw]
    [sova.statecharts.watch :as w]
    [sova.statecharts.engine.core :as core]))

(def t0 1000000)

(defn- acts [] (for [[statechart {:keys [acts]}] registry/statecharts [ev m] acts :when (contains? (set pw/powers) (:power m))] [statechart ev m]))

(defn- only [p v] (assoc (into {} (for [x pw/powers] [(pw/power-key x) (not v)])) (pw/power-key p) v))

(deftest one-power-per-act
  ;; each act's power alone decides it: Off (every other On) refuses it; On (every other Off) lets it pass the check
  (doseq [[sc ev m] (acts) by ["overseer" "statechart"]]
    (let [p (:power m)
          off (pw/power-check (:tool m) p {:by by :powers (only p false)})
          on  (pw/power-check (:tool m) p {:by by :powers (only p true)})]
      (is (= "power-off" (:code off)) (str sc " " ev " by " by ": Off refuses"))
      (is (= (pw/off-sentence p "overseer") (:sentence off)))
      (is (nil? on) (str sc " " ev " by " by ": On passes")))))

(deftest gather-reads-feature-chats-for-the-assistant
  ;; owner-feature-chats t12: the gathering power has its own meaning in the Project Assistant column
  (is (= "Open feature request chats with the owner is off for the Project Assistant. Do not retry it. Tell the owner it went to the team: it reaches the operator as a request."
         (pw/off-sentence "gather" "assistant")))
  (is (.startsWith (pw/off-sentence "gather" "overseer") "Start, offer and close gatherings is off for the overseer on its own."))
  (is (= "power-off" (:code (pw/power-check "start_feature_chat" "gather" {:by "assistant" :powers (only "gather" false)}))))
  (is (= (pw/off-sentence "gather" "assistant") (:sentence (pw/power-check "start_feature_chat" "gather" {:by "assistant" :powers (only "gather" false)}))))
  (is (= "Send coding sessions prompts" (pw/label-of "codingPrompt" "assistant")) "a power with no assistant label keeps its own"))

(deftest build-on-promote-off
  ;; al_3 t13: build On, promote Off: the statechart's coding session start passes, its promotion is refused
  (let [env {:by "statechart" :powers (assoc (pw/carry-over "L1") :coding-start true :promote false)}
        act (fn [sc ev] (get-in registry/statecharts [sc :acts ev]))
        chk (fn [sc ev] (let [m (act sc ev)] (pw/power-check (:tool m) (:power m) env)))]
    (is (nil? (chk "item" :build/start)) "sova_create_session by the statechart")
    (is (nil? (chk "project" :build/start)))
    (is (= "Promote decisions into the spec is off for the overseer on its own. Do not retry it. File what you would do as an idea (sova_idea) or raise a sova_card card that says what and why; the operator's click starts a turn in which you may act."
           (:sentence (chk "reconciler" :decision/promote))) "sova_promote refused"))
  (testing "through the engine: the check stage of a real session"
    (let [eng (core/new-engine registry/statecharts (assoc registry/options :absorb-unknown true))
          env {:by "statechart" :project-id "pr1" :powers (assoc pw/all-off :coding-start true)}]
      (core/start! eng "project/pr1" "project" {:id "pr1" :name "Site" :root "/r"} t0)
      (core/start! eng "reconciler/o1/pr1" "reconciler" {:org-id "o1" :project-id "pr1"} t0)
      (is (nil? (core/explain-refusal eng "project/pr1" :build/start env {:stages #{:level}})))
      (is (= {:stage :level :code "power-off"}
             (select-keys (core/explain-refusal eng "reconciler/o1/pr1" :decision/promote env {:stages #{:level}}) [:stage :code]))))))

(deftest the-operator-is-never-restricted
  (doseq [[_ _ m] (acts)]
    (is (nil? (pw/power-check (:tool m) (:power m) {:by "operator" :powers pw/all-off :paused true})))
    (is (nil? (pw/power-check (:tool m) (:power m) {:by "overseer" :attended true :powers pw/all-off :paused true}))
      "an overseer turn the operator started")
    (is (nil? (pw/power-check (:tool m) (:power m) {:by "assistant" :attended true :powers pw/all-off}))
      "the operator's own turn in the Project Assistant's chat"))
  (is (some? (pw/power-check "sova_create_session" "codingStart" {:by "statechart" :attended true :powers pw/all-off}))
    "a statechart act is never attended"))

(deftest brakes-turn-every-power-off
  (let [all-on (into {} (for [p pw/powers] [(pw/power-key p) true]))]
    (doseq [[_ _ m] (acts)]
      (let [paused (pw/power-check (:tool m) (:power m) {:by "overseer" :powers all-on :paused true})
            roster (pw/power-check (:tool m) (:power m) {:by "statechart" :powers all-on :ceiling {:reason pw/empty-roster-reason}})]
        (is (= "brake" (:code paused)))
        (is (re-find #"Press Resume" (:sentence paused)))
        (is (= "brake" (:code roster)))
        (is (re-find #"The roster has no active people yet\." (:sentence roster)))
        (is (not (re-find #"L[0-3]" (:sentence roster))) "no level in a brake's words")))
    (is (nil? (pw/power-check "sova_note" "always" {:by "overseer" :powers pw/all-off :paused true})) "always-allowed acts are never braked")))

(deftest the-project-assistant-has-its-own-column
  (let [m (get-in registry/statecharts ["project" :acts :build/start])]
    (is (nil? (pw/power-check (:tool m) (:power m) {:by "assistant" :powers (only "codingStart" true)})))
    (let [r (pw/power-check (:tool m) (:power m) {:by "assistant" :powers pw/all-off})]
      (is (= "power-off" (:code r)))
      (is (= "Start coding sessions is off for the Project Assistant. Do not retry it. Tell the owner it went to the team: it reaches the operator as a request." (:sentence r))))
    (is (= "power-off" (:code (pw/power-check (:tool m) (:power m) {:by "assistant" :autonomy "L3"})))
      "an assistant envelope with no column reads all Off, never the overseer's level")))

(deftest an-envelope-from-before-switches-reads-its-levels-carry-over
  (is (nil? (pw/power-check "sova_promote" "promote" {:by "overseer" :autonomy "L2"})))
  (is (= "power-off" (:code (pw/power-check "sova_create_session" "codingStart" {:by "overseer" :autonomy "L2"}))))
  (is (= "power-off" (:code (pw/power-check "sova_project_verbs" "deploy" {:by "overseer" :autonomy "L3"}))) "no level ever deployed"))

(deftest carry-over-and-the-derived-level
  (is (= #{:gather :whatsapp :owner-updates :bookkeeping :share} (set (keep (fn [[k v]] (when v k)) (pw/carry-over "L1")))))
  (doseq [l ["L0" "L1" "L2" "L3"]] (is (= l (pw/derived-level (pw/carry-over l)))))
  (is (= "L1" (pw/derived-level (assoc (pw/carry-over "L3") :mark-merged false))) "never looser")
  (is (= "L0" (pw/derived-level (assoc (pw/carry-over "L3") :share false)))))

(deftest drives-follow-the-overseer-column
  (let [w (fn [over & {:as more}] (merge {:settings {:powers {:overseer over}}} more))]
    (is (pw/drive-on? (w (only "promote" true)) "promote"))
    (is (not (pw/drive-on? (w (only "promote" false)) "promote")))
    (is (not (pw/drive-on? (w (only "promote" true) :paused true) "promote")) "the attach brake")
    (is (not (pw/drive-on? (w (only "promote" true) :ceiling {:reason "r"}) "promote")) "the empty-roster brake")
    (is (pw/drive-on? (assoc-in (w (only "promote" true) :ceiling {:reason "r"}) [:settings :empty-roster-resumed] true) "promote")
      "Resume lifted the empty-roster brake")
    (is (pw/drive-on? {:settings {:autonomy "L2"}} "promote") "a watch saved before switches: its level's carry-over")
    (is (not (pw/drive-on? {:settings {:autonomy "L2"}} "codingStart")))))

(deftest the-watch-migrates-its-level-to-powers
  (let [s (w/migrate-v1 {:config #{:watch} :data {:settings {:autonomy "L3" :hold-min 10}}})]
    (is (= (pw/carry-over "L3") (get-in s [:data :settings :powers :overseer])))
    (is (= pw/all-off (get-in s [:data :settings :powers :assistant])))
    (is (= 10 (get-in s [:data :settings :hold-min])) "the rest kept"))
  (is (= {:data {:settings {:powers {:overseer {}}}}} (w/migrate-v1 {:data {:settings {:powers {:overseer {}}}}})) "already powers: untouched")
  (is (= 2 (:version (get registry/statecharts "watch")))))

(defn- project-engine []
  (let [eng (core/new-engine registry/statecharts (assoc registry/options :absorb-unknown true))]
    (core/start! eng "project/pr1" "project" {:id "pr1" :name "Site" :root "/r"} t0)
    eng))

(deftest the-assistant-starts-a-fix-only-for-an-owner-request
  (let [env {:by "assistant" :project-id "pr1" :hold-ms 1000 :powers (only "codingStart" true)
             :session-id "f1" :title "Fix the form" :prompt "The form fails"}]
    (testing "no basis: refused"
      (let [eng (project-engine)
            r   (core/send! eng "project/pr1" :build/start env {:now t0})]
        (is (= "A fix starts only from an owner's request: file it first, then start the fix for it."
               (:sentence (:refused (first (:steps r))))))))
    (testing "an owner request: held for the waiting period, then a coding session on its own, basis kept"
      (let [eng (project-engine)
            r   (core/send! eng "project/pr1" :build/start (assoc env :basis {:kind "owner-request" :id "or_1"}) {:now t0})]
        (is (some? (:held (first (:steps r)))) "held")
        (core/fire-due! eng (+ t0 1000))
        (let [b (core/data eng "build/pr1/f1")]
          (is (= ["assistant" "coding" {:kind "owner-request" :id "or_1"}] [(:started-by b) (:kind b) (:basis b)])))))
    (testing "Off in its column: refused with its sentence"
      (let [eng (project-engine)
            r   (core/send! eng "project/pr1" :build/start (assoc env :powers pw/all-off :basis {:kind "owner-request" :id "or_1"}) {:now t0})]
        (is (= "power-off" (:code (:refused (first (:steps r))))))))))

(deftest deploy-is-a-held-act-of-its-own-power
  (testing "the overseer on its own: held, then the recipe's effect"
    (let [eng (project-engine)
          r   (core/send! eng "project/pr1" :deploy/run {:by "overseer" :project-id "pr1" :hold-ms 1000 :powers (only "deploy" true) :target "prod"} {:now t0})]
      (is (= "A deploy to prod through the project's own recipe" (:what (:held (first (:steps r))))))
      (let [due (core/fire-due! eng (+ t0 1000))]
        (is (= [{:kind "deploy-run" :by "overseer" :attended false :target "prod"}]
               (map #(select-keys % [:kind :by :attended :target]) (mapcat :outbox (:steps due))))))))
  (testing "Off: refused; the operator's own: at once"
    (let [eng (project-engine)]
      (is (= "power-off" (:code (:refused (first (:steps (core/send! eng "project/pr1" :deploy/run {:by "overseer" :project-id "pr1" :powers (pw/carry-over "L3")} {:now t0}))))))
        "no level ever deployed")
      (let [r (core/send! eng "project/pr1" :deploy/run {:by "operator" :project-id "pr1" :hold-ms 1000} {:now t0})]
        (is (nil? (:held (first (:steps r)))))
        (is (= ["deploy-run"] (map :kind (:outbox r))))))))

(deftest a-settings-change-with-only-a-level-sets-the-overseer-column-by-the-carry-over
  (let [eng (project-engine)]
    (core/send! eng "watch/pr1" :settings/changed {:settings {:autonomy "L3"}} {:now t0})
    (is (= (pw/carry-over "L3") (get-in (core/data eng "watch/pr1") [:settings :powers :overseer])) "an older host's level")
    (core/send! eng "watch/pr1" :settings/changed {:settings {:autonomy "L3" :powers {:overseer (pw/carry-over "L1") :assistant pw/all-off}}} {:now (+ t0 1)})
    (is (= (pw/carry-over "L1") (get-in (core/data eng "watch/pr1") [:settings :powers :overseer])) "powers given: they win")))
