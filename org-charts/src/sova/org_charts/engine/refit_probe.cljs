(ns sova.org-charts.engine.refit-probe
  "Test charts for the refit's engine features (engine/refit_test.cljs): `refit-parent` spawns
   `refit-kid` sessions and watches them, makes acts with checks, a correction, an act the hold
   policy holds, an effect-only hold, a chart-driven act, a timer and an invocation. Not shipped."
  (:require
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [com.fulcrologic.statecharts.elements :refer [state transition on-entry on-exit script Send cancel invoke]]
    [sova.org-charts.engine.dsl :as dsl]))

(def rank {"L0" 0 "L1" 1 "L2" 2 "L3" 3})

(defn level-check
  "A small level check: the operator and attended turns pass; else `:level` must reach `need`."
  [tool need envelope]
  (when-not (or (= "operator" (:by envelope)) (true? (:attended envelope))
                (>= (get rank (:level envelope) -1) (get rank need 99)))
    (str tool " needs " need ".")))

(defn- note [k]
  (script {:expr (fn [_ d] [(ops/assign k (conj (vec (get d k)) (dissoc (dsl/evt d) :at)))])}))

(def cap-check
  {:name :day-allowance
   :fn   (fn [d]
           (let [{:keys [used max]} (get-in (dsl/evt d) [:allowance :gather])]
             (when (and max (> (+ (or used 0) 1) max))
               {:sentence (str "Today's allowance is used: " used " of " max " gathering sessions started on its own.")
                :tail "Nothing starts before then."})))})

(def gather-at-once
  {:name :gatherings-open
   :fn   (fn [d]
           (let [{:keys [gatherings-open gatherings-cap]} (:at-once (dsl/evt d))]
             (when (and gatherings-cap (>= (or gatherings-open 0) gatherings-cap))
               (str gatherings-open " of its gathering sessions are open, and the limit is " gatherings-cap " at once."))))})

(def promote-cap
  {:name :promote-allowance
   :fn   (fn [d]
           (let [e (dsl/evt d)
                 {:keys [used max]} (get-in e [:allowance :promote])
                 n (count (:ids e))]
             (when (and max (> (+ (or used 0) n) max))
               (str "Today's allowance is used: " used " of " max " decisions promoted on its own."))))})

(def coding-at-once
  {:name :coding-running
   :fn   (fn [d]
           (let [{:keys [coding-running coding-cap]} (:at-once (dsl/evt d))]
             (when (and coding-cap (>= (or coding-running 0) coding-cap))
               (str coding-running " of its coding sessions are running, and the limit is " coding-cap " at once."))))})

(def named
  {:name :named :payload? true
   :fn   (fn [d] (when (dsl/blank? (:name (dsl/evt d))) "Name the kid."))})

(def parent-chart
  (statechart {}
    (state {:id :top :initial :idle}
      (dsl/hold-cancel-correction)
      (transition {:event :link/moved} (note :seen))
      (transition {:event :effect/done} (note :done))
      (transition {:event :effect/failed} (note :failed))
      (transition {:event :hold/released} (note :released))
      (transition {:event :hold/dropped} (note :dropped))
      (transition {:event :hold/cancelled} (note :cancelled))
      (transition {:event :hold/lapsed} (note :lapsed))
      (transition {:event :kid/watch} (dsl/watch #(:target (dsl/evt %))))
      (transition {:event :kid/unwatch} (dsl/unwatch #(:target (dsl/evt %))))
      (state {:id :idle}
        (dsl/act {:event :kid/spawn :checks [named]}
          (dsl/spawn {:chart "refit-kid" :id #(str "kid/" (:name (dsl/evt %))) :link :parent
                      :data (fn [d] {:name (:name (dsl/evt d))}) :if-exists #(:if-exists (dsl/evt %))}))
        (dsl/act {:event :decision/promote :checks [promote-cap]}
          (script {:expr (fn [_ d] [(ops/assign :promoted (into (vec (:promoted d)) (:ids (dsl/evt d))))])}))
        (dsl/act {:event :build/start :checks [coding-at-once]}
          (script {:expr (fn [_ d] [(ops/assign :builds (inc (:builds d 0)))])}))
        (dsl/act {:event :gather/start :target :gathering :checks [gather-at-once cap-check]}
          (script {:expr (fn [_ d] [(ops/assign :gathers (inc (:gathers d 0)))])})
          (dsl/effect :gather (fn [d] {:to (:to (dsl/evt d))})))
        (dsl/act {:event :drive/go} (dsl/drive {:event :gather/start :data (fn [_] {:to "auto"})}))
        (dsl/act {:event :offer/make}
          (dsl/held :offer (fn [_] {:to "x"}) {:while-in :idle :what "Offer to x"}))
        (dsl/act {:event :door/open :cond (fn [_ d] (:door-ok d)) :sova/refusal "The door is shut."})
        (transition {:event :timed/arm :target :timed}))
      (state {:id :gathering}
        (dsl/act {:event :gather/close :target :idle})
        (dsl/correction {:event :item/reopen :target :idle}))
      (state {:id :timed}
        (on-entry {} (Send {:id :t :event :timed/fired :delay 1000}))
        (on-exit {} (cancel {:sendid :t}))
        (invoke {:id :look :type :sova/look :params (fn [_ _] {:why "test"})})
        (transition {:event :timed/fired :target :idle} (note :fired))
        (transition {:event :look/finished :target :idle} (note :finished))
        (transition {:event :sova/resumed :target :idle} (note :resumed))))))

(def parent-acts
  {:kid/spawn    {:needs "L0" :tool "sova_note"}
   :gather/start {:needs "L1" :tool "sova_start_gathering" :hold true :counts "gather" :people-facing true
                  :what (fn [d] (str "Gathering with " (:to (dsl/evt d))))}
   :gather/close {:needs "L1" :tool "sova_close_gathering"}
   :decision/promote {:needs "L2" :tool "sova_promote" :hold true :counts "promote"
                      :count (fn [d] (count (:ids (dsl/evt d))))}
   :build/start  {:needs "L3" :tool "sova_create_session" :hold true :counts "create"}
   :drive/go     {}
   :offer/make   {}
   :door/open    {:pre [{:name :door-named :payload? true :fn (fn [d] (when (= "bad" (:door (dsl/evt d))) "No such door."))}]}
   :item/reopen  {:needs "L1" :tool "sova_reopen" :correction true}
   :hold/cancel  {:needs "L0" :tool "sova_note" :correction true}})

(def kid-chart
  (statechart {}
    (state {:id :kid :initial :new}
      (state {:id :new}
        (transition {:event :kid/grow :target :grown} (script {:expr (fn [_ _] [(ops/assign :size 1)])})))
      (state {:id :grown}
        (transition {:event :kid/shrink :target :new})
        (transition {:event :kid/touch} (script {:expr (fn [_ d] [(ops/assign :touched (inc (:touched d 0)))])}))))))

(def charts
  {"refit-parent" {:chart parent-chart :version 2 :storage :portable :exported [:gathers]
                   :migrate {1 (fn [s] (update s :config #(set (replace {:waiting :idle} %))))}
                   :acts parent-acts
                   :not-here (fn [e _ _] (str (namespace e) "/" (name e) " doesn't apply here."))}
   "refit-kid"    {:chart kid-chart :version 1 :storage :host-local :exported [:size]}})
