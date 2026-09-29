(ns sova.org-charts.charts.rules.item
  "The item chart's aggregates, pure over what its own sessions exported (design §3.8): a gap may
   have any number of gatherings and builds, and the lane routes on aggregates of their states.
   Facts are kept per session under `:batons`, `:decisions`, `:builds` in the item's data, each the
   last `link/moved` of that session: `{:states #{…} :exported {…}}`."
  (:require
    [clojure.string :as str]
    [sova.org-charts.charts.rules.levels :as lv]))

(defn states [f] (set (:states f)))
(defn ex [f] (:exported f))

;; ---- gatherings -----------------------------------------------------------------------------------

(defn baton-open? [f] (contains? (states f) :open))
(defn baton-ended? [f] (or (contains? (states f) :done) (contains? (states f) :closed)))
(defn baton-needs-operator? [f] (contains? (states f) :with-operator))

(defn gathering
  "The aggregate of these gatherings: needs-operator (any with the operator), asking (any open),
   ended (all ended), or nil (none)."
  [fs]
  (cond
    (empty? fs) nil
    (some baton-needs-operator? fs) :needs-operator
    (some baton-open? fs) :asking
    (every? baton-ended? fs) :ended
    :else :asking))

(defn lane-batons [d] (vals (remove (fn [[_ f]] (:follow-up f)) (:batons d))))
(defn follow-up-batons [d] (vals (filter (fn [[_ f]] (:follow-up f)) (:batons d))))

;; ---- decisions --------------------------------------------------------------------------------------

(defn dstate [f] (:state (ex f)))
(defn stale? [f] (contains? (states f) :stale))
(defn edited? [f] (contains? (states f) :edited-in-spec))
(defn built? [f] (contains? (states f) :built-done))

(defn live-decisions [d] (remove #(= "superseded" (dstate %)) (vals (:decisions d))))

(defn dphase
  "The item's decision phase: none · conflict · pending · drafted (a stale promoted one is promotable
   again) · edited · promoted."
  [d]
  (let [live (live-decisions d)
        ss   (set (map dstate live))]
    (cond
      (empty? live) "none"
      (ss "conflict") "conflict"
      (ss "pending") "pending"
      (or (ss "drafted") (some stale? live)) "drafted"
      (some edited? live) "edited"
      :else "promoted")))

(defn promoted-ids [d] (vec (sort (for [[id f] (:decisions d) :when (= "promoted" (dstate f))] id))))
(defn not-built-ids [d] (vec (sort (for [[id f] (:decisions d) :when (and (= "promoted" (dstate f)) (not (built? f)))] id))))
(defn all-built? [d] (let [live (live-decisions d)] (and (seq live) (every? #(and (= "promoted" (dstate %)) (built? %)) live))))
(defn none-built? [d] (not-any? built? (live-decisions d)))

(defn in-area-drafted-ids
  "Drafted (or stale promoted) decisions whose author owns the area: what the chart may promote at L2."
  [d]
  (vec (sort (for [[id f] (:decisions d)
                   :when (and (or (= "drafted" (dstate f)) (and (= "promoted" (dstate f)) (stale? f)))
                              (true? (:author-owns-area (ex f))))]
               id))))

(defn pending-ids [d] (vec (sort (for [[id f] (:decisions d) :when (= "pending" (dstate f))] id))))

;; ---- builds -----------------------------------------------------------------------------------------

(defn b-states [f] (states f))
(defn build-working? [f] (or (contains? (states f) :working) (pos? (or (:workers (ex f)) 0))))
(defn build-starting? [f] (some (states f) [:making-worktree :setting-mode :prompting]))
(defn build-not-started? [f] (contains? (states f) :not-started))
(defn build-landed?
  "Its work is where it belongs: merged into its target (git, or the recorded merge when git can't
   say), or it runs in the project root and is not working."
  [f]
  (let [ss (states f)]
    (or (contains? ss :merged)
        (and (contains? ss :tree-removed) (some? (:merged (ex f))) (not (contains? ss :new-since-merge)))
        (and (contains? ss :tree-root) (not (build-working? f))))))
(defn build-failed? [f] (contains? (states f) :turn-failed))

(defn live-builds [d] (remove build-not-started? (vals (:builds d))))

(defn building
  "The aggregate of these builds: starting · working · failed (the newest one's last turn failed) ·
   idle (any unmerged) · merged (all landed) · nil (none)."
  [d]
  (let [bs (live-builds d)]
    (cond
      (empty? bs) nil
      (some build-starting? bs) :starting
      (some build-working? bs) :working
      (build-failed? (last (sort-by #(:created-at (ex %)) bs))) :failed
      (every? build-landed? bs) :merged
      :else :idle)))

(defn covers?
  "The builds cover the item's promoted decisions: each promoted one is named by some build."
  [d]
  (let [named (set (mapcat #(:decisions (ex %)) (live-builds d)))]
    (every? named (promoted-ids d))))

;; ---- the level in force (from the watched watch session) -----------------------------------------------

(defn level-in-force
  "The project's level in force, from its watch's exported facts (paused, settings, roster-active)."
  [d]
  (let [w (ex (:watch d))]
    (:autonomy (lv/effective-autonomy {:autonomy (get-in w [:settings :autonomy] "L1") :paused (:paused w) :roster-active (:roster-active w)}))))

(defn at-least? [d need] (lv/level-at-least? (level-in-force d) need))

;; ---- the chart's own acts (r3) --------------------------------------------------------------------------

(defn build-prompt
  "The deterministic first prompt of a build the chart starts at L3: the promoted decisions it
   builds, by record and statement."
  [d ids]
  (str "Build what these promoted decisions of " (:idea-id d) " say (the project's spec holds their records):\n"
    (str/join "\n" (for [id ids :let [x (ex (get-in d [:decisions id]))]]
                     (str "- " (or (:record-id x) id) ": " (:statement x))))
    "\n\nRecord in the spec what you built (code and evidence) for each."))

(defn same-target-older
  "An own gathering nobody wrote in, older than an open one of this gap to the same person: the
   chart closes it (r3's move). `[old-sid newer-sid]` or nil."
  [d]
  (let [bs     (for [[sid f] (:batons d) :when (baton-open? f)] [sid f])
        first-to (fn [f] (:to (first (:handoffs (ex f)))))
        own?   (fn [f] (map? (:owner (ex f))))]
    (first (for [[a fa] bs [b fb] bs
                 :when (and (not= a b) (own? fa) (nil? (:wrote-at (ex fa)))
                            (= (first-to fa) (first-to fb)) (some? (first-to fa))
                            (< (or (:created-at (ex fa)) 0) (or (:created-at (ex fb)) 0)))]
             [a b]))))
