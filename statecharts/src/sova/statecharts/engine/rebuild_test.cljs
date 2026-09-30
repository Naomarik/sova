(ns sova.statecharts.engine.rebuild-test
  "`statecharts rebuild --verify` (engine/rebuild): a log written the way the host writes it replays to
   every session's snapshot; a hand-changed snapshot, a log that doesn't reach its start and rows
   without a snapshot are reported."
  (:require
    [cljs.test :refer [deftest is testing]]
    [clojure.string :as str]
    [sova.statecharts.api :as api]
    [sova.statecharts.engine.core :as core]
    [sova.statecharts.engine.rebuild :as rebuild]
    [sova.statecharts.engine.refit-probe :as rp]))

(def t0 1000000)
(def overseer {:by "overseer" :level "L3" :project-id "p1" :overseer-id "po1"})
(def unattended (assoc overseer :attended false :hold-ms 600000 :allowance {:gather {:used 0 :max 6}}))

(defn- nm [k] (if (keyword? k) (subs (str k) 1) (str k)))
(defn- as-read [x] (api/->clj (api/->js x)))

(defn- recorder
  "An engine whose steps become log rows as the host writes them (logged steps only, `at` unique
   with the engine's time as `t` when moved on, a host start's data as `:start`), read back through
   JSON the way the API hands them over."
  []
  (let [rows (atom []) last-at (atom 0)
        mk   #(core/new-engine rp/statecharts {:level-check rp/level-check :stamp (fn [_ _ _ _] (assoc unattended :fresh true))})
        eng  (atom (mk))
        log! (fn [r & [{:keys [start-sid start-envelope]}]]
               (doseq [s (:steps r) :when (or (:saved s) (:refused s) (:held s))]
                 (let [at  (max (:at s) (inc @last-at))
                       env (as-read (or (:data s) {}))
                       host-start? (and start-sid (= :sova/started (:event s)) (= start-sid (:session-id s)))]
                   (reset! last-at at)
                   (swap! rows conj
                     (cond-> {:at at :session (:session-id s) :statechart (:statechart s) :event (nm (:event s))
                              :envelope (if host-start? (as-read start-envelope) env) :after (mapv nm (:after s))}
                       host-start? (assoc :start env)
                       (not= at (:at s)) (assoc :t (:at s))
                       (:refused s) (assoc :refused (:sentence (:refused s)))
                       (:held s) (assoc :held true)
                       (:invoke-id s) (assoc :invoke-id (nm (:invoke-id s)))))))
               r)]
    {:rows rows :eng eng :log! log!
     :restart! (fn [now]
                 ;; a host restart: every session loaded from its snapshot, then resumed
                 (let [old @eng texts (into {} (map (fn [sid] [sid (core/dump old sid)])) (core/session-ids old))
                       e2  (mk)]
                   (doseq [[sid t] texts] (core/load! e2 sid t))
                   (reset! eng e2)
                   (log! (core/resume! e2 (vec (keys texts)) {:now now}))
                   (log! (core/fire-due! e2 now))))}))

