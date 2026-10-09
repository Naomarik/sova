(ns sova.statecharts.refit.baton-test
  "The baton statechart: starts, moves (and moves held behind a running reply), offers, claims and
   leases, the budget stop, the person-left cascade, decisions and referrals, the wrap-up."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.baton :as baton]
    [sova.statecharts.refit.host :as h]
    [sova.statecharts.rules.baton :as rb]))

(def sid "baton/o1/s1")
(def op {:by "operator"})
(def names {"p1" "Ana Ruiz" "p2" "Bob Diaz" "p3" "Cy Lee"})
(defn start
  ([d] (start d (h/new-host)))
  ([d host] (h/start! host "baton" sid (merge {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "Invoicing"
                                               :goal "Learn" :owner {:overseer-of "pr1"} :names names :operator-name "Omar"} d))))
(def to-ana {:to "p1"})
(def ana {:id "p1" :name "Ana Ruiz" :status "active"})
(def bob {:id "p2" :name "Bob Diaz" :status "active"})
(defn left [x pid] (h/send! x sid :link/moved {:from (str "person/o1/" pid) :statechart "person" :states [:person :left] :exported {:name (names pid)}}))
(defn msg [x from] (h/send! x sid :baton/message {:by (if (= from "operator") "operator" "person") :from from :active true}))

