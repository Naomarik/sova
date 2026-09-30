(ns sova.org-charts.charts.refit.holds-test
  "Holds on the real item chart, through the engine (the JVM host records holds, it doesn't run them):
   F2, a pending gathering hold reserves its slot, so with one slot left the first unattended start is
   held and the second refused at once with today's sentence; cancelling the first frees it."
  (:require
    [cljs.test :refer [deftest is testing]]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.engine.core :as core]))

(def t0 1000000)
(def sid "item/o1/pr1/g_1")

(defn- item-engine []
  (let [eng (core/new-engine registry/charts {:level-check lv/level-check :absorb-unknown true})]
    (core/start! eng sid "item" {:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/x"} t0)
    (core/send! eng sid :link/moved {:from "watch/o1/pr1" :chart "watch" :states [:watch]
                                     :exported {:settings {:autonomy "L3"} :roster-active true}} {:now t0})
    eng))

(defn- unattended [allowance at-once]
  {:by "overseer" :autonomy "L3" :roster-active true :paused false :archived false :ledger "day"
   :hold-ms 600000 :project-id "pr1" :overseer-id "po1"
   :allowance {:gather allowance :promote {:used 0 :max 60} :create {:used 0 :max 4} :prompt {:used 0 :max 12}}
   :at-once (merge {:gatherings-open 0 :gatherings-cap 5 :coding-running 0 :coding-cap 2} at-once)})

(defn- gather [to n] {:session-id (str "b" n) :to to :public-title "T" :goal "G" :question "Q"})

(defn- first-step [r] (first (:steps r)))
(defn- act-step "The gathering start's own step (a clock jump fires due timers first)."
  [r] (first (filter #(= :gather/start (:event %)) (:steps r))))

(defn- one-slot-left [label env sentence]
  (testing label
    (let [eng (item-engine)
          r1  (core/send! eng sid :gather/start (merge (gather "p1" 1) env) {:now t0})
          r2  (core/send! eng sid :gather/start (merge (gather "p2" 2) env) {:now (+ t0 1)})]
      (is (some? (:held (first-step r1))) "the first is held")
      (is (= sentence (:sentence (:refused (first-step r2)))) "the second is refused at once, never held")
      (is (= 1 (count (core/holds eng))))
      (let [id (:id (first (core/holds eng)))
            rc (core/send! eng sid :hold/cancel {:by "operator" :id id} {:now (+ t0 2)})]
        (is (= [:hold/cancel :hold/cancelled] (map :event (:steps rc)))))
      (is (empty? (core/holds eng)) "a cancelled hold was never counted")
      (let [r3 (core/send! eng sid :gather/start (merge (gather "p3" 3) env) {:now (+ t0 3)})]
        (is (some? (:held (first-step r3))) "the slot is free again: a third is held")))))

(deftest F2-one-slot-left-holds-one-and-refuses-the-next
  (one-slot-left "day allowance: 5 of 6 used"
    (unattended {:used 5 :max 6} {})
    "Today's allowance is used: 6 of 6 gathering sessions started on its own. It looks again at midnight.")
  (one-slot-left "at once: 4 of 5 open"
    (unattended {:used 0 :max 6} {:gatherings-open 4})
    "5 of its gathering sessions are open, and the limit is 5 at once."))

(deftest F12-a-gathering-waits-past-its-hold-only-when-its-kind-is-on-the-confirm-list
  (let [env (unattended {:used 0 :max 6} {})
        run (fn [kinds]
              (let [eng (item-engine)]
                (core/send! eng sid :gather/start (merge (gather "p1" 1) env {:confirm-kinds kinds}) {:now t0})
                {:held (first (core/holds eng)) :end (core/fire-due! eng (+ t0 600000)) :eng eng}))]
    (let [{:keys [held end eng]} (run ["gather"])]
      (is (true? (:confirm held)) "gather/start is of kind gather")
      (is (= [:hold/waiting] (map :event (:steps end))) "at its end it waits for the overseer")
      (is (= [true] (map :waiting (core/holds eng)))))
    (let [{:keys [held end eng]} (run (remove #{"gather"} ["message" "gather" "offer" "close" "promote" "build" "prompt" "owner-update" "roster-approve" "roster-decline"]))]
      (is (not (:confirm held)))
      (is (not= [:hold/waiting] (map :event (:steps end))) "off the list: it goes ahead at its end")
      (is (empty? (core/holds eng))))))

(deftest r7-a-gathering-to-someone-off-hours-waits-for-their-window
  ;; Thursday 2026-03-05 00:16Z is 03:16 in Istanbul (UTC+3); their day starts 09:00 (06:00Z)
  (let [ana    {:id "p1" :name "Ana" :status "active" :tz "Europe/Istanbul" :hours {:days [0 1 2 3 4 5 6] :from "09:00" :to "17:00"}}
        night  (.getTime (js/Date. "2026-03-05T00:16:00Z"))
        window (.getTime (js/Date. "2026-03-05T06:00:00Z"))
        env    (assoc (unattended {:used 0 :max 6} {}) :hold-ms 0 :target ana)]
    (testing "unattended: an hours wait until the window"
      (let [eng (item-engine)
            r   (core/send! eng sid :gather/start (merge (gather "p1" 1) env) {:now night})
            h   (first (core/holds eng))]
        (is (= "hours" (:wait h)))
        (is (= window (:until h)))
        (is (not (contains? (:batons (core/data eng sid)) "baton/o1/b1")) "not started yet")
        (is (some? (:held (act-step r))))))
    (testing "in hours it goes at once"
      (let [eng (item-engine)]
        (core/send! eng sid :gather/start (merge (gather "p1" 1) env) {:now (+ window 1)})
        (is (empty? (core/holds eng)))))
    (testing "the operator's click goes at once, marked off-hours"
      (let [eng (item-engine)
            r   (core/send! eng sid :gather/start (merge (gather "p1" 1) {:by "operator" :target ana}) {:now night})]
        (is (empty? (core/holds eng)))
        (is (= window (:off-hours (act-step r))))))))
