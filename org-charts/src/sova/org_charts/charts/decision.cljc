(ns sova.org-charts.charts.decision
  "The decision chart (portable, `decision/<org>/<p>/<did>`): one recorded decision
   (§app.requirements/decisions, /owner-area, /promotion).

   ```
   decision ‹compound›
   ├─ pending      recorded; not compared yet, or its last comparison failed
   ├─ conflicted   a side of an open conflict
   ├─ drafted      compared, no open conflict, in the project draft: promotable
   ├─ promoted ‹parallel›
   │   ├─ currency ‹current · stale›            stale: its record is missing or its decisions-owned fields differ (promotable again)
   │   ├─ text     ‹as-promoted · edited-in-spec› Keep Spec's Words / Restore Their Words
   │   └─ built    ‹not-built · built›           its record has code and reviewed or verified evidence
   └─ superseded   `supersededBy`
   ```

   C16: what the reconciler decided is chart state (its run's results, `reconcile/result`); what the
   project's spec says stays a fact (`spec/facts`, sent after a promotion, at resume and when the
   spec's manifest changes). Born by its baton's `record_decision` (or a settle by hand); on birth it
   tells its reconciler and its item, which watch it.

   Start data: DecisionRow's recorded fields `{:org-id :project-id :id :area :area-key :owner-area
   :statement :quote :by :name :session-id :entry-id :marker-id :item :resolves :shown :recorded-at}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry script Send]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.baton :as rb]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)

(def result-states {"pending" :pending "conflict" :conflicted "drafted" :drafted "superseded" :superseded})

(defn result [d] (b/evt d))
(defn result-to? [s] (fn [_ d] (= s (:state (result d)))))

(def result-keys [:record-id :superseded-by :folded :checked-with :author-owns-area :area-key :resolves])

(defn take-result-ops [d]
  (let [res (result d)]
    (into [] (for [k result-keys :when (contains? res k)] (ops/assign k (get res k))))))

(defn- state-name [s] (on-entry {} (script {:expr (fn [_ _] [(ops/assign :state s)])})))

(defn- result-transitions
  "The reconciler's verdict moves the decision, from wherever it is (a promoted one compared again
   and found in conflict, superseded or restated included)."
  [here & [keep-on]]
  (for [[s target] result-states :when (and (not= target here) (not (contains? keep-on s)))]
    (transition {:sova/feed :feed :event :reconcile/result :cond (result-to? s) :target target}
      (script {:expr (fn [_ d] (take-result-ops d))}))))

(defn- same-result [here-state]
  (transition {:sova/feed :quiet :event :reconcile/result :cond (result-to? here-state)}
    (script {:expr (fn [_ d] (take-result-ops d))})))

;; ---- owner area --------------------------------------------------------------------------------------

(defn owner-area-check
  "A roster decision area (as the host lists them, `owner-areas`) or none; never on a superseded one."
  [d]
  (if (= "superseded" (:state d))
    (r/refuse 409 "That decision was superseded: its owner area no longer decides anything.")
    (rb/owner-area-refusal (b/evt d))))

(defn new-owner-area [d] (rb/spelled-owner-area (b/evt d)))
(defn owner-area-changes? [_ d] (not= (new-owner-area d) (:owner-area d)))

(defn owner-area-ops [d]
  (let [ev (b/evt d)]
    [(ops/assign :owner-area-history (conj (vec (:owner-area-history d))
                                       {:at (b/now-ms d) :by "operator" :name (:operator-name ev) :from (:owner-area d) :to (new-owner-area d)}))
     (ops/assign :owner-area (new-owner-area d))
     (ops/assign :author-owns-area (true? (:author-owns-area ev)))]))

;; ---- spec facts --------------------------------------------------------------------------------------

(defn fact [d k] (get (b/evt d) k))
(defn stale? [d] (or (false? (:record-present d)) (false? (:fields-match d))))
(defn edited? [d] (true? (:edited-in-spec d)))
(defn built? [d] (= "built" (:build d)))

(defn facts-ops [d]
  (let [ev (b/evt d)]
    (into [] (for [k [:record-present :fields-match :edited-in-spec :build] :when (contains? ev k)] (ops/assign k (get ev k))))))

(def text-check
  (fn [d] (when-not (edited? d) (r/refuse 409 "Its words in the spec are as they were promoted."))))