(deftest starts
  (is (h/in? (start to-ana) sid :with-person))
  (is (h/in? (start {:to "operator"}) sid :with-operator))
  (is (true? (:needs-you (h/data (start {:to "operator"}) sid))))
  (let [x (start {:targets ["p1" "p2"]})]
    (is (h/in? x sid :pool))
    (is (= ["p1" "p2"] (:to (rb/current-offer (h/data x sid))))))
  (is (= [{:op :watch :target "person/o1/p1"}] (h/directives (start to-ana) sid)))
  (testing "no link when the caller can't show one"
    (is (not (some #{"mint-links"} (h/kinds (start (assoc to-ana :mint-link false)) sid))))))

(deftest hand-to
  (let [x (start to-ana)]
    (is (= "Not handed over: Ana Ruiz has not chosen Bob Diaz. Tell Ana Ruiz who could answer (name and decision area, from the list) and ask them to choose; hand over once they name or confirm someone."
           (h/refusal x sid :baton/hand-to {:by "model" :target bob :chosen false :question "Q"})))
    (is (= "Give the question you need them to answer." (h/refusal x sid :baton/hand-to {:by "model" :target bob :chosen true})))
    (is (= "They already hold the baton." (h/refusal x sid :baton/hand-to {:by "model" :target ana :chosen true :question "Q"})))
    (let [y (h/send! x sid :baton/hand-to {:by "model" :target bob :chosen true :question "Q" :briefing "B"})]
      (is (h/in? y sid :with-person))
      (is (= "p2" (:holder (h/data y sid))))
      (is (= 2 (count (:handoffs (h/data y sid))))))
    (testing "to the operator: always reachable; the owner overseer hears of it"
      (let [y (h/send! (h/clear! x sid) sid :baton/hand-to {:by "model" :target {:id "operator"} :question "Who pays?"})]
        (is (h/in? y sid :with-operator))
        (is (= [:reason/noted] (map :event (h/elsewhere y))))))))

(deftest take-back-mid-reply
  (let [x (-> (start to-ana) (h/send! sid :reply/writing {}))]
    (is (= "You already hold the baton." (h/refusal (start {:to "operator"}) sid :baton/take-back op)))
    (let [y (h/send! x sid :baton/take-back op)]
      (testing "nothing moves until the reply stops"
        (is (h/in? y sid :with-person))
        (is (h/in? y sid :reply-stopping))
        (is (some #{"stop-reply"} (h/kinds y sid))))
      (let [z (h/send! y sid :reply/ended {})]
        (is (h/in? z sid :with-operator))
        (is (= "(taken back)" (:question (last (:handoffs (h/data z sid))))))))))

(deftest pending-move-dropped-when-it-now-fails
  (let [x (-> (start to-ana) (h/send! sid :reply/writing {})
              (h/send! sid :baton/handoff (assoc op :target bob :question "Q")))]
    (is (h/in? x sid :reply-stopping))
    ;; meanwhile the model's own hand_to reached Bob
    (let [y (-> x (h/send! sid :baton/hand-to {:by "model" :target bob :chosen true :question "Q"}) (h/send! sid :reply/ended {}))]
      (is (h/in? y sid :with-person))
      (is (= "p2" (:holder (h/data y sid))))
      (is (= 2 (count (:handoffs (h/data y sid))))))))

(deftest offers-claims-leases
  (let [x (start {:targets ["p1" "p2"] :lease-ms 1000})
        y (-> x (msg "p1") (h/send! sid :reply/ended {}))]
    (is (h/in? (h/advance! (msg x "p1") 5000) sid :leased) "no lapse between the claim and its reply")
    (is (h/in? y sid :leased))
    (is (= "p1" (:holder (h/data y sid))))
    (is (= "Someone else is answering right now." (h/refusal y sid :baton/message {:by "person" :from "p2" :active true})))
    (let [z (h/advance! y 1000)]
      (is (h/in? z sid :pool))
      (is (nil? (:holder (h/data z sid))))
      (is (h/in? (msg z "p2") sid :leased)))
    (testing "never lapses mid-reply: the reply's end restarts it"
      (let [z (-> y (h/send! sid :reply/writing {}) (h/advance! 5000))]
        (is (h/in? z sid :leased))
        (is (h/in? (-> z (h/send! sid :reply/ended {}) (h/advance! 999)) sid :leased))
        (is (h/in? (-> z (h/send! sid :reply/ended {}) (h/advance! 1000)) sid :pool))))
    (is (= "There is no open offer." (h/refusal (start to-ana) sid :baton/withdraw op)))
    (is (h/in? (h/send! x sid :baton/withdraw op) sid :with-operator))))

(deftest budget
  (let [x (start (assoc to-ana :messages-max 2))
        w (-> x (msg "p1") (h/send! sid :reply/ended {}) (msg "p1"))
        y (h/send! w sid :reply/ended {})]
    (testing "server-3: the last allowed message's reply starts in its own step, so the stop waits for it"
      (is (h/in? w sid :at-limit))
      (is (h/in? w sid :reply-starting))
      (is (h/in? w sid :with-person) "still theirs while its reply is starting")
      (is (h/in? (h/send! w sid :reply/starting {}) sid :reply-starting) "the host's reply/starting is idempotent")
      (is (h/in? (h/send! w sid :lease/lapse {}) sid :with-person)))
    (testing "a message the runtime refuses after all starts no reply"
      (let [r (-> x (msg "p1") (h/send! sid :message/refused {}))]
        (is (h/in? r sid :reply-idle))
        (is (= 0 (get-in (h/data r sid) [:budget :messages-used])))))
    (is (h/in? y sid :at-limit))
    (is (h/in? y sid :with-operator) "after the reply to the last allowed message")
    (is (= rb/limit-question (:question (last (:handoffs (h/data y sid))))))
    (testing "the limit never cuts a reply"
      (let [z (-> x (msg "p1") (h/send! sid :reply/writing {}) (msg "p1"))]
        (is (h/in? z sid :with-person))
        (is (h/in? (h/send! z sid :reply/ended {}) sid :with-operator))))
    (is (= rb/limit-reached (h/refusal y sid :baton/handoff (assoc op :target ana :question "Q"))))
    (is (= "A conversation's limit is at most 1000 messages (it is 2 now)." (h/refusal y sid :baton/extend (assoc op :more 999))))
    (is (h/in? (h/send! y sid :baton/extend (assoc op :more 5)) sid :under))
    (testing "recount never raises"
      (is (= 1 (get-in (h/data (h/send! y sid :budget/recount {:n 1}) sid) [:budget :messages-used])))
      (is (= 2 (get-in (h/data (h/send! y sid :budget/recount {:n 9}) sid) [:budget :messages-used]))))))

(deftest person-left
  (testing "the holder: to the operator"
    (let [y (left (start to-ana) "p1")]
      (is (h/in? y sid :with-operator))
      (is (= "(left the organization)" (:question (last (:handoffs (h/data y sid))))))))
  (testing "an invitee of an open offer: withdrawn to the operator"
    (let [y (left (start {:targets ["p1" "p2"]}) "p2")]
      (is (h/in? y sid :with-operator))
      (is (= "(Bob Diaz left the organization; offer withdrawn)" (:question (last (:handoffs (h/data y sid))))))))
  (testing "an offer someone else holds carries on"
    (is (h/in? (left (msg (start {:targets ["p1" "p2"]}) "p1") "p2") sid :leased)))
  (testing "mid-reply: the reply is stopped first"
    (let [y (-> (start to-ana) (h/send! sid :reply/writing {}) (left "p1"))]
      (is (h/in? y sid :reply-stopping))
      (is (h/in? (h/send! y sid :reply/ended {}) sid :with-operator)))))

(deftest done-close-wrapup
  (let [x (-> (start to-ana) (msg "p1") (h/send! sid :reply/ended {}))
        y (h/send! x sid :baton/goal-done {:by "model" :summary "All set"})]
    (testing "goal_done inside the reply: the wrap-up waits for the reply to end"
      (let [m (-> (start to-ana) (msg "p1") (h/send! sid :reply/writing {}) (h/send! sid :baton/goal-done {:by "model" :summary "All set"}))]
        (is (not (h/in? m sid :wrapup-running)))
        (is (h/in? (h/send! m sid :reply/ended {}) sid :wrapup-running))))
    (is (h/in? y sid :done))
    (is (h/in? y sid :wrapup-running))
    (is (= "This session is already done." (h/refusal y sid :baton/goal-done {:by "model" :summary "x"})))
    (let [f (h/send! y sid :wrapup/stopped {:detail "boom"})]
      (is (h/in? f sid :wrapup-failed))
      (is (h/in? (h/send! f sid :baton/wrapup-retry op) sid :wrapup-running))
      (testing "done then closed: the wrap-up is not run again"
        (let [c (-> y (h/send! sid :wrapup/finished {:applied 1}) (h/send! sid :baton/close op))]
          (is (h/in? c sid :closed))
          (is (h/in? c sid :wrapup-done)))))
    (is (= "It ran past 10 minutes without finishing." (get-in (h/data (h/advance! y (* 11 60000)) sid) [:wrapup :error])))
    (is (= "The server shut down during the wrap-up." (get-in (h/data (h/send! y sid :sova/resumed {}) sid) [:wrapup :error])))
    (is (= "The wrap-up is already running." (h/refusal y sid :baton/wrapup-retry op))))
  (testing "nobody wrote: skipped, never retried"
    (let [y (h/send! (start to-ana) sid :baton/close op)]
      (is (h/in? y sid :wrapup-skipped))
      (is (= "Only a wrap-up that stopped can be retried." (h/refusal y sid :baton/wrapup-retry op)))))
  (testing "the overseer's close, in today's order"
    (let [x (start to-ana)]
      (is (= "Say why you close it (reason)." (h/refusal x sid :baton/close {:by "overseer" :attended true})))
      (is (= "Not one of your gathering sessions." (h/refusal x sid :baton/close {:by "overseer" :attended true :reason "r" :owner-project "px"})))
      (is (= "Someone it went to has already written in it." (h/refusal (msg x "p1") sid :baton/close {:by "overseer" :attended true :reason "r" :owner-project "pr1"}))))))

(deftest decisions
  (let [x (start to-ana)]
    (is (= "\"money\" is not an owner area. Use one of: \"payroll\" or \"none\"."
           (h/refusal x sid :baton/record-decision {:by "model" :area "Pay" :statement "S" :quote "Q" :owner-area "money" :owner-areas ["payroll"]})))
    (let [y (h/send! x sid :baton/record-decision {:by "model" :decision-id "s1:e1" :area "Pay" :statement "S" :quote "Q" :owner-area "PAYROLL" :owner-areas ["payroll"]})
          sp (last (h/directives y sid))]
      (is (= ["s1:e1"] (:decisions (h/data y sid))))
      (is (= :spawn (:op sp)))
      (is (= "payroll" (get-in sp [:data :owner-area])))
      (is (empty? (h/elsewhere y)) "a decision mid-session is no reason and no reconcile"))
    (testing "a settle session's decision asks for a reconcile in 2 s"
      (let [y (h/send! (start (assoc to-ana :conflict {:id "cf1" :area "pay"})) sid :baton/record-decision
                {:by "model" :decision-id "s1:e2" :area "Pay" :statement "S" :quote "Q" :owner-areas []})]
        (is (= [:reconcile/request] (map :event (h/elsewhere y))))))))

(deftest recovered-decisions
  ;; A marker left without its decision is recovered by Sova with its original author
  (let [d    {:area "Pay" :statement "S" :quote "Q" :owner-areas []}
        rec  (fn [by-env author id] (merge d {:by by-env :recovery true :recovery-by author :decision-id id}))
        x    (-> (start to-ana) (h/send! sid :baton/hand-to {:by "model" :target bob :chosen true :question "Q" :briefing "B"}))
        spawn-of (fn [y] (last (filter #(= :spawn (:op %)) (h/directives y sid))))]
    (is (= "p2" (:holder (h/data x sid))) "Bob holds it now")
    (testing "Sova's recovery keeps the marker's author (Ana took part), not the holder now"
      (let [y (h/send! x sid :baton/record-decision (rec "system" "p1" "s1:m1"))]
        (is (= ["s1:m1"] (:decisions (h/data y sid))))
        (is (= "p1" (get-in (spawn-of y) [:data :by])))
        (is (= "Ana Ruiz" (get-in (spawn-of y) [:data :name])))))
    (testing "the operator's own marker too"
      (is (= "operator" (get-in (spawn-of (h/send! x sid :baton/record-decision (rec "system" "operator" "s1:m2"))) [:data :by]))))
    (testing "only Sova recovers: a model, the operator or a route claiming a recovery is refused"
      (doseq [by ["model" "operator" "overseer" "person"]]
        (is (= "Only Sova recovers a decision." (h/refusal x sid :baton/record-decision (rec by "p1" "s1:m3"))) by)))
    (testing "someone who never took part is refused, never recorded as anyone's"
      (is (= "Not recovered: the person who decided isn't part of this conversation." (h/refusal x sid :baton/record-decision (rec "system" "p3" "s1:m4"))))
      (is (= "Not recovered: the person who decided isn't part of this conversation." (h/refusal x sid :baton/record-decision (rec "system" nil "s1:m4")))))
    (testing "a recovery-by without the recovery flag is ignored: the holder decides, as always"
      (is (= "p2" (get-in (spawn-of (h/send! x sid :baton/record-decision (merge d {:by "model" :recovery-by "p1" :decision-id "s1:m5"}))) [:data :by]))))
    (testing "a closed conversation still takes the recovery of a decision made while it was open"
      (let [c (h/send! x sid :baton/close op)
            y (h/send! c sid :baton/record-decision (rec "system" "p1" "s1:m6"))]
        (is (h/in? c sid :closed))
        (is (some #{"s1:m6"} (:decisions (h/data y sid))))
        (is (= "p1" (get-in (spawn-of y) [:data :by])))))
    (testing "a recovered decision keeps the name its marker kept, not the conversation's label now"
      (let [y (h/send! x sid :baton/record-decision (assoc (rec "system" "p1" "s1:m8") :recovery-name "Ana R. (then)"))]
        (is (= "Ana R. (then)" (get-in (spawn-of y) [:data :name])))
        (is (= "record" (get-in (spawn-of y) [:data :name-at])))))
    (testing "a recovered marker that kept no name: today's label, said to be the label at recovery"
      (let [y (h/send! x sid :baton/record-decision (rec "system" "p1" "s1:m9"))]
        (is (= "Ana Ruiz" (get-in (spawn-of y) [:data :name])))
        (is (= "recovery" (get-in (spawn-of y) [:data :name-at])))))
    (testing "a live decision: the holder's name as recorded; a recovery-name without the guard is ignored"
      (let [y (h/send! x sid :baton/record-decision (merge d {:by "model" :decision-id "s1:m10" :recovery-name "Forged"}))]
        (is (= "Bob Diaz" (get-in (spawn-of y) [:data :name])))
        (is (= "record" (get-in (spawn-of y) [:data :name-at])))))
    (testing "a name override outside Sova's guarded recovery never names anyone"
      (doseq [by ["model" "operator" "overseer" "person"]]
        (let [y (h/send! x sid :baton/record-decision (merge d {:by by :decision-id (str "s1:n-" by) :recovery-name "Forged"}))]
          (is (= "Bob Diaz" (get-in (spawn-of y) [:data :name])) by)
          (is (= "record" (get-in (spawn-of y) [:data :name-at])) by))
        (is (= "Only Sova recovers a decision." (h/refusal x sid :baton/record-decision (assoc (rec by "p1" (str "s1:r-" by)) :recovery-name "Forged"))) by))
      (is (= "Not recovered: the person who decided isn't part of this conversation."
             (h/refusal x sid :baton/record-decision (assoc (rec "system" "p3" "s1:r-p3") :recovery-name "Forged")))))
    (testing "the same decision id twice: refused, no second record and no second spawn"
      (let [y (h/send! x sid :baton/record-decision (rec "system" "p1" "s1:m7"))]
        (is (= "That decision is already recorded." (h/refusal y sid :baton/record-decision (rec "system" "p1" "s1:m7"))))
        (is (= "That decision is already recorded." (h/refusal y sid :baton/record-decision (merge d {:by "model" :decision-id "s1:m7"}))))))))

(deftest global-overseer-card
  (let [x (start to-ana)]
    (is (= "This reaches people or ends something: ask with sova_card, listing the session s1 in its items, and act in the turn the user's click starts."
           (h/refusal x sid :baton/take-back {:by "operator" :via "overseer"})))
    (is (nil? (h/refusal x sid :baton/take-back {:by "operator" :via "overseer" :card {:sessions ["s1"]}})))
    (is (nil? (h/refusal x sid :baton/take-back op)) "the operator's own click needs no card")))

(deftest reconcile-when-ended
  (let [with-d (fn [x] (h/send! x sid :baton/record-decision {:by "model" :decision-id "s1:e1" :area "Pay" :statement "S" :quote "Q" :owner-areas []}))
        drives (fn [x] (filter #(= :drive (:op %)) (h/directives x sid)))]
    (testing "F8a: any project gathering that ends with decisions asks the reconciler (the statechart's own act)"
      (let [y (-> (start to-ana) with-d (h/send! sid :baton/close op))
            dr (first (drives y))]
        (is (= :reconcile/request (:event dr)))
        (is (= "reconciler/o1/pr1" (:target dr)))
        (is (= 1 (count (drives (h/send! y sid :wrapup/finished {}))))) "once"))
    (is (empty? (drives (h/send! (start to-ana) sid :baton/close op))) "no decisions, no reconcile")
    (is (empty? (drives (-> (start (assoc to-ana :conflict {:id "cf1" :area "pay"})) with-d (h/send! sid :baton/close op)))) "a settle session asks on its own")))

(deftest r10-nobody-sends-into-a-gathering
  ;; F-128: sova_send refuses a gathering session (only its participants write in it)
  (is (not (contains? baton/acts :baton/send)) "no act sends text into a gathering")
  (testing "a participant's own message is never held and has no confirm kind"
    (is (not (:hold (get-in baton/acts [:baton/message]))))
    (is (nil? (get-in baton/acts [:baton/message :confirm-kind])))))

(deftest the-global-overseers-hand-off-mints-no-link
  (let [go {:by "operator" :via "overseer" :card {:sessions ["s1"] :people ["p2"]}}]
    (is (some #{"mint-link"} (map name (h/kinds (h/send! (start to-ana) sid :baton/handoff (assoc op :target bob :question "Q")) sid))))
    (is (not-any? #{"mint-link"} (map name (h/kinds (h/send! (start to-ana) sid :baton/handoff (assoc go :target bob :question "Q" :mint-link false)) sid))))))

(deftest extend-reads-more-never-the-envelopes-by
  (let [x (start (assoc to-ana :messages-max 2))]
    (is (= 7 (get-in (h/data (h/send! x sid :baton/extend {:by "operator" :more 5}) sid) [:budget :messages-max])))
    (is (= "by must be a whole number from 1 to 1000" (h/refusal x sid :baton/extend {:by "operator"})))))
