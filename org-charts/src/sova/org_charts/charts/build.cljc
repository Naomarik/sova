(ns sova.org-charts.charts.build
  "The build chart (portable, `build/<org>/<p>/<sid>`): one coding session the project started, the
   overseer's (`coding`) or the operator's (`operator-coding`), its worktree, branch and merge
   (§app.project-overseer/coding-worktrees, /new-coding-session, /coding-mode).

   ```
   build ‹compound› → regions ‹parallel›
   ├─ setup   making-worktree · setting-mode · prompting · ready · not-started
   ├─ turn    idle · working · failed          (the runtime's facts; `workers` beside it)
   ├─ tree    open · missing · removed · root  (git facts: the worktrees extension's probe)
   ├─ branch  no-commits · unmerged · merged · new-since-merge   (git facts)
   └─ merge   merge-idle · merging              (Merge Branch: the operator's only)
   ```

   Git decides merged (a branch that gained commits after a merge is unmerged again); the recorded
   merge decides only when the branch is gone or git can't be read. Paths are host-local: the host
   keeps the session file and worktree folder in its own table, never here.

   Start data: started.json's row `{:org-id :project-id :session-id :kind :title :prompt :started-by
   :via :gap :item :decisions :model :thinking :mode :op-item :folder :created-at}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry script raise]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)

(defn e [d] (b/evt d))
(defn done-kind? [k] (fn [_ d] (= k (:kind (e d)))))
(defn result [d] (:result (e d)))

(defn in-root-sentence [d] (str "It runs in the project root" (if (:in-root d) (str ": " (:in-root d)) ".")))

(defn running? [d] (or (= "working" (:turn d)) (pos? (or (:workers d) 0))))

(defn busy-check
  "refuseBusy: another host's worktree, the session working, its workers running."
  [d]
  (cond
    (true? (:elsewhere (e d))) (r/refuse 409 "On another host: its worktree is there.")
    (= "working" (:turn d)) (r/refuse 409 "The session is working.")
    (pos? (or (:workers d) 0)) (r/refuse 409 "Its workers are running.")))

(defn root-check [d] (when (or (:in-root d) (nil? (:branch d))) (r/refuse 409 (in-root-sentence d))))

(def invalid (lv/invalid-check b/evt))

(defn prompt-check
  "sova_send after its mode check (the host's `invalid`): a terminal holds it, its worktree was
   removed, the text is blank."
  [d]
  (let [ev (e d)]
    (cond
      (true? (:live ev)) (r/refuse 409 (str "\"" (:title d) "\" is open in a terminal, so it is read-only."))
      (= "removed" (:tree d)) (r/refuse 409 "Its worktree was removed, so it has no folder to work in.")
      (lv/blank? (:text ev)) (r/refuse 400 "text must not be blank."))))

(def prompt-cap (lv/cap-check "prompt" (constantly 1) b/evt))

(defn- region [k v]
  (on-entry {} (script {:expr (fn [_ d] (cond-> [(ops/assign k v)]
                                          (= k :turn) (conj (ops/assign :running (or (= v "working") (pos? (or (:workers d) 0)))))))})))

(defn- probe-state
  "A git probe's facts `{:tree open|missing|removed|root :branch no-commits|unmerged|merged|new-since-merge :ahead :dirty :new-since-merge}`."
  [d k]
  (get (e d) k))

(defn- probe-ops [d]
  (let [ev (e d)]
    (into [] (for [k [:ahead :dirty :new-since-merge :branch-gone :error] :when (contains? ev k)] (ops/assign (keyword (str "git-" (name k))) (get ev k))))))

(defn- tree-transitions [here]
  (for [[s target] [["open" :tree-open] ["missing" :tree-missing] ["removed" :tree-removed] ["root" :tree-root]] :when (not= target here)]
    (transition {:sova/feed :feed :event :git/probe :cond (fn [_ d] (= s (probe-state d :tree))) :target target})))

(defn- branch-transitions [here]
  (for [[s target] [["no-commits" :no-commits] ["unmerged" :unmerged] ["merged" :merged] ["new-since-merge" :new-since-merge]] :when (not= target here)]
    (transition {:sova/feed :feed :event :git/probe :cond (fn [_ d] (= s (probe-state d :branch))) :target target})))

(defn coding? [d] (= "coding" (:kind d)))

(defn commit-paragraph
  "codingWorktreeParagraph, verbatim."
  [{:keys [branch target]}]
  (str "You work in your own git worktree on the branch " branch ". Commit your work on this branch before you end your turn: uncommitted changes can't be merged. "
    "Before you end your turn, also merge " target " into your branch and resolve any conflicts."))

(defn first-prompt
  "codingFirstPrompt: the prompt, then (in its own worktree) the commit paragraph."
  [d]
  (if (:branch d) (str (:prompt d) "\n\n" (commit-paragraph d)) (:prompt d)))