(def chart
  (statechart {:initial :decision}
    (state {:id :decision :initial :pending}
      (on-entry {}
        (script {:expr (fn [_ d] [(ops/assign :at (or (:recorded-at d) (b/now-ms d)))])})
        ;; its reconciler and its item watch it from now on
        (Send {:event :decision/recorded :targetexpr (fn [_ d] (b/reconciler-sid (:org-id d) (:project-id d)))
               :content (fn [_ d] {:id (:id d) :sid (b/decision-sid (:org-id d) (:project-id d) (:id d))})}))
      (dsl/hold-cancel-correction)

      (transition {:sova/feed :quiet :event :spec/facts} (script {:expr (fn [_ d] (facts-ops d))}))
      ;; the same area again: nothing changes, nothing is logged
      (dsl/act {:sova/feed :feed :event :decision/owner-area :checks [owner-area-check] :cond (fn [e d] (not (owner-area-changes? e d)))})
      (dsl/act {:sova/feed :feed :event :decision/owner-area :checks [owner-area-check] :cond owner-area-changes?}
        (script {:expr (fn [_ d] (owner-area-ops d))})
        ;; a side of an open conflict: its conflict is routed again (a new session only when the target changes)
        (Send {:event :decision/owner-area-changed :targetexpr (fn [_ d] (b/reconciler-sid (:org-id d) (:project-id d)))
               :content (fn [_ d] {:id (:id d) :owner-area (:owner-area d) :author-owns-area (:author-owns-area d)})}))

      (state {:id :pending} (state-name "pending") (result-transitions :pending) (same-result "pending"))
      (state {:id :conflicted} (state-name "conflict") (result-transitions :conflicted) (same-result "conflict"))
      (state {:id :drafted} (state-name "drafted") (result-transitions :drafted) (same-result "drafted")
        (transition {:sova/feed :feed :event :promote/done :target :promoted}
          (script {:expr (fn [_ d] (let [ev (b/evt d)]
                                     [(ops/assign :promoted-at (b/now-ms d)) (ops/assign :promoted-text (:text-hash ev))
                                      (ops/assign :promoted-commit (:commit ev)) (ops/assign :record-present true)
                                      (ops/assign :fields-match true) (ops/assign :edited-in-spec false)]))})
          (Send {:event :milestone/noted :targetexpr (fn [_ d] (b/project-sid (:org-id d) (:project-id d)))
                 :content (fn [_ d] {:kind "decision-promoted" :shown (not (false? (:shown d)))})})))

      (state {:id :promoted}
        (state-name "promoted")
        ;; a promoted one's fields come as "drafted": it stays promoted and takes them; it leaves
        ;; only for conflict or superseded (and goes stale through the facts)
        (result-transitions :promoted #{"drafted"})
        (transition {:sova/feed :quiet :event :reconcile/result :cond (result-to? "drafted")}
          (script {:expr (fn [_ d] (take-result-ops d))}))
        (parallel {:id :promoted-regions}
          (state {:id :currency :initial :current}
            (state {:id :current} (transition {:sova/feed :feed :cond (fn [_ d] (stale? d)) :target :stale}))
            ;; promotable again: a promotion of it re-promotes
            (state {:id :stale}
              (transition {:sova/feed :feed :cond (fn [_ d] (not (stale? d))) :target :current})
              (transition {:sova/feed :feed :event :promote/done :target :current}
                (script {:expr (fn [_ d] (let [ev (b/evt d)]
                                           [(ops/assign :promoted-at (b/now-ms d)) (ops/assign :promoted-text (:text-hash ev))
                                            (ops/assign :promoted-commit (:commit ev)) (ops/assign :record-present true) (ops/assign :fields-match true)]))}))))
          (state {:id :text :initial :as-promoted}
            (state {:id :as-promoted} (transition {:sova/feed :feed :cond (fn [_ d] (edited? d)) :target :edited-in-spec}))
            (state {:id :edited-in-spec}
              (transition {:sova/feed :feed :cond (fn [_ d] (not (edited? d))) :target :as-promoted})
              ;; Keep Spec's Words: the spec's prose becomes the promoted text
              (dsl/act {:sova/feed :feed :event :decision/settle-text :target :as-promoted :checks [text-check]
                        :cond (fn [_ d] (= "keep" (:action (b/evt d))))}
                (script {:expr (fn [_ d] (let [ev (b/evt d)]
                                           [(ops/assign :text-kept {:at (b/now-ms d) :by "operator" :name (:operator-name ev)})
                                            (ops/assign :promoted-text (:text-hash ev)) (ops/assign :edited-in-spec false)]))}))
              ;; Restore Their Words: the prose re-promoted (committed)
              (dsl/act {:sova/feed :feed :event :decision/settle-text :checks [text-check] :cond (fn [_ d] (= "restore" (:action (b/evt d))))}
                (dsl/effect :restore-text (fn [d] {:id (:id d) :record-id (:record-id d)})))))
          (state {:id :built :initial :not-built}
            (state {:id :not-built} (transition {:sova/feed :feed :cond (fn [_ d] (built? d)) :target :built-done}))
            (state {:id :built-done} (transition {:sova/feed :feed :cond (fn [_ d] (not (built? d))) :target :not-built})))))

      (state {:id :superseded} (state-name "superseded")
        (result-transitions :superseded)
        ;; a restatement folded into it: it keeps collecting them (they share its fate)
        (same-result "superseded")))))

(def acts
  {:decision/owner-area  {:needs nil}
   :decision/settle-text {:needs nil}
   :hold/cancel          {:needs "L0" :correction true}})

(defn not-here [event config _data]
  (case event
    :decision/settle-text "Its words in the spec are as they were promoted."
    "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:state :area :area-key :owner-area :author-owns-area :by :name :statement :record-id :superseded-by
              :folded :item :session-id :promoted-at :build :edited-in-spec :record-present :fields-match :shown :resolves]
   :acts     acts
   :not-here not-here
   :cold?    (fn [config _] (contains? config :superseded))})
