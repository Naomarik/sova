(ns sova.org-charts.engine.core-test
  "Engine behaviour under Node (:node-test), on the probe chart, driven through engine.core."
  (:require
    [cljs.test :refer [deftest is testing]]
    [cljs.reader :as reader]
    [com.fulcrologic.statecharts.algorithms.v20150901-validation :as validation]
    [sova.org-charts.charts.registry :as registry]
    [sova.org-charts.engine.bounded :as bounded]
    [sova.org-charts.engine.core :as core]
    [sova.org-charts.engine.probe :as probe]))

(def t0 1000000)

(defn- new-eng
  ([] (new-eng {}))
  ([opts] (core/new-engine {"engine-probe" {:chart probe/chart :version probe/version}} opts)))

(defn- in? [eng sid & ids] (every? (set (core/configuration eng sid)) ids))

(defn- recording []
  (let [log (atom [])]
    [log {:on-save         (fn [sid snap] (swap! log conj [:save sid (:generation snap)]))
          :on-invoke-start (fn [inv] (swap! log conj [:start (:session-id inv) (:invoke-id inv) (:params inv)]))
          :on-invoke-stop  (fn [inv] (swap! log conj [:stop (:session-id inv) (:invoke-id inv)]))}]))

(deftest start-and-parallel-regions
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {:tick-ms 5000} t0)
    (is (= [:probe :running :lane :flow :a :gate :closed :watch :idle :acts :ready]
          (core/configuration eng "p"))
      "every region of the parallel state is entered, in document order")
    (is (= t0 (:now (core/data eng "p"))) ":now is the injected clock at start")))

(deftest event-send-and-at-stamp
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {} t0)
    (let [r (core/send! eng "p" :next {} {:now (+ t0 5)})]
      (is (in? eng "p" :b :b1))
      (is (= [:probe :running :lane :flow :a :gate :closed :watch :idle :acts :ready] (:before (first (:steps r)))))
      (is (= (+ t0 5) (get-in (first (:steps r)) [:data :at])) "the delivered event carries :at")
      (is (= (+ t0 5) (:now (core/data eng "p")))))))

(deftest delayed-send-fires-on-the-injected-clock-and-is-cancelled-on-exit
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {:tick-ms 60000} t0)
    (core/send! eng "p" :next {} {:now t0})
    (core/send! eng "p" :next {} {:now (+ t0 10)})
    (is (in? eng "p" :b2))
    (is (= (+ t0 10 60000) (core/next-due-at eng)) "the timer is due tick-ms after entry")
    (let [r (core/fire-due! eng (+ t0 10 59999))]
      (is (empty? (:steps r)) "nothing fires before its time")
      (is (in? eng "p" :b2)))
    (let [r (core/fire-due! eng (+ t0 10 60000))]
      (is (= [:timer/fired] (map :event (:steps r))))
      (is (in? eng "p" :c))
      (is (= 1 (:fired (core/data eng "p")))))
    (testing "exit cancels the pending delayed send"
      (let [eng (new-eng)]
        (core/start! eng "p" "engine-probe" {:tick-ms 60000} t0)
        (core/send! eng "p" :next {} {:now t0})
        (core/send! eng "p" :next {} {:now t0})
        (is (some? (core/next-due-at eng)))
        (core/send! eng "p" :hold {} {:now (+ t0 1)})
        (is (in? eng "p" :held))
        (is (nil? (core/next-due-at eng)) "leaving :b2 cancelled :tick")
        (is (empty? (:steps (core/fire-due! eng (+ t0 120000)))))))))

(deftest deep-history-restores-the-nested-configuration
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {:tick-ms 1000} t0)
    (core/send! eng "p" :next {} {:now t0})
    (core/send! eng "p" :next {} {:now t0})
    (is (in? eng "p" :flow :b :b2))
    (core/send! eng "p" :hold {} {:now (+ t0 1)})
    (is (in? eng "p" :held))
    (is (not (in? eng "p" :flow)))
    (core/send! eng "p" :resume {} {:now (+ t0 2)})
    (is (in? eng "p" :flow :b :b2) "resume through deep history lands in b2, not the default a")
    (is (= (+ t0 2 1000) (core/next-due-at eng)) "re-entering b2 re-arms its timer")))

