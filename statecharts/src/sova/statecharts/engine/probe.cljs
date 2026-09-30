(ns sova.statecharts.engine.probe
  "A small statechart that exercises every engine feature the org statecharts rely on, shipped in the bundle as
   \"engine-probe\" so the TS tests prove them against the vendored ESM (not only under :node-test):
   event send, delayed send + cancel on exit, deep history, parallel regions, an eventless
   transition guarded by In(), a host invocation started on entry and cancelled on exit, guards on the
   event envelope with :sova/* refusal tags, outbox effects, a cross-session send and a resume event.
   It also holds an eventless cycle on purpose (`spin/facts`), for the engine's step limit."
  (:require
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [com.fulcrologic.statecharts.elements
     :refer [state parallel transition on-entry on-exit script Send cancel history invoke In final raise]]))

(def version
  "2: the gate's spin states (an eventless cycle for the step limit)."
  2)

(defn- evt [data] (get-in data [:_event :data]))

(defn- bump [k] (script {:expr (fn [_ d] [(ops/assign k (inc (get d k 0)))])}))

(defn- effect [kind]
  (script {:expr (fn [_ d] [(ops/assign :outbox (conj (vec (:outbox d)) {:kind kind :key (str kind "/" (:seq d 0))}))
                            (ops/assign :seq (inc (:seq d 0)))])}))

(def rank {"L0" 0 "L1" 1 "L2" 2 "L3" 3})

(defn may [need]
  (fn [_ data]
    (let [{:keys [by attended level]} (evt data)]
      (or (= "operator" by) (true? attended) (>= (get rank level -1) (get rank need))))))

(def statechart
  (chart/statechart {:initial :probe}
    (state {:id :probe :initial :running}
      (transition {:event :probe/stop :target :stopped})
      (parallel {:id :running}

        ;; Region 1: a lane with nesting, deep history, a timer and an invocation.
        (state {:id :lane :initial :flow}
          (state {:id :flow :initial :a}
            (history {:id :flow-h :type :deep} :a)
            (transition {:event :hold :target :held})
            (state {:id :a}
              (transition {:event :next :target :b}))
            (state {:id :b :initial :b1}
              (state {:id :b1}
                (transition {:event :next :target :b2}))
              (state {:id :b2}
                ;; delayed self-send, cancelled on exit (delayed sends are not cancelled by the library)
                (on-entry {} (Send {:id :tick :event :timer/fired :delayexpr (fn [_ d] (:tick-ms d 60000))}))
                (on-exit {} (cancel {:sendid :tick}))
                (transition {:event :timer/fired :target :c} (bump :fired))))
            (state {:id :c}
              (invoke {:id :look :type :sova/look :params (fn [_ d] {:fired (:fired d 0) :sid (:_sessionid d)})})
              (transition {:event :look/finished :target :a} (bump :looks))
              (transition {:event :next :target :a})
              (transition {:event :sova/resumed :target :a} (bump :resumes))))
          (state {:id :held}
            (transition {:event :resume :target :flow-h})))

        ;; Region 2: a gate toggled by events.
        (state {:id :gate :initial :closed}
          (state {:id :closed}
            (transition {:event :gate/open :target :open})
            (transition {:event :spin/facts :target :spin-working}
              (script {:expr (fn [_ d] [(ops/assign :spin (select-keys (evt d) [:merged :running]))])}))
            ;; a peer's ping may carry spin facts: a cycle in the receiving session, mid-call
            (transition {:event :peer/pinged :cond (fn [_ d] (some? (:spin (evt d)))) :target :spin-working}
              (script {:expr (fn [_ d] [(ops/assign :spin (:spin (evt d)))])})))
          (state {:id :open} (transition {:event :gate/close :target :closed}))
          ;; An eventless cycle, the shape of work-item mutant M34 (a merged build that still runs: working
          ;; takes `landed` without asking `running`, and merged goes back to working while it runs). Merged
          ;; and not running settles in :spin-merged; merged and running never settles: the step limit throws.
          ;; Entering :spin-working arms an (ignored) timer, so a cycle also fills the queue, which a
          ;; rolled-back call must put back.
          (state {:id :spin-working}
            (on-entry {} (Send {:id :spin-timer :event :spin/tick :delay 3600000}))
            (transition {:cond (fn [_ d] (get-in d [:spin :merged])) :target :spin-merged})
            (transition {:event :gate/close :target :closed}))
          (state {:id :spin-merged}
            (transition {:cond (fn [_ d] (get-in d [:spin :running])) :target :spin-working})
            (transition {:event :gate/close :target :closed})))

        ;; Region 3: an eventless transition that reads region 2 through In().
        (state {:id :watch :initial :idle}
          (state {:id :idle}
            (transition {:event :poke :target :armed}))
          (state {:id :armed}
            (transition {:cond (In :open) :target :fired}
              (bump :fired-eventless)
              (raise {:event :watch/fired-inner})))
          (state {:id :fired}
            (transition {:event :watch/fired-inner} (bump :inner))
            (transition {:event :reset :target :idle})))

        ;; Region 4: guards on the envelope, effects, a cross-session send.
        (state {:id :acts :initial :ready}
          (state {:id :ready}
            (transition {:event :act/promote :cond (may "L2") :target :acted
                         :sova/needs "L2" :sova/refusal "It needs L2. Do not retry it."}
              (effect "promote"))
            (transition {:event :act/ping}
              (Send {:event :peer/pinged :targetexpr (fn [_ d] (:peer d))
                     :content (fn [_ d] (cond-> {:from (:_sessionid d) :n (:pings d 0)}
                                          (:spin-out d) (assoc :spin (:spin-out d))))})
              (bump :pings))
            (transition {:event :peer/pinged} (bump :pinged))
            ;; the library logs: a warning (an operation it does not know) and an error (a script that throws)
            (transition {:event :probe/warn} (script {:expr (fn [_ _] [{:op :probe-unknown-op}])}))
            (transition {:event :probe/throw} (script {:expr (fn [_ _] (throw (ex-info "the probe's script threw" {})))})))
          (state {:id :acted}
            (transition {:event :act/undo :target :ready}))))
      ;; nested final: the session keeps running, so its configuration still shows it
      (final {:id :stopped}))))