(defn- verify [{:keys [rows eng]} sid & [text]]
  (rebuild/verify-session rp/statecharts sid (filterv #(= sid (:session %)) @rows)
    (if (some? text) text (core/dump @eng sid))))

(defn- lived
  "A parent's life: a host start, a spawned kid, an effect answered, a look run and answered, a
   held act released at its end, a refusal, a watch dropped, a restart, a set-state with a patch."
  []
  (let [{:keys [eng log! restart!] :as rec} (recorder)
        e #(deref eng)]
    (log! (core/start! (e) "par" "refit-parent" {:label "p"} t0) {:start-sid "par" :start-envelope {:by "operator"}})
    (log! (core/send! (e) "par" :kid/spawn (assoc overseer :name "ana") {:now (+ t0 1)}))
    (let [r (log! (core/send! (e) "par" :gather/start (assoc overseer :to "ana" :attended true) {:now (+ t0 2)}))]
      (log! (core/send! (e) "par" :effect/done {:key (:key (first (:outbox r))) :result {:path "s.jsonl"}} {:now (+ t0 3)})))
    (log! (core/send! (e) "par" :gather/close (assoc overseer :attended true) {:now (+ t0 4)}))
    (let [r (log! (core/send! (e) "par" :timed/arm {} {:now (+ t0 5)}))]
      (log! (core/send! (e) "par" :look/finished {} {:now (+ t0 6) :invoke-id (:run-id (first (:invocations r)))})))
    (log! (core/send! (e) "par" :gather/start (assoc unattended :to "bo") {:now (+ t0 10)}))
    (log! (core/send! (e) "kid/ana" :kid/grow {} {:now (+ t0 11)}))
    (log! (core/set-state! (e) "par" {:states [:timed] :reason "x"} {:by "operator"} {:now (+ t0 12)}))
    (log! (core/fire-due! (e) (+ t0 600010)))
    (log! (core/send! (e) "par" :gather/close (assoc overseer :attended true) {:now (+ t0 600011)}))
    (log! (core/send! (e) "par" :timed/arm {} {:now (+ t0 600012)}))
    (restart! (+ t0 700000))
    (log! (core/set-state! (e) "par" {:states ["timed"] :patch {:gathers 9} :reason "stuck"} {:by "overseer" :attended true} {:now (+ t0 700001)}))
    rec))

(deftest a-log-written-by-the-host-replays-to-every-snapshot
  (let [rec (lived)
        evs (set (map :event @(:rows rec)))]
    (is (every? evs ["sova/started" "kid/spawn" "link/moved" "effect/done" "look/finished" "hold/released" "sova/resumed" "sova/set-state"])
      "the life covers every kind of row the replay treats specially")
    (is (some :refused @(:rows rec)) "and a refusal")
    (doseq [sid ["par" "kid/ana"]]
      (let [v (verify rec sid)]
        (is (:same v) (str sid " replays to its snapshot: " (pr-str (:differences v)) " " (pr-str (:divergence v))))
        (is (nil? (:divergence v)))))))

(deftest a-hand-changed-snapshot-is-reported
  (let [rec  (lived)
        text (core/dump @(:eng rec) "par")]
    (testing "its states"
      (let [e2 (core/new-engine rp/statecharts {})]
        (core/load! e2 "par" text)
        (core/set-state! e2 "par" {:states ["gathering"] :reason "hand edit"} {:by "overseer" :attended true} {:now (+ t0 800000)})
        (let [v (verify rec "par" (core/dump e2 "par"))]
          (is (false? (:same v)))
          (is (some #{:configuration} (map :what (:differences v)))))))
    (testing "its timers"
      (let [v (verify rec "par" (core/snapshot-text (assoc (core/read-snapshot text) :queue [])))]
        (is (= [:timers] (map :what (:differences v))) "only what was changed")))
    (testing "its links"
      (let [v (verify rec "kid/ana" (str/replace (core/dump @(:eng rec) "kid/ana") "\"par\"" "\"other\""))]
        (is (some #{:links} (map :what (:differences v))))))))

(deftest a-log-that-doesnt-reach-its-start-or-has-no-snapshot-is-reported
  (let [rec (lived)
        rows (filterv #(= "par" (:session %)) @(:rows rec))]
    (is (= [:start] (map :what (:differences (rebuild/verify-session rp/statecharts "par" (vec (rest rows)) (core/dump @(:eng rec) "par"))))))
    (is (= [:snapshot] (map :what (:differences (rebuild/verify-session rp/statecharts "par" rows nil)))))))

(deftest a-step-the-replay-takes-another-way-is-the-first-divergence
  (let [rec  (lived)
        rows (mapv #(if (and (= "par" (:session %)) (= "kid/spawn" (:event %))) (assoc % :after ["nowhere"]) %) @(:rows rec))
        v    (rebuild/verify-session rp/statecharts "par" (filterv #(= "par" (:session %)) rows) (core/dump @(:eng rec) "par"))]
    (is (:same v) "the outcome still matches")
    (is (= "kid/spawn" (:event (:divergence v))))
    (is (= ["nowhere"] (:logged (:divergence v))))))
