(ns sova.org-charts.charts.conflict
  "The conflict chart (portable, `conflict/<org>/<p>/<cid>`): two decisions that contradict each
   other, and who settles them (§app.requirements/routing, /reconciler).

   ```
   conflict ‹compound›
   ├─ unrouted            routing failed, or its settle session closed without a re-route: open,
   │                      routable by hand; a decide-tier Needs-you item (C17)
   ├─ routed-to-person    a settle session asks them (no link: Needs you asks the operator to send one)
   ├─ routed-to-operator  a settle session with the operator from the start
   └─ settled             keep a · keep b · both · neither (a resolution replaced both)
   ```

   The route is computed by the host (today's routeConflict over the roster and its history: owner
   area, operator-set say, the main stakeholder, self-asserted → operator) and arrives as data at
   birth and with a re-route. A re-route closes the earlier settle session first, so two people are
   never asked the same thing.

   Start data: `{:org-id :project-id :id :area :area-key :owner-area :a {:id :by :name :statement
   :quote :at} :b {…} :p :routed-to :route-reason :self-asserted :route-error :baton-session-id
   :model :thinking :owner :operator-name :created-at}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state transition on-entry script Send]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)
(def resolved-refusal "That conflict is resolved")

(defn e [d] (b/evt d))
(defn- clip [s n] (if (> (count s) n) (subs s 0 n) s))
(defn- day [ms] (subs (b/utc-minute ms) 0 10))

(defn settle-baton-data
  "batonFor: the settle session's start (its goal carries both sides; no link is minted)."
  [d]
  (let [{:keys [a b area owner-area]} d
        side (fn [label x] (str label " (" (:name x) ", " (day (or (:at x) 0)) "): " (:statement x) "\n  Their words: \"" (:quote x) "\""))]
    {:org-id (:org-id d) :project-id (:project-id d) :session-id (:baton-session-id d)
     :to (:routed-to d) :mint-link false :owner (or (:owner d) "operator")
     :public-title (clip (str "Settle: " area) 120)
     :goal (clip (str "Two recorded decisions about " area " contradict each other. Find out from the person you are talking to which one holds, "
                      "or what the decision is instead. Record the answer with record_decision in the area \"" area "\""
                      (when owner-area (str " and the owner area \"" owner-area "\"")) ", with their exact words, then finish with goal_done.\n\n"
                      (side "A" a) "\n" (side "B" b))
                 2000)
     :question (clip (str "Two decisions about " area " disagree. " (:name a) ": \"" (:statement a) "\" " (:name b) ": \"" (:statement b) "\" Which one holds?") 1000)
     :conflict {:id (:id d) :area area}
     :model (:model d) :thinking (:thinking d)
     :operator-name (:operator-name d)
     :names (merge {} (when (:routed-to d) {(:routed-to d) (:routed-to-name d)}))}))

(defn- spawn-settle []
  (dsl/spawn {:chart "baton" :link :conflict
              :id (fn [d] (b/baton-sid (:org-id d) (:baton-session-id d)))
              :data settle-baton-data}))

(defn- close-asking
  "Close the settle session that asked before (a re-route, a settle by hand), when there was one
   and it isn't the one asking now."
  [why]
  (b/send-if :baton/close
    (fn [d] (when (and (:asking d) (not= (:asking d) (:baton-session-id d))) (b/baton-sid (:org-id d) (:asking d))))
    (fn [_] {:by "system" :reason why})))

(def reroute-check
  (fn [d] (let [ev (e d)]
            (cond
              (not (lv/blank? (:invalid ev))) (r/refuse 400 (:invalid ev))
              (not (or (= "operator" (:to ev)) (= "active" (get-in ev [:target :status])))) (r/refuse 400 "Route to an active person or the operator")))))

(defn- same-target? [_ d] (and (true? (:keep-if-same (e d))) (= (:to (e d)) (:routed-to d))))

(defn- reroute-ops [d]
  (let [ev (e d)]
    [(ops/assign :routed-to (:to ev))
     (ops/assign :route-reason (or (:route-reason ev) (str (if (= "operator" (:to ev)) (:operator-name d) (get-in ev [:target :name])) " chosen by " (:operator-name d) ".")))
     (ops/assign :self-asserted (true? (:self-asserted ev)))
     (ops/assign :baton-session-id (:session-id ev))
     (ops/assign :route-error nil)]))

(defn- routed-target [_ d] (if (= "operator" (:routed-to d)) :routed-to-operator :routed-to-person))

(defn- reroute-transitions []
  (for [[target to-op?] [[:routed-to-operator true] [:routed-to-person false]]]
    (dsl/act {:event :conflict/reroute :target target :checks [reroute-check]
              :cond (fn [env d] (and (not (same-target? env d)) (= to-op? (= "operator" (:to (e d))))))}
      (script {:expr (fn [_ d] [(ops/assign :asking (:baton-session-id d))])})
      (script {:expr (fn [_ d] (reroute-ops d))}))))

(defn- settle-ops [outcome resolved-by]
  (fn [d] [(ops/assign :outcome outcome) (ops/assign :resolved-by resolved-by) (ops/assign :resolved-at (b/now-ms d))]))

(defn settle-check [d]
  (let [ev (e d)]
    (cond
      (not (lv/blank? (:invalid ev))) (r/refuse (or (:invalid-status ev) 400) (:invalid ev))
      (and (nil? (:keep ev)) (nil? (:statement ev))) (r/refuse 400 "Expected { keep: \"a\" | \"b\" | \"both\" } or { statement }")
      (some? (:statement ev)) (let [s (str/trim (str (:statement ev)))] (when (or (= "" s) (> (count s) 500)) (r/refuse 400 "statement must be 1–500 characters")))
      (not (contains? #{"a" "b" "both"} (:keep ev))) (r/refuse 400 "Expected { keep: \"a\" | \"b\" | \"both\" } or { statement }"))))

(defn- open-transitions []
  (concat
    (reroute-transitions)
    ;; the same target again (an owner-area change that routes where it already goes): nothing
    [(dsl/act {:event :conflict/reroute :checks [reroute-check] :cond same-target?})
     ;; settled by the reconciler's run (the first decision in its settle session)
     (transition {:event :conflict/resolved :target :settled}
       (script {:expr (fn [_ d] ((settle-ops (:outcome (e d)) (:resolved-by (e d))) d))}))
     ;; settled by hand: the session still asking is over
     (dsl/act {:event :conflict/settle :target :settled :checks [settle-check]}
       (script {:expr (fn [_ d] ((settle-ops (if (:statement (e d)) "neither" (:keep (e d))) (:decision-id (e d))) d))})
       (script {:expr (fn [_ d] [(ops/assign :asking (:baton-session-id d))])})
       (script {:expr (fn [_ d] [(ops/assign :baton-session-id nil)])})
       (close-asking "settled")
       (dsl/effect :settle (fn [d] (merge (select-keys (e d) [:keep :statement :decision-id]) {:id (:id d) :a (get-in d [:a :id]) :b (get-in d [:b :id])})))
       (b/tell-watch (fn [d] {:kind "reconcile/resolved" :params {:ids [(:id d)]} :by "operator" :key (str "resolved:" (:id d))})))]))

(def chart
  (statechart {:initial :conflict}
    (state {:id :conflict :initial :conflict-born}
      (dsl/hold-cancel-correction)
      (b/flush-transition)
      ;; the settle's results (the host wrote the operator's decision, superseded the losers) go to
      ;; the decisions through the reconciler
      (transition {:event :effect/done :cond (fn [_ d] (= "settle" (:kind (e d))))}
        (Send {:event :settle/results :targetexpr (fn [_ d] (b/reconciler-sid (:org-id d) (:project-id d)))
               :content (fn [_ d] {:decisions (get-in (e d) [:result :decisions])})}))

      (state {:id :conflict-born}
        (transition {:cond (fn [_ d] (or (some? (:route-error d)) (nil? (:routed-to d)))) :target :unrouted})
        (transition {:cond (fn [_ d] (= "operator" (:routed-to d))) :target :routed-to-operator})
        (transition {:target :routed-to-person}))

      (state {:id :unrouted}
        (on-entry {} (script {:expr (fn [_ d] [(ops/assign :state "open")])}))
        (open-transitions))

      (state {:id :routed-to-person}
        (on-entry {}
          (script {:expr (fn [_ d] [(ops/assign :state "open")])})
          (close-asking "re-routed")
          (spawn-settle))
        ;; its settle session closed without a re-route: nobody is asked (C17)
        (transition {:event :link/moved :cond (fn [_ d] (and (= "baton" (:chart (b/moved d))) (= (:baton-session-id d) (b/last-part (:from (b/moved d)))) (b/moved-in? d :closed)))
                     :target :unrouted})
        (open-transitions))

      (state {:id :routed-to-operator}
        (on-entry {}
          (script {:expr (fn [_ d] [(ops/assign :state "open")])})
          (close-asking "re-routed")
          (spawn-settle))
        (transition {:event :link/moved :cond (fn [_ d] (and (= "baton" (:chart (b/moved d))) (= (:baton-session-id d) (b/last-part (:from (b/moved d)))) (b/moved-in? d :closed)))
                     :target :unrouted})
        (open-transitions))

      (state {:id :settled}
        (on-entry {} (script {:expr (fn [_ d] [(ops/assign :state "resolved")])}))))))

(def acts
  {:conflict/reroute {:needs nil :people-facing true :hours b/hours-window :card (fn [d] {:people (remove #{"operator"} [(:to (e d))])})}
   :conflict/settle  {:needs nil}
   :hold/cancel      {:needs "L0" :correction true}})

(defn not-here [event config _]
  (if (contains? config :settled) resolved-refusal "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:state :area :area-key :owner-area :a :b :routed-to :route-reason :self-asserted :baton-session-id
              :outcome :resolved-by :created-at :resolved-at]
   :acts     acts
   :not-here not-here
   :cold?    (fn [config _] (contains? config :settled))})
