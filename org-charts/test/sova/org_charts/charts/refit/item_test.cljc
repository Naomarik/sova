(ns sova.org-charts.charts.refit.item-test
  "The item chart: the lane on aggregates of many gatherings and builds, follow-ups, stall clocks,
   hold/resume with history, drop, corrections, and the acts it starts itself at the level in force."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.org-charts.charts.refit.host :as h]))

(def sid "item/o1/pr1/g_1")
(def op {:by "operator"})
(defn start [] (h/start! (h/new-host) "item" sid {:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/invoicing"}))
(defn watch-at [x level & {:keys [paused archived]}]
  (h/send! x sid :link/moved {:from "watch/o1/pr1" :chart "watch" :states [:watch]
                              :exported {:settings {:autonomy level} :paused (boolean paused) :roster-active true :archived (boolean archived)}}))
(defn baton [x n states & {:as ex}]
  (h/send! x sid :link/moved {:from (str "baton/o1/b" n) :chart "baton" :states (into [:baton] states)
                              :exported (merge {:owner {:overseer-of "pr1"} :decisions [] :created-at n} ex)}))
(defn decision [x id state & {:keys [states ex]}]
  (h/send! x sid :link/moved {:from (str "decision/o1/pr1/" id) :chart "decision" :states (into [:decision (keyword state)] states)
                              :exported (merge {:state state :author-owns-area true :statement (str "S " id)} ex)}))
(defn build [x n states & {:as ex}]
  (h/send! x sid :link/moved {:from (str "build/o1/pr1/c" n) :chart "build" :states (into [:build] states)
                              :exported (merge {:decisions ["d1"] :created-at n} ex)}))
(defn drives [x] (filter #(= :drive (:op %)) (h/directives x sid)))

(deftest lane
  (let [x (-> (start) (watch-at "L0"))]
    (is (h/in? x sid :open))
    (let [a (baton x 1 [:open :with-person])]
      (is (h/in? a sid :asking))
      (is (h/in? (baton a 1 [:open :with-operator] :needs-you true) sid :needs-operator))
      (testing "coordinator-38: the operator replied, so nothing waits on them: it is only asking"
        (is (h/in? (baton a 1 [:open :with-operator] :needs-you false) sid :asking))
        (is (h/in? (-> a (baton 1 [:open :with-operator] :needs-you true) (baton 1 [:open :with-operator] :needs-you false)) sid :asking)))
      (testing "two gatherings: the lane waits for both"
        (let [two (-> a (baton 2 [:open :with-person]) (baton 1 [:done] :decisions ["d1"]) (decision "d1" "pending"))]
          (is (h/in? two sid :asking))
          (is (h/in? (baton two 2 [:closed]) sid :unreconciled))))
      (testing "ended with no decision: open again, one attempt used"
        (let [y (baton a 1 [:closed])]
          (is (h/in? y sid :open))
          (is (= 1 (:attempts (h/data y sid))))))
      (testing "deciding → promoted → building → merged → done"
        (let [y (-> a (baton 1 [:done] :decisions ["d1"]) (decision "d1" "pending"))]
          (is (h/in? y sid :unreconciled))
          (is (h/in? (decision y "d1" "conflict") sid :conflicted))
          (is (h/in? (decision y "d1" "drafted") sid :drafted))
          (let [p (decision y "d1" "promoted")]
            (is (h/in? p sid :awaiting-build))
            (is (h/in? (build p 1 [:working]) sid :working))
            (is (h/in? (build p 1 [:turn-idle :unmerged]) sid :idle))
            (is (h/in? (build p 1 [:turn-failed :unmerged]) sid :failed))
            (let [m (build p 1 [:turn-idle :merged])]
              (is (h/in? m sid :merged))
              (is (h/in? (decision m "d1" "promoted" :states [:built-done]) sid :done))
              (testing "a newer decision reopens it"
                (is (h/in? (decision m "d2" "pending") sid :unreconciled))))))))))

(deftest follows-a-superseding-winner
  ;; server-6's syn-conflict-two-gaps: a settle answers with another gap's decision; this item follows it
  (let [y (-> (start) (watch-at "L0") (baton 1 [:done] :decisions ["d1"]) (decision "d1" "conflict"))
        s (decision y "d1" "superseded" :ex {:superseded-by "d2"})]
    (is (h/in? y sid :conflicted))
    (is (some #(= {:op :watch :target "decision/o1/pr1/d2"} %) (h/directives s sid)) "the winner is watched")
    (is (h/in? s sid :unreconciled) "pending until the winner's own facts come")
    (is (h/in? (decision s "d2" "drafted") sid :drafted))
    (is (h/in? (-> s (decision "d2" "drafted") (decision "d2" "promoted")) sid :awaiting-build))
    (is (= 1 (count (filter #(= "decision/o1/pr1/d2" (:target %)) (h/directives (decision s "d1" "superseded" :ex {:superseded-by "d2"}) sid))))
        "watched once")))

(deftest follow-ups
  (let [p (-> (start) (watch-at "L0") (baton 1 [:done] :decisions ["d1"]) (decision "d1" "promoted"))
        y (h/send! p sid :gather/start (assoc op :session-id "b9" :to "p1" :public-title "More" :goal "g" :question "q"))]
    (is (h/in? y sid :awaiting-build) "a gathering once promoted is a follow-up")
    (is (true? (get-in (h/data y sid) [:batons "baton/o1/b9" :follow-up])))
    (is (h/in? (baton y 9 [:open :with-person]) sid :follow-up-asking))
    (is (h/in? (baton y 9 [:open :with-operator] :needs-you true) sid :follow-up-needs-operator))
    (is (h/in? (-> y (baton 9 [:open :with-operator] :needs-you true) (baton 9 [:open :with-operator] :needs-you false)) sid :follow-up-asking)
        "coordinator-38 (server-6 real-26): after the operator's reply the follow-up is asking")))

(deftest hold-resume-drop
  (let [x (-> (start) (watch-at "L0") (baton 1 [:open :with-person]))
        y (h/send! x sid :item/hold op)]
    (is (h/in? y sid :on-hold))
    (is (= "§gap/invoicing is already on hold." (h/refusal y sid :item/hold op)))
    (is (= "§gap/invoicing is not on hold." (h/refusal x sid :item/resume op)))
    (is (= "Only the operator holds or resumes a gap, from the project page." (h/refusal x sid :item/hold {:by "overseer" :attended true})))
    (is (h/in? (h/send! y sid :item/resume op) sid :asking) "resume returns where it was (deep history)")
    (let [dr (h/send! x sid :gap/drop op)]
      (is (h/in? dr sid :dropped))
      (is (= ["idea-status"] (h/kinds dr sid))))))

(deftest stall
  (let [x (-> (h/start! (h/new-host) "item" sid {:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/x" :stall-after-ms {:open 1000}}) (watch-at "L0"))
        y (h/advance! x 1000)]
    (is (h/in? y sid :stalled))
    (is (some #(= "item/stalled" (get-in % [:data :kind])) (h/elsewhere y)))
    (is (h/in? (baton y 1 [:open :with-person]) sid :calm))))

(deftest builds-rest-on-promoted-decisions
  (let [p (-> (start) (watch-at "L0") (baton 1 [:done] :decisions ["d1"]) (decision "d1" "promoted"))]
    (is (= "d7 is not a promoted, not yet built decision of §gap/invoicing: a build rests only on its gap's promoted decisions."
           (h/refusal p sid :build/start (assoc op :session-id "c1" :decisions ["d7"]))))
    (is (= "§gap/invoicing has no promoted decision to build yet." (h/refusal (start) sid :build/start op)))
    (let [y (h/send! p sid :build/start (assoc op :session-id "c1"))]
      (is (h/in? y sid :build-starting))
      (is (= ["d1"] (get-in (last (h/directives y sid)) [:data :decisions])))
      (is (h/in? (build y 1 [:making-worktree]) sid :build-starting))
      (is (h/in? (build y 1 [:ready :working]) sid :working)))))

(deftest drive
  (let [ended (fn [lvl] (-> (start) (watch-at lvl) (baton 1 [:done] :decisions ["d1"]) (decision "d1" "pending")))]
    (testing "the reconcile after a gathering is the baton's own (F8a); nothing at L0 or paused"
      (is (empty? (drives (ended "L0"))))
      (is (empty? (drives (-> (start) (watch-at "L3" :paused true) (baton 1 [:done] :decisions ["d1"]) (decision "d1" "pending"))))))
    (testing "L2: promote in-area drafted decisions, never out of area"
      (is (some #{:decision/promote} (map :event (drives (decision (ended "L2") "d1" "drafted")))))
      (is (not (some #{:decision/promote} (map :event (drives (decision (ended "L2") "d1" "drafted" :ex {:author-owns-area false})))))))
    (testing "L3: build once all promoted, none built, no build"
      (let [y (decision (ended "L3") "d1" "promoted")
            d (first (filter #(= :build/start (:event %)) (drives y)))]
        (is d)
        (is (= ["d1"] (get-in d [:data :decisions])))
        (is (re-find #"S d1" (get-in d [:data :prompt])))
        (is (= "Build §gap/invoicing" (get-in d [:data :title]))))
      (is (not (some #{:build/start} (map :event (drives (decision (ended "L2") "d1" "promoted")))))))
    (testing "planned gatherings start at L1, once"
      (let [x (-> (start) (watch-at "L0") (h/send! sid :gather/plan {:by "overseer" :to "p1" :public-title "T" :goal "G" :question "Q"}))]
        (is (empty? (drives x)))
        (let [y (watch-at x "L1")]
          (is (= [:gather/start] (map :event (drives y))))
          (is (= 1 (count (drives (watch-at y "L2")))) "not twice"))))
    (testing "F8b: after an attempt to Ana answered nothing, Bob's plan starts and Ana's never again"
      (let [plan (fn [x to] (h/send! x sid :gather/plan {:by "overseer" :to to :public-title "T" :goal "G" :question "Q"}))
            x (-> (start) (watch-at "L0") (plan "p1") (plan "p2") (plan "p1"))
            y (watch-at x "L1")
            d1 (first (drives y))]
        (is (= "p1" (get-in d1 [:data :to])))
        (let [z (-> y (baton 1 [:open :with-person] :handoffs [{:to "p1"}]) (baton 1 [:closed] :handoffs [{:to "p1"}]))
              starts (filter #(= :gather/start (:event %)) (drives z))]
          (is (h/in? z sid :open))
          (is (= ["p1" "p2"] (map #(get-in % [:data :to]) starts)) "the third plan (Ana again) is never started"))))
    (testing "move: close an own gathering nobody wrote in once a newer one to the same person is open"
      (let [y (-> (start) (watch-at "L1")
                  (baton 1 [:open :with-person] :handoffs [{:to "p1"}])
                  (baton 2 [:open :with-person] :handoffs [{:to "p1"}]))
            c (first (filter #(= :baton/close (:event %)) (drives y)))]
        (is (= "baton/o1/b1" (:target c)))))))

(deftest corrections
  (let [p (-> (start) (watch-at "L0") (baton 1 [:done] :decisions ["d1"]) (decision "d1" "promoted" :states [:built-done])
              (build 1 [:turn-idle :merged]))]
    (is (h/in? p sid :done))
    (is (= "A correction needs a reason: say why." (h/refusal p sid :correct/reopen {:by "overseer" :attended true})))
    (is (h/in? (h/send! p sid :correct/reopen {:by "overseer" :attended true :reason "the demo broke"}) sid :merged))
    (is (= "§gap/invoicing is not done." (h/refusal (start) sid :correct/reopen {:by "overseer" :attended true :reason "r"})))))

(deftest R4-reopened-and-answered-nothing-are-feed-not-reasons
  (let [kinds (fn [x] (set (keep #(when (= :reason/noted (:event %)) (get-in % [:data :kind])) (h/elsewhere x))))
        p (-> (start) (watch-at "L0") (baton 1 [:done] :decisions ["d1"]) (decision "d1" "promoted"))
        reopened (decision (h/clear! p sid) "d2" "pending")
        nothing (-> (start) (watch-at "L0") (baton 1 [:open :with-person]) (h/clear! sid) (baton 1 [:closed]))]
    (is (h/in? reopened sid :unreconciled))
    (is (not (contains? (kinds reopened) "item/reopened")) "reopened: a feed entry, no reason")
    (is (h/in? nothing sid :open))
    (is (= 1 (:attempts (h/data nothing sid))))
    (is (not (contains? (kinds nothing) "item/answered-nothing")) "answered nothing: a feed entry, no reason")))
