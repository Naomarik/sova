(ns sova.org-charts.charts.refit.person-test
  "The person chart: every status pair is one transition, the left cascade's own part, field
   authority, caps, the referral's completeness, revert (C6), and the rules' sentences."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.org-charts.charts.refit.host :as h]
    [sova.org-charts.charts.person :as person]
    [sova.org-charts.charts.rules.person :as rp]))

(def op {:by "operator"})
(def ana {:name "Ana Ruiz" :status "active" :role "CFO" :decides ["payroll"] :contact {:email "ana@x.co"}})
(def referral {:why "Knows invoicing" :referred-by "p_bob00000" :session-id "s1" :quote "Ask Carla"})
(def carla {:name "Carla Diaz" :status "proposed" :role "Accountant" :contact {:phone "+57 300 123 4567"} :referral referral})

(defn born [p]
  (let [{:keys [person changed]} (rp/apply-change nil p "operator" #{})]
    (-> (h/new-host) (h/start! "person" "person/o1/p1" {:org-id "o1" :id "p1" :person person :changed changed :by {:kind "operator"}}))))

(def sid "person/o1/p1")

(deftest birth
  (let [x (born ana)]
    (is (h/in? x sid :active))
    (is (= "Ana Ruiz" (:name (h/data x sid))))
    (is (= [:roster-history] (mapv keyword (h/kinds x sid))))
    (is (= [:name :status :contact :role :decides] (mapv :field (:lines (first (h/outbox x sid))))))
    (is (h/in? (born carla) sid :proposed))))

(deftest status-pairs
  (testing "each pair the operator's edit allows is taken, to the right state"
    (doseq [[from to state] [[ana "left" :left] [carla "left" :left] [carla "active" :active]
                             [(assoc ana :status "left") "active" :active]]]
      (let [x (-> (born from) (h/clear! sid) (h/send! sid :person/edit (assoc op :patch {:status to} :names-taken #{})))]
        (is (h/in? x sid state) (str (:status from) " → " to)))))
  (testing "active → proposed needs the full referral"
    (let [x (born ana)]
      (is (= "A proposed person needs why they were referred, who referred them." (h/refusal x sid :person/edit (assoc op :patch {:status "proposed"}))))
      (is (h/in? (h/send! x sid :person/edit (assoc op :patch {:status "proposed" :referral referral})) sid :proposed)))))

(deftest leaving-revokes-links
  (let [x (-> (born ana) (h/clear! sid) (h/send! sid :person/leave op))]
    (is (h/in? x sid :left))
    (is (= ["roster-history" "revoke-person-links"] (h/kinds x sid)))))

(deftest approve-and-decline
  (let [x (born carla)]
    (is (h/in? (h/send! x sid :person/approve op) sid :active))
    (is (h/in? (h/send! (born carla) sid :person/decline op) sid :left))
    (is (= "Ana Ruiz is not waiting for approval." (h/refusal (born ana) sid :person/approve op)))
    (is (= "Ana Ruiz is active, not proposed." (h/refusal (born ana) sid :person/approve {:by "overseer" :attended true})))
    (testing "the overseer needs L2 outside the operator's turns"
      (is (re-find #"sova_roster needs L2" (h/refusal (born carla) sid :person/approve {:by "overseer" :autonomy "L1" :roster-active true})))
      (is (nil? (h/refusal (born carla) sid :person/approve {:by "overseer" :autonomy "L2" :roster-active true}))))))

(deftest field-authority
  (let [x (born ana)]
    (is (= "A wrapup change may not write role." (h/refusal x sid :person/edit {:by "wrapup" :patch {:role "Boss"}})))
    (is (= "A overseer change may not write status." (h/refusal x sid :person/edit {:by "overseer" :attended true :patch {:status "left"}})))
    (is (nil? (h/refusal x sid :person/edit {:by "wrapup" :patch {:language "es-CO"}})))
    (is (= "language must be a BCP-47 tag such as es-CO" (h/refusal x sid :person/edit {:by "wrapup" :patch {:language "spanish!"}})))
    (is (= "Bob is already on the roster." (h/refusal x sid :person/edit (assoc op :patch {:name "Bob"} :names-taken #{"bob"}))))))

(deftest nothing-changed-writes-nothing
  (let [x (-> (born ana) (h/clear! sid) (h/send! sid :person/edit (assoc op :patch {:role "CFO"})))]
    (is (= [] (h/kinds x sid)))))

(deftest revert
  (let [x (born ana)]
    (is (= person/revert-creation (h/refusal x sid :person/revert (assoc op :row {:at 1 :field "name" :from nil :to "Ana Ruiz"}))))
    (is (= "Ana Ruiz's role has changed since then, so reverting this would undo a later change. Revert the latest change instead."
           (h/refusal x sid :person/revert (assoc op :row {:at 2 :field "role" :from "Clerk" :to "Accountant"}))))
    (let [y (-> x (h/clear! sid) (h/send! sid :person/revert (assoc op :row {:at 2 :field "role" :from "Clerk" :to "CFO"})))]
      (is (= "Clerk" (:role (h/data y sid))))
      (is (= 2 (:revert-of (first (h/outbox y sid))))))
    (testing "a status revert runs the lifecycle (a revert that sets left cascades)"
      (let [y (h/send! x sid :person/revert (assoc op :row {:at 3 :field "status" :from "left" :to "active"}))]
        (is (h/in? y sid :left))
        (is (some #{"revoke-person-links"} (h/kinds y sid)))))))

(deftest rules
  (is (= "“2024” names no decision area: use words, like “website”." (:sentence (rp/clean-field :decides ["2024"]))))
  (is (= "decides must have at most 12 items" (:sentence (rp/clean-field :decides (map #(str "area " %) (range 13))))))
  (is (= ["pay"] (rp/clean-field :decides ["pay" "PAY" " "])))
  (is (= "competence.go must be {level 1–5, n ≥ 0}" (:sentence (rp/clean-field :competence {"go" {:level 7 :n 1}}))))
  (is (= ["the email is not an email address" "the phone is not a phone number" "the other channel names no handle or number"]
         (rp/contact-problems {:email "ask tony" :phone "12" :other "ask tony"})))
  (is (= [] (rp/contact-problems {:email "a@b.co" :whatsapp "+1 (555) 123-4567" :other "Slack: @bob"})))
  (is (= "A referral may only create a proposed person." (:sentence (rp/apply-change nil {:name "X" :status "active"} "referral" #{}))))
  (is (= "Not recorded yet: still missing a real contact channel (the phone is not a phone number; never write a placeholder). Ask Bob for it, then call propose_roster_edit again with everything."
         (:sentence (rp/referral-refusal {:name "C" :role "R" :contact {:phone "ask"} :why "w" :quote "q"} nil "Bob"))))
  (is (= "Carla was already proposed and waits for the operator's approval. Hand to the operator if you need them now."
         (:sentence (rp/referral-refusal {:name "Carla"} {:name "Carla" :status "proposed"} "Bob")))))

(deftest global-overseer-and-the-chart
  (let [x (born ana)]
    (is (re-find #"^This reaches people or ends something: ask with sova_confirm, listing p1 in its items" (h/refusal x sid :person/leave {:by "operator" :via "overseer"})))
    (is (nil? (h/refusal x sid :person/leave {:by "operator" :via "overseer" :card {:people ["p1"]}})))
    (testing "a revert that sets left needs the card; another revert does not"
      (is (some? (h/refusal x sid :person/revert {:by "operator" :via "overseer" :row {:at 3 :field "status" :from "left" :to "active"}})))
      (is (nil? (h/refusal x sid :person/revert {:by "operator" :via "overseer" :row {:at 3 :field "role" :from "Clerk" :to "CFO"}})))))
  (is (= "A chart change may not approve or decline people." (h/refusal (born carla) sid :person/approve {:by "chart" :autonomy "L3" :roster-active true}))))

(deftest a-person-created-left-starts-left
  (let [x (born {:name "Old Timer" :status "left"})]
    (is (h/in? x sid :left))
    (is (= "left" (:status (h/data x sid))))))

(deftest F-093-an-overseer-approved-referral-stays-self-asserted
  ;; decidesTrusted: a decides entry a referral introduced counts only after an OPERATOR status→active line.
  (let [{:keys [person changed]} (rp/apply-change nil carla "referral" #{})
        x    (-> (h/new-host) (h/start! "person" sid {:org-id "o1" :id "p1" :person person :changed changed
                                                      :by {:kind "referral" :session-id "s1" :quote "Ask Carla"}}))
        hist (fn [y] (last (filter #(= "roster-history" (name (:kind %))) (h/outbox y sid))))]
    (is (= "referral" (get-in (hist x) [:by :kind])) "the creation lines say referral")
    (let [y (h/send! x sid :person/approve {:by "overseer" :attended true :by-kind "overseer"})]
      (is (h/in? y sid :active))
      (is (= "overseer" (get-in (hist y) [:by :kind])) "an overseer's approval says overseer, never operator")
      (is (= [{:field :status :from "proposed" :to "active"}] (map #(select-keys % [:field :from :to]) (:lines (hist y))))))
    (is (= "operator" (get-in (hist (h/send! x sid :person/approve {:by "operator" :by-kind "operator"})) [:by :kind])))))
