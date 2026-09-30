(ns sova.statecharts.refit.started-test
  "r11 (F-146 changed on purpose): one list of every session the project started, cap 200; past it
   the oldest SETTLED one is retired, never a live one."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.refit.host :as h]
    [sova.statecharts.rules.started :as st]))

(def psid "project/o1/pr1")
(defn sid [n] (str "baton/o1/s" n))
(defn project [] (h/start! (h/new-host) "project" psid {:org-id "o1" :id "pr1" :name "Site" :root "/r"}))
(defn noted [x from to] (reduce #(h/send! %1 psid :started/noted {:sid (sid %2) :kind "gathering"}) x (range from to)))
(defn settle [x n] (h/send! x psid :link/moved {:from (sid n) :statechart "baton" :states [:baton :closed :wrapup-done] :exported {}}))
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
  (let [bs "build/o1/pr1/c1"
        b  (-> (h/start! (h/new-host) "build" bs {:org-id "o1" :project-id "pr1" :session-id "c1" :kind "coding" :title "T" :prompt "P"})
               (h/send! bs :effect/done {:kind "make-worktree" :result {:branch "sova/t" :target "main" :base "b0"}})
               (h/send! bs :effect/done {:kind "set-mode"}) (h/send! bs :effect/done {:kind "first-prompt"}))]
    (is (h/in? (h/send! b bs :session/retire {}) bs :build) "not merged: stays")))
