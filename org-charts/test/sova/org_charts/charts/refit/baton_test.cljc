(ns sova.org-charts.charts.refit.baton-test
  "The baton chart: starts, moves (and moves held behind a running reply), offers, claims and
   leases, the budget stop, the person-left cascade, decisions and referrals, the wrap-up."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.org-charts.charts.baton :as baton]
    [sova.org-charts.charts.refit.host :as h]
    [sova.org-charts.charts.rules.baton :as rb]))

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
(defn left [x pid] (h/send! x sid :link/moved {:from (str "person/o1/" pid) :chart "person" :states [:person :left] :exported {:name (names pid)}}))
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
        y (msg x "p1")]
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
        y (-> x (msg "p1") (msg "p1"))]
    (is (h/in? y sid :at-limit))
    (is (h/in? y sid :with-operator) "after the last allowed message (no reply ran)")
    (is (= rb/limit-question (:question (last (:handoffs (h/data y sid))))))
    (testing "the limit never cuts a reply"
      (let [z (-> x (msg "p1") (h/send! sid :reply/writing {}) (msg "p1"))]
        (is (h/in? z sid :with-person))
        (is (h/in? (h/send! z sid :reply/ended {}) sid :with-operator))))
    (is (= rb/limit-reached (h/refusal y sid :baton/handoff (assoc op :target ana :question "Q"))))
    (is (= "A conversation's limit is at most 1000 messages (it is 2 now)." (h/refusal y sid :baton/extend (assoc op :by 999))))
    (is (h/in? (h/send! y sid :baton/extend (assoc op :by 5)) sid :under))
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
  (let [x (msg (start to-ana) "p1")
        y (h/send! x sid :baton/goal-done {:by "model" :summary "All set"})]
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

(deftest global-overseer-card
  (let [x (start to-ana)]
    (is (= "This reaches people or ends something: ask with sova_confirm, listing the session s1 in its items, and act in the turn the user's click starts."
           (h/refusal x sid :baton/take-back {:by "operator" :via "overseer"})))
    (is (nil? (h/refusal x sid :baton/take-back {:by "operator" :via "overseer" :card {:sessions ["s1"]}})))
    (is (nil? (h/refusal x sid :baton/take-back op)) "the operator's own click needs no card")))

(deftest reconcile-when-ended
  (let [with-d (fn [x] (h/send! x sid :baton/record-decision {:by "model" :decision-id "s1:e1" :area "Pay" :statement "S" :quote "Q" :owner-areas []}))
        drives (fn [x] (filter #(= :drive (:op %)) (h/directives x sid)))]
    (testing "F8a: any project gathering that ends with decisions asks the reconciler (the chart's own act)"
      (let [y (-> (start to-ana) with-d (h/send! sid :baton/close op))
            dr (first (drives y))]
        (is (= :reconcile/request (:event dr)))
        (is (= "reconciler/o1/pr1" (:target dr)))
        (is (= 1 (count (drives (h/send! y sid :wrapup/finished {}))))) "once"))
    (is (empty? (drives (h/send! (start to-ana) sid :baton/close op))) "no decisions, no reconcile")
    (is (empty? (drives (-> (start (assoc to-ana :conflict {:id "cf1" :area "pay"})) with-d (h/send! sid :baton/close op)))) "a settle session asks on its own")))

(deftest the-overseers-send-into-a-gathering
  (let [x   (start to-ana)
        att {:by "overseer" :attended true :autonomy "L3" :roster-active true}
        y   (h/send! x sid :baton/send (assoc att :text "Please ask about Q3" :delivery "followUp"))]
    (is (some #{"send-prompt"} (map name (h/kinds y sid))))
    (is (= {:text "Please ask about Q3" :delivery "followUp"} (select-keys (last (h/outbox y sid)) [:text :delivery])))
    (is (= [["watch/o1/pr1" "prompt"]] (map (juxt :target (comp :kind :data)) (filter #(= :ledger/take (:event %)) (h/elsewhere y)))))
    (is (= "text must not be blank." (h/refusal x sid :baton/send (assoc att :text " "))))
    (is (re-find #"sova_send needs L3" (h/refusal x sid :baton/send {:by "overseer" :autonomy "L2" :roster-active true :text "t"})))
    (testing "a participant's own message is never held and has no confirm kind"
      (is (not (:hold (get-in baton/acts [:baton/message]))))
      (is (nil? (get-in baton/acts [:baton/message :confirm-kind]))))))
