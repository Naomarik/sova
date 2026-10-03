(ns sova.statecharts.refit.started-test
  "r11 (F-146 changed on purpose): one list of every build the project started (and of every gathering
   its placement started), cap 200; past it the oldest SETTLED one is retired, never a live one."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.refit.host :as h]
    [sova.statecharts.rules.started :as st]))

(def psid "project/pr1")
(defn sid [n] (str "build/pr1/c" n))
(defn project [] (h/start! (h/new-host) "project" psid {:id "pr1" :name "Site" :root "/r"}))
(defn noted [x from to] (reduce #(h/send! %1 psid :started/noted {:sid (sid %2) :kind "coding"}) x (range from to)))
(defn settle [x n] (h/send! x psid :link/moved {:from (sid n) :statechart "build" :states [:build :merged :turn-idle] :exported {}}))
(defn rows [x] (map :sid (:started (h/data x psid))))
(defn retired [x] (map :target (filter #(= :session/retire (:event %)) (h/elsewhere x))))

(def full (delay (noted (project) 0 200)))

(deftest overflow-retires-the-oldest-settled
  (let [x (-> @full (settle 7) (settle 3) (noted 200 201))]
    (is (= 200 (count (rows x))))
    (is (= [(sid 3)] (retired x)) "the oldest settled one, not the oldest")
    (is (not (some #{(sid 3)} (rows x))))
    (is (= (sid 0) (first (rows x))) "a live older one stays")))

(deftest a-list-of-201-live-retires-nothing
  (let [x (noted @full 200 201)]
    (is (= 201 (count (rows x))))
    (is (empty? (retired x)))))

(deftest once-one-settles-it-is-retired-on-the-next-write
  (let [x (-> @full (noted 200 202) (settle 5))]
    (is (= [(sid 5)] (retired x)))
    (is (= 201 (count (rows x))) "back toward 200 as they settle")
    (is (= 200 (count (rows (settle x 9)))))))

(deftest the-project-knows-its-last-merge
  (let [x  (noted (project) 0 2)
        mv (fn [x n at] (h/send! x psid :link/moved {:from (sid n) :statechart "build" :states [:build :merged :turn-idle] :exported {:merged {:at at :commit "c"}}}))
        y  (-> x (mv 0 50) (mv 1 40))]
    (is (= 50 (:last-merged-at (h/data y psid))) "the newest merge among its builds")
    (is (= 70 (:last-merged-at (h/data (mv y 1 70) psid))))
    (is (nil? (:last-merged-at (h/data (h/send! x psid :link/moved {:from "build/pr1/zz" :statechart "build" :states [:build :merged] :exported {:merged {:at 90}}}) psid)))
        "only a build it lists")))

(deftest the-placement-lists-its-gatherings
  (let [pl  "placement/o1/pr1"
        bs  (fn [n] (str "baton/o1/s" n))
        x   (reduce #(h/send! %1 pl :started/noted {:sid (bs %2) :kind "gathering"})
              (h/start! (h/new-host) "placement" pl {:org-id "o1" :project-id "pr1"}) (range 0 201))
        y   (h/send! x pl :link/moved {:from (bs 4) :statechart "baton" :states [:baton :closed :wrapup-done] :exported {}})]
    (is (= 201 (count (:started (h/data x pl)))))
    (is (= [(bs 4)] (map :target (filter #(= :session/retire (:event %)) (h/elsewhere y)))))))

(deftest settledness
  (is (st/settled? "baton" [:baton :done :wrapup-skipped]))
  (is (not (st/settled? "baton" [:baton :done :wrapup-running])) "its wrap-up is still running")
  (is (not (st/settled? "baton" [:baton :open :with-person])))
  (is (st/settled? "build" [:build :merged :turn-idle]))
  (is (not (st/settled? "build" [:build :merged :working])) "a turn is running")
  (is (not (st/settled? "build" [:build :unmerged :turn-idle]))))

(deftest a-live-session-never-retires
  (let [b  (h/start! (h/new-host) "baton" "baton/o1/s1" {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "T" :goal "G" :to "operator"
                                                         :owner {:overseer-of "pr1"} :names {} :operator-name "Omar"})]
    (is (h/in? (h/send! b "baton/o1/s1" :session/retire {}) "baton/o1/s1" :baton) "an open gathering stays")
    (let [closed (h/send! b "baton/o1/s1" :baton/close {:by "operator"})]
      (is (h/in? closed "baton/o1/s1" :wrapup-skipped))
      (is (false? (:com.fulcrologic.statecharts/running? (h/wmem (h/send! closed "baton/o1/s1" :session/retire {}) "baton/o1/s1")))
        "closed, nobody wrote: retired (final: the session ends)")))
  (let [bs "build/pr1/c1"
        b  (-> (h/start! (h/new-host) "build" bs {:project-id "pr1" :session-id "c1" :kind "coding" :title "T" :prompt "P"})
               (h/send! bs :effect/done {:kind "make-worktree" :result {:branch "sova/t" :target "main" :base "b0"}})
               (h/send! bs :effect/done {:kind "set-mode"}) (h/send! bs :effect/done {:kind "first-prompt"}))]
    (is (h/in? (h/send! b bs :session/retire {}) bs :build) "not merged: stays")))
