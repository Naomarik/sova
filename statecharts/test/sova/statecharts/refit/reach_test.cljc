(ns sova.statecharts.refit.reach-test
  "r12 (q15 = C, offer-delivery-scope.md §7 tests 1–8 and rule 12): an offer reaches each invitee only
   in their own hours, one re-armed reach timer per offer, a link minted per invitee reached in the
   offer's own step (a later reach only marks them reached), only the reached may claim, and reaching
   pauses while the offer is held."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.refit.host :as h]
    [sova.statecharts.rules.baton :as rb]
    [sova.statecharts.rules.reach :as reach]))

;; the host's clock starts at 1700000000000: Tuesday 2023-11-14 22:13:20 UTC
(def t0 1700000000000)
(def minute 60000)
(def hour (* 60 minute))
(def wed-03 (+ t0 (* 4 hour) (* 46 minute) 40000))            ; Wednesday 03:00 UTC
(def every-day [0 1 2 3 4 5 6])
(def ana {:id "p1" :name "Ana" :status "active" :tz "UTC" :hours {:days every-day :from "22:00" :to "23:30"}})
(def bo  {:id "p2" :name "Bo" :status "active" :tz "UTC" :hours {:days every-day :from "03:00" :to "11:00"}})
(def cy  {:id "p3" :name "Cy" :status "active"})

(def sid "baton/o1/s1")
(def op {:by "operator"})
(defn offer
  ([] (offer {}))
  ([d] (h/start! (h/new-host) "baton" sid (merge {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "Logo" :goal "G"
                                                   :owner {:overseer-of "pr1"} :targets ["p1" "p2" "p3"] :target-people [ana bo cy]
                                                   :names {"p1" "Ana" "p2" "Bo" "p3" "Cy"} :operator-name "Omar"} d))))
