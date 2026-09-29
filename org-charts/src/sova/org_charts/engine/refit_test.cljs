(ns sova.org-charts.engine.refit-test
  "The refit's engine features (API.md) on the refit probe charts: spawn, links, effects, acts and
   explain, corrections, holds (policy, reservation F2, release, drop, cancel), drive, invocations,
   resume, set-state, migrations, cold loads."
  (:require
    [cljs.test :refer [deftest is testing]]
    [clojure.string :as str]
    [sova.org-charts.engine.core :as core]
    [sova.org-charts.engine.hold-policy :as policy]
    [sova.org-charts.engine.refit-probe :as rp]))

(def t0 1000000)
(def overseer {:by "overseer" :level "L3" :project-id "p1" :overseer-id "po1"})

(defn- new-eng
  ([] (new-eng {}))
  ([opts] (core/new-engine rp/charts (merge {:level-check rp/level-check} opts))))

(defn- parent [eng] (core/start! eng "par" "refit-parent" {} t0) eng)
(defn- in? [eng sid & ids] (every? (set (core/configuration eng sid)) ids))
(defn- thrown [f] (try (f) nil (catch :default e e)))

;; ---- spawn and links -------------------------------------------------------------------------------

(deftest spawn-starts-the-child-in-the-same-call-linked-and-watched
  (let [eng (parent (new-eng))
        r   (core/send! eng "par" :kid/spawn (assoc overseer :name "ana") {:now (+ t0 1)})]
    (is (= ["par" "kid/ana" "par"] (map :session-id (:steps r)))
      "the parent's step, the child's start, then the child's link/moved to its watcher")
    (is (= [:kid/spawn :sova/started :link/moved] (map :event (:steps r))))
    (is (= {:parent "par"} (:sova/links (core/data eng "kid/ana"))))
    (is (= ["par"] (:sova/watchers (core/data eng "kid/ana"))))
    (is (= [{:sid "kid/ana" :chart "refit-kid" :link :parent}] (:sova/children (core/data eng "par"))))
    (is (= #{"par" "kid/ana"} (set (keys (:snapshots r)))) "both snapshots land in the one batch")
    (is (= [{:session-id "kid/ana" :chart "refit-kid" :by "par" :link :parent}] (:spawned r)))
    (is (= {:from "kid/ana" :chart "refit-kid" :states [:kid :new] :running true :exported {}}
          (first (:seen (core/data eng "par")))))
    (testing "a move of the child notifies its watcher with its exported keys"
      (core/send! eng "kid/ana" :kid/grow {} {:now (+ t0 2)})
      (is (= {:from "kid/ana" :states [:kid :grown] :exported {:size 1}}
            (select-keys (last (:seen (core/data eng "par"))) [:from :states :exported]))))
    (testing "a data change outside the exported keys notifies no one"
      (let [n (count (:seen (core/data eng "par")))]
        (core/send! eng "kid/ana" :kid/touch {} {:now (+ t0 3)})
        (is (= n (count (:seen (core/data eng "par")))))))
    (testing "spawning an id that exists throws and rolls the call back"
      (let [before (core/dump eng "par")
            e      (thrown #(core/send! eng "par" :kid/spawn (assoc overseer :name "ana") {:now (+ t0 4)}))]
        (is (= core/session-exists-type (:type (ex-data e))))
        (is (= before (core/dump eng "par")))))
    (testing ":if-exists :skip makes it a no-op"
      (let [r (core/send! eng "par" :kid/spawn (assoc overseer :name "ana" :if-exists :skip) {:now (+ t0 5)})]
        (is (= ["par"] (map :session-id (filter :saved (:steps r)))))))))

(deftest watch-and-unwatch-relink
  (let [eng (parent (new-eng))]
    (core/start! eng "kid/bo" "refit-kid" {} t0)
    (let [r (core/send! eng "par" :kid/watch {:target "kid/bo"} {:now (+ t0 1)})]
      (is (= ["par"] (:sova/watchers (core/data eng "kid/bo"))))
      (is (some #(= :sova/watched (:event %)) (:steps r)))
      (is (= "kid/bo" (:from (last (:seen (core/data eng "par"))))) "watching sends the current state at once"))
    (core/send! eng "par" :kid/unwatch {:target "kid/bo"} {:now (+ t0 2)})
    (is (= [] (:sova/watchers (core/data eng "kid/bo"))))
    (let [n (count (:seen (core/data eng "par")))]
      (core/send! eng "kid/bo" :kid/grow {} {:now (+ t0 3)})
      (is (= n (count (:seen (core/data eng "par")))) "no longer notified"))))

;; ---- effects -------------------------------------------------------------------------------------

(deftest effects-are-keyed-pending-and-answered-once
  (let [eng (parent (new-eng))
        r   (core/send! eng "par" :gather/start (assoc overseer :to "ana" :attended true) {:now (+ t0 1)})
        eff (first (:outbox r))
        k   (:key eff)]
    (is (= "gather" (:kind eff)))
    (is (re-matches #"par@\d+\.0" k) "the engine's key: session @ generation . index")
    (is (= #{k} (set (keys (:sova/pending (core/data eng "par"))))) "pending until answered (durable)")
    (let [r2 (core/send! eng "par" :effect/done {:key k :result {:path "s.jsonl"}} {:now (+ t0 2)})]
      (is (= [{:key k :result {:path "s.jsonl"} :kind "gather" :effect (dissoc eff :session-id)}]
            (map #(dissoc % :by) (:done (core/data eng "par")))))
      (is (empty? (:sova/pending (core/data eng "par"))))
      (is (= 1 (count (:steps r2)))))
    (let [r3 (core/send! eng "par" :effect/done {:key k} {:now (+ t0 3)})]
      (is (empty? (:steps r3)) "a second answer for the same key is stale")
      (is (= [{:session-id "par" :event :effect/done :key k}] (:stale r3))))))

;; ---- acts, explain, enabled events ----------------------------------------------------------------

(deftest explain-order-and-send-agree
  (let [eng (parent (new-eng))
        ask (fn [ev env] [(core/explain eng "par" ev env {:now t0})
                          (:refused (first (:steps (core/trial eng "par" ev env {:now t0}))))])]
    (testing "level first"
      (let [[x s] (ask :gather/start {:by "overseer" :level "L0" :attended false})]
        (is (= {:sentence "sova_start_gathering needs L1." :stage :level :check nil} x))
        (is (= x s) "a direct send is refused with the same answer")))
    (testing "then the act's pre checks"
      (is (= :pre (:stage (first (ask :door/open {:door "bad"}))))))
    (testing "then the state: no transition for it here"
      (let [[x] (ask :gather/close overseer)]
        (is (= {:sentence "gather/close doesn't apply here." :stage :state} x))))
    (testing "then the transition's checks, with tail"
      (let [[x] (ask :gather/start (assoc overseer :attended true :allowance {:gather {:used 6 :max 6}}))]
        (is (= :check (:stage x)))
        (is (= "day-allowance" (:check x)))
        (is (= "Nothing starts before then." (:tail x)))))
    (testing "then its cond, with the transition's own sentence"
      (is (= {:sentence "The door is shut." :stage :cond} (first (ask :door/open {})))))
    (testing "a taken act explains to nil"
      (is (nil? (first (ask :gather/start (assoc overseer :attended true))))))
    (testing "enabled events: every declared act, payload checks skipped"
      (let [ev (into {} (map (juxt :event identity)) (core/enabled-events eng "par" (assoc overseer :attended true) {:now t0}))]
        (is (true? (:enabled (ev :kid/spawn))) "the payload check (a name) is not run without a payload")
        (is (false? (:enabled (ev :gather/close))))
        (is (= :state (get-in ev [:gather/close :refusal :stage])))
        (is (= (sort (map str (keys rp/parent-acts))) (sort (map str (keys ev)))))))))

(deftest a-correction-needs-a-reason-except-from-the-operator
  (let [eng (parent (new-eng))]
    (core/send! eng "par" :gather/start (assoc overseer :to "a" :attended true) {:now t0})
    (let [r (core/send! eng "par" :item/reopen overseer {:now (+ t0 1)})]
      (is (= "A correction needs a reason: say why." (:sentence (:refused (first (:steps r))))))
      (is (in? eng "par" :gathering)))
    (core/send! eng "par" :item/reopen (assoc overseer :reason "the gathering was aimed wrong") {:now (+ t0 2)})
    (is (in? eng "par" :idle))
    (core/send! eng "par" :gather/start (assoc overseer :to "a" :attended true) {:now (+ t0 3)})
    (core/send! eng "par" :item/reopen {:by "operator"} {:now (+ t0 4)})
    (is (in? eng "par" :idle) "the operator's own click needs no reason")))

;; ---- holds -----------------------------------------------------------------------------------------

(def unattended (assoc overseer :attended false :hold-ms 600000 :allowance {:gather {:used 0 :max 6}}))

(deftest the-hold-policy-is-one-switch
  (is (policy/held-by? {:by "chart"}))
  (is (policy/held-by? {:by "overseer"}))
  (is (not (policy/held-by? {:by "overseer" :attended true})))
  (is (not (policy/held-by? {:by "operator"})))
  (with-redefs [policy/overseer-unattended-held? false]
    (is (not (policy/held-by? {:by "overseer"})) "flipped: the overseer's unattended calls go at once…")
    (is (policy/held-by? {:by "chart"}) "…chart-started acts stay held"))
  (is (= [["refit-parent" "gather/start"]] (policy/held-acts rp/charts)))
  (is (not (policy/held? {:hold true} {:by "chart" :hold-ms 0} {})) "0 = no hold"))

(deftest an-unattended-act-waits-in-a-hold-then-goes-ahead-under-a-fresh-envelope
  (let [stamps (atom [])
        eng    (parent (new-eng {:stamp (fn [sid ev payload ctx]
                                          (swap! stamps conj [sid ev (:to payload) ctx])
                                          (assoc unattended :fresh true))}))
        r      (core/send! eng "par" :gather/start (assoc unattended :to "ana") {:now t0})
        hold   (:held (first (:steps r)))]
    (is (in? eng "par" :idle) "not taken now")
    (is (= {:id "gather/start#0" :act true :event :gather/start :kind "gather/start" :since t0 :until (+ t0 600000)
            :by "overseer" :scope "p1" :overseer-id "po1" :project-id "p1" :counts "gather" :reserve 1 :what "Gathering with ana"}
          (dissoc hold :data)))
    (is (= [hold] (map #(dissoc % :session-id) (:holds r))))
    (is (= [(assoc hold :session-id "par")] (core/holds eng)))
    (is (= (+ t0 600000) (core/next-due-at eng)))
    (let [r2 (core/fire-due! eng (+ t0 600000))]
      (is (= [["par" :gather/start "ana" {:by "overseer" :overseer-id "po1" :project-id "p1"}]] @stamps)
        "the host stamps a fresh envelope at release, for the act's own project and overseer (F3)")
      (is (= [:gather/start :hold/released] (map :event (:steps r2))))
      (is (true? (get-in (first (:steps r2)) [:data :fresh])))
      (is (= "gather/start#0" (get-in (first (:steps r2)) [:data :sova/released])))
      (is (in? eng "par" :gathering))
      (is (empty? (core/holds eng)))
      (is (= [{:kind "gather" :to "ana"}] (map #(select-keys % [:kind :to]) (:outbox r2)))))))

(deftest a-hold-refused-at-release-is-dropped
  (let [eng (parent (new-eng {:stamp (fn [_ _ _ _] (assoc unattended :level "L0"))}))]
    (core/send! eng "par" :gather/start (assoc unattended :to "ana") {:now t0})
    (let [r (core/fire-due! eng (+ t0 600000))]
      (is (= [:gather/start :hold/dropped] (map :event (:steps r))))
      (is (= :level (:stage (:refused (first (:steps r))))))
      (is (= {:id "gather/start#0" :sentence "sova_start_gathering needs L1." :stage :level}
            (select-keys (first (:dropped (core/data eng "par"))) [:id :sentence :stage])))
      (is (in? eng "par" :idle))
      (is (contains? (:snapshots r) "par") "the hold's end is durable"))))

(deftest cancelling-a-hold-drops-its-timer
  (let [eng (parent (new-eng))]
    (core/send! eng "par" :gather/start (assoc unattended :to "ana") {:now t0})
    (let [r (core/send! eng "par" :hold/cancel {:by "overseer" :level "L1" :id "gather/start#0"} {:now (+ t0 1)})]
      (is (= "A correction needs a reason: say why." (:sentence (:refused (first (:steps r)))))))
    (let [r (core/send! eng "par" :hold/cancel {:by "overseer" :level "L1" :id "nope" :reason "x"} {:now (+ t0 1)})]
      (is (= "No held act has that id." (:sentence (:refused (first (:steps r)))))))
    (let [r (core/send! eng "par" :hold/cancel {:by "operator" :id "gather/start#0"} {:now (+ t0 2)})]
      (is (= [:hold/cancel :hold/cancelled] (map :event (:steps r))))
      (is (empty? (core/holds eng)))
      (is (nil? (core/next-due-at eng)) "its timer is gone")
      (is (empty? (:steps (core/fire-due! eng (+ t0 600000))))))))

(deftest F2-pending-holds-reserve-their-allowance
  (let [eng  (parent (new-eng))
        env  (assoc unattended :allowance {:gather {:used 5 :max 6}})
        r1   (core/send! eng "par" :gather/start (assoc env :to "a") {:now t0})
        r2   (core/send! eng "par" :gather/start (assoc env :to "b") {:now (+ t0 1)})]
    (is (some? (:held (first (:steps r1)))) "the first is held")
    (is (= "Today's allowance is used: 6 of 6 gathering sessions started on its own."
          (:sentence (:refused (first (:steps r2)))))
      "the second is refused at once: the pending hold counts as used")
    (is (= 1 (count (core/holds eng))))
    (testing "an attended call sees the reservation too"
      (is (= :check (:stage (core/explain eng "par" :gather/start (assoc env :attended true) {:now t0})))))
    (testing "another scope's holds reserve nothing here"
      (is (nil? (core/explain eng "par" :gather/start (assoc env :attended true :project-id "p2") {:now t0}))))
    (core/send! eng "par" :hold/cancel {:by "operator" :id "gather/start#0"} {:now (+ t0 2)})
    (let [r3 (core/send! eng "par" :gather/start (assoc env :to "c") {:now (+ t0 3)})]
      (is (some? (:held (first (:steps r3)))) "cancelled, the reservation is free: a third is held"))
    (testing "at release the hold no longer reserves against itself"
      (let [r (core/fire-due! eng (+ t0 3 600000))]
        (is (= [:gather/start :hold/released] (map :event (:steps r))))))))

(deftest an-effect-only-hold-lapses-when-its-state-is-gone
  (let [eng (parent (new-eng))]
    (core/send! eng "par" :offer/make (assoc unattended :hold-ms 1000) {:now t0})
    (is (= [{:kind "offer" :what "Offer to x" :while-in :idle}]
          (map #(select-keys % [:kind :what :while-in]) (core/holds eng))))
    (let [r (core/fire-due! eng (+ t0 1000))]
      (is (= [:hold/released] (map :event (:steps r))))
      (is (= ["offer"] (map :kind (:outbox r)))))
    (core/send! eng "par" :offer/make (assoc unattended :hold-ms 1000) {:now (+ t0 2000)})
    (core/send! eng "par" :timed/arm {} {:now (+ t0 2001)})
    (let [r (core/fire-due! eng (+ t0 3000))]
      (is (some #(= :hold/lapsed (:event %)) (:steps r)))
      (is (empty? (:outbox r))))
    (testing "the operator's click is never held"
      (let [eng (parent (new-eng))
            r   (core/send! eng "par" :offer/make {:by "operator"} {:now t0})]
        (is (= ["offer"] (map :kind (:outbox r))))
        (is (empty? (core/holds eng)))))))

(deftest drive-acts-under-a-stamped-chart-envelope
  (let [ctxs (atom [])
        eng  (parent (new-eng {:stamp (fn [_ _ _ ctx] (swap! ctxs conj ctx) (assoc unattended :hold-ms 5000))}))
        r    (core/send! eng "par" :drive/go {:by "system" :project-id "p1"} {:now t0})]
    (is (= {:by "chart" :project-id "p1"} (first @ctxs)) "the driving session's project is passed on")
    (is (= [:drive/go :gather/start] (map :event (:steps r))))
    (is (= "chart" (:by (second (:steps r)))))
    (is (some? (:held (second (:steps r)))) "a chart-started act is held")
    (core/fire-due! eng (+ t0 5000))
    (is (in? eng "par" :gathering))))

;; ---- W5, invocations, resume -------------------------------------------------------------------------

(deftest due-events-fire-before-an-external-event
  (let [eng (parent (new-eng))]
    (core/send! eng "par" :timed/arm {} {:now t0})
    (let [r (core/send! eng "par" :gather/start (assoc overseer :attended true :to "a") {:now (+ t0 1500)})]
      (is (= [:timed/fired :gather/start] (map :event (:steps r))) "the lapsed timer first, then the act")
      (is (in? eng "par" :gathering)))))

(deftest invocation-runs-stale-results-and-resume
  (let [eng (parent (new-eng))
        r   (core/send! eng "par" :timed/arm {} {:now t0})
        run (:run-id (first (:invocations r)))]
    (is (= :sova/look (:type (first (:invocations r)))))
    (is (= #{run} (set (keys (:sova/invocations (core/data eng "par"))))))
    (testing "resume: the run is cut off, the resumed step comes first, the past-due timer waits"
      (let [text (core/dump eng "par")
            eng2 (new-eng)]
        (core/load! eng2 "par" text)
        (let [r (core/resume! eng2 ["par"] {:now (+ t0 5000)})]
          (is (= [:sova/resumed] (map :event (:steps r))))
          (is (= [{:run-id run :type "sova/look" :invoke-id "look"}] (:cut-off (first (:resumed (core/data eng2 "par"))))))
          (is (empty? (:sova/invocations (core/data eng2 "par")))))
        (testing "a result for the cut-off run is stale"
          (let [r (core/send! eng2 "par" :look/finished {} {:now (+ t0 5001) :invoke-id run})]
            (is (empty? (:steps r)))
            (is (= run (:invoke-id (first (:stale r)))))))))
    (testing "a result for the live run is delivered"
      (core/send! eng "par" :look/finished {} {:now (+ t0 1) :invoke-id run})
      (is (in? eng "par" :idle)))))

(deftest resume-sends-link-moved-per-link-and-leaves-timers-for-fire-due
  (let [eng (parent (new-eng))]
    (core/send! eng "par" :kid/spawn (assoc overseer :name "ana") {:now t0})
    (core/send! eng "par" :timed/arm {} {:now t0})
    (let [texts {"par" (core/dump eng "par") "kid/ana" (core/dump eng "kid/ana")}
          eng2  (new-eng)]
      (doseq [[sid t] texts] (core/load! eng2 sid t))
      (let [n (count (:seen (core/data eng2 "par")))
            r (core/resume! eng2 ["kid/ana"] {:now (+ t0 9000)})]
        (is (= [:sova/resumed :link/moved] (map :event (:steps r))))
        (is (= (inc n) (count (:seen (core/data eng2 "par")))))
        (is (in? eng2 "par" :timed) "the past-due timer is not fired by resume")
        (let [r (core/fire-due! eng2 (+ t0 9000))]
          (is (= [:timed/fired] (map :event (:steps r)))))))))

;; ---- set-state -----------------------------------------------------------------------------------------

(deftest set-state-only-for-the-overseer-in-an-attended-turn
  (let [eng (parent (new-eng))
        go  (fn [env req] (core/set-state! eng "par" req env {:now t0}))
        refused (fn [r] (:refused (first (:steps r))))]
    (is (= core/attended-only (:sentence (refused (go {:by "operator"} {:states [:timed] :reason "x"})))))
    (is (= core/attended-only (:sentence (refused (go {:by "operator" :via "overseer" :attended true} {:states [:timed] :reason "x"})))))
    (is (= core/attended-only (:sentence (refused (go {:by "overseer"} {:states [:timed] :reason "x"})))))
    (is (= core/attended-only (:sentence (refused (go {:by "overseer" :attended true :via "overseer"} {:states [:timed] :reason "x"})))))
    (let [ok {:by "overseer" :attended true}]
      (is (= "A correction needs a reason: say why." (:sentence (refused (go ok {:states [:timed]}))))))
    (let [ok {:by "overseer" :attended true}]
      (is (= "This chart has no state nope." (:sentence (refused (go ok {:states [:nope] :reason "x"})))))
      (is (= "Those states can't be active together: idle and timed." (:sentence (refused (go ok {:states [:idle :timed] :reason "x"})))))
      (let [r (go ok {:states ["timed"] :patch {:gathers 9} :reason "stuck after a crash"})]
        (is (in? eng "par" :timed))
        (is (= "stuck after a crash" (:reason (first (:steps r)))))
        (is (= 9 (:gathers (core/data eng "par"))))
        (is (= [:start] (map :op (:invocations r))) "entries run: the look starts…")
        (is (= (+ t0 1000) (core/next-due-at eng)) "…and the timer is armed"))
      (let [r (core/set-state! eng "par" {:states [:gathering] :reason "wrong phase"} ok {:now (+ t0 1)})]
        (is (in? eng "par" :gathering))
        (is (= [:stop] (map :op (:invocations r))) "exits run: the look stops…")
        (is (nil? (core/next-due-at eng)) "…and the timer is cancelled")))))

;; ---- migrations and cold loads ---------------------------------------------------------------------------

(deftest migrations-chain-and-refuse-what-they-cannot
  (let [eng  (parent (new-eng))
        v2   (core/dump eng "par")
        v1   (-> v2 (str/replace ":version 2" ":version 1") (str/replace ":idle" ":waiting"))
        eng2 (new-eng)]
    (is (= 2 (:version (core/load! eng2 "par" v1))))
    (is (in? eng2 "par" :idle) "v1's :waiting is v2's :idle")
    (is (str/includes? (core/migrate-text rp/charts v1) ":version 2"))
    (is (re-find #"newer than this build" (ex-message (thrown #(core/load! eng2 "x" (str/replace v2 ":version 2" ":version 3"))))))
    (is (re-find #"no migration from v0" (ex-message (thrown #(core/load! eng2 "x" (str/replace v2 ":version 2" ":version 0"))))))))

(deftest cold-sessions-load-on-demand-and-unknown-ones-roll-back
  (let [store (atom {})
        eng   (parent (new-eng {:load-cold (fn [sid] (get @store sid))}))]
    (core/send! eng "par" :kid/spawn (assoc overseer :name "ana") {:now t0})
    (swap! store assoc "kid/ana" (core/dump eng "kid/ana"))
    (core/unload! eng "kid/ana")
    (let [r (core/send! eng "kid/ana" :kid/grow {} {:now (+ t0 1)})]
      (is (= ["kid/ana"] (:loaded r)))
      (is (= "kid/ana" (:from (last (:seen (core/data eng "par")))))))
    (let [before (core/dump eng "par")
          e      (thrown #(core/send! eng "par" :kid/watch {:target "kid/nobody"} {:now (+ t0 2)}))]
      (is (= core/unknown-session-type (:type (ex-data e))))
      (is (= before (core/dump eng "par")) "the whole call rolled back"))))

(deftest a-delayed-send-to-another-session-is-in-its-snapshot
  (let [eng (parent (new-eng))]
    (core/send! eng "par" :timed/arm {} {:now t0})
    (let [r (core/send! eng "par" :gather/start (assoc overseer :attended true) {:now (+ t0 2000)})]
      (is (contains? (:snapshots r) "par")))))

(deftest chart-info-lists-acts-states-and-corrections
  (let [info (core/chart-info rp/charts "refit-parent")]
    (is (= 2 (:version info)))
    (is (= [:hold/cancel :item/reopen] (:corrections info)))
    (is (= ["door-named"] (get-in info [:acts :door/open :pre])))
    (is (some #(= {:id :timed :kind :state :parent :top} %) (:states info)))
    (is (some #(and (= [:gather/start] (:event %)) (= ["day-allowance"] (:sova/checks %))) (:transitions info)))
    (is (= [{:state :timed :type :sova/look :id :look}] (:invocations info)))))

