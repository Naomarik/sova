(ns sova.org-charts.charts.refit.pins-test
  "Pins for what verifier-2's chart mutation run2 (at 81743449) left alive: each assertion fails
   under one surviving mutant, named in its message (run2c.json ids)."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.baton :as bt]
    [sova.org-charts.charts.person :as person]
    [sova.org-charts.charts.proj :as proj]
    [sova.org-charts.charts.watch :as w]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.charts.refit.host :as h]
    [sova.org-charts.charts.residence :as res]
    [sova.org-charts.charts.rules.baton :as rb]
    [sova.org-charts.charts.rules.item :as ri]
    [sova.org-charts.charts.rules.person :as rp]
    [sova.org-charts.charts.rules.started :as st]))

(def op {:by "operator"})
(def t0 1700000000000)
(def hour 3600000)
(defn ev [data] {:_event {:data data}})
(defn what [chart act data] ((get-in registry/charts [chart :acts act :what]) (ev data)))

;; ---- person ------------------------------------------------------------------------------------------

(deftest person-pins
  (is (nil? (person/target-status {:status "active" :_event {:name :person/edit :data {:patch {:status "active" :role "r"}}}}))
      "person01: a patch naming the current status moves nowhere")
  (is (= "left" (person/target-status {:status "active" :_event {:name :person/edit :data {:patch {:status "left"}}}}))))

;; ---- project -----------------------------------------------------------------------------------------