(def chart
  (statechart {:initial :build}
    (state {:id :build :initial :regions}
      (on-entry {} (script {:expr (fn [_ d] [(ops/assign :turn "idle") (ops/assign :workers 0) (ops/assign :tree "open")])}))
      (dsl/hold-cancel-correction)
      (b/flush-transition)
      (transition {:sova/feed :quiet :event :git/probe} (script {:expr (fn [_ d] (probe-ops d))}))
      (transition {:sova/feed :quiet :event :workers/changed}
        (script {:expr (fn [_ d] (let [n (or (:n (e d)) 0)]
                                   [(ops/assign :workers n) (ops/assign :running (or (= "working" (:turn d)) (pos? n)))]))}))
      (transition {:sova/feed :quiet :event :effect/done :cond (done-kind? "remove-worktree")}
        (script {:expr (fn [_ d] [(ops/assign :removed-at (b/now-ms d)) (ops/assign :remove-refused nil)
                                  (ops/assign :branch-deleted (true? (:branch-deleted (result d))))])})
        (raise {:event :tree/removed}))
      (transition {:sova/feed :quiet :event :effect/failed :cond (done-kind? "remove-worktree")}
        (script {:expr (fn [_ d] [(ops/assign :remove-refused (:detail (e d)))])}))

      ;; sova_send (L3, held when unattended; counts a prompt)
      (dsl/act {:sova/feed :feed :event :build/prompt :checks [invalid prompt-check prompt-cap]}
        (dsl/effect :prompt (fn [d] (select-keys (e d) [:text :mode])))
        (b/ledger :ledger/take "prompt" (constantly 1)))

      ;; q9: record a merge git can't show (the branch gone, git unreadable), by commit
      (dsl/correction {:event :correct/merged :checks [(fn [d] (when (lv/blank? (:commit (e d))) (r/refuse 400 "Name the commit it was merged by.")))]}
        (script {:expr (fn [_ d] [(ops/assign :merged {:at (b/now-ms d) :commit (:commit (e d))})])}))

      (parallel {:id :regions}
        (state {:id :setup :initial :making-worktree}
          (state {:id :making-worktree}
            (on-entry {} (dsl/effect :make-worktree (fn [d] (select-keys d [:session-id :title :folder]))))
            (transition {:sova/feed :feed :event :effect/done :cond (done-kind? "make-worktree") :target :setting-mode}
              (script {:expr (fn [_ d] (let [res (result d)]
                                         (if (:in-root res)
                                           [(ops/assign :in-root (:in-root res)) (ops/assign :tree "root")]
                                           [(ops/assign :branch (:branch res)) (ops/assign :base (:base res)) (ops/assign :target (:target res))])))}))
            (transition {:sova/feed :feed :event :effect/failed :cond (done-kind? "make-worktree") :target :not-started}
              (script {:expr (fn [_ d] [(ops/assign :not-started (str "No session was started: its worktree could not be made (" (:detail (e d)) ")."))])})))
          (state {:id :setting-mode}
            (on-entry {} (dsl/effect :set-mode (fn [d] {:mode (:mode d)})))
            (transition {:sova/feed :feed :event :effect/done :cond (fn [_ d] (and ((done-kind? "set-mode") nil d) (not (lv/blank? (:prompt d))))) :target :prompting})
            ;; New Coding Session: no prompt; its worktree's note is the first entry
            (transition {:sova/feed :feed :event :effect/done :cond (done-kind? "set-mode") :target :ready}
              (script {:expr (fn [_ d] (when (:branch d)
                                         (dsl/effect-ops d (dsl/effect-map :worktree-note (fn [_] {:text (commit-paragraph d)}) d))))}))
            ;; its mode could not be set: started, not prompted
            (transition {:sova/feed :feed :event :effect/failed :cond (done-kind? "set-mode") :target :ready}
              (script {:expr (fn [_ d] [(ops/assign :mode-not-set (or (:detail (e d)) true))])})))
          (state {:id :prompting}
            (on-entry {} (dsl/effect :first-prompt (fn [d] {:prompt (first-prompt d)})))
            (transition {:sova/feed :feed :event :effect/done :cond (done-kind? "first-prompt") :target :ready})
            (transition {:sova/feed :feed :event :effect/failed :cond (done-kind? "first-prompt") :target :ready}
              (script {:expr (fn [_ d] [(ops/assign :prompt-error (:detail (e d)))])})))
          (state {:id :ready})
          (state {:id :not-started}))

        (state {:id :turn :initial :turn-idle}
          (state {:id :turn-idle} (region :turn "idle")
            (transition {:sova/feed :quiet :event :turn/started :target :working}))
          (state {:id :working} (region :turn "working")
            (transition {:sova/feed :quiet :event :turn/ended :cond (fn [_ d] (true? (:failed (e d)))) :target :turn-failed}
              (script {:expr (fn [_ d] [(ops/assign :last-turn-at (b/now-ms d))])})
              (b/send-if :reason/noted (fn [d] (when (coding? d) (b/watch-sid (:org-id d) (:project-id d))))
                (fn [d] {:kind "coding/settled" :params {:title (:title d) :failed true :session-id (:session-id d)} :by "system"
                         :key (str "coding/settled:" (:session-id d) "@" (b/now-ms d))})))
            (transition {:sova/feed :quiet :event :turn/ended :target :turn-idle}
              (script {:expr (fn [_ d] [(ops/assign :last-turn-at (b/now-ms d))])})
              (b/send-if :reason/noted (fn [d] (when (coding? d) (b/watch-sid (:org-id d) (:project-id d))))
                (fn [d] {:kind "coding/settled" :params {:title (:title d) :failed false :session-id (:session-id d)} :by "system"
                         :key (str "coding/settled:" (:session-id d) "@" (b/now-ms d))}))))
          (state {:id :turn-failed} (region :turn "failed")
            (transition {:sova/feed :quiet :event :turn/started :target :working})))

        (state {:id :tree :initial :tree-open}
          (transition {:sova/feed :feed :event :tree/removed :type :internal :target :tree-removed})
          (state {:id :tree-open} (region :tree "open") (tree-transitions :tree-open)
            (transition {:sova/feed :feed :cond (fn [_ d] (some? (:in-root d))) :target :tree-root}))
          (state {:id :tree-missing} (region :tree "missing") (tree-transitions :tree-missing))
          (state {:id :tree-removed} (region :tree "removed"))
          (state {:id :tree-root} (region :tree "root")))

        (state {:id :branch :initial :no-commits}
          (state {:id :no-commits} (region :branch-state "no-commits") (branch-transitions :no-commits))
          (state {:id :unmerged} (region :branch-state "unmerged") (branch-transitions :unmerged))
          (state {:id :merged} (region :branch-state "merged") (branch-transitions :merged))
          (state {:id :new-since-merge} (region :branch-state "new-since-merge") (branch-transitions :new-since-merge)))

        (state {:id :merge :initial :merge-idle}
          (state {:id :merge-idle}
            ;; Merge Branch: the operator's gesture only; git's own refusals come back from the effect
            (dsl/act {:sova/feed :feed :event :build/merge :target :merging :checks [root-check busy-check]}
              (dsl/effect :merge (fn [d] {:branch (:branch d) :target (:target d) :title (:title d)})))
            ;; Remove Worktree: refused while it works; the branch goes too only when merged
            (dsl/act {:sova/feed :feed :event :build/remove-worktree :checks [(fn [d] (when (= "removed" (:tree d)) (r/refuse 409 "Its worktree was already removed.")))
                                                            root-check busy-check]}
              (dsl/effect :remove-worktree (fn [d] {:branch (:branch d) :merged (= "merged" (:branch-state d))}))))
          (state {:id :merging}
            (transition {:sova/feed :feed :event :effect/done :cond (done-kind? "merge") :target :merge-idle}
              (script {:expr (fn [_ d] [(ops/assign :merged {:at (b/now-ms d) :commit (:commit (result d))})
                                        (ops/assign :merge-refused nil)])})
              (b/send-if :reason/noted (fn [d] (b/watch-sid (:org-id d) (:project-id d)))
                (fn [d] {:kind "build/merged" :params {:title (:title d) :branch (:branch d) :target (:target d)} :by "operator"
                         :key (str "build/merged:" (:session-id d) "@" (:commit (result d)))}))
              (b/send-if :milestone/noted (fn [d] (b/project-sid (:org-id d) (:project-id d))) (fn [_] {:kind "build-merged"})))
            ;; git refused (the reason in today's words): the overseer is told unless it is about the
            ;; root's own checkout (the operator's to fix)
            (transition {:sova/feed :feed :event :effect/failed :cond (done-kind? "merge") :target :merge-idle}
              (script {:expr (fn [_ d] [(ops/assign :merge-refused (:detail (e d)))])})
              (b/send-if :reason/noted (fn [d] (when-not (str/starts-with? (str (:detail (e d))) "The project root") (b/watch-sid (:org-id d) (:project-id d))))
                (fn [d] {:kind "build/merge-refused" :params {:title (:title d) :reason (:detail (e d))} :by "operator"
                         :key (str "build/merge-refused:" (:session-id d) "@" (b/now-ms d))})))))))))

(def acts
  {:build/prompt          {:needs "L3" :tool "sova_send" :code-facing true :counts "prompt" :hold true :confirm-kind "prompt"
                           :what (fn [d] (str "A prompt to \"" (:title d) "\""))}
   :build/merge           {:needs nil}
   :build/remove-worktree {:needs nil}
   :correct/merged        {:needs "L2" :tool "sova_correct" :correction true}
   :hold/cancel           {:needs "L0" :correction true}})

(defn not-here [event config data]
  (case event
    :build/merge (if (contains? config :merging) "A merge is running." "That can't be done now.")
    :build/remove-worktree (if (contains? config :merging) "A merge is running." "That can't be done now.")
    "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:session-id :kind :title :started-by :via :gap :item :decisions :branch :base :target :in-root :merged
              :turn :workers :running :tree :branch-state :last-turn-at :mode-not-set :not-started :created-at]
   :acts     acts
   :not-here not-here})
