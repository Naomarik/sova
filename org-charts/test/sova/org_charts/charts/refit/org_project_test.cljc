(ns sova.org-charts.charts.refit.org-project-test
  "The org, residence and project charts: owner and its clearing, births, the holder check and the
   commit loop, archive, stakeholder, overseer conversations, owner updates and item-less starts."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.org-charts.charts.refit.host :as h]
    [sova.org-charts.charts.residence :as res]))

(def op {:by "operator"})
(def osid "org/o1")
(defn org [] (h/start! (h/new-host) "org" osid {:id "o1" :name "Acme" :slug "acme"}))
(defn left [x sid pid name] (h/send! x sid :link/moved {:from (str "person/o1/" pid) :chart "person" :states [:person :left] :exported {:name name}}))

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
    (let [y (h/send! x osid :project/add (assoc op :project-id "pr1" :name "Site" :root "/r"))]
      (is (= "project/o1/pr1" (:id (last (h/directives y osid))))))
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

(def psid "project/o1/pr1")
(defn project [] (h/start! (h/new-host) "project" psid {:org-id "o1" :id "pr1" :name "Site" :root "/r"}))

(deftest archive-and-starts
  (let [x (project)]
    (is (= "Stop these first: 2 gathering sessions open (A, B); its overseer is working."
           (h/refusal x psid :project/archive (assoc op :blockers {:gatherings ["A" "B"] :overseer-working true}))))
    (let [a (h/send! x psid :project/archive op)]
      (is (h/in? a psid :archived))
      (is (= "Site is archived. Unarchive it first." (h/refusal a psid :baton/start (assoc op :session-id "s1"))))
      (is (h/in? (h/send! a psid :project/unarchive op) psid :active)))
    (testing "q7: an unlinked overseer build only in a turn the operator started"
      (is (re-find #"^Without a gap" (h/refusal x psid :build/start {:by "overseer" :autonomy "L3" :roster-active true :session-id "c1"})))
      (is (nil? (h/refusal x psid :build/start {:by "overseer" :attended true :session-id "c1"}))))
    (is (= "operator-coding" (get-in (last (h/directives (h/send! x psid :build/start (assoc op :session-id "c1")) psid)) [:data :kind])))))

(deftest stakeholder
  (let [x (h/send! (project) psid :stakeholder/set (assoc op :person-id "p1" :target {:status "active"}))]
    (is (h/in? x psid :stakeholder-set))
    (is (= "Only an active person on the roster can be a project's main stakeholder." (h/refusal x psid :stakeholder/set (assoc op :person-id "p2" :target {:status "left"}))))
    (let [c (left x psid "p1" "Ana")]
      (is (h/in? c psid :stakeholder-cleared))
      (is (= {:person-id "p1" :name "Ana" :at (h/now c)} (:stakeholder-cleared (h/data c psid))))
      (is (h/in? (h/send! c psid :stakeholder/set (assoc op :person-id nil)) psid :no-stakeholder)))))

(deftest overseer-clear
  (let [x (-> (project) (h/send! psid :overseer/start (assoc op :conversation-id "c0")))]
    (is (h/in? x psid :has-overseer))
    (let [y (reduce (fn [y i] (h/send! y psid :overseer/clear (assoc op :conversation-id (str "c" i)))) x (range 1 25))]
      (is (= 20 (count (get-in (h/data y psid) [:overseer :history]))))
      (is (some #(= :ledger/reset-message (:event %)) (h/elsewhere y))))))

(deftest owner-updates
  (let [x (project)
        po {:by "overseer" :autonomy "L1" :roster-active true :owner-active true :text "We shipped the invoice page."}]
    (is (= "This organization has no owner, so there is no page to post to." (h/refusal x psid :owner-update/post (dissoc po :owner-active))))
    (is (= "Nothing new since the last update: post one when a conversation finishes, a decision is agreed, or a coding session finishes or is merged."
           (h/refusal x psid :owner-update/post po)))
    (is (nil? (h/refusal x psid :owner-update/post (assoc po :attended true))) "the operator's own request posts any time")
    (let [m (h/send! x psid :milestone/noted {:kind "baton-done"})
          y (h/send! m psid :owner-update/post po)]
      (is (h/in? m psid :since-post))
      (is (h/in? y psid :cooling))
      (is (h/in? y psid :no-milestone))
      (is (= "An update was posted less than an hour ago: at most one a day." (h/refusal (h/send! y psid :milestone/noted {}) psid :owner-update/post po)))
      (is (h/in? (h/advance! y (* 24 3600000)) psid :ready)))
    (is (= "The text leaks." (h/refusal x psid :owner-update/post (assoc po :attended true :leak "The text leaks."))))
    (is (nil? (h/refusal x psid :owner-update/post (assoc po :build-finished-at (h/now x)))) "a build that finished a turn since is a milestone")))

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
  (let [bsid "build/o1/pr1/c1"
        x (-> (h/start! (h/new-host) "build" bsid {:org-id "o1" :project-id "pr1" :session-id "c1" :kind "coding" :title "T" :prompt "Build it"})
              (h/send! bsid :effect/done {:kind "make-worktree" :result {:branch "sova/t-abc123" :target "main"}})
              (h/send! bsid :effect/done {:kind "set-mode"}))]
    (is (= "Build it\n\nYou work in your own git worktree on the branch sova/t-abc123. Commit your work on this branch before you end your turn: uncommitted changes can't be merged. Before you end your turn, also merge main into your branch and resolve any conflicts."
           (:prompt (last (h/outbox x bsid)))))))

(deftest stakeholder-same-person-adds-no-line
  (let [x (h/send! (project) psid :stakeholder/set (assoc op :person-id "p1" :target {:status "active"}))
        y (h/send! x psid :stakeholder/set (assoc op :person-id "p1" :target {:status "active"}))]
    (is (= 1 (count (:stakeholder-history (h/data y psid)))))))

(deftest F-185-the-global-overseers-gathering-start-needs-its-card
  (let [x   (project)
        go  {:by "operator" :via "overseer" :session-id "s1" :public-title "T" :goal "G" :question "Q"}
        one (assoc go :to "p1")
        two (assoc go :targets ["p1" "p2"])]
    (is (= "This reaches people or ends something: ask with sova_confirm, listing the project pr1, p1 in its items, and act in the turn the user's click starts."
           (h/refusal x psid :baton/start one)))
    (is (some? (h/refusal x psid :baton/start (assoc one :card {:projects ["pr1"]}))) "every person must be on it")
    (is (nil? (h/refusal x psid :baton/start (assoc one :card {:projects ["pr1"] :people ["p1"]}))))
    (is (some? (h/refusal x psid :baton/start (assoc two :card {:projects ["pr1"] :people ["p1"]}))))
    (is (nil? (h/refusal x psid :baton/start (assoc two :card {:projects ["pr1"] :people ["p1" "p2"]}))))
    (is (nil? (h/refusal x psid :baton/start (assoc go :to "operator" :card {:projects ["pr1"]}))) "the operator is never a card item")
    (is (nil? (h/refusal x psid :baton/start (assoc one :by "operator" :via nil))) "the operator's own page asks nothing")))
