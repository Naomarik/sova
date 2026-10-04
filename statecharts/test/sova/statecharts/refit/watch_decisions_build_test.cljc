(ns sova.statecharts.refit.watch-decisions-build-test
  "The watch, decision, reconciler, conflict and build statecharts."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.reasons :as rs]
    [sova.statecharts.refit.host :as h]
    [sova.statecharts.watch :as w]))

(def op {:by "operator"})

;; ---- watch ----------------------------------------------------------------------------------------

(def wsid "watch/pr1")
(defn watch [] (-> (h/start! (h/new-host) "watch" wsid {:project-id "pr1" :tick-ms 0 :last-run-at 1700000000000})
                   (h/send! wsid :link/moved {:from "project/pr1" :statechart "project" :states [:project :has-overseer :active] :exported {:name "Site"}})))
(def done-reason {:kind "baton/done" :params {:title "Invoicing" :session-id "s1"} :key "baton/done:s1" :by "system"})

(deftest watch-loop
  (let [x (watch)]
    (is (h/in? x wsid :quiet))
    (let [y (h/send! x wsid :reason/noted done-reason)]
      (is (h/in? y wsid :waiting))
      (is (h/in? (h/advance! y 60000) wsid :running) "a soon reason looks after soonLookSec")
      (let [r (h/advance! y 60000)]
        (testing "C1: a stopped look's reasons come back in front"
          (is (= ["The gathering session \"Invoicing\" reached its goal."] (map :text (:reasons (h/data (h/send! r wsid :look/stopped {:detail "x"}) wsid))))))
        (is (h/in? (h/send! r wsid :look/finished {}) wsid :quiet))
        (is (= "Not started: busy." (h/refusal r wsid :operator/run-now op)))))
    (testing "C3: two reasons with different keys are two reasons"
      (let [y (-> x (h/send! wsid :reason/noted done-reason) (h/send! wsid :reason/noted (assoc done-reason :key "baton/done:s2")) (h/send! wsid :reason/noted done-reason))]
        (is (= 2 (count (:reasons (h/data y wsid)))))))
    (testing "C2: the overseer's own act while it runs is no reason; the same while idle is"
      (let [busy (h/send! x wsid :turn/started {:look false})]
        (is (h/in? (h/send! busy wsid :reason/noted {:kind "reconcile/drafted" :params {:ids ["d1"]} :by "overseer" :key "k"}) wsid :quiet))
        (is (h/in? (h/send! busy wsid :reason/noted {:kind "reconcile/drafted" :params {:ids ["d1"]} :by "operator" :key "k"}) wsid :waiting))))
    (testing "paused by an attach: L0 in force, looks wait; a level set resumes"
      (let [p (-> x (h/send! wsid :org/attached-here {}) (h/send! wsid :reason/noted done-reason) (h/advance! 120000))]
        (is (h/in? p wsid :due))
        (is (h/in? (h/send! p wsid :operator/level-set (assoc op :resume-at "L2")) wsid :running))
        (is (= "L2" (get-in (h/data (h/send! p wsid :operator/level-set (assoc op :autonomy "L0" :resume-at "L2")) wsid) [:settings :autonomy]))
          "the envelope's autonomy (the level in force, L0 while paused) never overrides the level chosen")))
    (testing "the looks per day hold at the limit, and midnight gives them back"
      (let [y (-> x (h/send! wsid :settings/changed {:settings {:caps {:unattended-per-day 0}}}) (h/send! wsid :reason/noted done-reason) (h/advance! 60000))]
        (is (h/in? y wsid :held))
        (is (= "looks" (:key (first (:held (h/data y wsid))))))
        (is (= "Not started: the daily limit of 0 unattended runs is reached." (h/refusal y wsid :operator/run-now op)))))
    (testing "ledgers"
      (let [y (-> x (h/send! wsid :ledger/take {:kind "gather" :n 1 :ledger "day" :by "overseer"})
                    (h/send! wsid :ledger/take {:kind "gather" :n 1 :ledger "day" :by "operator"}))]
        (is (= {:used 1 :max 6} (:gather (w/allowance (h/data y wsid) "day"))))
        (is (= 0 (get-in (h/data (h/send! y wsid :day/rollover {}) wsid) [:ledgers :day :gather] 0)))))
    (is (= "Site is archived. Unarchive it to use its overseer."
           (h/refusal (h/send! x wsid :link/moved {:from "project/pr1" :statechart "project" :states [:archived :has-overseer] :exported {:name "Site"}}) wsid :operator/run-now op)))))