(deftest eventless-transition-reads-another-region-with-In
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {} t0)
    (core/send! eng "p" :poke {} {:now t0})
    (is (in? eng "p" :armed) "the eventless transition waits while the gate is closed")
    (core/send! eng "p" :gate/open {} {:now (+ t0 1)})
    (is (in? eng "p" :open :fired) "opening the gate lets the eventless transition in another region fire")
    (is (= 1 (:fired-eventless (core/data eng "p"))))
    (is (= 1 (:inner (core/data eng "p"))) "the event raised by that transition is processed in the same macrostep")))

(deftest invocation-starts-on-entry-and-is-cancelled-on-exit
  (let [[log opts] (recording)
        eng (new-eng opts)]
    (core/start! eng "p" "engine-probe" {:tick-ms 1} t0)
    (core/send! eng "p" :next {} {:now t0})
    (core/send! eng "p" :next {} {:now t0})
    (let [r (core/fire-due! eng (+ t0 1))]
      (is (in? eng "p" :c))
      (is (= [{:session-id "p" :invoke-id :look :type :sova/look :params {:fired 1 :sid "p"} :op :start}]
            (map #(dissoc % :run-id) (:invocations r))))
      (is (re-matches #"p#look#\d+" (:run-id (first (:invocations r)))) "each start gets a run id"))
    (is (= [:start "p" :look {:fired 1 :sid "p"}] (last (filter #(= :start (first %)) @log))))
    (let [r (core/send! eng "p" :next {} {:now (+ t0 2)})]
      (is (in? eng "p" :a))
      (is (= [:stop] (map :op (:invocations r))) "leaving :c stops the look")
      (is (= [:stop "p" :look] (last (remove #(= :save (first %)) @log)))))
    (testing "the host reports the look back with its invoke id"
      (core/send! eng "p" :next {} {:now (+ t0 3)})
      (core/send! eng "p" :next {} {:now (+ t0 3)})
      (core/fire-due! eng (+ t0 4))
      (core/send! eng "p" :look/finished {} {:now (+ t0 5) :invoke-id :look})
      (is (in? eng "p" :a))
      (is (= 1 (:looks (core/data eng "p")))))))

(deftest guards-trial-and-enabled-events
  (let [[log opts] (recording)
        eng (new-eng opts)]
    (core/start! eng "p" "engine-probe" {} t0)
    (let [saves (count @log)
          r     (core/trial eng "p" :act/promote {:by "overseer" :level "L1"} {:now t0})]
      (is (false? (:taken r)))
      (is (= [{:source :ready :target [:acted] :event [:act/promote] :cond false
               :sova/needs "L2" :sova/refusal "It needs L2. Do not retry it."}]
            (:refused r)))
      (is (= (:before r) (:configuration r)))
      (is (= saves (count @log)) "a trial saves nothing"))
    (let [r (core/trial eng "p" :act/promote {:by "overseer" :level "L2"} {:now t0})]
      (is (true? (:taken r)))
      (is (some #{:acted} (:configuration r)))
      (is (= [{:kind "promote" :chart-key "promote/0" :session-id "p"}] (map #(dissoc % :key) (:outbox r))))
      (is (in? eng "p" :ready) "the real session did not move"))
    (let [r (core/trial eng "p" :act/promote {:by "operator"} {:now t0})]
      (is (true? (:taken r)) "the operator's own act passes every level"))
    (is (not (some #{:act/promote} (map :event (core/enabled-events eng "p" {:by "overseer" :level "L1"} {:now t0})))))
    (is (some #{:act/promote} (map :event (core/enabled-events eng "p" {:by "overseer" :level "L3"} {:now t0}))))
    (is (= [:probe/stop :hold :next :gate/open :spin/facts :peer/pinged :poke :act/promote :act/ping :probe/warn :probe/throw]
          (map :event (core/enabled-events eng "p" {:level "L2"} {:now t0}))))
    (let [r (core/send! eng "p" :act/promote {:by "overseer" :level "L2"} {:now t0})]
      (is (= [{:kind "promote" :chart-key "promote/0" :session-id "p"}] (map #(dissoc % :key) (:outbox r))) "the outbox is returned…")
      (is (= (:key (first (:outbox r))) (key (first (:sova/pending (core/data eng "p"))))) "…kept pending under its key…")
      (is (= [] (:outbox (core/data eng "p"))) "…and drained from the data model"))))

(deftest trial-touches-nothing-outside-the-copy
  (let [[log opts] (recording)
        eng (new-eng opts)]
    (core/start! eng "a" "engine-probe" {:peer "b" :tick-ms 1000} t0)
    (core/start! eng "b" "engine-probe" {} t0)
    (core/send! eng "a" :next {} {:now t0})
    (reset! log [])
    (testing "a trial that would arm a timer arms none"
      (let [r (core/trial eng "a" :next {} {:now t0})]
        (is (true? (:taken r)))
        (is (some #{:b2} (:configuration r)))
        (is (= [{:to "a" :event :timer/fired :delay 1000 :data {}}] (map #(select-keys % [:to :event :delay :data]) (:sends r))) "the would-be send is reported…")
        (is (nil? (core/next-due-at eng)) "…but not queued")))
    (testing "a trial that would start an invocation starts none"
      (core/send! eng "a" :next {} {:now t0})
      (reset! log [])
      (let [r (core/trial eng "a" :timer/fired {} {:now t0})]
        (is (some #{:c} (:configuration r)))
        (is (= [:start] (map :op (:invocations r))))
        (is (empty? @log) "no host callback, no save")))
    (testing "a trial of a cross-session send delivers nothing"
      (let [r (core/trial eng "a" :act/ping {} {:now t0})]
        (is (= ["b"] (map :to (:sends r))))
        (core/fire-due! eng t0)
        (is (nil? (:pinged (core/data eng "b"))))))
    (is (= [:probe :running :lane :flow :b :b2 :gate :closed :watch :idle :acts :ready]
          (core/configuration eng "a")) "the session never moved")))

(deftest cross-session-send
  (let [eng (new-eng)]
    (core/start! eng "a" "engine-probe" {:peer "b"} t0)
    (core/start! eng "b" "engine-probe" {} t0)
    (let [r (core/send! eng "a" :act/ping {} {:now t0})]
      (is (= [:act/ping :peer/pinged] (map :event (:steps r))) "delivered to the loaded peer in the same call")
      (is (= ["a" "b"] (map :session-id (:steps r))))
      (is (= [{:from "a" :to "b" :event :peer/pinged :data {:from "a" :n 0} :delay 0 :due-at t0 :send-id nil :delivered true}]
            (map #(update % :send-id (constantly nil)) (:sends r))))
      (is (= 1 (:pinged (core/data eng "b")))))
    (core/unload! eng "b")
    (let [r (core/send! eng "a" :act/ping {} {:now t0})]
      (is (= [:act/ping] (map :event (:steps r))))
      (is (false? (:delivered (first (:sends r)))) "a send to a session this engine does not hold is reported undelivered")
      (is (nil? (core/next-due-at eng)) "and not left in the queue"))))

(deftest dump-load-round-trip-mid-flight
  (testing "a pending delayed send survives dump → load into a fresh engine and fires after"
    (let [eng (new-eng)]
      (core/start! eng "p" "engine-probe" {:tick-ms 60000} t0)
      (core/send! eng "p" :gate/open {} {:now t0})
      (core/send! eng "p" :next {} {:now t0})
      (core/send! eng "p" :next {} {:now (+ t0 7)})
      (let [text  (core/dump eng "p")
            eng2  (new-eng)
            info  (core/load! eng2 "p" text)]
        (is (= 1 (:pending info)))
        (is (= (core/configuration eng "p") (core/configuration eng2 "p")))
        (is (= (core/data eng "p") (core/data eng2 "p")))
        (is (= (+ t0 7 60000) (core/next-due-at eng2)))
        (core/fire-due! eng2 (+ t0 7 60000))
        (is (in? eng2 "p" :c :open))
        (is (= 1 (:fired (core/data eng2 "p")))))))
  (testing "a cut-off invocation: load, then a resumed event, then the timer ordering and history hold"
    (let [[log opts] (recording)
          eng  (new-eng)]
      (core/start! eng "p" "engine-probe" {:tick-ms 1} t0)
      (core/send! eng "p" :next {} {:now t0})
      (core/send! eng "p" :next {} {:now t0})
      (core/fire-due! eng (+ t0 1))
      (is (in? eng "p" :c))
      (let [text (core/dump eng "p")
            eng2 (new-eng opts)]
        (core/load! eng2 "p" text)
        (is (empty? @log) "loading runs nothing")
        (let [r (core/send! eng2 "p" :sova/resumed {} {:now (+ t0 100)})]
          (is (in? eng2 "p" :a))
          (is (= 1 (:resumes (core/data eng2 "p"))))
          (is (= [:stop] (map :op (:invocations r))) "the resumed exit stops the (dead) look"))
        (is (= (:generation (reader/read-string text)) (dec (core/generation eng2 "p")))
          "the generation continues from the snapshot"))))
  (testing "history survives dump/load"
    (let [eng (new-eng)]
      (core/start! eng "p" "engine-probe" {:tick-ms 50} t0)
      (core/send! eng "p" :next {} {:now t0})
      (core/send! eng "p" :next {} {:now t0})
      (core/send! eng "p" :hold {} {:now t0})
      (let [eng2 (new-eng)]
        (core/load! eng2 "p" (core/dump eng "p"))
        (core/send! eng2 "p" :resume {} {:now (+ t0 10)})
        (is (in? eng2 "p" :b2))
        (is (= (+ t0 10 50) (core/next-due-at eng2)))))))

(deftest queue-order-after-a-long-gap
  (testing "simultaneously past-due timers across sessions fire in (time, ordinal) order"
    (let [eng (new-eng)]
      (doseq [[sid tick] [["x" 300] ["y" 100] ["z" 200]]]
        (core/start! eng sid "engine-probe" {:tick-ms tick} t0)
        (core/send! eng sid :next {} {:now t0})
        (core/send! eng sid :next {} {:now t0}))
      (let [eng2 (new-eng)]
        (doseq [sid ["z" "x" "y"]] (core/load! eng2 sid (core/dump eng sid)))
        (let [r (core/fire-due! eng2 (+ t0 100000))]
          (is (= ["y" "z" "x"] (map :session-id (:steps r)))))))))

(deftest load-refuses-a-version-mismatch
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {} t0)
    (let [text (core/dump eng "p")
          eng2 (core/new-engine {"engine-probe" {:chart probe/chart :version (inc probe/version)}} {})]
      (is (thrown-with-msg? js/Error (re-pattern (str "v" probe/version ", this build has v" (inc probe/version)))
            (core/load! eng2 "p" text)))
      (is (not (core/loaded? eng2 "p")) "nothing of the refused snapshot is kept"))))

(deftest nested-final-keeps-configuration
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {} t0)
    (let [r (core/send! eng "p" :probe/stop {} {:now t0})]
      (is (= [:probe :stopped] (core/configuration eng "p")))
      (is (true? (:running (first (:steps r))))))))

(deftest saves-carry-generation
  (let [[log opts] (recording)
        eng (new-eng opts)]
    (core/start! eng "p" "engine-probe" {} t0)
    (core/send! eng "p" :next {} {:now t0})
    (is (= [[:save "p" 1] [:save "p" 2]] @log))))

;; ---- the step limit ---------------------------------------------------------------------------

(defn- thrown [f] (try (f) nil (catch :default e e)))

(deftest an-eventless-cycle-trips-the-step-limit
  (testing "a merged build that still runs, in a chart that cycles on it (mutant M34's shape): a typed error, not a hang"
    (let [eng (new-eng {:max-microsteps 50})]
      (core/start! eng "p" "engine-probe" {:tick-ms 60000} t0)
      (core/send! eng "p" :next {} {:now t0})
      (core/send! eng "p" :next {} {:now t0})
      (let [config (core/configuration eng "p")
            data   (core/data eng "p")
            gen    (core/generation eng "p")
            due    (core/next-due-at eng)
            dumped (core/dump eng "p")
            e      (thrown #(core/send! eng "p" :spin/facts {:merged true :running true} {:now (+ t0 5)}))]
        (is (some? e) "the call throws")
        (is (bounded/step-limit-error? e))
        (is (= {:type :sova/step-limit :limit 50 :microsteps 51 :session-id "p" :event :spin/facts}
              (select-keys (ex-data e) [:type :limit :microsteps :session-id :event])))
        (is (re-find #"Step limit: session p took more than 50 microsteps on spin/facts" (ex-message e)))
        (testing "the call changed nothing: configuration, data, generation, the pending timer and the queue"
          (is (= dumped (core/dump eng "p")) "the snapshot, the session's queue included (the cycle armed timers)")
          (is (= config (core/configuration eng "p")))
          (is (= data (core/data eng "p")))
          (is (= gen (core/generation eng "p")))
          (is (= due (core/next-due-at eng))))
        (testing "and the engine goes on: the timer fires on time"
          (core/fire-due! eng (+ t0 60000))
          (is (in? eng "p" :c))))))
  (testing "the default limit trips too, and an eventless trial trips it the same way"
    (let [eng (new-eng)]
      (core/start! eng "p" "engine-probe" {} t0)
      ;; checked before the cycle runs: an unbounded default would hang here, not fail
      (when (is (= 200 bounded/default-max-microsteps (:limit @eng)) "an engine is bounded by default")
        (let [e (thrown #(core/send! eng "p" :spin/facts {:merged true :running true} {:now t0}))]
          (is (= bounded/default-max-microsteps (:limit (ex-data e)))))
        (is (bounded/step-limit-error? (thrown #(core/trial eng "p" :spin/facts {:merged true :running true} {:now t0}))))
        (is (in? eng "p" :closed)))))
  (testing "merged and not running settles well under the limit, and every step reports its microsteps"
    (let [eng (new-eng {:max-microsteps 50})]
      (core/start! eng "p" "engine-probe" {} t0)
      (let [r (core/send! eng "p" :spin/facts {:merged true :running false} {:now t0})]
        (is (in? eng "p" :spin-merged))
        (is (= 2 (:microsteps (first (:steps r)))) "the event's own transition, then one eventless one")))))

(deftest a-step-limit-rolls-back-the-whole-call
  (testing "a's ping is processed and saved, then b cycles on it in the same call: neither session keeps anything"
    (let [[log opts] (recording)
          eng (new-eng (assoc opts :max-microsteps 50))]
      (core/start! eng "a" "engine-probe" {:peer "b" :spin-out {:merged true :running true}} t0)
      (core/start! eng "b" "engine-probe" {} t0)
      (let [before (into {} (for [sid ["a" "b"]] [sid [(core/dump eng sid) (core/generation eng sid)]]))
            saves  (count @log)
            e      (thrown #(core/send! eng "a" :act/ping {} {:now (+ t0 1)}))]
        (is (= {:session-id "b" :event :peer/pinged} (select-keys (ex-data e) [:session-id :event])))
        (is (= saves (count @log)) "no onSave ran: callbacks come only after a call commits…")
        (is (= before (into {} (for [sid ["a" "b"]] [sid [(core/dump eng sid) (core/generation eng sid)]])))
          "…but the engine holds both sessions, their generations and their queues as before the call")
        (is (nil? (:pings (core/data eng "a"))))))))

(deftest a-limit-of-n-allows-exactly-n
  (let [eng (new-eng {:max-microsteps 2})]
    (core/start! eng "p" "engine-probe" {} t0)
    (is (nil? (thrown #(core/send! eng "p" :spin/facts {:merged true :running false} {:now t0}))) "2 microsteps pass a limit of 2"))
  (let [eng (new-eng {:max-microsteps 1})]
    (core/start! eng "p" "engine-probe" {} t0)
    (is (= 2 (:microsteps (ex-data (thrown #(core/send! eng "p" :spin/facts {:merged true :running false} {:now t0}))))))
    (is (in? eng "p" :closed))))

;; ---- the library's own log lines land in each call's errors (through the timbre shim) --------------------

(deftest a-library-warning-or-error-lands-in-the-calls-errors
  (let [eng (new-eng)]
    (core/start! eng "p" "engine-probe" {} t0)
    (testing "a warning the library logs (an operation it does not know)"
      (let [r (core/send! eng "p" :probe/warn {} {:now t0})]
        (is (= [{:level "warn" :message "Operation not understood {:op :probe-unknown-op}"}] (:errors r)))))
    (testing "an error the library logs (a script that threw): its words, then the error's own message"
      (let [r (core/send! eng "p" :probe/throw {} {:now t0})]
        (is (= [{:level "error" :message "Expression failure — the probe's script threw"}] (:errors r)))))
    (testing "the next call starts with none"
      (is (= [] (:errors (core/send! eng "p" :next {} {:now t0})))))))

(deftest the-charts-pass-the-librarys-validation
  (testing "the engine registers charts without the library's check (fixed at build time): this is that check"
    (doseq [[nm c] (assoc (update-vals registry/charts :chart) "engine-probe" probe/chart)]
      (is (= [] (vec (validation/problems c))) nm))))

(deftest a-snapshot-is-plain-edn-and-a-uuid-round-trips
  (let [eng (new-eng)
        u   (random-uuid)]
    (core/start! eng "p" "engine-probe" {:u u} t0)
    (let [text (core/dump eng "p")
          eng2 (new-eng)]
      (is (not (re-find #"#(inst|queue|js)\b" text)))
      (core/load! eng2 "p" text)
      (is (= u (:u (core/data eng2 "p"))))
      (is (thrown? js/Error (core/load! (new-eng) "q" (str "#inst \"2026-01-01\" " text))) "an unknown tag is refused"))))
