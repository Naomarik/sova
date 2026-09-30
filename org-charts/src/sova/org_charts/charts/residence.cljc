(ns sova.org-charts.charts.residence
  "The residence chart (host-local, `residence/<org>`): this host's hold on the org, and the
   workspace repo's commit loop (§app.organizations/holder, /workspace-repo, /portability).

   Tenure ‹checking · held-elsewhere · held-here · detached›: an attach reads the holder record
   (the org snapshot's `holder`, r1) in the clone and on origin (a fetch of at most 15 s: an
   unreachable remote means only the clone counts); either naming another host not released holds
   it elsewhere, and the attach answers 409 `held` with today's sentence until the operator
   attaches anyway. Advisory, as today (q5): nothing is fenced.

   Commits ‹clean · dirty · committing›: a write makes it dirty; every minute it looks, and commits
   when an hour has passed since HEAD's commit (HEAD counts Commit Now, a restart and other hosts'
   commits); a failed push is retried at the next due look. Commit Now commits at once.

   Start data: `{:org-id :org-name :host-id :host-name :mode \"create\"|\"attach\" :commit-every-ms?}`."
  (:require
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel final]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)
(def look-ms 60000)
(def default-commit-every-ms 3600000)

(defn commit-every [data] (or (:commit-every-ms data) default-commit-every-ms))

;; ---- the holder check -------------------------------------------------------------------------------

(defn elsewhere
  "The holder record naming another host, not released (local first, then origin's), or nil."
  [data {:keys [local remote]}]
  (let [other? (fn [h] (and (map? h) (:host-id h) (not= (:host-id h) (:host-id data)) (nil? (:released-at h))))]
    (first (filter other? [local remote]))))

(defn held-sentence
  "heldSentence: the attach's 409 answer."
  [{:keys [host-name since]}]
  (str host-name " holds this organization" (when since (str " (since " (b/utc-minute since) " UTC)")) ". If it still runs there, attaching it here too makes two copies that drift apart, and one host's work can't be pushed. "
    "Detach it on " host-name " first, or attach anyway if " host-name " is gone."))

(defn read-result [data] (get-in (b/evt data) [:result]))
(defn holder-read? [_ data] (= "read-holder" (:kind (b/evt data))))

(defn claim-org
  "Tell the org chart this host holds it now (the holder record, r1)."
  []
  (Send {:event :holder/claim
         :targetexpr (fn [_ d] (b/org-sid (:org-id d)))
         :content (fn [_ d] {:host-id (:host-id d) :host-name (:host-name d) :since (b/now-ms d)})}))

(defn due?
  "An hour (the commit interval) since HEAD's commit."
  [_ d]
  (>= (- (b/now-ms d) (or (:head-at d) 0)) (commit-every d)))

(defn commit-result-ops
  "A commit's result: HEAD's time, whether the push failed (kept in the snapshot), git's error."
  [d]
  (let [res (read-result d)]
    [(ops/assign :head-at (or (:head-at res) (:head-at d) (b/now-ms d)))
     (ops/assign :push-pending (true? (:push-failed res)))
     (ops/assign :last-git-error (:error res))]))

(defn commit-effect [message-fn]
  (dsl/effect :commit (fn [d] {:message (message-fn d)})))