(deftest project-pins
  (is (= "less than an hour ago" (proj/hours-ago t0 (+ t0 (dec hour)))))
  (is (= "1 hour ago" (proj/hours-ago t0 (+ t0 hour))) "proj09")
  (is (= "2 hours ago" (proj/hours-ago t0 (+ t0 (* 2 hour)))) "proj04")
  (is (not (proj/milestone? (assoc (ev {:build-finished-at t0}) :last-post-at t0))) "proj07: a build that finished at the last post is no news")
  (is (proj/milestone? (assoc (ev {:build-finished-at (inc t0)}) :last-post-at t0)))
  (let [upd (fn [last-post now] (proj/update-check (assoc (ev {:owner-active true :text "News" :at now :build-finished-at (dec now)}) :last-post-at last-post)))]
    (is (nil? (upd t0 (+ t0 proj/update-every-ms))) "proj10: a day to the ms is a day")
    (is (some? (upd t0 (+ t0 proj/update-every-ms -1))))
    (is (nil? (upd nil t0)) "proj00: never posted: no gate"))
  (let [left (fn [chart] (proj/stakeholder-left? nil (assoc (ev {:from (str chart "/o1/p1") :chart chart :states [:left]}) :stakeholder "p1")))]
    (is (true? (boolean (left "person"))))
    (is (not (left "baton")) "proj01: only the person's own chart"))
  (is (= 2 (count (proj/set-stakeholder-ops (assoc (ev {:person-id "p1"}) :stakeholder "p1")))) "proj13: the same stakeholder again adds no line")
  (is (= 3 (count (proj/set-stakeholder-ops (assoc (ev {:person-id "p2"}) :stakeholder "p1")))))
  (let [x (h/send! (h/start! (h/new-host) "project" "project/o1/pr1" {:org-id "o1" :id "pr1" :name "Site" :root "/r"})
                   "project/o1/pr1" :gap/file {:by "overseer" :attended true :autonomy "L3" :gap-id "g_1" :idea-id "§gap/x"})
        sp (first (filter #(= "item" (:chart %)) (h/directives x "project/o1/pr1")))]
    (is (= "item/o1/pr1/g_1" (:id sp)))
    (is (false? (:watch? sp)) "proj06: the project never watches its items"))
  (is (= "A coding session \"Pay\"" (what "project" :build/start {:title "Pay"})) "proj14")
  (is (= "A coding session \"untitled\"" (what "project" :build/start {}))))

;; ---- watch -------------------------------------------------------------------------------------------

(deftest watch-pins
  (let [looks (fn [a b] (w/raised-keys {:caps {:unattended-per-day a}} {:caps {:unattended-per-day b}}))]
    (is (= {"looks" "looks"} (looks 3 5)))
    (is (= {"looks" "looks"} (looks 3 nil)) "Unlimited raises it")
    (is (= {} (looks 5 3)) "watch19: lowered frees nothing")
    (is (= {} (looks nil 5)) "watch02: from Unlimited nothing was held")
    (is (= {} (w/raised-keys {:caps {:unattended-per-day 3}} {:caps {}})) "watch03: not in the new settings"))
  (let [day (w/refused-item {:ledger "day" :kind "gather" :used 6 :max 6} t0)
        msg (w/refused-item {:ledger "message" :kind "gather" :used 1 :max 1} t0)]
    (is (= "day:gather" (:key day)) "watch08")
    (is (< t0 (:retry-at day)))
    (is (= "message:gather" (:key msg)))
    (is (= t0 (:retry-at msg))))
  (let [ops (w/start-run-ops (assoc (ev {:at t0}) :looks-today 2))]
    (is (some #(= 3 (get-in % [:data :looks-today] (get % :looks-today))) (map #(if (map? %) % {}) ops)) "watch10")))

;; ---- baton -------------------------------------------------------------------------------------------

(def bsid "baton/o1/s1")
(defn baton [d] (h/start! (h/new-host) "baton" bsid (merge {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "Invoicing" :goal "Learn"
                                                           :owner {:overseer-of "pr1"} :names {"p1" "Ana Ruiz" "p2" "Bob Diaz"} :operator-name "Omar"} d)))
(defn msg [x from] (h/send! x bsid :baton/message {:by (if (= from "operator") "operator" "person") :from from :active true}))
(def cy {:by "model" :name "Cy Lee" :role "Accountant" :decides ["pay"] :contact {:email "cy@example.test"} :why "knows pay" :quote "ask Cy" :person-id "p9"})

(deftest baton-pins
  (let [x (-> (baton {:targets ["p1" "p2"]}) (msg "p1"))
        lease #(:lease-until (rb/current-offer (h/data % bsid)))]
    (is (= (+ t0 (* 15 60000)) (lease x)))
    (is (= (lease x) (lease (-> x (h/advance! 60000) (msg "operator")))) "baton01: the operator's message renews no lease")
    (is (nil? (lease (msg (baton {:targets ["p1" "p2"]}) "operator"))) "baton01: the operator writing into the pool leases it to nobody")
    (is (= (+ t0 60000 (* 15 60000)) (lease (-> x (h/advance! 60000) (msg "p1")))) "the holder's does"))
  (is (nil? (:person-wrote-at (h/data (msg (baton {:to "p1"}) "operator") bsid))) "baton02: the operator is no person")
  (is (= t0 (:person-wrote-at (h/data (-> (baton {:to "p1"}) (msg "p1") (h/advance! 60000) (msg "p1")) bsid))) "the first time stays")
  (is (= t0 (:closed-at (h/data (h/send! (baton {:to "p1"}) bsid :baton/close op) bsid))) "baton10")
  (is (some #(= {:event :milestone/noted :target "project/o1/pr1" :data {:kind "baton-done" :shown true}} (select-keys % [:event :target :data]))
            (h/elsewhere (h/send! (baton {:to "p1"}) bsid :baton/goal-done {:by "model" :summary "All set"}))) "baton08")
  (let [p (-> (baton {:to "p1"}) (msg "p1"))]
    (is (= "Not recorded: Cy Lee is already on the roster. Ask Ana Ruiz and try again." (h/refusal p bsid :baton/propose (assoc cy :names-taken ["cy lee"]))) "baton12")
    (let [sp (last (h/directives (h/send! p bsid :baton/propose (assoc cy :names-taken [])) bsid))]
      (is (= "p1" (get-in sp [:data :person :referral :referred-by])) "baton13"))
    (let [sp (last (h/directives (h/send! p bsid :baton/record-decision {:by "model" :decision-id "s1:e1" :area "Pay" :statement "S" :quote "Q" :owner-areas []}) bsid))]
      (is (= ["p1" "Ana Ruiz"] [(get-in sp [:data :by]) (get-in sp [:data :name])]) "baton11")))
  (let [y (-> (baton {:to "p1"}) (msg "p1") (h/send! bsid :reply/ended {}) (h/send! bsid :baton/goal-done {:by "model" :summary "All set"}))]
    (is (h/in? y bsid :wrapup-running))
    (is (= 0 (:applied (:wrapup (h/data (h/send! y bsid :wrapup/finished {}) bsid)))) "baton14")
    (is (= 0 (:applied (:wrapup (h/data (h/send! y bsid :wrapup/stopped {}) bsid)))) "baton15"))
  (let [cold? (get-in registry/charts ["baton" :cold?])]
    (is (not (cold? #{:done :wrapup-running} nil)) "baton03: a wrap-up still to run keeps it warm")
    (is (not (cold? #{:with-person :wrapup-idle} nil)))
    (is (cold? #{:done :wrapup-done} nil))))

;; ---- decision, conflict, reconciler ------------------------------------------------------------------

(deftest decision-pins
  (let [start #(h/start! (h/new-host) "decision" "decision/o1/pr1/s1:e1" (merge {:org-id "o1" :project-id "pr1" :id "s1:e1" :area "Pay" :owner-area "none" :statement "S"} %))]
    (is (= 5 (:at (h/data (start {:recorded-at 5}) "decision/o1/pr1/s1:e1"))) "decisi14")
    (is (= t0 (:at (h/data (start {}) "decision/o1/pr1/s1:e1"))))))

(def csid "conflict/o1/pr1/cf1")
(defn conflict [d] (h/start! (h/new-host) "conflict" csid (merge {:org-id "o1" :project-id "pr1" :id "cf1" :area "Pay" :baton-session-id "s9" :routed-to "p3"
                                                                  :a {:id "d1" :name "Ana" :statement "M" :quote "m" :at 0} :b {:id "d2" :name "Bob" :statement "W" :quote "w" :at 0}} d)))

(deftest conflict-pins
  (let [x (conflict {})
        s500 (apply str (repeat 500 "x"))]
    (is (nil? (h/refusal x csid :conflict/settle (assoc op :statement s500))) "confli06: 500 is allowed")
    (is (= "statement must be 1–500 characters" (h/refusal x csid :conflict/settle (assoc op :statement (str s500 "x")))))
    (is (= "Bob decides it." (:route-reason (h/data (h/send! x csid :conflict/reroute (assoc op :to "operator" :session-id "s10" :operator-name "Omar" :route-reason "Bob decides it.")) csid)))
        "confli12: the host's reason is kept")
    (is (= "Omar chosen by Omar." (:route-reason (h/data (h/send! x csid :conflict/reroute (assoc op :to "operator" :session-id "s10" :operator-name "Omar")) csid)))
        "the operator's name comes on the event (it was blank when the conflict's own data had none)")))

(def rsid "reconciler/o1/pr1")
(defn rec [] (h/start! (h/new-host) "reconciler" rsid {:org-id "o1" :project-id "pr1"}))
(defn index [x id state & [states]]
  (h/send! x rsid :link/moved {:from (str "decision/o1/pr1/" id) :chart "decision" :states (into [:decision (keyword state)] states)
                               :exported {:state state :author-owns-area true :name "Ana"}}))

(deftest reconciler-pins
  (is (= "Promoting 1 decision" (what "reconciler" :decision/promote {:ids ["d1"]})) "reconc08")
  (is (= "Promoting 2 decisions" (what "reconciler" :decision/promote {:ids ["d1" "d2"]})))
  (is (true? (get-in (h/data (index (rec) "d1" "promoted" [:stale]) rsid) [:index "d1" :stale])) "reconc16")
  (is (false? (get-in (h/data (index (rec) "d1" "promoted") rsid) [:index "d1" :stale])))
  (let [r (-> (rec) (h/send! rsid :reconcile/request op)
              (h/send! rsid :reconcile/finished {:decisions [{:id "d7" :state "drafted"}]}))]
    (is (= ["decision/o1/pr1/d7"] (map :target (filter #(= :reconcile/result (:event %)) (h/elsewhere r)))) "reconc09: an id not in the index yet"))
  (let [y (-> (rec) (index "d1" "drafted"))
        eff #(last (h/outbox (h/send! y rsid :decision/promote (merge {:by "overseer" :ids ["d1"]} %)) rsid))]
    (is (= "message" (:ledger (eff {:attended true}))) "reconc12")
    (is (= "day" (:ledger (eff {:attended false :autonomy "L2" :roster-active true :allowance {:promote {:used 0 :max 5}}}))))
    (let [p (h/send! y rsid :decision/promote {:by "overseer" :attended true :ids ["d1"]})
          e (last (h/outbox p rsid))
          reasons #(filter (fn [s] (and (= :reason/noted (:event s)) (= "reconcile/promoted" (get-in s [:data :kind])))) (h/elsewhere %))]
      (is (= 1 (count (reasons (h/send! p rsid :effect/done {:kind "promote" :effect e :result {:promoted ["d1"]}})))) "reconc18")
      (is (empty? (reasons (h/send! p rsid :effect/done {:kind "promote" :effect e :result {:promoted []}})))))))

;; ---- item --------------------------------------------------------------------------------------------

(def isid "item/o1/pr1/g_1")
(defn item-baton [x n states handoffs]
  (h/send! x isid :link/moved {:from (str "baton/o1/b" n) :chart "baton" :states (into [:baton] states)
                               :exported {:owner {:overseer-of "pr1"} :decisions [] :created-at n :handoffs handoffs}}))

(deftest item-pins
  (let [x (-> (h/start! (h/new-host) "item" isid {:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/invoicing"})
              (h/send! isid :link/moved {:from "watch/o1/pr1" :chart "watch" :states [:watch]
                                         :exported {:settings {:autonomy "L0"} :paused false :roster-active true :archived false}}))
        asked (fn [to] (:answered-nothing-to (h/data (-> x (item-baton 1 [:open :with-person] [{:to to}]) (item-baton 1 [:closed] [{:to to}])) isid)))]
    (is (= ["p1"] (asked "p1")) "item19")
    (is (empty? (asked "pool")) "item07: an offer's pool is nobody")))

;; ---- build -------------------------------------------------------------------------------------------

(def csid* "build/o1/pr1/c1")
(defn build [& [d]] (h/start! (h/new-host) "build" csid* (merge {:org-id "o1" :project-id "pr1" :session-id "c1" :kind "coding" :title "Pay page" :prompt "Build it"} d)))
(def made-tree {:kind "make-worktree" :result {:branch "sova/pay-abc123" :target "main" :base "b0"}})
(defn ready [x] (-> x (h/send! csid* :effect/done made-tree) (h/send! csid* :effect/done {:kind "set-mode"}) (h/send! csid* :effect/done {:kind "first-prompt"})))

(deftest build-pins
  (let [x (ready (build))
        running #(:running (h/data % csid*))]
    (is (false? (running (h/send! x csid* :workers/changed {:n 0}))) "build06: idle, no workers")
    (is (true? (running (h/send! x csid* :workers/changed {:n 2}))))
    (is (true? (running (h/send! x csid* :turn/started {}))) "build09 build13: working, no workers")
    (is (false? (running (-> x (h/send! csid* :turn/started {}) (h/send! csid* :turn/ended {})))))
    (let [removal #(:merged (last (filter (fn [o] (= "remove-worktree" (:kind o))) (h/outbox (h/send! % csid* :build/remove-worktree op) csid*))))]
      (is (true? (removal (h/send! x csid* :git/probe {:branch "merged"}))) "build08")
      (is (false? (removal (h/send! x csid* :git/probe {:branch "unmerged"}))))))
  (let [made (h/send! (build {:prompt nil}) csid* :effect/done made-tree)]
    (is (true? (:mode-not-set (h/data (h/send! made csid* :effect/failed {:kind "set-mode"}) csid*))) "build12: failed with no detail")
    (is (= "no such mode" (:mode-not-set (h/data (h/send! made csid* :effect/failed {:kind "set-mode" :detail "no such mode"}) csid*))))
    (is (some #{"worktree-note"} (h/kinds (h/send! made csid* :effect/done {:kind "set-mode"}) csid*)) "build19: its own worktree gets the note"))
  (let [in-root (h/send! (build {:prompt nil}) csid* :effect/done {:kind "make-worktree" :result {:in-root "it isn't a Git repository."}})]
    (is (not (some #{"worktree-note"} (h/kinds (h/send! in-root csid* :effect/done {:kind "set-mode"}) csid*))))))

(deftest watch-release-waits-while-archived
  (let [wsid "watch/o1/pr1"
        moved (fn [x states] (h/send! x wsid :link/moved {:from "project/o1/pr1" :chart "project" :states states :exported {:name "Site"}}))
        x (-> (h/start! (h/new-host) "watch" wsid {:org-id "o1" :project-id "pr1" :tick-ms 0 :roster-active true :last-run-at t0})
              (moved [:project :has-overseer :active])
              (h/send! wsid :limit/refused {:kind "gather" :ledger "day" :used 6 :max 6}))
        held #(count (:held (h/data % wsid)))]
    (is (= 1 (held x)))
    (is (= 0 (held (h/advance! x (* 24 hour)))) "midnight releases it")
    (is (= 1 (held (h/advance! (moved x [:archived :has-overseer]) (* 24 hour)))) "watch01: not while archived")))

(deftest watch-switch-pins
  (let [wsid "watch/o1/pr1"
        x (h/start! (h/new-host) "watch" wsid {:org-id "o1" :project-id "pr1" :tick-ms 0 :roster-active true :last-run-at t0})
        off (h/send! x wsid :settings/changed {:settings {:watch false}})]
    (is (h/in? off wsid :watch-off))
    (is (h/in? (h/send! off wsid :settings/changed {:settings {:watch true}}) wsid :watch-on) "watch09: turned on again")))

(deftest look-gap-pins
  (is (= (+ t0 (* 10 60000)) (w/due-at {:tick-ms 0 :last-run-at t0 :_event {:data {:at t0}}})) "GAP1 GAP2: ten minutes to the ms")
  (is (= (+ t0 (* 3 60000)) (w/due-at {:tick-ms 0 :last-run-at t0 :settings {:watch-gap-min 3} :_event {:data {:at t0}}}))))

;; ---- residence ---------------------------------------------------------------------------------------

(deftest residence-pins
  (let [rsid* "residence/o1"
        start #(h/start! (h/new-host) "residence" rsid* {:org-id "o1" :org-name "Acme" :host-id "h_me" :host-name "me" :mode % :commit-every-ms 3600000})
        x (start "create")
        committing (h/send! x rsid* :commit/now op)
        attach (start "attach")]
    (is (h/in? committing rsid* :committing))
    (is (h/in? (h/send! committing rsid* :effect/done {:kind "pause-overseers"}) rsid* :committing) "reside02: only a commit's result ends it")
    (is (h/in? (-> committing (h/send! rsid* :store/written {}) (h/send! rsid* :effect/done {:kind "push" :result {}})) rsid* :committing) "reside00")
    (is (h/in? (h/send! committing rsid* :effect/failed {:kind "push" :detail "x"}) rsid* :committing) "reside03")
    (is (h/in? (h/send! committing rsid* :effect/failed {:kind "commit" :detail "x"}) rsid* :dirty))
    (is (not (true? (:push-pending (h/data (h/send! x rsid* :effect/done {:kind "pause-overseers" :result {:push-failed true}}) rsid*)))) "reside01")
    (is (true? (:push-pending (h/data (h/send! x rsid* :effect/done {:kind "push" :result {:push-failed true}}) rsid*))))
    (is (h/in? attach rsid* :checking))
    (is (h/in? (h/send! attach rsid* :effect/done {:kind "commit"}) rsid* :checking) "reside05: only the holder read decides")
    (is (h/in? (h/send! attach rsid* :effect/failed {:kind "commit"}) rsid* :checking) "reside06")
    (is (h/in? (h/send! attach rsid* :effect/failed {:kind "read-holder"}) rsid* :held-here))))

;; ---- run4 (verifier-3, at 1915b16c) ------------------------------------------------------------------

(def osid "org/o1")
(defn org [] (h/start! (h/new-host) "org" osid {:id "o1" :name "Acme"}))
(defn owner [x pid & [ex]] (h/send! x osid :owner/set (merge op {:person-id pid :target {:status "active"}} ex)))

(deftest org-run4-pins
  (let [n80 (apply str (repeat 80 "a"))]
    (is (nil? (h/refusal (org) osid :org/rename (assoc op :name n80))) "org11: 80 characters is allowed")
    (is (= "name must be 1–80 characters" (h/refusal (org) osid :org/rename (assoc op :name (str n80 "a"))))))
  (let [x (owner (org) "p1")]
    (is (= "overseer" (:via (last (:owner-history (h/data (owner (org) "p1" {:via "overseer"}) osid))))) "org08: the overseer's hand")
    (is (not (contains? (last (:owner-history (h/data x osid))) :via)) "the operator's own: no via")
    (let [none (h/send! x osid :owner/set (assoc op :person-id nil))]
      (is (h/in? none osid :owner-none) "org05 org10: None from a set owner")
      (is (nil? (:owner (h/data none osid)))))
    (is (h/in? (h/send! x osid :link/moved {:from "person/o1/p2" :chart "person" :states [:person :left] :exported {:name "Bo"}}) osid :owner-set)
        "org01: someone else leaving clears nothing")
    (let [cleared (h/send! x osid :link/moved {:from "person/o1/p1" :chart "person" :states [:person :left] :exported {:name "Ana"}})
          y (owner (h/clear! cleared osid) "p2")]
      (is (h/in? cleared osid :owner-cleared))
      (is (some #(= {:op :watch :target "person/o1/p2"} %) (h/directives y osid)) "org04: a new owner from cleared is watched (the setting act, not the None one)")
      (is (= "p2" (:owner (h/data y osid)))))))

(deftest residence-run4-pins
  (is (= 3600000 (res/commit-every {})) "reside11: an hour by default")
  (is (= 5 (res/commit-every {:commit-every-ms 5})))
  (is (= "That organization is already attached here." (res/not-here :attach/confirm #{:held-here} {})) "reside07")
  (is (= "That can't be done now." (res/not-here :commit/now #{:held-here} {})))
  (let [rsid* "residence/o1"
        x (h/start! (h/new-host) "residence" rsid* {:org-id "o1" :org-name "Acme" :host-id "h_me" :host-name "me" :mode "create" :commit-every-ms 3600000})]
    (is (h/in? (-> x (h/send! rsid* :commit/now op) (h/send! rsid* :effect/done {:kind "commit" :result {}})) rsid* :clean)
        "reside09: a commit with nothing written meanwhile leaves it clean")))

(deftest rules-run4-pins
  (is (nil? (rb/extend-refusal {:budget {:messages-max 60}} {:more 940})) "rbaton03: to exactly 1000")
  (is (= "A conversation's limit is at most 1000 messages (it is 60 now)." (:sentence (rb/extend-refusal {:budget {:messages-max 60}} {:more 941}))))
  (is (nil? (rb/extend-refusal {:budget {:messages-max 60}} {:more 5 :invalid ""})) "rbaton04: a blank invalid is none")
  (is (not (:sentence (rp/clean-field :competence {"invoicing" {:level 3 :n 0}}))) "rperson04: n 0 is allowed")
  (is (= "competence.invoicing must be {level 1–5, n ≥ 0}" (:sentence (rp/clean-field :competence {"invoicing" {:level 3 :n -1}}))) "n −1 is not")
  (let [f {:states #{:tree-removed} :exported {:merged {:at 1}}}]
    (is (ri/build-landed? f))
    (is (not (ri/build-landed? (update f :states conj :new-since-merge))) "ritem06: new commits since the merge: not landed"))
  (let [b (fn [owner wrote at] {:states #{:open} :exported {:owner owner :wrote-at wrote :created-at at :handoffs [{:to "p1"}]}})]
    (is (= ["baton/o1/b1" "baton/o1/b2"] (ri/same-target-older {:batons {"baton/o1/b1" (b {:overseer-of "pr1"} nil 1) "baton/o1/b2" (b {:overseer-of "pr1"} nil 2)}})))
    (is (nil? (ri/same-target-older {:batons {"baton/o1/b1" (b "operator" nil 1) "baton/o1/b2" (b {:overseer-of "pr1"} nil 2)}})) "ritem00: the operator's own is never the chart's to close")
    (is (nil? (ri/same-target-older {:batons {"baton/o1/b1" (b {:overseer-of "pr1"} 5 1) "baton/o1/b2" (b {:overseer-of "pr1"} nil 2)}})) "…nor one somebody wrote in")))

;; ---- runF (verifier-3 FINAL, at 7824f35e) ---------------------------------------------------------------

(def dsid "decision/o1/pr1/s1:e1")

(deftest decision-runf-pins
  (let [x (h/start! (h/new-host) "decision" dsid {:org-id "o1" :project-id "pr1" :id "s1:e1" :area "Pay" :owner-area "none" :statement "S"})
        y (h/send! x dsid :reconcile/result {:state "bogus" :record-id "R9"})]
    (is (h/in? y dsid :pending))
    (is (nil? (:record-id (h/data y dsid))) "decisi07: a verdict naming no state it knows is not taken")
    (is (= "R9" (:record-id (h/data (h/send! x dsid :reconcile/result {:state "pending" :record-id "R9"}) dsid))) "its own state's verdict is")))

(deftest conflict-runf-pins
  (let [x (h/clear! (conflict {}) csid)
        to-rec #(filter (fn [s] (= :settle/results (:event s))) (h/elsewhere %))]
    (is (empty? (to-rec (h/send! x csid :effect/done {:kind "spawn" :result {:decisions [{:id "d9"}]}}))) "confli01 confli03: another effect's result is not the settle's")
    (is (= [{:decisions [{:id "d9"}]}] (map :data (to-rec (h/send! x csid :effect/done {:kind "settle" :result {:decisions [{:id "d9"}]}}))))))
  (is (h/in? (conflict {:route-error "no such person"}) csid :unrouted) "confli10: a route error with a target is unrouted")
  (is (h/in? (conflict {:routed-to nil}) csid :unrouted))
  (is (h/in? (conflict {}) csid :routed-to-person)))

(deftest reconciler-runf-pins
  (let [x (h/send! (rec) rsid :reconcile/request (assoc op :delay-ms 500))]
    (is (h/in? x rsid :debouncing))
    (is (h/in? (h/send! x rsid :reconcile/request (assoc op :delay-ms 500)) rsid :debouncing) "reconc03: another delayed one waits for the same timer")
    (is (h/in? (h/send! x rsid :reconcile/request op) rsid :running) "reconc10: one with no delay runs now")))

(deftest item-runf-pins
  (let [x (-> (h/start! (h/new-host) "item" isid {:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/invoicing"})
              (h/send! isid :link/moved {:from "watch/o1/pr1" :chart "watch" :states [:watch]
                                         :exported {:settings {:autonomy "L1"} :paused false :roster-active true :archived false}})
              (h/send! isid :gather/start (assoc op :session-id "b1" :to "p1" :targets ["p1"] :public-title "Pay" :goal "Learn")))]
    (is (h/in? x isid :gather-starting))
    (is (h/in? (item-baton x 1 [:open :with-person] [{:to "p1"}]) isid :asking) "item00 item04: its gathering open is asking, nothing waits on the operator")
    (is (h/in? (item-baton x 2 [:open :with-operator] [{:to "operator"}]) isid :gather-starting) "another gathering's news: still starting its own")
    (let [back (-> x (h/send! isid :item/hold op) (item-baton 1 [:open :with-person] [{:to "p1"}])
                   (h/send! isid :correct/relink (assoc op :session "baton/o1/b1" :to-item "item/o1/pr1/g_2"))
                   (h/send! isid :item/resume op))]
      (is (h/in? back isid :gather-starting) "item00 item04: resumed with its gathering moved to another gap, nothing waits on the operator")
      (is (= "gather-starting" (:phase (h/data back isid))))))
  (is (ri/build-landed? {:states #{:tree-root} :exported {}}) "ritem07: in the root and not working: landed")
  (is (not (ri/build-landed? {:states #{:tree-root :working} :exported {}})))
  (let [d {:idea-id "§gap/x" :decisions {"d1" {:exported {:statement "Pay monthly"}} "d2" {:exported {:record-id "R2" :statement "Pay in euros"}}}}]
    (is (= (str "Build what these promoted decisions of §gap/x say (the project's spec holds their records):\n- d1: Pay monthly\n- R2: Pay in euros"
                "\n\nRecord in the spec what you built (code and evidence) for each.")
           (ri/build-prompt d ["d1" "d2"]))
        "ritem08: by record, else by id")))

(deftest build-runf-pins
  (let [x (build {:prompt nil})]
    (is (h/in? (h/send! x csid* :effect/failed {:kind "prompt" :detail "busy"}) csid* :making-worktree) "build01: another effect's failure is not the worktree's")
    (let [made (h/send! x csid* :effect/done made-tree)]
      (is (h/in? (h/send! made csid* :effect/done made-tree) csid* :setting-mode) "build02: a late worktree answer is not the mode's")
      (is (h/in? (h/send! made csid* :effect/done {:kind "set-mode"}) csid* :ready))))
  (let [x (ready (build))
        ledger #(:ledger (:data (last (filter (fn [s] (= :ledger/take (:event s))) (h/elsewhere (h/send! (h/clear! x csid*) csid* :build/prompt (merge op {:text "go"} %)))))))]
    (is (= "message" (ledger {:attended true})) "base08: an attended act takes from the message allowance")
    (is (= "day" (ledger {:attended false})))
    (is (= "day" (ledger {})))
    (is (= "turn" (ledger {:attended true :ledger :turn})) "the host's own ledger wins")))

(deftest day-key-runf-pins
  (let [local (fn [y m dd] #?(:clj (.toEpochMilli (.toInstant (.atStartOfDay (java.time.LocalDate/of y m dd) (java.time.ZoneId/systemDefault))))
                              :cljs (.getTime (js/Date. y (dec m) dd))))]
    (is (= "2026-01-05" (b/day-key (+ (local 2026 1 5) 3600000))) "base02: January is 01")
    (is (= "2026-10-10" (b/day-key (+ (local 2026 10 10) 3600000))) "base03: 10 has no leading zero")
    (is (= "2026-12-09" (b/day-key (+ (local 2026 12 9) 3600000))))))

;; ---- runF, the rest (verifier-3 FINAL complete) ------------------------------------------------------------

(defn running? [x sid] (:com.fulcrologic.statecharts/running? (h/wmem x sid)))

(deftest baton-runf-pins
  (is (nil? (rb/abilities-refusal {} {:invalid ""})) "rbaton04 (abilities-refusal): a blank invalid is none")
  (is (= "bad abilities" (:sentence (rb/abilities-refusal {} {:invalid "bad abilities"}))))
  (is (false? (bt/asks? false {})) "r14m03: only a true rule asks")
  (is (false? (bt/asks? nil {})))
  (is (true? (bt/asks? true {})))
  (let [x (baton {:to "p1"})]
    (is (h/in? x bsid :with-person))
    (is (= "Bob X" (get-in (h/data (h/send! x bsid :link/moved {:from "person/o1/p2" :chart "person" :states [:person :left] :exported {:name "Bob X"}}) bsid) [:names "p2"]))
        "baton00: someone it doesn't wait on leaving is only news of their name")
    (is (h/in? (h/send! x bsid :person/left {:person-id "p2"}) bsid :with-person) "baton04: a leaver who neither holds it nor is invited moves nothing")
    (is (h/in? (h/send! x bsid :person/left {:person-id "p1"}) bsid :with-operator) "the holder leaving hands it to the operator"))
  (let [y (-> (baton {:to "p1"}) (msg "p1") (h/send! bsid :reply/ended {}) (h/send! bsid :baton/goal-done {:by "model" :summary "All set"}))]
    (is (h/in? y bsid :wrapup-running))
    (is (running? (h/send! y bsid :session/retire {}) bsid) "r11m11: done, its wrap-up still running: not retired")
    (is (not (running? (-> y (h/send! bsid :wrapup/finished {}) (h/send! bsid :session/retire {})) bsid)) "its wrap-up ended: retired")))

(deftest build-retire-runf-pins
  (let [w (-> (ready (build)) (h/send! csid* :turn/started {}) (h/send! csid* :git/probe {:branch "merged"}))]
    (is (h/in? w csid* :merged))
    (is (running? (h/send! w csid* :session/retire {}) csid*) "r11m13: merged mid-turn: not retired")
    (is (not (running? (-> w (h/send! csid* :turn/ended {}) (h/send! csid* :session/retire {})) csid*)) "its turn over: retired"))
  (let [made (h/send! (build {:prompt nil}) csid* :effect/done made-tree)]
    (is (h/in? (h/send! made csid* :effect/failed {:kind "prompt" :detail "busy"}) csid* :setting-mode) "build03b: another effect's failure is not the mode's")
    (is (h/in? (h/send! made csid* :effect/failed {:kind "set-mode"}) csid* :ready))))

(deftest started-runf-pins
  (is (not (st/settled? "baton" [:baton :open :with-person :wrapup-done])) "r11m02: an open one is live whatever its wrap-up says")
  (is (not (st/settled? "baton" [:baton :asking])) "r11m05: only retired settles whatever the chart")
  (is (not (st/settled? "item" [:item :asking])))
  (is (= [{:sid "a" :settled true}] (st/note [{:sid "a" :settled true}] {:sid "a" :kind "gathering"})) "r11m10: noted twice is one row, as it was")
  (is (= [{:sid "a" :settled true} {:sid "b" :kind "gathering" :settled false}] (st/note [{:sid "a" :settled true}] {:sid "b" :kind "gathering"}))))

(deftest send-link-refusal-pins
  (let [p   {:id "p1" :name "Ann" :status "active"}
        row {:holder "p1" :handoffs [{:n 1 :to "p1"}]}]
    (is (nil? (rb/send-link-refusal row {:target p})) "the holder of the current hand-off")
    (is (= "Ann is not active, so they get no link." (:sentence (rb/send-link-refusal row {:target (assoc p :status "left")}))))
    (is (= "Ann does not hold the baton, so there is no link to send." (:sentence (rb/send-link-refusal (assoc row :holder "operator") {:target p}))))
    (is (= "person must be a roster person's id" (:sentence (rb/send-link-refusal row {:target nil}))))
    (let [offer {:offer-id "o1" :holder nil :offers [{:id "o1" :n 2 :state "open" :to ["p1" "p2"] :reach {"p1" {:state "waiting"}}}]}]
      (is (= "Ann is not reached yet: their link is made when their working hours start." (:sentence (rb/send-link-refusal offer {:target p}))))
      (is (nil? (rb/send-link-refusal offer {:target (assoc p :id "p2")})) "an invitee with no reach entry was reached at once")
      (is (= "Ann is not invited to the open offer." (:sentence (rb/send-link-refusal offer {:target (assoc p :id "p3")})))))))
