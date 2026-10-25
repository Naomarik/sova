(ns sova.statecharts.refit.registry-test
  "Registry-wide lints over the twelve statecharts."
  (:require
    [cljs.test :refer [deftest is]]
    [sova.statecharts.refit.acts-golden :as ag]
    [sova.statecharts.refit.acts-table :as at]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.powers :as pw]
    [sova.statecharts.engine.core :as core]))

(deftest no-transition-re-enters-a-whole-parallel
  (is (empty? (core/reentry-hazards registry/statecharts))
    "an external transition to its own source's descendant under a parallel re-enters every region (use :type :internal)"))

;; ---- al_3: every act maps to exactly one power, "always" or "operator" ----------------------------------

(defn- acts [] (for [[statechart {:keys [acts]}] registry/statecharts [ev m] acts] [statechart ev m]))

(def kinds (into #{"always" "operator"} pw/powers))

(deftest every-act-of-a-tool-has-one-power-from-the-list
  ;; an act a tool (or a drive) makes names exactly one power, or always/operator; other acts (the
  ;; operator's and people's own) are nobody's column and name none
  (doseq [[statechart ev m] (acts) :when (:tool m)]
    (is (contains? kinds (:power m)) (str statechart " " ev ": " (pr-str (:power m)))))
  (doseq [[statechart ev m] (acts) :when (contains? m :needs)]
    (is false (str statechart " " ev " still declares a level"))))

(deftest every-held-act-has-a-switchable-power
  ;; what waits in a hold reaches a person or the code: never an always-allowed act
  (doseq [[statechart ev m] (acts) :when (:hold m)]
    (is (contains? (set pw/powers) (:power m)) (str statechart " " ev ": " (pr-str (:power m))))))

(deftest no-act-has-a-confirm-kind-and-nothing-approves-a-hold
  (is (empty? (for [[sc ev m] (acts) :when (:confirm-kind m)] [sc ev])) "al_3 q2: the confirmation checklist is gone")
  (is (empty? (for [[sc ev _] (acts) :when (= ev :hold/approve)] sc)) "no hold waits for an approval"))

(deftest a-tool-backed-by-acts-of-two-powers-is-per-op
  ;; sova_project_verbs, sova_correct, sova_roster's approve/decline (one power), sova_start_gathering
  ;; (gather; its plan is always): the tools whose acts differ in power are the per-op ones
  (let [by-tool (reduce (fn [acc [_ _ m]] (if (:tool m) (update acc (:tool m) (fnil conj #{}) (:power m)) acc)) {} (acts))]
    (is (= {"sova_correct" #{"bookkeeping" "markMerged"}
            "sova_idea" #{"always"}
            "sova_start_gathering" #{"always" "gather"}
            "sova_project_verbs" #{"always" "copiesRun" "copiesReset" "share" "onboard" "deploy"}}
           (select-keys by-tool ["sova_correct" "sova_idea" "sova_start_gathering" "sova_project_verbs"])))
    (doseq [t ["sova_close_gathering" "sova_send_to_person" "sova_owner_update" "sova_roster" "sova_promote" "sova_create_session" "sova_send" "sova_preview" "sova_reconcile"]]
      (is (= 1 (count (get by-tool t))) t))))

(deftest the-power-table-matches-shared-powers
  ;; shared/powers.ts POWER_INFO, as the statecharts keep it (a server test compares the bundle's copy too)
  (is (= ["gather" "whatsapp" "ownerUpdates" "roster" "promote" "bookkeeping" "codingStart" "codingPrompt" "onboard" "markMerged" "copiesRun" "copiesReset" "share" "deploy"] pw/powers))
  (is (= {"L1" #{"gather" "whatsapp" "ownerUpdates" "bookkeeping" "share"} "L2" #{"roster" "promote" "markMerged"}
          "L3" #{"codingStart" "codingPrompt" "onboard" "copiesRun" "copiesReset"} nil #{"deploy"}}
         (reduce (fn [acc p] (update acc (:old (pw/info p)) (fnil conj #{}) p)) {} pw/powers)))
  (is (= #{"gather" "codingStart" "codingPrompt" "copiesRun" "deploy"} (set (filter #(:assistant (pw/info %)) pw/powers)))))

;; ---- r8a: every transition declares its feed class --------------------------------------------------

(deftest every-transition-has-a-feed-class
  (is (empty? (core/unclassified registry/statecharts))
    "each transition declares :sova/feed :feed (moves an item, reaches a person or code) or :quiet (bookkeeping)"))

;; ---- every act's metadata (holds first: q10) ---------------------------------------------------------

(deftest every-acts-metadata-is-the-golden-one
  (let [now (at/table)
        bad (for [k (sort (into (set (keys now)) (keys ag/golden))) :when (not= (get now k) (get ag/golden k))]
              [k :now (get now k) :golden (get ag/golden k)])]
    (is (= 83 (count ag/golden)))
    (is (empty? bad) (str (count bad) " differ: " (pr-str (take 10 bad))))))

(deftest exactly-these-acts-are-held
  (is (= #{["baton" ":baton/close"] ["build" ":build/prompt"] ["item" ":build/start"] ["item" ":gather/start"]
           ["person" ":person/approve"] ["person" ":person/decline"] ["placement" ":baton/start"] ["project" ":build/start"]
           ["placement" ":owner-update/post"] ["placement" ":outreach/send"] ["project" ":preview/start"] ["project" ":services/share"] ["project" ":session/prompt"] ["project" ":verbs/onboard"] ["reconciler" ":decision/promote"]
           ["project" ":deploy/run"]}
         (set (for [[k m] (at/table) :when (:hold m)] k)))))
