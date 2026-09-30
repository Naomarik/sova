(ns sova.org-charts.charts.reconciler
  "The reconciler chart (portable, `reconciler/<org>/<p>`): the project's decisions as one queue
   (§app.requirements/reconciler, /promotion, /routing, /drafts-with-provenance).

   ```
   reconciler ‹compound›
   ├─ off          Reconcile decisions is off: only reconcile/request is refused (an automatic
   │               request records the error); promoting, drafting, routing, settling by hand and
   │               owner areas work as when idle (W24)
   ├─ idle
   ├─ debouncing   a request with a delay (2 s for a settle session's decision), durable (C4)
   ├─ running      :sova/reconcile (the decide seam's calls: area joins, pair questions, restatements,
   │               settlements); a request meanwhile runs it once more after (never two at once)
   └─ failed       the last run's error; new decisions stay pending
   ```

   It watches every decision of the project (each tells it at birth) and keeps their index, which the
   promotion's per-id checks read. A run's results fan out: `reconcile/result` to each decision, a
   spawned `conflict` per new conflict (the host routed it), `conflict/resolved` to settled ones,
   and typed reasons to the watch (`by` who asked). Promotion is one effect per request (the host
   writes the spec and commits); only what was promoted counts on the ledger.

   Start data: `{:org-id :project-id :enabled?}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state transition on-entry on-exit script Send cancel invoke raise]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)
(def reconcile-off "Turn on Reconcile decisions in Settings → Decisions.")

(defn e [d] (b/evt d))
(defn enabled? [d] (not (false? (:enabled d))))
(defn auto? [d] (= "sova" (some-> (:by (e d)) name)))

;; ---- the index ------------------------------------------------------------------------------------

(defn index-ops
  "A watched decision moved: its row in the index (state, author-owns-area, name)."
  [d]
  (let [m (b/moved d) ex (:exported m)]
    [(ops/assign [:index (b/last-part (:from m))]
       (merge (select-keys ex [:state :author-owns-area :name :area-key :item :record-id :superseded-by])
         {:sid (:from m)}))]))

;; ---- promotion ------------------------------------------------------------------------------------

(defn promote-ids [d] (vec (distinct (map str (:ids (e d))))))

(defn promote-kind
  "operator-explicit (by id), bulk (Select All Ready), overseer (its tool, or the chart's own at L2)."
  [d]
  (let [ev (e d)]
    (cond
      (contains? #{"overseer" "chart"} (some-> (:by ev) name)) "overseer"
      (:bulk ev) "bulk"
      :else "operator-explicit")))

(defn verdicts
  "promoteDecisions' per-id refusals, in its order, over the index: `[[id reason-or-nil] …]`.
   A stale promoted decision is promotable again (its record went missing or differs)."
  [d]
  (let [kind (promote-kind d)]
    (for [id (promote-ids d)
          :let [row (get-in d [:index id])]]
      [id (cond
            (nil? row) (if (= kind "overseer")
                         "not a drafted decision of this project (sova_decisions state drafted lists them; run sova_reconcile first)"
                         "unknown decision")
            (not (or (= "drafted" (:state row)) (:stale row))) (str "it is " (:state row) "; only a reconciled (drafted) decision can be promoted")
            (and (not (:author-owns-area row)) (not= kind "operator-explicit")) (str "outside " (or (:name row) "its author") "'s decision area: promote it explicitly by id")
            :else nil)])))

(defn promote-check [d]
  (let [ids (promote-ids d)]
    (if (empty? ids)
      (r/refuse 400 "Give the ids to promote.")
      (let [vs (verdicts d) refused (filter second vs)]
        (when (= (count refused) (count vs))
          (r/refuse 409 (str "Promoted 0, refused " (count refused) ": "
                          (str/join "; " (map (fn [[id why]] (str id " (" why ")")) refused)) ".")))))))

(def promote-cap (lv/cap-check "promote" (fn [d] (count (promote-ids d))) b/evt))

(defn- promote-effect []
  (dsl/effect :promote (fn [d] {:ids (vec (keep (fn [[id why]] (when-not why id)) (verdicts d)))
                                :refused (vec (for [[id why] (verdicts d) :when why] {:id id :reason why}))
                                :by (promote-kind d)
                                :by-actor (some-> (:by (e d)) name)
                                :ledger (or (some-> (:ledger (e d)) name) (if (:attended (e d)) "message" "day"))})))

(defn promote-done
  "The promotion's result: each promoted decision is told, the ledger counts only what was promoted,
   and the watch hears of it."
  []
  [(script {:expr (fn [_ d] [(ops/assign :last-promote (get-in (e d) [:result]))])})
   (Send {:event :ledger/take :targetexpr (fn [_ d] (b/watch-sid (:org-id d) (:project-id d)))
          :content (fn [_ d] (let [{:keys [by-actor ledger]} (get-in (e d) [:effect])]
                               {:kind "promote" :n (count (get-in (e d) [:result :promoted])) :by by-actor :ledger ledger}))})
   (b/tell-watch (fn [d] (let [res (get-in (e d) [:result]) ids (vec (:promoted res))]
                           (when (seq ids)
                             {:kind "reconcile/promoted" :params {:ids ids :by (get-in (e d) [:effect :by])}
                              :by (get-in (e d) [:effect :by-actor]) :key (str "promoted:" (str/join "," ids))}))))
   (b/send-all (fn [d] (let [res (get-in (e d) [:result])]
                         (for [id (:promoted res) :let [sid (get-in d [:index id :sid])] :when sid]
                           {:target sid :event :promote/done
                            :data {:text-hash (get-in res [:text-hashes (keyword id)] (get-in res [:text-hashes id]))
                                   :commit (get-in res [:commit :sha])}}))))])

;; ---- run results ------------------------------------------------------------------------------------

(defn result-fanout
  "reconcile/finished's results as sends: each decision's verdict, each resolved conflict."
  [d]
  (let [res (e d)]
    (vec (concat
           (for [row (:decisions res) :let [sid (or (get-in d [:index (:id row) :sid]) (b/decision-sid (:org-id d) (:project-id d) (:id row)))]]
             {:target sid :event :reconcile/result :data (dissoc row :id)})
           (for [c (:resolved res)]
             {:target (b/conflict-sid (:org-id d) (:project-id d) (:id c)) :event :conflict/resolved :data c})))))

(defn- reasons-of [d]
  (let [res (e d) by (:by d)
        mk (fn [kind ids] (when (seq ids) {:kind kind :params {:ids (vec ids)} :by by :key (str kind ":" (str/join "," ids))}))]
    (vec (keep identity [(mk "reconcile/conflict" (map :id (:conflicts res)))
                         (mk "reconcile/resolved" (map :id (:resolved res)))
                         (mk "reconcile/drafted" (:drafted-ids res))]))))

(defn- finished-content []
  [(script {:expr (fn [_ d] (let [res (e d)]
                              [(ops/assign :last-run (cond-> {:at (b/now-ms d) :compared (or (:compared res) 0) :found (count (:conflicts res))}
                                                       (:error res) (assoc :error (:error res))))
                               (ops/assign :spawning (vec (:conflicts res)))
                               (ops/assign :reasons-out (reasons-of d))]))})
   (b/send-all result-fanout)
   (raise {:event :spawn/next})
   (Send {:event :reason/noted :targetexpr (fn [_ d] (b/watch-sid (:org-id d) (:project-id d)))
          :content (fn [_ d] {:reasons (:reasons-out d) :by (:by d)})})])

(defn request-ops [d]
  (let [ev (e d)]
    [(ops/assign :by (or (some-> (:by ev) name) "operator"))
     (ops/assign :owner (or (:owner ev) (:owner d) "operator"))]))

(def chart
  (statechart {:initial :reconciler}
    (state {:id :reconciler :initial :born}
      (dsl/hold-cancel-correction)
      (b/hold-review)

      ;; the index of the project's decisions
      (transition {:sova/feed :quiet :event :decision/recorded}
        (script {:expr (fn [_ d] [(ops/assign [:index (:id (e d))] (merge (get-in d [:index (:id (e d))]) {:sid (:sid (e d)) :state "pending"}))])})
        (dsl/watch (fn [d] (:sid (e d)))))
      (transition {:sova/feed :quiet :event :link/moved :cond (fn [_ d] (= "decision" (:chart (b/moved d))))}
        (script {:expr (fn [_ d] (conj (index-ops d)
                                   (ops/assign [:index (b/last-part (:from (b/moved d))) :stale]
                                     (and (b/moved-in? d :stale) true))))}))
      (transition {:sova/feed :quiet :event :settings/reconcile}
        (script {:expr (fn [_ d] [(ops/assign :enabled (true? (:on (e d))))])}))

      (b/flush-transition)
      (transition {:sova/feed :quiet :event :spawn/next :cond (fn [_ d] (seq (:spawning d)))}
        (dsl/spawn {:chart "conflict" :link :reconciler
                    :id (fn [d] (b/conflict-sid (:org-id d) (:project-id d) (:id (first (:spawning d)))))
                    :data (fn [d] (merge (first (:spawning d)) {:org-id (:org-id d) :project-id (:project-id d)
                                                                :owner (:owner d) :created-at (b/now-ms d)}))})
        (script {:expr (fn [_ d] [(ops/assign :spawning (vec (rest (:spawning d))))])})
        (raise {:event :spawn/next}))

      ;; ── what works in every state, the switch aside ────────────────────────────────────────
      (dsl/act {:sova/feed :feed :event :decision/promote :checks [promote-check promote-cap]}
        (promote-effect))
      (transition {:sova/feed :quiet :event :effect/done :cond (fn [_ d] (= "promote" (:kind (e d))))}
        (promote-done))
      (transition {:sova/feed :quiet :event :settle/results}
        (b/send-all (fn [d] (for [row (:decisions (e d))]
                              {:target (or (get-in d [:index (:id row) :sid]) (b/decision-sid (:org-id d) (:project-id d) (:id row)))
                               :event :reconcile/result :data (dissoc row :id)}))))
      ;; a decision's owner area changed: re-route the open conflict it is a side of (the host
      ;; computes the route; `conflict/reroute` closes the old session only when the target changes)
      (transition {:sova/feed :quiet :event :decision/owner-area-changed}
        (dsl/effect :route-conflict-of (fn [d] {:decision-id (:id (e d))})))
      (dsl/act {:sova/feed :feed :event :draft/rewrite}
        (dsl/effect :draft (fn [_] {})))

      (state {:id :born}
        (transition {:sova/feed :quiet :cond (fn [_ d] (not (enabled? d))) :target :off})
        (transition {:sova/feed :quiet :target :idle}))

      (state {:id :off}
        (transition {:sova/feed :quiet :cond (fn [_ d] (enabled? d)) :target :idle})
        ;; an automatic request (a settle session's decision, the chart's own at L1) is recorded
        (transition {:sova/feed :quiet :event :reconcile/request :cond (fn [_ d] (contains? #{"sova" "chart"} (some-> (:by (e d)) name)))}
          (script {:expr (fn [_ d] [(ops/assign :last-run {:at (b/now-ms d) :compared 0 :found 0 :error reconcile-off})])}))
        (dsl/act {:sova/feed :feed :event :reconcile/request :checks [(fn [_] (r/refuse 409 reconcile-off))]}))

      (state {:id :idle}
        (transition {:sova/feed :quiet :cond (fn [_ d] (not (enabled? d))) :target :off})
        (dsl/act {:sova/feed :feed :event :reconcile/request :cond (fn [_ d] (pos? (or (:delay-ms (e d)) 0))) :target :debouncing}
          (script {:expr (fn [_ d] (conj (request-ops d) (ops/assign :delay-ms (:delay-ms (e d)))))}))
        (dsl/act {:sova/feed :feed :event :reconcile/request :target :running}
          (script {:expr (fn [_ d] (request-ops d))})))

      (state {:id :failed}
        (transition {:sova/feed :quiet :cond (fn [_ d] (not (enabled? d))) :target :off})
        (dsl/act {:sova/feed :feed :event :reconcile/request :cond (fn [_ d] (pos? (or (:delay-ms (e d)) 0))) :target :debouncing}
          (script {:expr (fn [_ d] (conj (request-ops d) (ops/assign :delay-ms (:delay-ms (e d)))))}))
        (dsl/act {:sova/feed :feed :event :reconcile/request :target :running}
          (script {:expr (fn [_ d] (request-ops d))}))
        (dsl/correction {:event :correct/clear-failed :target :idle}))

      (state {:id :debouncing}
        (on-entry {} (Send {:id :debounce :event :debounce/over :delayexpr (fn [_ d] (or (:delay-ms d) 2000))}))
        (on-exit {} (cancel {:sendid :debounce}))
        (transition {:sova/feed :quiet :event :debounce/over :target :running})
        ;; a request now runs now; another delayed one waits for the same timer
        (dsl/act {:sova/feed :feed :event :reconcile/request :cond (fn [_ d] (zero? (or (:delay-ms (e d)) 0))) :target :running}
          (script {:expr (fn [_ d] (request-ops d))}))
        (dsl/act {:sova/feed :feed :event :reconcile/request}))

      (state {:id :running}
        (on-entry {} (script {:expr (fn [_ d] [(ops/assign :again false)])}))
        (invoke {:id :run :type :sova/reconcile :params (fn [_ d] {:by (:by d) :owner (:owner d) :project-id (:project-id d)})})
        (dsl/act {:sova/feed :feed :event :reconcile/request}
          (script {:expr (fn [_ d] [(ops/assign :again true)])}))
        (transition {:sova/feed :quiet :event :reconcile/finished :cond (fn [_ d] (and (nil? (:error (e d))) (:again d))) :target :running}
          (finished-content))
        (transition {:sova/feed :quiet :event :reconcile/finished :cond (fn [_ d] (nil? (:error (e d)))) :target :idle}
          (finished-content))
        (transition {:sova/feed :quiet :event :reconcile/finished :target :failed}
          (finished-content))
        (transition {:sova/feed :quiet :event :reconcile/stopped :target :failed}
          (script {:expr (fn [_ d] [(ops/assign :last-run {:at (b/now-ms d) :compared 0 :found 0 :error (or (:detail (e d)) "The run stopped.")})])}))
        (transition {:sova/feed :quiet :event :sova/resumed :target :failed}
          (script {:expr (fn [_ d] [(ops/assign :last-run {:at (b/now-ms d) :compared 0 :found 0 :error "The server restarted during the run."})])}))))))

(def acts
  {:reconcile/request    {:needs "L1" :tool "sova_reconcile"}
   :decision/promote     {:needs "L2" :tool "sova_promote" :code-facing true :counts "promote" :hold true :confirm-kind "promote"
                          :what (fn [d] (let [n (count (promote-ids d))] (str "Promoting " n " decision" (when (not= 1 n) "s"))))}
   :draft/rewrite        {:needs nil}
   :correct/clear-failed {:needs "L1" :correction true :tool "sova_correct"}
   :hold/cancel          {:needs "L0" :correction true}
   :hold/approve         {:needs "L0" :correction true}})

(defn not-here [event config _]
  (case event
    :reconcile/request (if (contains? config :off) reconcile-off "That can't be done now.")
    :correct/clear-failed "The last run did not fail."
    "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:last-run :by :enabled]
   :acts     acts
   :not-here not-here})
