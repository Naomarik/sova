(ns sova.org-charts.charts.refit.hours-test
  "r7: a person's next working window, on fixed clocks and zones (DST both ways, overnight windows,
   no hours = always open), and the tz/hours sentences. Runs on the JVM and in CLJS (Intl)."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.org-charts.charts.rules.hours :as hours]))

(defn at [s] #?(:clj (.toEpochMilli (java.time.Instant/parse s)) :cljs (.getTime (js/Date. s))))

(def weekdays [1 2 3 4 5])
(def ist {:tz "Europe/Istanbul" :hours {:days weekdays :from "09:00" :to "17:00"}})

(deftest a-fixed-offset-zone
  ;; 2026-03-02 is a Monday; Istanbul is UTC+3 all year
  (is (nil? (hours/next-window ist (at "2026-03-02T06:00:00Z"))) "09:00 there: open")
  (is (nil? (hours/next-window ist (at "2026-03-02T13:59:59Z"))))
  (is (= (at "2026-03-02T06:00:00Z") (hours/next-window ist (at "2026-03-02T05:59:00Z"))) "08:59: opens at 09:00")
  (is (= (at "2026-03-03T06:00:00Z") (hours/next-window ist (at "2026-03-02T14:00:00Z"))) "17:00 is closed: tomorrow")
  (is (= (at "2026-03-09T06:00:00Z") (hours/next-window ist (at "2026-03-06T14:30:00Z"))) "Friday evening: Monday")
  (is (= (at "2026-03-09T06:00:00Z") (hours/next-window ist (at "2026-03-08T12:00:00Z"))) "Sunday: Monday"))

(deftest no-hours-is-always-open
  (is (nil? (hours/next-window {} (at "2026-03-08T12:00:00Z"))))
  (is (nil? (hours/next-window {:tz "Europe/Istanbul"} (at "2026-03-08T12:00:00Z"))))
  (is (nil? (hours/next-window {:hours (:hours ist)} (at "2026-03-08T12:00:00Z"))) "no zone: no check")
  (is (nil? (hours/open-now? {} 0))))

(deftest an-overnight-window
  ;; Monday 22:00 → Tuesday 06:00, Istanbul
  (let [p {:tz "Europe/Istanbul" :hours {:days [1] :from "22:00" :to "06:00"}}]
    (is (nil? (hours/next-window p (at "2026-03-03T00:00:00Z"))) "Tuesday 03:00: inside Monday's window")
    (is (= (at "2026-03-09T19:00:00Z") (hours/next-window p (at "2026-03-03T03:00:00Z"))) "Tuesday 06:00: next Monday 22:00")
    (is (= (at "2026-03-02T19:00:00Z") (hours/next-window p (at "2026-03-02T10:00:00Z"))))))

(deftest daylight-saving
  (testing "spring forward (Berlin, 2026-03-29 02:00 → 03:00): 02:30 doesn't exist, it is 03:30 CEST"
    (let [p {:tz "Europe/Berlin" :hours {:days [0] :from "02:30" :to "04:00"}}]
      (is (= (at "2026-03-29T01:30:00Z") (hours/next-window p (at "2026-03-29T00:00:00Z"))))))
  (testing "fall back (Berlin, 2026-10-25 03:00 → 02:00): 02:30 happens twice, the first one counts"
    (let [p {:tz "Europe/Berlin" :hours {:days [0] :from "02:30" :to "04:00"}}]
      (is (= (at "2026-10-25T00:30:00Z") (hours/next-window p (at "2026-10-24T22:00:00Z"))))
      (is (nil? (hours/next-window p (at "2026-10-25T01:45:00Z"))) "02:45 CET, the second pass: still inside")))
  (testing "a weekend across a change (New York, 2026-03-08): Monday 09:00 is EDT, 13:00Z"
    (let [p {:tz "America/New_York" :hours {:days weekdays :from "09:00" :to "12:00"}}]
      (is (= (at "2026-03-09T13:00:00Z") (hours/next-window p (at "2026-03-06T18:00:00Z"))))
      (is (= (at "2026-03-06T14:00:00Z") (hours/next-window p (at "2026-03-06T12:00:00Z"))) "Friday 09:00 was EST, 14:00Z"))))

(deftest hours-now-for-reads
  (is (= {:open true} (hours/open-now? ist (at "2026-03-02T06:00:00Z"))))
  (is (= {:open false :next-open (at "2026-03-03T06:00:00Z")} (hours/open-now? ist (at "2026-03-02T14:00:00Z")))))

(deftest the-sentences
  (is (nil? (hours/tz-problem "Europe/Istanbul")))
  (is (nil? (hours/tz-problem nil)))
  (is (nil? (hours/tz-problem "")) "empty clears it")
  (is (= "tz must be an IANA time zone, like Europe/Istanbul" (hours/tz-problem "Mars/Olympus")))
  (is (nil? (hours/hours-problem nil)))
  (is (nil? (hours/hours-problem (:hours ist))))
  (is (= "hours must be { days, from, to } or null" (hours/hours-problem "9-5")))
  (is (= "hours.days must list days 0–6 (0 is Sunday), each once" (hours/hours-problem {:days [7] :from "09:00" :to "17:00"})))
  (is (= "hours.days must list days 0–6 (0 is Sunday), each once" (hours/hours-problem {:days [1 1] :from "09:00" :to "17:00"})))
  (is (= "hours.days must list days 0–6 (0 is Sunday), each once" (hours/hours-problem {:days [] :from "09:00" :to "17:00"})))
  (is (= "hours.from and hours.to must be times like 09:00" (hours/hours-problem {:days [1] :from "9:00" :to "17:00"})))
  (is (= "hours.from and hours.to must be times like 09:00" (hours/hours-problem {:days [1] :from "09:00" :to "24:00"})))
  (is (= "hours.from and hours.to must differ" (hours/hours-problem {:days [1] :from "09:00" :to "09:00"}))))

(deftest reaching-several-people
  (let [now  (at "2026-03-02T05:00:00Z")
        open {:tz "Europe/Istanbul" :hours {:days [1] :from "07:00" :to "17:00"}}
        late {:tz "Europe/Istanbul" :hours {:days [1] :from "10:00" :to "17:00"}}]
    (is (nil? (hours/reach-window [] now)))
    (is (nil? (hours/reach-window [ist open] now)) "one of them is in hours: it goes")
    (is (nil? (hours/reach-window [ist {:name "no hours"}] now)) "someone without hours is always open")
    (is (= (at "2026-03-02T06:00:00Z") (hours/reach-window [ist late] now)) "else the earliest window")))
