(ns sova.org-charts.charts.refit.company-hours-test
  "r13 (q16): the company's working hours are its people's default. Own hours win when set; neither
   means always in hours. The org sets them (operator only, a person's validation); each person's
   chart reads the org's and exports its effective hours; an offer's reach re-reckons from them."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.org-charts.charts.refit.host :as h]
    [sova.org-charts.charts.rules.baton :as rb]
    [sova.org-charts.charts.rules.hours :as hours]
    [sova.org-charts.charts.rules.person :as rp]))

(def every-day [0 1 2 3 4 5 6])
(def own {:tz "Europe/Istanbul" :hours {:days [1 2 3 4 5] :from "09:00" :to "17:00"}})
(def company {:tz "UTC" :hours {:days every-day :from "03:00" :to "11:00"}})
(def op {:by "operator"})

(deftest the-rule
  (is (= own (hours/effective own company)) "own over company")
  (is (not (hours/inherited? own company)))
  (is (= company (hours/effective {:name "Bo"} company)) "company only")
  (is (hours/inherited? {:name "Bo"} company))
  (is (nil? (hours/effective {:name "Bo"} nil)) "neither: always in hours")
  (is (nil? (hours/effective {:name "Bo"} {:tz "UTC"})) "a company zone without hours is no hours")
  (is (= company (hours/effective {:tz "Europe/Istanbul"} company)) "a zone alone of their own is no hours: the company's"))

;; ---- the org sets them ----------------------------------------------------------------------------

(def osid "org/o1")
(defn org [] (h/start! (h/new-host) "org" osid {:id "o1" :name "Acme"}))

(deftest the-org-sets-them
  (let [x (org)
        y (h/send! x osid :org/hours (merge op company))]
    (is (= company (select-keys (h/data y osid) [:tz :hours])))
    (is (= "Only the operator sets the company's working hours." (h/refusal x osid :org/hours (merge {:by "overseer"} company))))
    (is (= "tz must be an IANA time zone, like Europe/Istanbul" (h/refusal x osid :org/hours (assoc op :tz "Mars/Olympus"))) "a person's sentences")
    (is (= "hours.from and hours.to must differ" (h/refusal x osid :org/hours (assoc op :hours {:days [1] :from "09:00" :to "09:00"}))))
    (testing "cleared with null / \"\""
      (let [c (h/send! y osid :org/hours (assoc op :tz "" :hours nil))]
        (is (nil? (:tz (h/data c osid))))
        (is (nil? (:hours (h/data c osid))))))))

;; ---- each person reads them -------------------------------------------------------------------------

(def psid "person/o1/p1")
(defn person [p]
  (let [{:keys [person changed]} (rp/apply-change nil (merge {:name "Bo" :status "active"} p) "operator" #{})]
    (h/start! (h/new-host) "person" psid {:org-id "o1" :id "p1" :person person :changed changed :by {:kind "operator"}})))
(defn org-moved [x c] (h/send! x psid :link/moved {:from osid :chart "org" :states [:org :owner-none] :exported (merge {:name "Acme"} c)}))
(defn eff [x] (select-keys (h/data x psid) [:effective-hours :hours-inherited]))

(deftest each-person-reads-them
  (is (some #(= {:op :watch :target osid} %) (h/directives (person {}) psid)) "the person watches its org")
  (is (= {:effective-hours company :hours-inherited true} (eff (org-moved (person {}) company))) "company only")
  (is (= {:effective-hours own :hours-inherited false} (eff (org-moved (person own) company))) "own over company")
  (is (= {:effective-hours nil :hours-inherited false} (eff (org-moved (person {}) {}))) "neither")
  (testing "their own cleared: the company's again; the company's cleared: always in hours"
    (let [x (org-moved (person own) company)
          y (h/send! x psid :person/edit (assoc op :patch {:tz nil :hours nil} :names-taken #{}))]
      (is (= {:effective-hours company :hours-inherited true} (eff y)))
      (is (= {:effective-hours nil :hours-inherited false} (eff (org-moved y {:tz nil :hours nil})))))))

;; ---- a company edit re-arms an offer's reach --------------------------------------------------------

(deftest a-company-edit-re-arms-reach
  ;; the host's clock: Tuesday 2023-11-14 22:13:20 UTC; Bo has no hours of his own
  (let [bsid "baton/o1/s1"
        t0 1700000000000
        wed-03 (+ t0 (* 4 3600000) (* 46 60000) 40000)
        x (h/start! (h/new-host) "baton" bsid {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "Logo" :goal "G"
                                               :owner {:overseer-of "pr1"} :targets ["p1" "p2"] :names {"p1" "Ana" "p2" "Bo"}
                                               :target-people [{:id "p1" :name "Ana"} {:id "p2" :name "Bo"}]})
        timers #(filter (fn [p] (= :offer/reach (first p))) (h/pending % bsid))
        moved (fn [y ex] (h/send! y bsid :link/moved {:from "person/o1/p2" :chart "person" :states [:person :active]
                                                      :exported (merge {:name "Bo" :tz nil :hours nil} ex)}))]
    (is (= "reached" (get-in (rb/current-offer (h/data x bsid)) [:reach "p2" :state])) "no hours anywhere: reached at once")
    (let [y (h/start! (h/new-host) "baton" bsid {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "Logo" :goal "G"
                                                 :owner {:overseer-of "pr1"} :targets ["p1" "p2"] :names {"p1" "Ana" "p2" "Bo"}
                                                 :target-people [{:id "p1" :name "Ana"} (merge {:id "p2" :name "Bo"} (assoc company :hours (assoc (:hours company) :from "05:00")))]})]
      (is (= [[:offer/reach (+ wed-03 (* 2 3600000))]] (timers y)) "the company's 05:00, stamped as his effective hours")
      (is (= [[:offer/reach wed-03]] (timers (moved y {:effective-hours company :hours-inherited true}))) "the company moved to 03:00: re-armed")
      (is (= "reached" (get-in (rb/current-offer (h/data (moved y {:effective-hours nil :hours-inherited false}) bsid)) [:reach "p2" :state]))
          "the company's hours cleared: always in hours, reached at once"))))
