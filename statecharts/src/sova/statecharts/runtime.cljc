(ns sova.statecharts.runtime
  "The runtime statechart (host-local, `runtime/<p>`): the project's software registry on this host
   (§app/project-runtime). Project layer: it knows the project id and root, never an organization. The
   project spawns it at birth beside its watch; the host starts it for every existing project as the
   project's engine opens. Approval and proof are this host's, so after an attach elsewhere it starts fresh.

   ```
   runtime ‹compound› → regions ‹parallel›
   ├─ standing  unregistered · awaiting-approval · conforming · registered · stale · failed
   └─ playbook  idle · running · proposed
   ```

   standing moves only by eventless transitions over `rules/runtime standing-of` (the facts the host
   observed on main's HEAD: `runtime/observed`, a quiet mirror sent only when they changed). Entering
   conforming emits effect `conform {hash}` (the operator's approval is the authority); entering
   registered records the registration. playbook follows the build the project's `verbs/onboard` started
   (`playbook/started`, then its `link/moved`). `runtime/approve {hash}` is the operator's only.

   What runs right now (units, instances) is never stored here: the host joins the engine's status at read
   time. Start data: `{:project-id :root}`."
  (:require
    [clojure.string]
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry script]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.statecharts.base :as b]
    [sova.statecharts.rules.runtime :as rr]
    [sova.statecharts.engine.dsl :as dsl]))

(def version 1)

(def fact-keys [:commit :def :software :sources :approved :proof :confined-proof :suite])

(defn- e [d] (b/evt d))
(defn- done-kind? [k] (fn [_ d] (= k (:kind (e d)))))

(defn- reason
  "A reason to the project's watch, as the statechart's own news (r14: `asks` decides whether it looks)."
  [f]
  [(script {:sova/reason true
            :expr (fn [_ d] (when-let [r (f d)]
                              (b/queue-sends d [{:target (b/watch-sid (:project-id d)) :event :reason/noted
                                                 :data (merge {:by "statechart" :at (b/now-ms d)} r)}])))})
   (com.fulcrologic.statecharts.elements/raise {:event :sova.statecharts/flush})])

