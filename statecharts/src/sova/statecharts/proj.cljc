(ns sova.statecharts.proj
  "The project statechart (portable, `project/<p>`): one registered project, in an organization or not
   (§app.organizations/projects, /archive; §app.project-overseer/identity). It knows nothing of
   organizations: an organization places a project with its own `placement/<org>/<p>`, which watches
   this one through its exported data.

   Regions (under one compound):
   - shelf ‹active · archived›: archive is refused while anything is open (\"Stop these first: …\",
     the host stamps what is open, `blockers`); while archived nothing new starts in it.
   - overseer ‹none · present›: its conversation (current + at most 20 earlier ones).

   The project is also where coding sessions that build no gap start (New Coding Session, Start Coding
   Session from an item, the global Overseer's `code`, and the overseer's `sova_create_session gap:
   \"none\"`, attended only, q7). It keeps the list of builds it and its items started (r11) and exports
   `last-merged-at`, the newest merge among them.

   Start data: `{:id :name :root :origin :remote? :created-at}`. It spawns its watch (host-local) at birth."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry script Send]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.statecharts.base :as b]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.rules.refusal :as r]
    [sova.statecharts.rules.started :as st]
    [sova.statecharts.engine.dsl :as dsl]))

(def version 2)
(def conversations-max 20)

(def invalid (lv/invalid-check b/evt))

(defn archived-refusal [data] (r/refuse 409 (str (:name data) " is archived. Unarchive it first.")))
(defn archived-overseer-refusal [data] (r/refuse 409 (str (:name data) " is archived. Unarchive it to use its overseer.")))

(defn not-archived [data] (when (:archived data) (archived-refusal data)))

(defn- plural [n one many] (str n " " (if (= 1 n) one many)))

