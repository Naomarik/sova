(ns sova.statecharts.refit.server4-findings-test
  "server-3/4's P2–P5 findings, one rule test each: the lease end moves on renew; a coding session's
   reasons fold per session and outcome and name a title even without one; Restore Their Words makes
   their words the promoted text again."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [sova.statecharts.refit.host :as h]))

(def op {:by "operator"})

;; ---- baton: lease/renew moves the offer's lease end (server-3 #5) -----------------------------------

(def sid "baton/o1/s1")
(defn offered []
  (h/start! (h/new-host) "baton" sid {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "T" :goal "G" :targets ["p1" "p2"]
                                      :lease-ms 1000 :owner {:overseer-of "pr1"} :names {"p1" "Ana" "p2" "Bob"} :operator-name "Omar"}))

(deftest the-lease-end-moves-when-it-renews
  (let [x  (h/send! (offered) sid :baton/message {:by "person" :from "p1" :active true})
        o0 (first (:offers (h/data x sid)))
        y  (-> x (h/advance! 400) (h/send! sid :reply/writing {}) (h/send! sid :reply/ended {}))
        o1 (first (:offers (h/data y sid)))]
    (is (h/in? y sid :leased))
    (is (= (+ (h/now x) 1000) (:lease-until o0)))
    (is (= (+ (h/now y) 1000) (:lease-until o1)) "the reply's end renewed it: now + lease-ms")
    (is (= (h/now y) (:last-activity-at o1)))))

;; ---- build: reasons fold per session and outcome; a title even without one (server-4 #5, #6) ---------

(def bsid "build/o1/pr1/c1")
(defn build [& [d]] (h/start! (h/new-host) "build" bsid (merge {:org-id "o1" :project-id "pr1" :session-id "c1" :kind "coding" :title "Pay page" :prompt "Build it"} d)))
(defn made [x] (-> x (h/send! bsid :effect/done {:kind "make-worktree" :result {:branch "sova/pay-abc123" :target "main" :base "b0"}})
                   (h/send! bsid :effect/done {:kind "set-mode"}) (h/send! bsid :effect/done {:kind "first-prompt"})))
(defn reasons [x] (filter #(= :reason/noted (:event %)) (h/elsewhere x)))

(deftest a-coding-sessions-reasons-fold
  (let [two (-> (made (build))
                (h/send! bsid :turn/started {}) (h/send! bsid :turn/ended {})
                (h/advance! 5000)
                (h/send! bsid :turn/started {}) (h/send! bsid :turn/ended {}))
        ks  (map #(get-in % [:data :key]) (filter #(= "coding/settled" (get-in % [:data :kind])) (reasons two)))]
    (is (= 2 (count ks)))
    (is (apply = ks) "two finished turns before a look: one reason (the watch folds by key)")
    (is (= "coding/settled:c1:ok" (first ks))))
  (testing "no start title: the branch names it"
    (let [x (-> (made (build {:title nil})) (h/send! bsid :turn/started {}) (h/send! bsid :turn/ended {}))]
      (is (= "sova/pay-abc123" (get-in (first (reasons x)) [:data :params :title]))))))

;; ---- decision: Restore Their Words makes them the promoted text again (server-4 #7) -------------------

(def dsid "decision/o1/pr1/s1:e1")
(defn edited []
  (-> (h/start! (h/new-host) "decision" dsid {:org-id "o1" :project-id "pr1" :id "s1:e1" :area "Pay" :owner-area "none" :statement "S"})
      (h/send! dsid :reconcile/result {:state "drafted" :record-id "§requirements.pay/s"})
      (h/send! dsid :promote/done {:text-hash "h1" :commit "abc"})
      (h/send! dsid :spec/facts {:edited-in-spec true})))

(deftest restore-their-words
  (let [kept     (h/send! (edited) dsid :decision/settle-text (assoc op :action "keep" :text-hash "h2"))
        again    (h/send! kept dsid :spec/facts {:edited-in-spec true})
        asked    (h/send! again dsid :decision/settle-text (assoc op :action "restore"))
        restored (h/send! asked dsid :effect/done {:kind "restore-text" :result {:restored true :text-hash "h1" :commit "def"}})
        d        (h/data restored dsid)]
    (is (h/in? restored dsid :as-promoted))
    (is (= "h1" (:promoted-text d)) "their words' hash, not the kept one")
    (is (= "def" (:promoted-commit d)))
    (is (nil? (:text-kept d)))
    (is (false? (:edited-in-spec d)))
    (is (h/in? (h/send! asked dsid :effect/failed {:kind "restore-text" :detail "x"}) dsid :edited-in-spec) "a failed restore leaves it edited")))