(def chart
  (statechart {:initial :residence}
    (state {:id :residence :initial :regions}
      (parallel {:id :regions}
        (state {:id :tenure :initial :checking}
          (state {:id :checking}
            (on-entry {}
              (script {:expr (fn [_ d] (when (= "create" (:mode d)) [(ops/assign :created true)]))})
              (dsl/effect :read-holder (fn [_] {:fetch-ms 15000})))
            ;; A create holds it at once (nothing to read).
            (transition {:sova/feed :feed :cond (fn [_ d] (true? (:created d))) :target :held-here})
            (transition {:sova/feed :feed :event :effect/done :cond (fn [env d] (and (holder-read? env d) (some? (elsewhere d (read-result d)))))
                         :target :held-elsewhere}
              (script {:expr (fn [_ d] (let [h (elsewhere d (read-result d))]
                                         [(ops/assign :held-by h) (ops/assign :held-sentence (held-sentence h))]))}))
            (transition {:sova/feed :feed :event :effect/done :cond holder-read? :target :held-here})
            ;; A fetch that fails is an unreachable remote: the clone's record alone was read.
            (transition {:sova/feed :feed :event :effect/failed :cond holder-read? :target :held-here}))

          (state {:id :held-elsewhere}
            (dsl/act {:sova/feed :feed :event :attach/confirm :target :held-here}))

          (state {:id :held-here}
            (on-entry {}
              (claim-org)
              (script {:expr (fn [_ d] [(ops/assign :held-by nil) (ops/assign :held-sentence nil)])})
              (commit-effect (fn [d] (if (:created d) (str "Create organization " (:org-name d)) (str "Attached on " (:host-name d)))))
              ;; An attach pauses every project of the repo on this host (a create pauses nothing).
              (script {:expr (fn [_ d] (when-not (:created d) (dsl/effect-ops d (dsl/effect-map :pause-overseers nil d))))}))
            (dsl/act {:sova/feed :feed :event :org/detach :target :detached}
              (dsl/effect :revoke-owner-links (fn [_] {:why "detached"}))
              (Send {:event :holder/release :targetexpr (fn [_ d] (b/org-sid (:org-id d)))
                     :content (fn [_ d] {:host-id (:host-id d)})})
              (commit-effect (fn [d] (str "Released by " (:host-name d))))))

          ;; The engine unloads the org once this is entered and its effects ran.
          (final {:id :detached}))

        ;; The hourly committer (F-012): every minute it looks; once an hour has passed since HEAD
        ;; it commits whatever git reports changed (any writer: visits, costs, updates, ideas, notes,
        ;; a hand edit), and with nothing to commit it pushes what the remote lacks. A write while
        ;; it commits is in the next commit.
        (state {:id :commits :initial :clean}
          ;; internal: an external one leaves the :regions parallel, re-entering :tenure (read-holder, claims)
          (dsl/act {:sova/feed :feed :event :commit/now :type :internal :target :committing})
          (transition {:sova/feed :quiet :event :effect/done :cond (fn [_ d] (#{"commit" "push"} (:kind (b/evt d))))}
            (script {:expr (fn [_ d] (commit-result-ops d))}))
          (state {:id :clean}
            (on-entry {} (Send {:id :look-clean :event :commit/look :delay look-ms}))
            (on-exit {} (cancel {:sendid :look-clean}))
            (transition {:sova/feed :quiet :event :store/written :target :dirty})
            (transition {:sova/feed :quiet :event :commit/look :cond due? :target :committing})
            (transition {:sova/feed :quiet :event :commit/look :target :clean}))
          (state {:id :dirty}
            (on-entry {} (Send {:id :look-dirty :event :commit/look :delay look-ms}))
            (on-exit {} (cancel {:sendid :look-dirty}))
            (transition {:sova/feed :quiet :event :commit/look :cond due? :target :committing})
            (transition {:sova/feed :quiet :event :commit/look :target :dirty}))
          (state {:id :committing}
            (on-entry {}
              (script {:expr (fn [_ d] [(ops/assign :written-since false)])})
              (commit-effect (fn [_] nil)))
            (transition {:sova/feed :quiet :event :store/written}
              (script {:expr (fn [_ d] [(ops/assign :written-since true)])}))
            (transition {:sova/feed :quiet :event :effect/done :cond (fn [_ d] (and (= "commit" (:kind (b/evt d))) (:written-since d))) :target :dirty}
              (script {:expr (fn [_ d] (commit-result-ops d))}))
            (transition {:sova/feed :quiet :event :effect/done :cond (fn [_ d] (= "commit" (:kind (b/evt d)))) :target :clean}
              (script {:expr (fn [_ d] (commit-result-ops d))}))
            (transition {:sova/feed :quiet :event :effect/failed :cond (fn [_ d] (= "commit" (:kind (b/evt d)))) :target :dirty}
              (script {:expr (fn [_ d] [(ops/assign :last-git-error (:detail (b/evt d)))])}))))))))

(def acts
  {:attach/confirm {:needs nil}
   :org/detach     {:needs nil}
   :commit/now     {:needs nil}})

(defn not-here [event config _data]
  (cond
    (= event :attach/confirm) (if (contains? config :held-here) "That organization is already attached here." "That can't be done now.")
    (contains? config :detached) "Unknown organization"
    :else "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :host-local
   :exported [:held-by :held-sentence :last-git-error :push-pending :head-at]
   :acts     acts
   :not-here not-here
   :final-refusal "Unknown organization"})