;; ---- decision -------------------------------------------------------------------------------------

(def dsid "decision/o1/pr1/s1:e1")
(defn decision [] (h/start! (h/new-host) "decision" dsid {:org-id "o1" :project-id "pr1" :id "s1:e1" :area "Pay" :owner-area "none" :statement "S"}))

(deftest decision-life
  (let [x (decision)]
    (is (h/in? x dsid :pending))
    (is (= [:decision/recorded] (map :event (h/elsewhere x))))
    (let [dr (h/send! x dsid :reconcile/result {:state "drafted" :record-id "§requirements.pay/s"})
          p  (h/send! dr dsid :promote/done {:text-hash "h1" :commit "abc"})]
      (is (h/in? dr dsid :drafted))
      (is (h/in? p dsid :current))
      (is (h/in? (h/send! p dsid :spec/facts {:record-present false}) dsid :stale))
      (is (h/in? (h/send! p dsid :spec/facts {:build "built"}) dsid :built-done))
      (is (= "Its words in the spec are as they were promoted." (h/refusal p dsid :decision/settle-text (assoc op :action "keep"))))
      (let [ed (h/send! p dsid :spec/facts {:edited-in-spec true})]
        (is (h/in? ed dsid :edited-in-spec))
        (is (h/in? (h/send! ed dsid :decision/settle-text (assoc op :action "keep" :text-hash "h2")) dsid :as-promoted))
        (is (= ["restore-text"] (h/kinds (h/send! (h/clear! ed dsid) dsid :decision/settle-text (assoc op :action "restore")) dsid)))))
    (is (= "\"money\" is not an owner area. Use one of: \"payroll\" or \"none\"." (h/refusal x dsid :decision/owner-area (assoc op :owner-area "money" :owner-areas ["payroll"]))))
    (let [y (h/send! x dsid :decision/owner-area (assoc op :owner-area "Payroll" :owner-areas ["payroll"]))]
      (is (= "payroll" (:owner-area (h/data y dsid))))
      (is (= 1 (count (:owner-area-history (h/data y dsid))))))
    (is (= "That decision was superseded: its owner area no longer decides anything."
           (h/refusal (h/send! x dsid :reconcile/result {:state "superseded" :superseded-by "x"}) dsid :decision/owner-area (assoc op :owner-area "none"))))))

;; ---- reconciler -------------------------------------------------------------------------------------

(def rsid "reconciler/o1/pr1")
(defn rec [& [d]] (h/start! (h/new-host) "reconciler" rsid (merge {:org-id "o1" :project-id "pr1"} d)))
(defn index [x id state & {:as ex}]
  (h/send! x rsid :link/moved {:from (str "decision/o1/pr1/" id) :statechart "decision" :states [:decision (keyword state)]
                               :exported (merge {:state state :author-owns-area true :name "Ana"} ex)}))

