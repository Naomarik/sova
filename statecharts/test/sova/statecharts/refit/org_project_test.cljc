(ns sova.statecharts.refit.org-project-test
  "The org, residence, project and placement statecharts: owner and its clearing, placements, the holder
   check and the commit loop, archive, overseer conversations, gap-less builds; the placement's
   stakeholder, owner updates and item-less gatherings."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.base :as b]
    [sova.statecharts.refit.host :as h]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.residence :as res]))

(def op {:by "operator"})
(def osid "org/o1")
(defn org [] (h/start! (h/new-host) "org" osid {:id "o1" :name "Acme" :slug "acme"}))
(defn left [x sid pid name] (h/send! x sid :link/moved {:from (str "person/o1/" pid) :statechart "person" :states [:person :left] :exported {:name name}}))

(deftest owner
  (let [x (org)]
    (is (= "Only an active person on the roster can be the owner." (h/refusal x osid :owner/set (assoc op :person-id "p1" :target {:status "proposed"}))))
    (let [y (h/send! x osid :owner/set (assoc op :person-id "p1" :target {:status "active"}))]
      (is (h/in? y osid :owner-set))
      (is (= "p1" (:owner (h/data y osid))))
      (is (some #{"revoke-owner-links"} (h/kinds y osid)))
      (is (some #(= {:op :watch :target "person/o1/p1"} %) (h/directives y osid)))
      (let [c (left y osid "p1" "Ana")]
        (is (h/in? c osid :owner-cleared))
        (is (= "Ana" (get-in (h/data c osid) [:owner-cleared :name])))
        (is (= "left" (:why (last (:owner-history (h/data c osid))))))
        (is (h/in? (h/send! c osid :owner/set (assoc op :person-id nil)) osid :owner-none))))
    (is (= "name must be 1–80 characters" (h/refusal x osid :org/rename (assoc op :name " "))))
    (let [y  (h/send! x osid :project/place (assoc op :project-id "pr1" :placed-via "born"))
          sp (last (h/directives y osid))]
      (is (= "placement/o1/pr1" (:id sp)))
      (is (= {:org-id "o1" :project-id "pr1" :via "born" :placed-at (h/now y)} (:data sp)))
      (is (= :skip (:if-exists sp)) "placing a placed project again is a no-op (the org-open invariant)"))
    (is (= "pr1 is not a project here." (h/refusal x osid :project/place (assoc op :project-id "pr1" :invalid "pr1 is not a project here."))))
    (is (= "Bob is already on the roster." (h/refusal x osid :person/add (assoc op :person {:name "Bob"} :names-taken #{"bob"}))))))

(deftest residence
  (let [sid "residence/o1"
        attach (fn [] (h/start! (h/new-host) "residence" sid {:org-id "o1" :org-name "Acme" :host-id "h_me" :host-name "me" :mode "attach" :commit-every-ms 3600000}))
        x (attach)]
    (is (h/in? x sid :checking))
    (let [held (h/send! x sid :effect/done {:kind "read-holder" :result {:local {:host-id "h_other" :host-name "box" :since 0}}})]
      (is (h/in? held sid :held-elsewhere))
      (is (re-find #"^box holds this organization" (res/held-sentence (:held-by (h/data held sid)))))
      (is (h/in? (h/send! held sid :attach/confirm op) sid :held-here)))
    (let [here (h/send! x sid :effect/done {:kind "read-holder" :result {:local {:host-id "h_other" :released-at 5}}})]
      (is (h/in? here sid :held-here))
      (is (some #{"pause-overseers"} (h/kinds here sid)) "an attach pauses its projects")
      (testing "an hourly commit"
        (let [d (-> here (h/send! sid :effect/done {:kind "commit" :result {:head-at (h/now here)}}) (h/send! sid :store/written {}))]
          (is (h/in? d sid :dirty))
          (is (h/in? (h/advance! d 60000) sid :dirty) "not an hour since HEAD")
          (is (h/in? (h/advance! d 3600000) sid :committing))))
      (is (h/in? (h/send! here sid :org/detach op) sid :detached)))
    (is (not (some #{"pause-overseers"} (h/kinds (h/start! (h/new-host) "residence" sid {:org-id "o1" :host-id "h_me" :mode "create"}) sid))) "a create pauses nothing")))

(def psid "project/pr1")
(defn project [] (h/start! (h/new-host) "project" psid {:id "pr1" :name "Site" :root "/r"}))

(def plsid "placement/o1/pr1")
(defn project-moved [x states exported]
  (h/send! x plsid :link/moved {:from psid :statechart "project" :states (into [:project] states) :exported (merge {:name "Site"} exported)}))
(defn placement []
  (-> (h/start! (h/new-host) "placement" plsid {:org-id "o1" :project-id "pr1" :via "born" :placed-at 1700000000000})
      (project-moved [:active :no-overseer] {})))

(deftest archive-and-starts
  (let [x (project)]
    (is (= "Stop these first: 2 gathering sessions open (A, B); 1 coding session running (Pay); its overseer is working."
           (h/refusal x psid :project/archive (assoc op :blockers {:phrases ["2 gathering sessions open (A, B)"] :coding ["Pay"] :overseer-working true})))
        "what others contribute (an organization's open gatherings) comes first")
    (is (= "Stop these first: its overseer is working." (h/refusal x psid :project/archive (assoc op :blockers {:overseer-working true}))))
    (let [a (h/send! x psid :project/archive op)]
      (is (h/in? a psid :archived))
      (is (= "Site is archived. Unarchive it first." (h/refusal a psid :build/start (assoc op :session-id "c1"))))
      (is (= "Site is archived. Unarchive it first." (h/refusal (project-moved (placement) [:archived :no-overseer] {}) plsid :baton/start (assoc op :session-id "s1")))
          "the placement starts nothing for an archived project (its exported facts)")
      (is (h/in? (h/send! a psid :project/unarchive op) psid :active)))
    (testing "q7: the overseer's build only in a turn the operator started, at every level"
      (is (= "A coding session starts only in a turn the operator started: ask with sova_card."
             (h/refusal x psid :build/start {:by "overseer" :autonomy "L3" :session-id "c1"})))
      (is (re-find #"sova_create_session needs L3" (h/refusal x psid :build/start {:by "overseer" :autonomy "L1" :session-id "c1"})))
      (is (nil? (h/refusal x psid :build/start {:by "overseer" :attended true :session-id "c1"}))))
    (let [y  (h/send! x psid :build/start (assoc op :session-id "c1"))
          sp (last (h/directives y psid))]
      (is (= "build/pr1/c1" (:id sp)))
      (is (= "operator-coding" (get-in sp [:data :kind])))
      (is (not (contains? (:data sp) :org-id)) "a build carries no organization"))))

(deftest stakeholder
  (let [x (h/send! (placement) plsid :stakeholder/set (assoc op :person-id "p1" :target {:status "active"}))]
    (is (h/in? x plsid :stakeholder-set))
    (is (some #(= {:op :watch :target "person/o1/p1"} %) (h/directives x plsid)))
    (is (= "Only an active person on the roster can be a project's main stakeholder." (h/refusal x plsid :stakeholder/set (assoc op :person-id "p2" :target {:status "left"}))))
    (let [c (left x plsid "p1" "Ana")]
      (is (h/in? c plsid :stakeholder-cleared))
      (is (= {:person-id "p1" :name "Ana" :at (h/now c)} (:stakeholder-cleared (h/data c plsid))))
      (is (h/in? (h/send! c plsid :stakeholder/set (assoc op :person-id nil)) plsid :no-stakeholder)))))

(deftest placement-is-born-watching-its-project
  (let [x  (h/start! (h/new-host) "placement" plsid {:org-id "o1" :project-id "pr1" :via "import" :placed-at 5})
        ds (h/directives x plsid)]
    (is (some #(= {:op :watch :target "project/pr1"} %) ds))
    (is (some #(and (= :spawn (:op %)) (= "reconciler/o1/pr1" (:id %)) (= :skip (:if-exists %))) ds) "its reconciler, once")
    (let [y (project-moved x [:active :has-overseer] {:name "Shop"})]
      (is (= "Shop" (:project-name (h/data y plsid))))
      (is (false? (:archived (h/data y plsid))))
      (is (h/in? y plsid :no-milestone)))))

(deftest overseer-clear
  (let [x (-> (project) (h/send! psid :overseer/start (assoc op :conversation-id "c0")))]
    (is (h/in? x psid :has-overseer))
    (let [y (reduce (fn [y i] (h/send! y psid :overseer/clear (assoc op :conversation-id (str "c" i)))) x (range 1 25))]
      (is (= 20 (count (get-in (h/data y psid) [:overseer :history]))))
      (is (some #(= :ledger/reset-message (:event %)) (h/elsewhere y))))))

(deftest owner-updates
  (let [x (placement)
        po {:by "overseer" :autonomy "L1" :owner-active true :text "We shipped the invoice page."}]
    (is (= "This organization has no owner, so there is no page to post to." (h/refusal x plsid :owner-update/post (dissoc po :owner-active))))
    (is (= "Nothing new since the last update: post one when a conversation finishes, a decision is agreed, or a coding session finishes or is merged."
           (h/refusal x plsid :owner-update/post po)))
    (is (nil? (h/refusal x plsid :owner-update/post (assoc po :attended true))) "the operator's own request posts any time")
    (let [m (h/send! x plsid :milestone/noted {:kind "baton-done"})
          y (h/send! m plsid :owner-update/post po)]
      (is (h/in? m plsid :since-post))
      (is (h/in? y plsid :cooling))
      (is (h/in? y plsid :no-milestone))
      (is (= "An update was posted less than an hour ago: at most one a day." (h/refusal (h/send! y plsid :milestone/noted {}) plsid :owner-update/post po)))
      (is (h/in? (h/advance! y (* 24 3600000)) plsid :ready)))
    (is (= "The text leaks." (h/refusal x plsid :owner-update/post (assoc po :attended true :leak "The text leaks."))))
    (is (nil? (h/refusal x plsid :owner-update/post (assoc po :build-finished-at (h/now x)))) "a build that finished a turn since is a milestone")
    (testing "a build merged since the last post is a milestone (the project's exported last-merged-at)"
      (let [y (h/send! (h/send! x plsid :milestone/noted {}) plsid :owner-update/post po)
            later (+ (h/now y) 1000)
            m (project-moved (h/advance! y 2000) [:active] {:last-merged-at later})]
        (is (h/in? y plsid :no-milestone))
        (is (h/in? m plsid :since-post))
        (is (h/in? (project-moved y [:active] {:last-merged-at (- (h/now y) 1)}) plsid :no-milestone) "a merge before the post is not")))))

(deftest preview-links
  (let [x (project)
        po {:by "overseer" :autonomy "L1" :coding-session "c1" :port 5173 :purpose "  The shop for Ana  " :overseer-id "po1"}]
    (is (= "Say what it shows and to whom (purpose): one line." (h/refusal x psid :preview/start (assoc po :purpose " "))))
    (is (= "The purpose is one line of at most 200 characters." (h/refusal x psid :preview/start (assoc po :purpose (apply str (repeat 201 "a"))))))
    (is (= "The purpose is one line of at most 200 characters." (h/refusal x psid :preview/start (assoc po :purpose "a\nb"))))
    (is (= "Nothing listens on port 5173." (h/refusal x psid :preview/start (assoc po :invalid "Nothing listens on port 5173."))) "the host's own check")
    (let [y (h/send! x psid :preview/start po)
          fx (first (filter #(= "preview" (:kind %)) (h/outbox y psid)))]
      (is (some? fx))
      (is (= "The shop for Ana" (:purpose fx)))
      (is (= "c1" (:coding-session fx)))
      (is (= 5173 (:port fx)))
      (is (not-any? #(contains? fx %) [:url :label :link]) "an effect carries no link: its result and payload are logged"))))

(deftest project-verbs
  ;; sova_project_verbs (§app.project-services/callers): stopping is L0, the other verbs L3; the level
  ;; binds only runs the operator did not start; an archived project stops but starts nothing.
  (let [x (project)
        po (fn [level] {:by "overseer" :autonomy level :verb "up"})]
    (is (nil? (h/refusal x psid :services/down (assoc (po "L0") :verb "down"))) "down from L0")
    (is (= "This run was not started by the operator, and your autonomy here is L0; sova_project_verbs needs L3. Do not retry it. File what you would do as an idea (sova_idea) or raise a sova_card card that says what and why; the operator's click starts a turn in which you may act."
           (h/refusal x psid :services/run (po "L0"))))
    (is (re-find #"sova_project_verbs needs L3" (h/refusal x psid :services/run (po "L2"))))
    (is (nil? (h/refusal x psid :services/run (po "L3"))) "up at L3")
    (is (nil? (h/refusal x psid :services/run (assoc (po "L0") :attended true))) "the operator's own run, at any level")
    (is (re-find #"sova_project_verbs needs L3" (h/refusal x psid :services/run (assoc (po "L3") :paused true))) "paused is L0")
    (is (= "Nothing runs on port 4910." (h/refusal x psid :services/run (assoc (po "L3") :invalid "Nothing runs on port 4910."))) "the host's own check")
    (let [a (h/send! x psid :project/archive op)]
      (is (= "Site is archived. Unarchive it first." (h/refusal a psid :services/run (po "L3"))))
      (is (nil? (h/refusal a psid :services/down (assoc (po "L0") :verb "down"))) "stopping is never refused for an archived project"))
    (let [y (h/send! x psid :services/run (po "L3"))]
      (is (empty? (h/outbox y psid)) "the act is the gate only: the host runs the verb"))))

(deftest sharing-a-running-copy
  ;; sova_project_verbs share (§app.project-overseer/previews): L1, people-facing, refused while archived; the
  ;; effect shares the copy's endpoint, never a link.
  (let [x (project)
        po (fn [level] {:by "overseer" :autonomy level :verb "share" :instance "in_1" :endpoint "web.3000" :days 2 :overseer-id "po1"})]
    (is (re-find #"sova_project_verbs needs L1" (h/refusal x psid :services/share (po "L0"))))
    (is (nil? (h/refusal x psid :services/share (assoc (po "L0") :attended true))) "the operator's own run, at any level")
    (is (nil? (h/refusal x psid :services/share (po "L1"))) "share at L1")
    (is (= "web.9 is not declared for sharing." (h/refusal x psid :services/share (assoc (po "L1") :invalid "web.9 is not declared for sharing."))) "the host's own check")
    (let [a (h/send! x psid :project/archive op)]
      (is (= "Site is archived. Unarchive it first." (h/refusal a psid :services/share (po "L3")))))
    (let [y (h/send! x psid :services/share (po "L1"))
          fx (first (filter #(= "services-share" (:kind %)) (h/outbox y psid)))]
      (is (= {:instance "in_1" :endpoint "web.3000" :days 2 :overseer-id "po1"} (select-keys fx [:instance :endpoint :days :overseer-id :url :link])))
      (is (not-any? #(contains? fx %) [:url :label :link :hash]) "an effect carries no link: its result and payload are logged"))))

(deftest hourly-committer
  (let [sid "residence/o1"
        x (-> (h/start! (h/new-host) "residence" sid {:org-id "o1" :host-id "h_me" :host-name "me" :mode "create" :commit-every-ms 3600000})
              (h/send! sid :effect/done {:kind "commit" :result {:head-at 1700000000000}}))]
    (is (h/in? x sid :clean))
    (testing "F5b: a clean look once an hour passed commits whatever git says changed"
      (is (h/in? (h/advance! x 3600000) sid :committing))
      (is (h/in? (h/advance! x 60000) sid :clean)))
    (testing "F5a: a write during a commit is in the next one"
      (let [c (-> x (h/send! sid :commit/now op) (h/send! sid :store/written {}) (h/send! sid :effect/done {:kind "commit" :result {:head-at (h/now x)}}))]
        (is (h/in? c sid :dirty))))
    (testing "a failed push is kept in the snapshot's data"
      (is (true? (:push-pending (h/data (-> x (h/send! sid :commit/now op) (h/send! sid :effect/done {:kind "commit" :result {:push-failed true}})) sid)))))
    (is (re-find #"holds this organization" (:held-sentence (h/data (h/send! (h/start! (h/new-host) "residence" sid {:org-id "o1" :host-id "h_me" :mode "attach"}) sid :effect/done {:kind "read-holder" :result {:local {:host-id "h_x" :host-name "box"}}}) sid))))))

(deftest build-prompt-carries-the-commit-paragraph
  (let [bsid "build/pr1/c1"
        x (-> (h/start! (h/new-host) "build" bsid {:project-id "pr1" :session-id "c1" :kind "coding" :title "T" :prompt "Build it"})
              (h/send! bsid :effect/done {:kind "make-worktree" :result {:branch "sova/t-abc123" :target "main"}})
              (h/send! bsid :effect/done {:kind "set-mode"}))]
    (is (= "Build it\n\nYou work in your own git worktree on the branch sova/t-abc123. Commit your work on this branch before you end your turn: uncommitted changes can't be merged. Before you end your turn, also merge main into your branch and resolve any conflicts."
           (:prompt (last (h/outbox x bsid)))))))

(deftest stakeholder-same-person-adds-no-line
  (let [x (h/send! (placement) plsid :stakeholder/set (assoc op :person-id "p1" :target {:status "active"}))
        y (h/send! x plsid :stakeholder/set (assoc op :person-id "p1" :target {:status "active"}))]
    (is (= 1 (count (:stakeholder-history (h/data y plsid)))))))

(deftest F-185-the-global-overseers-gathering-start-needs-its-card
  (let [x   (placement)
        go  {:by "operator" :via "overseer" :session-id "s1" :public-title "T" :goal "G" :question "Q"}
        one (assoc go :to "p1")
        two (assoc go :targets ["p1" "p2"])]
    (is (= "This reaches people or ends something: ask with sova_card, listing the project pr1, p1 in its items, and act in the turn the user's click starts."
           (h/refusal x plsid :baton/start one)))
    (is (some? (h/refusal x plsid :baton/start (assoc one :card {:projects ["pr1"]}))) "every person must be on it")
    (is (nil? (h/refusal x plsid :baton/start (assoc one :card {:projects ["pr1"] :people ["p1"]}))))
    (is (some? (h/refusal x plsid :baton/start (assoc two :card {:projects ["pr1"] :people ["p1"]}))))
    (is (nil? (h/refusal x plsid :baton/start (assoc two :card {:projects ["pr1"] :people ["p1" "p2"]}))))
    (is (nil? (h/refusal x plsid :baton/start (assoc go :to "operator" :card {:projects ["pr1"]}))) "the operator is never a card item")
    (is (nil? (h/refusal x plsid :baton/start (assoc one :by "operator" :via nil))) "the operator's own page asks nothing")))

(deftest person-add-records-its-writer
  (let [spawned (fn [y] (:by (:data (last (h/directives y osid)))))]
    (is (= {:kind "operator"} (spawned (h/send! (org) osid :person/add (assoc op :person-id "p1" :person {:name "Ana"})))))
    (is (= {:kind "referral" :session-id "s1" :entry-id "e1" :quote "Ask Carla"}
           (spawned (h/send! (org) osid :person/add
                      (assoc op :person-id "p2" :by-kind "referral" :session-id "s1" :entry-id "e1" :quote "Ask Carla"
                                :person {:name "Carla" :status "proposed" :role "Accountant" :contact {:email "cy@example.test"}
                                         :referral {:why "Knows invoicing" :referred-by "p1" :session-id "s1" :quote "Ask Carla"}}))))
        "a referral's creation lines say referral (decidesTrusted relies on it)")))

(deftest commit-now-re-enters-nothing
  (let [sid  "residence/o1"
        here (-> (h/start! (h/new-host) "residence" sid {:org-id "o1" :org-name "Acme" :host-id "h_me" :host-name "me" :mode "attach" :commit-every-ms 3600000})
                 (h/send! sid :effect/done {:kind "read-holder" :result {:local {:host-id "h_other" :released-at 5}}}))
        n    (fn [x k] (count (filter #{k} (h/kinds x sid))))
        y    (h/send! here sid :commit/now op)]
    (is (h/in? y sid :held-here))
    (is (h/in? y sid :committing))
    (is (= (n here "read-holder") (n y "read-holder")) "the tenure region is not re-entered: no second read-holder")
    (is (= (n here "pause-overseers") (n y "pause-overseers")))))

(deftest starts-from-a-real-project-session-take-the-projects-own-ledger
  ;; server-2's replay: project data named its project only :id, so b/ledger sent to "watch/o1/"
  (let [ledger (fn [y] (filter #(= :ledger/take (:event %)) (h/elsewhere y)))]
    (is (= "pr1" (:project-id (h/data (project) psid))))
    (let [y (h/send! (placement) plsid :baton/start (assoc op :session-id "s1" :to "p1" :public-title "T" :goal "G" :question "Q"))]
      (is (= [["watch/pr1" "gather"]] (map (juxt :target (comp :kind :data)) (ledger y)))))
    (let [y (h/send! (project) psid :build/start (assoc op :session-id "c1"))]
      (is (= [["watch/pr1" "create"]] (map (juxt :target (comp :kind :data)) (ledger y)))))))

(deftest a-session-id-with-a-blank-part-throws
  (is (thrown? #?(:clj Exception :cljs js/Error) (b/watch-sid nil)))
  (is (thrown? #?(:clj Exception :cljs js/Error) (b/placement-sid "o1" "")))
  (is (= "watch/pr1" (b/watch-sid "pr1")))
  (is (= "build/pr1/c1" (b/build-sid "pr1" "c1")))
  (is (= "placement/o1/pr1" (b/placement-sid "o1" "pr1"))))

(deftest a-started-baton-gets-the-hosts-start-keys
  (let [y (h/send! (placement) plsid :baton/start (assoc op :session-id "s1" :targets ["p1" "p2"] :public-title "T" :goal "G" :question "Q"
                                                   :lease-ms 1000 :operator-name "Omar" :offer-id "off_x"))
        sp (first (filter #(= "baton" (:statechart %)) (h/directives y plsid)))]
    (is (= {:lease-ms 1000 :operator-name "Omar" :offer-id "off_x"}
           (select-keys (:data sp) [:lease-ms :operator-name :offer-id])))
    (is (= {:org-id "o1" :project-id "pr1"} (select-keys (:data sp) [:org-id :project-id])))
    (is (= ["baton/o1/s1"] (map :sid (:started (h/data y plsid)))) "the placement lists its gatherings")))

(deftest a-prompt-to-a-root-coding-session
  ;; coordinator-25 / r10: sova_send reaches any coding session under the root, not only builds
  (let [x   (project)
        att {:by "overseer" :attended true :autonomy "L3"}
        y   (h/send! x psid :session/prompt (assoc att :session-id "c9" :title "Pay page" :text "Run the tests" :mode "normal"))]
    (is (= {:kind "prompt" :session "c9" :text "Run the tests" :mode "normal"}
           (select-keys (last (filter #(= "prompt" (name (:kind %))) (h/outbox y psid))) [:kind :session :text :mode])))
    (is (= [["watch/pr1" "prompt"]] (map (juxt :target (comp :kind :data)) (filter #(= :ledger/take (:event %)) (h/elsewhere y)))))
    (is (= "text must not be blank." (h/refusal x psid :session/prompt (assoc att :session-id "c9" :title "Pay page" :text " "))))
    (is (= "\"Pay page\" is open in a terminal, so it is read-only." (h/refusal x psid :session/prompt (assoc att :session-id "c9" :title "Pay page" :text "t" :live true))))
    (is (= "Unknown mode" (h/refusal x psid :session/prompt (assoc att :session-id "c9" :text "t" :invalid "Unknown mode"))) "the host's mode refusal")
    (is (re-find #"sova_send needs L3" (h/refusal x psid :session/prompt {:by "overseer" :autonomy "L2" :session-id "c9" :text "t"})))
    (is (re-find #"^Today's allowance is used: 12 of 12" (h/refusal x psid :session/prompt (assoc att :attended false :session-id "c9" :text "t" :ledger "day" :allowance {:prompt {:used 12 :max 12}}))))))

(deftest server-3-p3-2-a-freeze-keeps-the-specs-hash
  (let [y (h/send! (placement) plsid :spec/freeze (assoc op :frozen true :spec-hash "sha-abc"))]
    (is (= {:frozen true :spec-hash "sha-abc" :at (h/now y)} (:spec (h/data y plsid))))
    (is (= {:frozen false :at (h/now y)} (:spec (h/data (h/send! y plsid :spec/freeze (assoc op :frozen false)) plsid))))))

(deftest owner-hidden-and-gaps-are-the-placements
  (let [y (h/send! (placement) plsid :placement/edit (assoc op :owner-hidden true))]
    (is (true? (:owner-hidden (h/data y plsid))))
    (is (false? (:owner-hidden (h/data (h/send! y plsid :placement/edit (assoc op :owner-hidden false)) plsid)))))
  (let [y  (h/send! (placement) plsid :gap/file {:by "overseer" :attended true :autonomy "L3" :gap-id "g_1" :idea-id "§gap/x"})
        sp (first (filter #(= "item" (:statechart %)) (h/directives y plsid)))]
    (is (= "item/o1/pr1/g_1" (:id sp)))
    (is (= {:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/x"} (:data sp))))
  (testing "none of it is the project's any more"
    (doseq [ev [:stakeholder/set :owner-update/post :outreach/send :baton/start :gap/file :spec/freeze :placement/edit]]
      (is (not (contains? (:acts (get registry/statecharts "project")) ev)) (str ev)))))

(deftest baton-start-keeps-who-started-it
  (let [started {:by "project-overseer" :overseer-id "c9" :why "The invoicing rules are missing."}
        y (h/send! (placement) plsid :baton/start (assoc op :session-id "s1" :to "p1" :public-title "T" :goal "G" :question "Q"
                                                  :started started :started-via "overseer"))
        spawn (first (filter #(= "baton" (:statechart %)) (h/directives y plsid)))]
    (is (= started (get-in spawn [:data :started])))
    (is (= "overseer" (get-in spawn [:data :started-via])))))