(defn- hash12
  "The first 12 characters of a hash, as people see it (no `sha256:` prefix)."
  [h]
  (let [s (clojure.string/replace (str h) #"^sha256:" "")] (subs s 0 (min 12 (count s)))))

;; ---- standing -----------------------------------------------------------------------------------

(def standing-ids {"unregistered" :unregistered "awaiting-approval" :awaiting-approval "conforming" :conforming
                   "registered" :registered "stale" :stale "failed" :failed})

(def entry-asks
  "r14: what entering each standing asks of the overseer (its on-entry sends the reason): a registration is
   news only; going stale or failing asks it to act."
  {:registered false :stale true :failed true})

(defn- moves-from [here]
  (for [[s target] standing-ids :when (not= target here)]
    (transition (cond-> {:sova/feed :feed :cond (fn [_ d] (= s (rr/standing-of d))) :target target}
                  (contains? entry-asks target) (assoc :sova/asks-overseer (entry-asks target))))))

(defn- standing
  "A standing's state: it mirrors its name, and main's hash as shown (`hash12`: the log drops hashes, and the
   registry's feed names the definition by it)."
  [id & content]
  (apply state {:id id}
    (on-entry {} (script {:expr (fn [_ d] [(ops/assign :standing (name id)) (ops/assign :hash12 (some-> (rr/main-hash d) hash12))])}))
    (concat (moves-from id) content)))

;; ---- the playbook's run ----------------------------------------------------------------------------

(defn- run-of? [_ d] (and (= (:from (b/moved d)) (get-in d [:playbook :sid])) (= "build" (:statechart (b/moved d)))))
(defn- moved-to [k] (fn [env d] (and (run-of? env d) (= k (rr/run-moved (b/moved d))))))
(defn- moved-to-end [env d] (and (run-of? env d) (contains? #{:merged :removed :not-started :no-change} (rr/run-moved (b/moved d)))))

(def result-of {:merged "merged" :removed "removed" :not-started "not-started" :no-change "no-change"})

(defn- end-ops
  "A run that ended: its result, the build unwatched; nothing to change (or a merge that left main's hash as it
   was, now or at the next observation) takes main's current sources as the registration's."
  [d]
  (let [k      (rr/run-moved (b/moved d))
        branch (get-in (b/moved d) [:exported :branch])
        adopt  (when (or (= k :no-change)
                         (and (= k :merged) (some? (rr/main-hash d)) (not= (rr/branch-hash d) (rr/main-hash d))
                              (= (rr/main-hash d) (get-in d [:registered :hash]))))
                 (rr/adopt d))]
    (cond-> [(ops/assign :playbook (-> (:playbook d) (assoc :result (result-of k) :ended-at (b/now-ms d)) (dissoc :branch-facts)
                                     (cond-> branch (assoc :branch branch))))
             (ops/assign :sova/directives (conj (vec (:sova/directives d)) {:op :unwatch :target (get-in d [:playbook :sid])}))]
      adopt (conj (ops/assign :registered adopt))
      (= k :merged) (conj (ops/assign :adopt-next true)))))

(defn- run-state [id label & content]
  (apply state {:id id}
    (on-entry {} (script {:expr (fn [_ d] [(ops/assign :playbook-state label)])}))
    content))

(defn- ended-transition []
  (transition {:sova/feed :feed :sova/asks-overseer {"runtime/playbook-done" :overseer-started} :event :link/moved :cond moved-to-end :target :idle}
    (script {:expr (fn [_ d] (end-ops d))})
    (reason (fn [d] (let [started-by (get-in d [:playbook :started-by])
                          k (rr/run-moved (b/moved d))]
                      {:kind "runtime/playbook-done" :asks (= "overseer" started-by)
                       :params {:result (result-of k) :session-id (get-in d [:playbook :session-id])}
                       :key (str "runtime/playbook-done:" (get-in d [:playbook :sid]))})))))

;; ---- facts ------------------------------------------------------------------------------------------

(defn- observed-ops
  "`runtime/observed`: the facts it carries (each key present), the playbook branch's facts while a run is
   live, then the drift (changed paths) and a pending adoption after a merge."
  [d]
  (let [ev  (e d)
        d2  (merge d (select-keys ev fact-keys))
        d2  (if (and (contains? ev :branch-facts) (:playbook d2))
              (assoc-in d2 [:playbook :branch-facts] (:branch-facts ev)) d2)
        adopt (when (:adopt-next d2) (rr/adopt d2))
        d2  (cond-> (dissoc d2 :adopt-next) adopt (assoc :registered adopt))]
    (cond-> (into [] (for [k fact-keys :when (contains? ev k)] (ops/assign k (get ev k))))
      (contains? ev :branch-facts) (conj (ops/assign :playbook (:playbook d2)))
      (:adopt-next d) (conj (ops/delete :adopt-next))
      adopt (conj (ops/assign :registered adopt))
      true (conj (ops/assign :drift (rr/drift d2))))))

(def statechart
  (chart/statechart {:initial :runtime}
    (state {:id :runtime :initial :regions}
      (b/flush-transition)
      (transition {:sova/feed :quiet :event :runtime/observed}
        (script {:expr (fn [_ d] (observed-ops d))}))

      ;; Approve {hash}: the operator's only; main's definition while it waits (awaiting approval, or failed:
      ;; approving it again runs conformance again), or the playbook branch's while its run is proposed.
      (dsl/act {:sova/feed :feed :event :runtime/approve
                :checks [(fn [d] (rr/approve-refusal d (b/by d) (:hash (e d))))]}
        (dsl/effect :approve (fn [d] (let [h (:hash (e d))]
                                       (cond-> {:hash h :ref "HEAD"}
                                         (not (rr/approves-main? d h)) (assoc :ref (get-in d [:playbook :branch])))))))
      (transition {:sova/feed :feed :event :effect/done :cond (done-kind? "approve")}
        (script {:expr (fn [_ d] (let [h (get-in (e d) [:result :hash])]
                                   (cond-> [(ops/assign :approved-last {:hash h :hash12 (hash12 h) :at (b/now-ms d)}) (ops/assign :approve-refused nil)]
                                     (and (= "failed" (:standing d)) (= h (rr/main-hash d))) (conj (ops/assign :cleared-at (b/now-ms d))))))}))
      (transition {:sova/feed :feed :event :effect/failed :cond (done-kind? "approve")}
        (script {:expr (fn [_ d] [(ops/assign :approve-refused (:detail (e d)))])}))

      ;; The automatic unconfined conformance's answer (whatever the standing is now: it records its own hash).
      (transition {:sova/feed :feed :event :effect/done :cond (done-kind? "conform")}
        (script {:expr (fn [_ d] [(ops/assign :conform-result (merge {:at (b/now-ms d)} (select-keys (get-in (e d) [:result]) [:hash :suite :pass :confined :at :failed :memory])))])}))
      (transition {:sova/feed :feed :event :effect/failed :cond (done-kind? "conform")}
        (script {:expr (fn [_ d] [(ops/assign :conform-result {:hash (rr/main-hash d) :suite (:suite d) :pass false :confined false :at (b/now-ms d)
                                                              :failed {:check "run" :detail (:detail (e d))}})])}))

      (parallel {:id :regions}
        (state {:id :standing :initial :unregistered}
          (standing :unregistered)
          (standing :awaiting-approval)
          (standing :conforming
            (on-entry {} (dsl/effect :conform (fn [d] {:hash (rr/main-hash d)}))))
          (standing :registered
            (on-entry {}
              (script {:expr (fn [_ d] (when-not (rr/current-registration? d)
                                         [(ops/assign :registered (rr/registration d (b/now-ms d))) (ops/assign :drift nil)]))}))
            (on-entry {}
              (reason (fn [d] {:kind "runtime/registered" :asks false
                               :params {:n (count (:software d)) :hash (hash12 (rr/main-hash d))}
                               :key (str "runtime/registered:" (rr/main-hash d) ":" (rr/fingerprint d))}))))
          (standing :stale
            (on-entry {}
              (reason (fn [d] {:kind "runtime/stale" :asks true :params {:paths (vec (get-in d [:drift :paths]))}
                               :key (str "runtime/stale:" (rr/fingerprint d))}))))
          (standing :failed
            (on-entry {}
              (reason (fn [d] (let [p (rr/proof d)]
                                {:kind "runtime/failed" :asks true
                                 :params (cond-> {:hash (hash12 (rr/main-hash d))}
                                           (get-in d [:def :error]) (assoc :error (get-in d [:def :error]))
                                           (:failed p) (assoc :check (get-in p [:failed :check]) :detail (get-in p [:failed :detail])))
                                 :key (str "runtime/failed:" (or (rr/main-hash d) (get-in d [:def :error])) ":" (:at p))}))))))

        (state {:id :playbook :initial :idle}
          (run-state :idle "idle"
            (transition {:sova/feed :feed :event :playbook/started :target :running}
              (script {:expr (fn [_ d] (let [ev (e d)]
                                         [(ops/assign :playbook (cond-> {:sid (:sid ev) :session-id (:session-id ev) :started-by (or (:started-by ev) "operator")
                                                                         :at (b/now-ms d)}
                                                                  (:why ev) (assoc :why (:why ev))
                                                                  (:title ev) (assoc :title (:title ev))))]))})
              (dsl/watch (fn [d] (:sid (e d))))))
          (run-state :running "running"
            (ended-transition)
            (transition {:sova/feed :feed :sova/asks-overseer false :event :link/moved :cond (moved-to :proposed) :target :proposed}
              (script {:expr (fn [_ d] [(ops/assign :playbook (assoc (:playbook d) :branch (get-in (b/moved d) [:exported :branch])))])})
              (reason (fn [d] {:kind "runtime/proposed" :asks false :params {:branch (get-in (b/moved d) [:exported :branch])}
                               :key (str "runtime/proposed:" (get-in d [:playbook :sid]) ":" (get-in (b/moved d) [:exported :last-turn-at]))})))
            (transition {:sova/feed :quiet :event :link/moved :cond run-of?}))
          (run-state :proposed "proposed"
            (ended-transition)
            (transition {:sova/feed :feed :event :link/moved :cond (moved-to :working) :target :running})
            (transition {:sova/feed :quiet :event :link/moved :cond run-of?})))))))

(def acts
  {:runtime/approve {:needs nil}})

(defn not-here [_event _config _data] "That can't be done now.")

(defn overseer-started? [d] (= "overseer" (get-in d [:playbook :started-by])))

(def entry
  {:statechart statechart
   :version    version
   :migrate    {}
   :storage    :host-local
   :exported   [:project-id :root :standing :hash12 :playbook-state :commit :def :software :sources :approved :proof :confined-proof :suite
                :registered :drift :playbook :conform-result :approved-last :approve-refused :cleared-at]
   :acts       acts
   :not-here   not-here})