(deftest reconciler
  (let [x (rec)]
    (is (h/in? x rsid :idle))
    (is (= "Turn on Reconcile decisions in Settings → Decisions." (h/refusal (rec {:enabled false}) rsid :reconcile/request op)))
    (is (= "Turn on Reconcile decisions in Settings → Decisions." (get-in (h/data (h/send! (rec {:enabled false}) rsid :reconcile/request {:by "sova" :delay-ms 2000}) rsid) [:last-run :error])))
    (testing "C4: a settle session's decision waits 2 s (a timer), then runs; one at a time"
      (let [d (h/send! x rsid :reconcile/request {:by "sova" :delay-ms 2000})]
        (is (h/in? d rsid :debouncing))
        (let [r (h/advance! d 2000)]
          (is (h/in? r rsid :running))
          (let [again (h/send! r rsid :reconcile/request op)]
            (is (true? (:again (h/data again rsid))))
            (is (h/in? (h/send! again rsid :reconcile/finished {:decisions []}) rsid :running))))))
    (testing "results fan out"
      (let [r (-> x (index "d1" "pending") (h/send! rsid :reconcile/request op)
                  (h/send! rsid :reconcile/finished {:decisions [{:id "d1" :state "drafted"}] :drafted-ids ["d1"]
                                                     :conflicts [{:id "cf1" :routed-to "operator" :baton-session-id "s9"}]}))]
        (is (h/in? r rsid :idle))
        (is (= #{:reconcile/result :reason/noted} (set (map :event (h/elsewhere r)))))
        (is (some #(= "conflict/o1/pr1/cf1" (:id %)) (h/directives r rsid)))
        (is (h/in? (h/send! (h/send! x rsid :reconcile/request op) rsid :reconcile/finished {:error "No decision provider is ready (Settings → Decisions)."}) rsid :failed))))
    (testing "promote: per-id verdicts, the whole request refused only when none may be promoted"
      (let [y (-> x (index "d1" "drafted") (index "d2" "pending") (index "d3" "drafted" :author-owns-area false))]
        (is (= "Promoted 0, refused 2: d2 (it is pending; only a reconciled (drafted) decision can be promoted); d3 (outside Ana's decision area: promote it explicitly by id)."
               (h/refusal y rsid :decision/promote {:by "overseer" :attended true :ids ["d2" "d3"]})))
        (is (nil? (h/refusal y rsid :decision/promote (assoc op :ids ["d3"]))) "the operator names it by id")
        (is (= "Give the ids to promote." (h/refusal y rsid :decision/promote (assoc op :ids []))))
        (is (re-find #"^Today's allowance is used: 5 of 5 decisions promoted"
                     (h/refusal y rsid :decision/promote {:by "overseer" :autonomy "L2" :ids ["d1"] :ledger "day" :allowance {:promote {:used 5 :max 5}}})))
        (let [p (h/send! y rsid :decision/promote {:by "overseer" :attended true :ids ["d1" "d2"] :ledger "message"})
              eff (last (h/outbox p rsid))]
          (is (= ["d1"] (:ids eff)))
          (let [done (h/send! p rsid :effect/done {:kind "promote" :effect eff :result {:promoted ["d1"] :commit {:sha "abc"}}})
                take (first (filter #(= :ledger/take (:event %)) (h/elsewhere done)))]
            (is (= 1 (get-in take [:data :n])) "only what was promoted counts")))))))

;; ---- conflict -----------------------------------------------------------------------------------------

(def csid "conflict/o1/pr1/cf1")
(def sides {:a {:id "d1" :name "Ana" :statement "Monthly" :quote "monthly" :at 0} :b {:id "d2" :name "Bob" :statement "Weekly" :quote "weekly" :at 0}})
(defn conflict [d] (h/start! (h/new-host) "conflict" csid (merge {:org-id "o1" :project-id "pr1" :id "cf1" :area "Pay" :baton-session-id "s9"} sides d)))

(deftest conflicts
  (let [x (conflict {:routed-to "p3" :route-reason "Cy decides pay."})]
    (is (h/in? x csid :routed-to-person))
    (let [sp (last (h/directives x csid))]
      (is (= "baton/o1/s9" (:id sp)))
      (is (false? (get-in sp [:data :mint-link])))
      (is (= "Settle: Pay" (get-in sp [:data :public-title]))))
    (is (h/in? (conflict {:routed-to "operator"}) csid :routed-to-operator))
    (is (h/in? (conflict {:route-error "no provider"}) csid :unrouted))
    (testing "its settle session closed without a re-route: nobody is asked (C17)"
      (is (h/in? (h/send! x csid :link/moved {:from "baton/o1/s9" :statechart "baton" :states [:baton :closed]}) csid :unrouted)))
    (testing "a re-route closes the earlier session and starts a new one"
      (let [y (h/send! x csid :conflict/reroute (assoc op :to "operator" :session-id "s10" :operator-name "Omar"))]
        (is (h/in? y csid :routed-to-operator))
        (is (some #(and (= :baton/close (:event %)) (= "baton/o1/s9" (:target %))) (h/elsewhere y)))
        (is (= "baton/o1/s10" (:id (last (h/directives y csid)))))))
    (is (= "Route to an active person or the operator" (h/refusal x csid :conflict/reroute (assoc op :to "p9" :target {:status "left"}))))
    (let [s (h/send! x csid :conflict/settle (assoc op :keep "a"))]
      (is (h/in? s csid :settled))
      (is (= "a" (:outcome (h/data s csid))))
      (is (= "That conflict is resolved" (h/refusal s csid :conflict/settle (assoc op :keep "b")))))
    (is (= "statement must be 1–500 characters" (h/refusal x csid :conflict/settle (assoc op :statement " "))))))

;; ---- build ----------------------------------------------------------------------------------------------

(def bsid "build/pr1/c1")
(defn build [& [d]] (h/start! (h/new-host) "build" bsid (merge {:project-id "pr1" :session-id "c1" :kind "coding" :title "Pay page" :prompt "Build it"} d)))
(defn made [x] (-> x (h/send! bsid :effect/done {:kind "make-worktree" :result {:branch "sova/pay-abc123" :target "main" :base "b0"}})
                   (h/send! bsid :effect/done {:kind "set-mode"}) (h/send! bsid :effect/done {:kind "first-prompt"})))

(deftest builds
  (let [x (made (build))]
    (is (h/in? x bsid :ready))
    (is (= "No session was started: its worktree could not be made (fatal: bad)."
           (:not-started (h/data (h/send! (build) bsid :effect/failed {:kind "make-worktree" :detail "fatal: bad"}) bsid))))
    (is (h/in? (h/send! (h/send! (build {:prompt nil}) bsid :effect/done {:kind "make-worktree" :result {:in-root "it isn't a Git repository."}}) bsid :effect/done {:kind "set-mode"}) bsid :ready))
    (let [w (h/send! x bsid :turn/started {})]
      (is (= "The session is working." (h/refusal w bsid :build/merge op)))
      (let [ended (h/send! w bsid :turn/ended {})]
        (is (some #(= "coding/settled" (get-in % [:data :kind])) (h/elsewhere ended)))
        (is (= "Its workers are running." (h/refusal (h/send! ended bsid :workers/changed {:n 2}) bsid :build/merge op)))
        (let [m (h/send! ended bsid :build/merge op)]
          (is (h/in? m bsid :merging))
          (let [done (h/send! m bsid :effect/done {:kind "merge" :result {:commit "c0ffee"}})]
            (is (= "c0ffee" (get-in (h/data done bsid) [:merged :commit])))
            (is (some #(= "build/merged" (get-in % [:data :kind])) (h/elsewhere done)) "master's reason for the operator's merge")
            (is (not-any? #(= :milestone/noted (:event %)) (h/elsewhere done)) "no milestone send: its project reads the exported merge"))
          (testing "a refusal about the root's checkout is not the overseer's news"
            (is (not (some #(= "build/merge-refused" (get-in % [:data :kind])) (h/elsewhere (h/send! m bsid :effect/failed {:kind "merge" :detail "The project root has main checked out, not dev."})))))))))
    (is (= "It runs in the project root: it isn't a Git repository."
           (h/refusal (h/send! (build) bsid :effect/done {:kind "make-worktree" :result {:in-root "it isn't a Git repository."}}) bsid :build/merge op)))
    (is (= "\"Pay page\" is open in a terminal, so it is read-only." (h/refusal x bsid :build/prompt {:by "overseer" :attended true :live true :text "go"})))
    (is (= "text must not be blank." (h/refusal x bsid :build/prompt {:by "overseer" :attended true :text " "})))
    (is (= "Its worktree was removed, so it has no folder to work in."
           (h/refusal (-> x (h/send! bsid :build/remove-worktree op) (h/send! bsid :effect/done {:kind "remove-worktree"})) bsid :build/prompt {:by "overseer" :attended true :text "go"})))
    (is (h/in? (h/send! x bsid :git/probe {:branch "new-since-merge"}) bsid :new-since-merge))))

(deftest F-133-a-folded-reason-never-pushes-the-soon-look-back
  ;; server-5: a coding session's turn settles at t, again at t+30 s (same key, folded): the look
  ;; comes a minute after the first
  (let [settled {:kind "coding/settled" :params {:title "Pay" :session-id "c1"} :key "coding/settled:c1:ok" :by "system"}
        x  (h/send! (watch) wsid :reason/noted settled)
        t  (h/now x)
        y  (-> x (h/advance! 30000) (h/send! wsid :reason/noted settled))]
    (is (= 1 (count (:reasons (h/data y wsid)))) "folded")
    (is (= (+ t 60000) (:soon-at (h/data y wsid))))
    (is (h/in? (h/advance! y 29999) wsid :waiting))
    (is (h/in? (h/advance! y 30000) wsid :running) "at t+60 s, not t+90 s")))

;; ---- R3 / R4 (coordinator-40, r8): what does not wake the overseer ----------------------------------

(deftest R3-news-of-the-statecharts-own-act-starts-no-look
  (let [x (watch)
        statechart-news (assoc done-reason :by "statechart")]
    (is (h/in? (h/send! x wsid :reason/noted statechart-news) wsid :quiet) "no look is due")
    (is (empty? (:reasons (h/data (h/send! x wsid :reason/noted statechart-news) wsid))) "it is no look reason: it reaches the next look as feed")
    (is (= 0 (:looks-today (h/data (h/advance! (h/send! x wsid :reason/noted statechart-news) (* 20 60000)) wsid) 0)) "it uses no look")
    (testing "a batch keeps the others"
      (let [y (h/send! x wsid :reason/noted {:reasons [statechart-news (assoc done-reason :key "baton/done:s2")] :by "system"})]
        (is (= ["baton/done:s2"] (map :key (:reasons (h/data y wsid)))))
        (is (h/in? y wsid :waiting)))))
  (testing "a statechart-driven act's reason says by statechart; the same act by the operator says system"
    (let [r   (fn [by] (-> (h/start! (h/new-host) "baton" "baton/o1/s1" {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "T" :goal "G"
                                                                        :owner {:overseer-of "pr1"} :to "p1" :names {"p1" "Ana"} :operator-name "Omar"})
                           (h/send! "baton/o1/s1" :baton/close {:by by :reason "A newer gathering covers it." :owner-project "pr1" :autonomy "L1" :hold-ms 0})))
          by-of (fn [x] (some #(when (= :reason/noted (:event %)) (get-in % [:data :by])) (h/elsewhere x)))]
      (is (= "statechart" (by-of (r "statechart"))))
      (is (= "system" (by-of (r "operator")))))))

(deftest build-not-prompted-tells-the-overseer
  ;; F20 follow-up (coordinator-42): a failed set-mode leaves the build started, not prompted (master), and
  ;; its project's watch is told, since a build the statechart started has no caller to answer
  (let [told (fn [x] (keep #(when (= :reason/noted (:event %)) (:data %)) (h/elsewhere x)))
        failed (fn [d] (-> (build d) (h/send! bsid :effect/done {:kind "make-worktree" :result {:branch "sova/pay-abc123" :target "main" :base "b0"}})
                           (h/send! bsid :effect/failed {:kind "set-mode" :detail "no such mode"})))
        x (failed {})
        r (first (told x))]
    (is (h/in? x bsid :ready))
    (is (= "no such mode" (:mode-not-set (h/data x bsid))))
    (is (not (some #{"first-prompt"} (h/kinds x bsid))) "never prompted in a mode it wasn't given")
    (is (= "build/not-prompted" (:kind r)))
    (is (= "system" (:by r)))
    (is (= "The coding session \"Pay page\" started, but its mode could not be set, so its first prompt was not sent." (rs/text r)))
    (is (rs/soon? r))
    (is (empty? (keep :kind (told (failed {:prompt nil})))) "no prompt to send: nothing to tell")))