(defn blockers-sentence
  "archiveBlockers: what is open, in the refusal's words (the host stamps the titles). `phrases` are
   whole parts others contribute (an organization's open gatherings), first."
  [{:keys [phrases coding overseer-working]}]
  (let [parts (cond-> (vec (remove str/blank? phrases))
                (seq coding) (conj (str (plural (count coding) "coding session" "coding sessions") " running (" (str/join ", " coding) ")"))
                overseer-working (conj "its overseer is working"))]
    (when (seq parts) (str "Stop these first: " (str/join "; " parts) "."))))

(defn archive-check [data]
  (some->> (blockers-sentence (:blockers (b/evt data))) (r/refuse 409)))

(defn via [data] (when (= "overseer" (some-> (:via (b/evt data)) name)) "overseer"))

;; ---- preview links ---------------------------------------------------------------------------------

(def purpose-max 200)

(defn preview-check
  "sova_preview start's purpose (§app.project-overseer/previews); the host's `invalid` carries the
   target's own checks (the session, the port's listener, the folder, Sova's ports, the address)."
  [data]
  (let [p (str/trim (or (:purpose (b/evt data)) ""))]
    (cond
      (= "" p) (r/refuse 400 "Say what it shows and to whom (purpose): one line.")
      (or (> (count p) purpose-max) (str/includes? p "\n")) (r/refuse 400 "The purpose is one line of at most 200 characters."))))

(defn preview-effect
  "What the effect mints from: never a link (the host keeps it; an effect's result is logged)."
  [data]
  (let [e (b/evt data)]
    (cond-> {:coding-session (:coding-session e) :purpose (str/trim (:purpose e)) :overseer-id (:overseer-id e)}
      (some? (:port e)) (assoc :port (:port e))
      (some? (:folder e)) (assoc :folder (:folder e))
      (some? (:days e)) (assoc :days (:days e)))))

;; ---- a running copy, shared -----------------------------------------------------------------------

(defn share-effect
  "What the effect shares (§app.project-overseer/previews): the copy and its endpoint, never a link (the
   host keeps it; an effect's result is logged)."
  [data]
  (let [e (b/evt data)]
    (cond-> {:instance (:instance e) :endpoint (:endpoint e) :overseer-id (:overseer-id e)}
      (some? (:days e)) (assoc :days (:days e)))))

(defn share-what [d]
  (let [e (b/evt d)
        copy (or (not-empty (:branch e)) (:instance e))]
    (str "A preview link: " (or (not-empty (:endpoint e)) "an endpoint") " of a running copy" (when copy (str " (" copy ")")))))

;; ---- starts ----------------------------------------------------------------------------------------

(defn attended-build-check
  "q7: the overseer starts a coding session here only in a turn the operator started."
  [data]
  (let [e (b/evt data)]
    (when (and (= "overseer" (some-> (:by e) name)) (not (true? (:attended e))))
      (r/refuse 409 "A coding session starts only in a turn the operator started: ask with sova_card."))))

(defn build-data [data]
  (let [e (b/evt data)]
    (merge (select-keys e [:title :prompt :model :thinking :mode :op-item :folder :worktree])
      {:project-id (:id data) :session-id (:session-id e)
       :kind (if (= "overseer" (some-> (:by e) name)) "coding" "operator-coding")
       :started-by (if (= "overseer" (some-> (:by e) name)) "overseer" "operator")
       :via (via data) :gap "none" :decisions [] :created-at (b/now-ms data)})))

(def create-cap (lv/cap-check "create" (constantly 1) b/evt))

;; ---- the Project verbs playbook (§app.project-runtime/onboard) ---------------------------------------

(def nothing-to-do "The project's software is registered and current: the playbook has nothing to do.")

(defn registered-check
  "An unattended overseer starts no run while the software is registered and current (the host stamps the
   registry's standing as `runtime-standing`): it would only loop."
  [data]
  (let [e (b/evt data)]
    (when (and (= "overseer" (some-> (:by e) name)) (not (true? (:attended e))) (= "registered" (:runtime-standing e)))
      (r/refuse 409 nothing-to-do))))

(defn onboard-data
  "The build the playbook runs in: kind `onboard`, no gap, the host-stamped playbook turn as its prompt."
  [data]
  (let [e (b/evt data)]
    (merge (select-keys e [:title :prompt :model :thinking :mode])
      {:project-id (:id data) :session-id (:session-id e) :kind "onboard"
       :started-by (if (= "overseer" (some-> (:by e) name)) "overseer" "operator")
       :via (via data) :gap "none" :decisions [] :created-at (b/now-ms data)})))
(def prompt-cap (lv/cap-check "prompt" (constantly 1) b/evt))

(defn root-prompt-check
  "sova_send to a root coding session after its mode check (the host's `invalid`), as build/prompt's:
   a terminal holds it (`live`), the text is blank."
  [d]
  (let [ev (b/evt d)]
    (cond
      (true? (:live ev)) (r/refuse 409 (str "\"" (:title ev) "\" is open in a terminal, so it is read-only."))
      (lv/blank? (:text ev)) (r/refuse 400 "text must not be blank."))))


;; ---- its builds' merges -----------------------------------------------------------------------------

(defn merged-at
  "A watched build's merge time, from its link notification."
  [d]
  (let [m (b/moved d)] (when (= "build" (:statechart m)) (get-in m [:exported :merged :at]))))

(defn merge-ops [d]
  (let [t (merged-at d)]
    (when (and (number? t) (> t (or (:last-merged-at d) 0))) [(ops/assign :last-merged-at t)])))

(def statechart
  (chart/statechart {:initial :project}
    (state {:id :project :initial :regions}
      (dsl/hold-cancel-correction)
      (b/hold-review)
      (b/flush-transition)
      ;; r11: an item's build joins the list (and the project watches it); a link says when one settled
      ;; and when one merged
      (apply transition {:sova/feed :quiet :event :started/noted}
        (b/started-content (fn [d] (let [e (b/evt d)] {:row (b/started-row d (:kind e) (:sid e)) :watch (:sid e)}))))
      (apply transition {:sova/feed :quiet :event :link/moved :cond b/from-started?}
        (script {:expr (fn [_ d] (merge-ops d))})
        (b/started-content (fn [d] (let [m (b/moved d)] {:mark [(:from m) (st/settled? (:statechart m) (:states m))]}))))
      (on-entry {}
        ;; project-scoped data names its project as every other statechart does: the watch's ledger and
        ;; reasons (b/ledger, b/tell-watch) and the engine's drive stamp read :project-id
        (script {:expr (fn [_ d] [(ops/assign :project-id (:id d))])})
        (dsl/spawn {:statechart "watch" :link :project :watch? false :if-exists :skip
                    :id (fn [d] (b/watch-sid (:id d)))
                    :data (fn [d] {:project-id (:id d)})})
        ;; its software registry (host-local, §app.project-runtime/registry)
        (dsl/spawn {:statechart "runtime" :link :project :watch? false :if-exists :skip
                    :id (fn [d] (b/runtime-sid (:id d)))
                    :data (fn [d] {:project-id (:id d) :root (:root d)})}))

      (dsl/act {:sova/feed :feed :event :project/edit :checks [invalid]}
        (script {:expr (fn [_ d] (let [e (b/evt d)]
                                   (cond-> []
                                     (:name e) (conj (ops/assign :name (str/trim (:name e))))
                                     (:root e) (conj (ops/assign :root (:root e))))))}))

      ;; A coding session that builds no gap.
      (dsl/act {:sova/feed :feed :event :build/start :checks [not-archived invalid attended-build-check create-cap]}
        (dsl/spawn {:statechart "build" :link :project :id (fn [d] (b/build-sid (:id d) (:session-id (b/evt d)))) :data build-data})
        (b/ledger :ledger/take "create" (constantly 1))
        (b/started-content (fn [d] {:row (b/started-row d (:kind (build-data d)) (b/build-sid (:id d) (:session-id (b/evt d))))})))
      ;; sova_send to a coding session under the project root that is not a build (a build's prompt
      ;; is its own statechart's build/prompt): L3, a prompt, held when unattended; the host's `invalid`
      ;; carries the session's checks (archived, a terminal holds it, delivery)
      (dsl/act {:sova/feed :feed :event :session/prompt :checks [invalid root-prompt-check prompt-cap]}
        ;; `session`, not `session-id`: an effect's own sessionId is this statechart's
        (dsl/effect :prompt (fn [d] (let [ev (b/evt d)] (cond-> {:session (:session-id ev) :text (:text ev)} (:mode ev) (assoc :mode (:mode ev))))))
        (b/ledger :ledger/take "prompt" (constantly 1)))
      ;; A preview link of one of its coding sessions' apps (§app.project-overseer/previews): L1, held
      ;; when unattended, counted against no allowance. The effect mints it; turning one off is no act.
      (dsl/act {:sova/feed :feed :event :preview/start :checks [not-archived invalid preview-check]}
        (dsl/effect :preview preview-effect))
      ;; sova_project_verbs on the project's running instances (§app.project-services/callers): stopping
      ;; one is L0, every other verb but the reads is L3; neither is held nor counted. The act is the
      ;; gate only: the host runs the verb once it is taken, and the verb's own rules (scope, confirm)
      ;; are the engine's. Stopping is never refused for an archived project.
      (dsl/act {:sova/feed :feed :event :services/down :checks [invalid]})
      (dsl/act {:sova/feed :feed :event :services/run :checks [not-archived invalid]})
      ;; Sharing one of them (§app.project-overseer/previews): L1, held when unattended, as preview/start; the
      ;; engine checked the share before the act, and the effect mints the link (again checked) once it goes
      ;; ahead. Revoking one is no act.
      (dsl/act {:sova/feed :feed :event :services/share :checks [not-archived invalid]}
        (dsl/effect :services-share share-effect))
      ;; The Project verbs playbook (§app.project-runtime/onboard): a build of kind onboard whose first prompt is
      ;; the playbook's turn (fixed, so q7 does not apply: branch only, the operator merges); L3, held when
      ;; unattended, counted as a coding session's start. The host's `invalid` carries the playbook missing, the
      ;; folder elsewhere and a run already live; the registry hears of it (`playbook/started`).
      (dsl/act {:sova/feed :feed :event :verbs/onboard :checks [not-archived invalid registered-check create-cap]}
        (dsl/spawn {:statechart "build" :link :project :id (fn [d] (b/build-sid (:id d) (:session-id (b/evt d)))) :data onboard-data})
        (b/ledger :ledger/take "create" (constantly 1))
        (b/started-content (fn [d] {:row (b/started-row d "onboard" (b/build-sid (:id d) (:session-id (b/evt d))))}))
        (b/send-if :playbook/started (fn [d] (b/runtime-sid (:id d)))
          (fn [d] (let [e (b/evt d) od (onboard-data d)]
                    (cond-> {:sid (b/build-sid (:id d) (:session-id e)) :session-id (:session-id e) :started-by (:started-by od)}
                      (not (lv/blank? (:why e))) (assoc :why (str/trim (:why e)))
                      (:title e) (assoc :title (:title e))
                      ;; the verb playbook it runs (§app.project-runtime/verb-playbooks), stamped by the host
                      (:playbook-id e) (assoc :playbook-id (:playbook-id e))
                      (:label e) (assoc :label (:label e))
                      (:proposes e) (assoc :proposes (:proposes e)))))))

      (parallel {:id :regions}
        (state {:id :shelf :initial :active}
          (state {:id :active}
            (transition {:sova/feed :feed :cond (fn [_ d] (some? (:archived d))) :target :archived})
            (dsl/act {:sova/feed :feed :event :project/archive :target :archived :checks [archive-check]}
              (script {:expr (fn [_ d] [(ops/assign :archived (cond-> {:at (b/now-ms d)} (via d) (assoc :via "overseer")))])}))
            ;; unarchiving an active project writes nothing
            (dsl/act {:sova/feed :feed :event :project/unarchive}))
          (state {:id :archived}
            (dsl/act {:sova/feed :feed :event :project/archive})
            (dsl/act {:sova/feed :feed :event :project/unarchive :target :active}
              (script {:expr (fn [_ d] [(ops/delete :archived)])}))))

        (state {:id :overseer :initial :no-overseer}
          (state {:id :no-overseer}
            (transition {:sova/feed :feed :cond (fn [_ d] (some? (:overseer d))) :target :has-overseer})
            (dsl/act {:sova/feed :feed :event :overseer/start :target :has-overseer :checks [invalid]}
              (script {:expr (fn [_ d] [(ops/assign :overseer {:id (:conversation-id (b/evt d)) :history []})])})))
          (state {:id :has-overseer}
            ;; Clear never refuses; it resets the per-message allowance.
            (dsl/act {:sova/feed :feed :event :overseer/clear :checks [invalid]}
              (script {:expr (fn [_ d] (let [o (:overseer d)]
                                         [(ops/assign :overseer {:id (:conversation-id (b/evt d))
                                                                 :history (vec (take conversations-max (cons (:id o) (:history o))))})]))})
              (Send {:event :ledger/reset-message :targetexpr (fn [_ d] (b/watch-sid (:id d))) :content (fn [_ _] {})}))
            (dsl/act {:sova/feed :feed :event :overseer/start})))))))

(def acts
  {:project/edit      {:needs nil}
   :project/archive   {:needs nil :people-facing true :card (fn [d] {:projects [(:id d)]})}
   :project/unarchive {:needs nil}
   :overseer/start    {:needs nil}
   :overseer/clear    {:needs nil :people-facing true :card (fn [d] {:projects [(:id d)]})}
   :build/start       {:needs "L3" :tool "sova_create_session" :code-facing true :counts "create" :hold true :confirm-kind "build"
                       :what (fn [d] (str "A coding session \"" (or (:title (b/evt d)) "untitled") "\""))}
   :session/prompt    {:needs "L3" :tool "sova_send" :code-facing true :counts "prompt" :hold true :confirm-kind "prompt"
                       :what (fn [d] (str "A prompt to \"" (or (not-empty (:title (b/evt d))) (:session-id (b/evt d))) "\""))}
   :preview/start     {:needs "L1" :tool "sova_preview" :people-facing true :hold true :confirm-kind "preview"
                       :what (fn [d] (str "A preview link: " (str/trim (or (:purpose (b/evt d)) ""))))}
   :services/down     {:needs "L0" :tool "sova_project_verbs"}
   :services/run      {:needs "L3" :tool "sova_project_verbs"}
   :services/share    {:needs "L1" :tool "sova_project_verbs" :people-facing true :hold true :confirm-kind "preview" :what share-what}
   :verbs/onboard     {:needs "L3" :tool "sova_project_verbs" :code-facing true :counts "create" :hold true :confirm-kind "build"
                       :what (fn [d] (str "The Project verbs playbook on " (:name d)))}
   :hold/cancel       {:needs "L0" :correction true}
   :hold/approve      {:needs "L0" :correction true}})

(defn not-here [_event _config _data] "That can't be done now.")

(def entry
  {:statechart statechart
   :version    version
   :migrate    {}
   :storage    :portable
   :exported   [:name :root :archived :overseer :started :last-merged-at]
   :acts       acts
   :not-here   not-here})
