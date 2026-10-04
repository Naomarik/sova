(ns sova.statecharts.rules.runtime
  "The software registry's pure rules (§app.project-runtime/standing): one standing derived from the facts
   the host observed on main (definition, approval, proof, sources), what changed since registration,
   and whether a definition waits for the operator's approval. Pure; nothing here knows an organization.")

(def standings ["unregistered" "awaiting-approval" "conforming" "registered" "stale" "failed"])

(defn main-hash [d] (when (= "present" (get-in d [:def :state])) (get-in d [:def :hash])))

(defn- proof-of?
  "An unconfined conformance of main's hash at the current suite, newer than a re-approval of a failed one."
  [d p]
  (and (map? p) (some? (main-hash d)) (= (main-hash d) (:hash p)) (= (:suite d) (:suite p))
       (not (true? (:confined p)))
       (or (nil? (:cleared-at d)) (> (or (:at p) 0) (:cleared-at d)))))

(defn proof
  "The unconfined proof that counts for main's hash: the newest of the host's stamp (`:proof`) and the
   conform effect's own answer (`:conform-result`), or nil."
  [d]
  (->> [(:proof d) (:conform-result d)] (filter #(proof-of? d %)) (sort-by #(or (:at %) 0)) last))

(defn approved? [d] (and (some? (main-hash d)) (= (main-hash d) (get-in d [:approved :hash]))))

(defn current-registration?
  "`:registered` is for main's hash at the current suite."
  [d]
  (let [r (:registered d)] (and (map? r) (= (main-hash d) (:hash r)) (= (:suite d) (:suite r)))))

(defn fingerprint [d] (get-in d [:sources :fingerprint]))

(defn standing-of
  "The standing (a string of `standings`) from the facts: no definition → unregistered; an invalid one or an
   unconfined failure of its hash → failed; not approved here → awaiting-approval; no unconfined pass at the
   current suite → conforming; registered at another fingerprint → stale; else registered."
  [d]
  (let [st (get-in d [:def :state])]
    (cond
      (or (nil? st) (= "absent" st)) "unregistered"
      (not= "present" st) "failed"
      (not (approved? d)) "awaiting-approval"
      :else (let [p (proof d)]
              (cond
                (nil? p) "conforming"
                (not (true? (:pass p))) "failed"
                (not (current-registration? d)) "registered"
                (= (fingerprint d) (get-in d [:registered :fingerprint])) "registered"
                :else "stale")))))

(defn registration
  "What entering registered records: main's hash, the suite, the sources' fingerprint and files, the commit."
  [d now]
  {:hash (main-hash d) :suite (:suite d) :fingerprint (fingerprint d) :files (vec (get-in d [:sources :files]))
   :commit (:commit d) :at now})

(defn changed-paths
  "The source paths whose content differs between the registration and main now (added, removed or changed),
   in the order main lists them, then the ones main dropped."
  [d]
  (let [then (into {} (map (juxt :path :sha)) (get-in d [:registered :files]))
        now  (vec (get-in d [:sources :files]))
        now-m (into {} (map (juxt :path :sha)) now)]
    (vec (concat (for [{:keys [path sha]} now :when (not= sha (get then path ::none))] path)
                 (for [{:keys [path]} (get-in d [:registered :files]) :when (not (contains? now-m path))] path)))))

(defn drift
  "`{:paths :fingerprint}` while the registration's fingerprint differs from main's, else nil."
  [d]
  (when (and (current-registration? d) (some? (get-in d [:registered :fingerprint]))
             (not= (fingerprint d) (get-in d [:registered :fingerprint])))
    {:paths (changed-paths d) :fingerprint (fingerprint d)}))

(defn adopt
  "A run that found nothing to change (or merged with main's hash unchanged): the registration takes main's
   current sources. nil when there is no current registration."
  [d]
  (when (current-registration? d)
    (assoc (:registered d) :fingerprint (fingerprint d) :files (vec (get-in d [:sources :files])))))

;; ---- approval ---------------------------------------------------------------------------------------

(defn branch-hash [d] (when (= "present" (get-in d [:playbook :branch-facts :def :state])) (get-in d [:playbook :branch-facts :def :hash])))

(defn main-waiting?
  "Main's valid definition waits for approval (awaiting approval), or for a fresh one (failed)."
  [d]
  (and (some? (main-hash d)) (contains? #{"awaiting-approval" "failed"} (:standing d))))

(defn branch-waiting?
  "The playbook's branch proposes a definition not yet approved here."
  [d]
  (and (= "proposed" (:playbook-state d)) (some? (branch-hash d)) (not (true? (get-in d [:playbook :branch-facts :approved])))))

(def nothing-waiting "There is no definition waiting for approval.")
(def changed-since "The definition changed since it was shown: look again.")
(def operator-only "Only the operator approves a definition.")

(defn approve-refusal
  "Why `runtime/approve {hash}` can't be taken now (nil: it can): `by` who acts, `h` the hash shown."
  [d by h]
  (cond
    (not= "operator" by) {:sentence operator-only :status 403}
    (not (or (main-waiting? d) (branch-waiting? d))) {:sentence nothing-waiting :status 409}
    (not (contains? (cond-> #{} (main-waiting? d) (conj (main-hash d)) (branch-waiting? d) (conj (branch-hash d))) h))
    {:sentence changed-since :status 409}))

(defn approves-main? [d h] (and (main-waiting? d) (= h (main-hash d))))

;; ---- the playbook's run, from its build's link notification ----------------------------------------------

(defn run-moved
  "Where the playbook's build has got to, from its `link/moved` (`{:states :exported}`): :merged, :removed,
   :not-started, :waiting (a turn ended, not running, its session waits on open alignment questions, whatever
   its branch holds), :no-change (a turn ended, not running, no commits), :proposed (a turn ended, not running,
   commits not merged), :working (running again), or nil (nothing to say yet)."
  [{:keys [states exported]}]
  (let [s (set states) ex exported]
    (cond
      (contains? s :merged) :merged
      (or (contains? s :tree-removed) (contains? s :retired)) :removed
      (contains? s :not-started) :not-started
      (true? (:running ex)) :working
      (nil? (:last-turn-at ex)) nil
      (pos? (or (:questions ex) 0)) :waiting
      (= "no-commits" (:branch-state ex)) :no-change
      (contains? #{"unmerged" "new-since-merge"} (:branch-state ex)) :proposed)))
