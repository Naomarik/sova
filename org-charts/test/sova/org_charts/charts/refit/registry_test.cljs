(ns sova.org-charts.charts.refit.registry-test
  "Registry-wide lints over the eleven charts."
  (:require
    [cljs.test :refer [deftest is]]
    [sova.org-charts.charts.refit.acts-golden :as ag]
    [sova.org-charts.charts.refit.acts-table :as at]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.engine.core :as core]))

(deftest no-transition-re-enters-a-whole-parallel
  (is (empty? (core/reentry-hazards registry/charts))
    "an external transition to its own source's descendant under a parallel re-enters every region (use :type :internal)"))

;; ---- r8(4) / F12: every held or person-reaching act has a confirm kind from the list ----------------

(def confirm-kinds
  "shared/project-overseer.ts CONFIRM_KINDS."
  #{"message" "gather" "offer" "close" "promote" "build" "prompt" "owner-update" "roster-approve" "roster-decline"})

(defn- acts [] (for [[chart {:keys [acts]}] registry/charts [ev m] acts] [chart ev m]))

(def one-person {:_event {:data {:to "p1"}}})
(def two-people {:_event {:data {:targets ["p1" "p2"]}}})

(defn- kinds
  "The kinds an act may take: a fn kind is resolved on a one-person and a two-person start."
  [m]
  (let [k (:confirm-kind m)]
    (cond (fn? k) #{(k one-person) (k two-people)} (some? k) #{k} :else #{})))

(deftest every-held-act-has-a-confirm-kind-from-the-list
  (doseq [[chart ev m] (acts) :when (:hold m)]
    (is (and (seq (kinds m)) (every? confirm-kinds (kinds m))) (str chart " " ev ": " (pr-str (kinds m))))))

(deftest every-confirm-kind-but-message-is-declared
  ;; r10: no act sends text into a gathering (F-128), so nothing is of kind "message"
  (is (= (disj confirm-kinds "message") (set (mapcat (fn [[_ _ m]] (kinds m)) (acts))))))

(deftest the-kind-of-each-act
  (is (= {["baton" :baton/offer] #{"offer"} ["baton" :baton/close] #{"close"}
          ["project" :baton/start] #{"gather" "offer"} ["item" :gather/start] #{"gather" "offer"}
          ["project" :build/start] #{"build"} ["item" :build/start] #{"build"} ["build" :build/prompt] #{"prompt"} ["project" :session/prompt] #{"prompt"}
          ["reconciler" :decision/promote] #{"promote"} ["project" :owner-update/post] #{"owner-update"}
          ["person" :person/approve] #{"roster-approve"} ["person" :person/decline] #{"roster-decline"}}
         (into {} (for [[chart ev m] (acts) :when (:confirm-kind m)] [[chart ev] (kinds m)])))))

(deftest a-start-to-two-or-more-people-is-an-offer
  (let [k (get-in registry/charts ["project" :acts :baton/start :confirm-kind])]
    (is (= "gather" (k one-person)))
    (is (= "gather" (k {:_event {:data {:to "operator"}}})))
    (is (= "offer" (k two-people)))))

;; ---- r8a: every transition declares its feed class --------------------------------------------------

(deftest every-transition-has-a-feed-class
  (is (empty? (core/unclassified registry/charts))
    "each transition declares :sova/feed :feed (moves an item, reaches a person or code) or :quiet (bookkeeping)"))

;; ---- every act's metadata (holds first: q10) ---------------------------------------------------------

(deftest every-acts-metadata-is-the-golden-one
  (let [now (at/table)
        bad (for [k (sort (into (set (keys now)) (keys ag/golden))) :when (not= (get now k) (get ag/golden k))]
              [k :now (get now k) :golden (get ag/golden k)])]
    (is (= 77 (count ag/golden)))
    (is (empty? bad) (str (count bad) " differ: " (pr-str (take 10 bad))))))

(deftest exactly-these-acts-are-held
  (is (= #{["baton" ":baton/close"] ["build" ":build/prompt"] ["item" ":build/start"] ["item" ":gather/start"]
           ["person" ":person/approve"] ["person" ":person/decline"] ["project" ":baton/start"] ["project" ":build/start"]
           ["project" ":owner-update/post"] ["project" ":session/prompt"] ["reconciler" ":decision/promote"]}
         (set (for [[k m] (at/table) :when (:hold m)] k)))))