(defn o [x] (rb/current-offer (h/data x sid)))
(defn state-of [x pid] (get-in (o x) [:reach pid :state]))
(defn minted [x] (vec (keep #(when (= "mint-link" (:kind %)) (:person-id %)) (h/outbox x sid))))
(defn reach-timers [x] (filter #(= :offer/reach (first %)) (h/pending x sid)))
(defn msg [x from] (h/send! x sid :baton/message {:by (if (= from "operator") "operator" "person") :from from :active true}))
(defn person [x p & [states]] (h/send! x sid :link/moved {:from (str "person/o1/" (:id p)) :statechart "person" :states (or states [:person :active])
                                                         :exported (select-keys p [:name :tz :hours])}))

(deftest t1-each-invitee-in-their-own-hours
  (let [x (offer)]
    (is (h/in? x sid :pool) "the offer opens: someone is in hours")
    (is (= ["reached" "waiting" "reached"] (map #(state-of x %) ["p1" "p2" "p3"])) "Ana in hours, Cy has none: reached; Bo waits")
    (is (= wed-03 (get-in (o x) [:reach "p2" :next])))
    (is (= ["p1" "p3"] (minted x)) "a link per reached invitee, none for Bo")
    (is (= "reach/off_s1_1/p1" (:key (first (filter #(= "mint-link" (:kind %)) (h/outbox x sid))))))
    (is (not (some #{"mint-links"} (h/kinds x sid))) "no link for everyone at once")
    (is (= [[:offer/reach wed-03]] (reach-timers x)) "one timer, at Bo's window")
    (let [y (h/advance! x (- wed-03 t0))]
      (is (= "reached" (state-of y "p2")) "his window opens: reached")
      (is (= wed-03 (get-in (o y) [:reach "p2" :at])))
      (is (= ["p1" "p3"] (minted y)) "coordinator-50: a reach after the offer's own step mints nothing; Needs you asks the operator to send Bo's link")
      (is (empty? (reach-timers y)) "nobody waits: no timer"))))

(deftest t2-the-offer-act
  (let [x (-> (offer {:targets nil :target-people nil :to "p1"}) (msg "p1") (h/send! sid :reply/ended {}))]
    (testing "the unattended overseer's offer: each invitee in their own hours"
      (let [y (h/send! x sid :baton/offer {:by "overseer" :attended false :hold-ms 0 :targets [ana bo cy] :question "Q"})]
        (is (h/in? y sid :pool))
        (is (= ["reached" "waiting" "reached"] (map #(state-of y %) ["p1" "p2" "p3"])))
        (is (= ["p1" "p3"] (minted y)))
        (is (= [[:offer/reach wed-03]] (reach-timers y)))))
    (testing "coordinator-44: the operator's own offer reaches every invitee at once, off hours too (r7's note)"
      (let [y (h/send! x sid :baton/offer (assoc op :targets [ana bo cy] :question "Q"))]
        (is (= ["reached" "reached" "reached"] (map #(state-of y %) ["p1" "p2" "p3"])))
        (is (= ["p1" "p2" "p3"] (minted y)))
        (is (empty? (reach-timers y)))))
    (testing "…and so does one in a turn the operator started (attended)"
      (let [y (h/send! x sid :baton/offer {:by "overseer" :attended true :targets [ana bo cy] :question "Q"})]
        (is (= "reached" (state-of y "p2"))))))
  (testing "a gathering started as an offer by the operator (the spawner says at-once)"
    (is (= "reached" (state-of (offer {:at-once true}) "p2"))))
  (testing "nobody in hours: the offer is open, nobody reached, the timer at the first window"
    (let [x (offer {:targets ["p2" "p4"] :target-people [bo (assoc bo :id "p4" :hours {:days every-day :from "05:00" :to "06:00"})]})]
      (is (= ["waiting" "waiting"] (map #(state-of x %) ["p2" "p4"])))
      (is (empty? (minted x)))
      (is (= [[:offer/reach wed-03]] (reach-timers x)))))
  (testing "an offer that mints no links (the caller can't show one) still reaches, minting nothing"
    (let [x (offer {:mint-link false})]
      (is (= "reached" (state-of x "p1")))
      (is (empty? (minted x))))))

(deftest t3-hours-edited-or-left-while-waiting
  (let [x (offer)]
    (testing "Bo's hours move earlier: re-armed"
      (let [y (person x (assoc bo :hours {:days every-day :from "23:00" :to "23:45"}))
            at (+ t0 (* 46 minute) 40000)]
        (is (= [[:offer/reach at]] (reach-timers y)))
        (is (= "reached" (state-of (h/advance! y (- at t0)) "p2")))))
    (testing "later: re-armed later"
      (let [y (person x (assoc bo :hours {:days every-day :from "05:00" :to "06:00"}))]
        (is (= [[:offer/reach (+ wed-03 (* 2 hour))]] (reach-timers y)))))
    (testing "his hours cleared: always in hours, reached at once"
      (let [y (person x (dissoc bo :hours :tz))]
        (is (= "reached" (state-of y "p2")))
        (is (= ["p1" "p3"] (minted y)) "reached, no link minted (not the offer's own step)")
        (is (empty? (reach-timers y)))))
    (testing "Bo leaves: the offer goes back to the operator (as today) and nobody is reached after"
      (let [y (person x bo [:person :left])]
        (is (h/in? y sid :with-operator))
        (is (empty? (reach-timers y)))
        (is (= "waiting" (get-in (h/data (h/advance! y (- wed-03 t0)) sid) [:offers 0 :reach "p2" :state])))))))

(deftest t4-rule-12-reaching-pauses-while-held
  (let [x      (-> (offer) (h/advance! (- wed-03 t0 (* 5 minute))))   ; 02:55: Bo still waits
        leased (-> x (msg "p1") (h/send! sid :reply/ended {}))]
    (is (h/in? leased sid :leased) "Ana (reached) claims it")
    (is (= "This offer has not reached you yet." (h/refusal x sid :baton/message {:by "person" :from "p2" :active true})) "Bo (not reached) cannot claim")
    (is (empty? (reach-timers leased)) "held: the reach timer stops")
    (let [during (h/advance! leased (* 10 minute))]                   ; 03:05: his window is open, the offer is held
      (is (h/in? during sid :leased))
      (is (= "waiting" (state-of during "p2")) "never reached while held")
      (is (not (some #{"p2"} (minted during))) "no link for Bo during the lease")
      (let [lapsed (h/advance! during (* 10 minute))]                 ; 03:10: the lease lapses (15 min)
        (is (h/in? lapsed sid :pool))
        (is (= "reached" (state-of lapsed "p2")) "the lease lapsed: reaching resumes, Bo is in hours")
        (is (not (some #{"p2"} (minted lapsed))) "a lapse's reach mints nothing either")))
    (testing "a lapse while Bo is out of hours: he waits for his next window"
      (let [late (-> (offer) (h/advance! (+ (- wed-03 t0) (* 7 hour) (* 50 minute)))) ; 10:50 Wed: Bo reached at 03:00
            fresh (offer {:targets ["p1" "p4"] :target-people [ana (assoc bo :id "p4")]})
            claimed (-> fresh (h/advance! (+ (- wed-03 t0) (* 7 hour) (* 50 minute))) (msg "p1"))]
        (is (= "reached" (state-of late "p2")))
        (is (= "reached" (state-of claimed "p4")) "p4 was reached at 03:00 (the timer fired)")
        (let [ana-only (-> (offer {:targets ["p1" "p5"] :target-people [ana (assoc bo :id "p5" :hours {:days every-day :from "11:30" :to "12:00"})]})
                           (h/advance! (+ (- wed-03 t0) (* 8 hour))) ; 11:00 Wed
                           (msg "p1") (h/send! sid :reply/ended {}))
              lapsed (h/advance! ana-only (* 15 minute))]           ; 11:15: lapses before p5's 11:30 window
          (is (h/in? lapsed sid :pool))
          (is (= "waiting" (state-of lapsed "p5")))
          (is (= [[:offer/reach (+ wed-03 (* 8 hour) (* 30 minute))]] (reach-timers lapsed)) "re-armed at the next window"))))))

(deftest t5-withdraw-cancels-reaching
  (let [y (h/send! (offer) sid :baton/withdraw op)]
    (is (h/in? y sid :with-operator))
    (is (empty? (reach-timers y)))
    (is (some #{"revoke-links"} (h/kinds y sid)) "the reached invitees' links stop")
    (is (not (some #{"p2"} (minted (h/advance! y (- wed-03 t0))))) "nobody reached after")))

(deftest t6-the-rule-itself
  (let [off {:id "o" :to ["p1" "p2" "p3"] :reach {}}
        people {"p1" ana "p2" bo}]
    (is (= {:reached ["p1" "p3"] :at wed-03} (select-keys (reach/step off people t0 false) [:reached :at])))
    (is (= {:reached [] :at nil} (select-keys (reach/step off people t0 true) [:reached :at])) "held: nobody, no timer")
    (let [held (:offer (reach/step off people t0 true))]
      (is (= wed-03 (get-in held [:reach "p2" :next])) "held: the reads still say when"))
    (testing "the host was down across Bo's window: reached at his NEXT window, never outside hours"
      (let [after (+ wed-03 (* 9 hour))                               ; 12:00 Wed: his window closed at 11:00
            r     (reach/step off people after false)]
        (is (= ["p3"] (:reached r)) "Ana is out of hours too at 12:00")
        (is (= (+ wed-03 (* 24 hour)) (get-in r [:offer :reach "p2" :next])) "Bo: Thursday 03:00")
        (is (= (+ wed-03 (* 19 hour)) (:at r)) "the timer: the first of them, Ana's 22:00")))
    (testing "reached stays reached"
      (let [once (:offer (reach/step off people t0 false))]
        (is (= [] (:reached (reach/step once people (+ t0 minute) false))))))
    (is (reach/may-claim? {:to ["p1"]} "p1") "an offer from before r12 reached everyone")
    (is (not (reach/may-claim? {:to ["p1"] :reach {"p1" {:state "waiting"}}} "p1")))))
