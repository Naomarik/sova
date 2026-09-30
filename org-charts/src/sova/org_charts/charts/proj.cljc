(ns sova.org-charts.charts.proj
  "The project chart (portable, `project/<org>/<p>`): one project of the org
   (§app.organizations/projects, /archive, /stakeholder; §app.project-overseer/identity;
   §app.owner-page/updates).

   Regions (under one compound):
   - shelf ‹active · archived›: archive is refused while anything is open (\"Stop these first: …\",
     the host stamps what is open, `blockers`); while archived nothing new starts in it.
   - overseer ‹none · present›: its conversation (current + at most 20 earlier ones).
   - stake ‹none · set · cleared›: the main stakeholder; the person leaving clears it.
   - milestone ‹none · since-post› and cooldown ‹cooling · ready›: the owner-update gates.

   The project is also where item-less starts happen: the operator's Start form and Send to
   person… (a baton owned by the operator), the overseer's gathering or offer with `gap: \"none\"`,
   and coding sessions that build no gap (New Coding Session, Start Coding Session from an item, the
   global Overseer's `code`, and the overseer's `sova_create_session gap: \"none\"`, attended only, q7).

   Start data: `{:org-id :id :name :root :created-at :origin}`. It spawns its reconciler (portable)
   and its watch (host-local) at birth."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel raise]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.charts.rules.started :as st]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)
(def history-max 50)
(def conversations-max 20)
(def update-max 2000)
(def update-every-ms (* 24 3600 1000))

(def invalid (lv/invalid-check b/evt))

(defn archived-refusal [data] (r/refuse 409 (str (:name data) " is archived. Unarchive it first.")))
(defn archived-overseer-refusal [data] (r/refuse 409 (str (:name data) " is archived. Unarchive it to use its overseer.")))

(defn not-archived [data] (when (:archived data) (archived-refusal data)))

(defn- plural [n one many] (str n " " (if (= 1 n) one many)))

(defn blockers-sentence
  "archiveBlockers: what is open, in the refusal's words (the host stamps the titles)."
  [{:keys [gatherings coding overseer-working]}]
  (let [parts (cond-> []
                (seq gatherings) (conj (str (plural (count gatherings) "gathering session" "gathering sessions") " open (" (str/join ", " gatherings) ")"))
                (seq coding) (conj (str (plural (count coding) "coding session" "coding sessions") " running (" (str/join ", " coding) ")"))
                overseer-working (conj "its overseer is working"))]
    (when (seq parts) (str "Stop these first: " (str/join "; " parts) "."))))

(defn archive-check [data]
  (some->> (blockers-sentence (:blockers (b/evt data))) (r/refuse 409)))

(defn via [data] (when (= "overseer" (some-> (:via (b/evt data)) name)) "overseer"))

;; ---- stakeholder ------------------------------------------------------------------------------

(defn stakeholder-check
  "Only an active person (the host stamps `target`), or null for none."
  [data]
  (let [e (b/evt data)]
    (when (and (some? (:person-id e)) (not= "active" (get-in e [:target :status])))
      (r/refuse 400 "Only an active person on the roster can be a project's main stakeholder."))))

(defn- stake-history [data row] (vec (take-last history-max (conj (vec (:stakeholder-history data)) row))))

(defn set-stakeholder-ops [data]
  (let [to (:person-id (b/evt data))]
    ;; a save that changes nothing adds no line (noteStakeholder), but it answers Needs you
    (cond-> [(ops/assign :stakeholder to) (ops/assign :stakeholder-cleared nil)]
      (not= to (:stakeholder data))
      (conj (ops/assign :stakeholder-history (stake-history data (cond-> {:at (b/now-ms data) :from (:stakeholder data) :to to :why "operator"}
                                                                   (via data) (assoc :via "overseer"))))))))

(defn stakeholder-left? [_ data]
  (let [m (b/moved data)]
    (and (= "person" (:chart m)) (some? (:stakeholder data))
         (= (:stakeholder data) (b/last-part (:from m))) (b/moved-in? data :left))))

(defn clear-stakeholder-ops [data]
  (let [pid (:stakeholder data)]
    [(ops/assign :stakeholder-history (stake-history data {:at (b/now-ms data) :from pid :to nil :why "left"}))
     (ops/assign :stakeholder nil)
     (ops/assign :stakeholder-cleared {:person-id pid :name (get-in (b/moved data) [:exported :name]) :at (b/now-ms data)})]))

(defn- stake-act [target cnd]
  (dsl/act {:sova/feed :feed :event :stakeholder/set :target target :checks [invalid stakeholder-check] :cond cnd}
    (b/relink (fn [d] (some->> (:stakeholder d) (b/person-sid (:org-id d))))
              (fn [d] (some->> (:person-id (b/evt d)) (b/person-sid (:org-id d)))))
    (script {:expr (fn [_ d] (set-stakeholder-ops d))})))

(defn- to-someone? [_ d] (some? (:person-id (b/evt d))))

;; ---- owner updates ---------------------------------------------------------------------------------

(defn hours-ago [at now]
  (let [h (quot (- now at) 3600000)]
    (cond (< h 1) "less than an hour ago" (= h 1) "1 hour ago" :else (str h " hours ago"))))

(defn cooling? [_ d] (and (number? (:last-post-at d)) (< (- (b/now-ms d) (:last-post-at d)) update-every-ms)))

(defn milestone?
  "A milestone since the last post: a standing one (a shown conversation done, a decision
   promoted, a build merged: `milestone/noted`), or a build of the project that finished a turn
   after it (not working now; the host stamps `build-finished-at`)."
  [data]
  (or (true? (:milestone data))
      (let [t (:build-finished-at (b/evt data))] (and (number? t) (> t (or (:last-post-at data) 0))))))

;; ---- outreach -----------------------------------------------------------------------------------

(def note-max 500)

(defn send-check
  "outreach/send (§app.outreach/send): the host resolved the person (`target`) and the link (`invalid`:
   why that link can't go to them); a link, a note, or both; the note's leak backstop."
  [data]
  (let [e    (b/evt data)
        t    (:target e)
        note (str/trim (or (:note e) ""))]
    (cond
      (nil? (:id t)) (r/refuse 400 "person must be a roster person's id")
      (not= "active" (:status t)) (r/refuse 409 (str (:name t) " is not active."))
      (not (lv/blank? (:invalid e))) (r/refuse 409 (:invalid e))
      (and (nil? (:link e)) (= "" note)) (r/refuse 400 "Send a link, a note, or both.")
      (> (count note) note-max) (r/refuse 400 "A note is at most 500 characters.")
      (not (lv/blank? (:leak e))) (r/refuse 409 (:leak e)))))

(defn update-check
  "sova_owner_update in today's order: an owner, the text, the leak backstop, then (unattended
   only) the 24 h gate and the milestone gate."
  [data]
  (let [e    (b/evt data)
        text (str/trim (or (:text e) ""))]
    (cond
      (not (:owner-active e)) (r/refuse 409 "This organization has no owner, so there is no page to post to.")
      (= "" text) (r/refuse 400 "Write the update first.")
      (> (count text) update-max) (r/refuse 400 "An update is at most 2,000 characters.")
      (not (lv/blank? (:leak e))) (r/refuse 409 (:leak e))
      (true? (:attended e)) nil
      (and (:last-post-at data) (< (- (b/now-ms data) (:last-post-at data)) update-every-ms))
      (r/refuse 409 (str "An update was posted " (hours-ago (:last-post-at data) (b/now-ms data)) ": at most one a day."))
      (not (milestone? data))
      (r/refuse 409 "Nothing new since the last update: post one when a conversation finishes, a decision is agreed, or a coding session finishes or is merged."))))

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

;; ---- starts ----------------------------------------------------------------------------------------

(defn gap-none-build-check
  "q7: an overseer build with no gap only in a turn the operator started."
  [data]
  (let [e (b/evt data)]
    (when (and (= "overseer" (some-> (:by e) name)) (not (true? (:attended e))))
      (r/refuse 409 "Without a gap, a coding session starts only in a turn the operator started: name the gap whose promoted decisions it builds (gap), or ask with sova_card."))))

(defn baton-data
  "A gathering the project starts (no gap): the start data the baton chart reads."
  [data]
  (let [e (b/evt data)]
    (merge (select-keys e [:to :public-title :goal :question :briefing :model :thinking :messages-max :abilities
                           :targets :op-item :parent :mint-link :started-via :started :lease-ms :operator-name :offer-id :target-people :names])
      {:org-id (:org-id data) :project-id (:id data) :session-id (:session-id e)
       :owner (if (contains? #{"overseer" "chart"} (some-> (:by e) name)) {:overseer-of (:id data)} "operator")
       :at-once (b/at-once? data)
       :created-at (b/now-ms data)})))

(defn build-data [data]
  (let [e (b/evt data)]
    (merge (select-keys e [:title :prompt :model :thinking :mode :op-item :folder])
      {:org-id (:org-id data) :project-id (:id data) :session-id (:session-id e)
       :kind (if (= "overseer" (some-> (:by e) name)) "coding" "operator-coding")
       :started-by (if (= "overseer" (some-> (:by e) name)) "overseer" "operator")
       :via (via data) :gap "none" :decisions [] :created-at (b/now-ms data)})))

(def gather-cap (lv/cap-check "gather" (constantly 1) b/evt))
(def create-cap (lv/cap-check "create" (constantly 1) b/evt))
(def prompt-cap (lv/cap-check "prompt" (constantly 1) b/evt))

(defn root-prompt-check
  "sova_send to a root coding session after its mode check (the host's `invalid`), as build/prompt's:
   a terminal holds it (`live`), the text is blank."
  [d]
  (let [ev (b/evt d)]
    (cond
      (true? (:live ev)) (r/refuse 409 (str "\"" (:title ev) "\" is open in a terminal, so it is read-only."))
      (lv/blank? (:text ev)) (r/refuse 400 "text must not be blank."))))


;; ---- the sessions it started (r11: one list, 200, the oldest settled retired) ---------------------------

(defn started-ops
  "Note a row (`:row`, and `:watch` it when an item started it) or mark one settled from its link
   (`:mark [sid settled?]`), then trim past the cap: the oldest settled rows leave, each sent
   `session/retire` and unwatched."
  [d {:keys [row watch mark]}]
  (let [rows (cond-> (vec (:started d)) row (st/note row) mark (st/mark (first mark) (second mark)))
        {:keys [rows retire]} (st/trim rows)
        dirs (concat (when watch [{:op :watch :target watch}]) (for [s retire] {:op :unwatch :target s}))]
    (cond-> [(ops/assign :started rows)]
      (seq dirs)   (conj (ops/assign :sova/directives (into (vec (:sova/directives d)) dirs)))
      (seq retire) (into (b/queue-sends d (for [s retire] {:target s :event :session/retire :data {}}))))))

(defn started-content [f]
  [(script {:expr (fn [_ d] (started-ops d (f d)))})
   (raise {:event :sova.charts/flush})])

(defn- started-row [d kind sid] {:sid sid :kind kind :at (b/now-ms d)})

(defn baton-kind [d] (if (>= (count (:targets (b/evt d))) 2) "offer" "gathering"))

(defn- from-started? [_ d] (let [m (b/moved d)] (some #(= (:from m) (:sid %)) (:started d))))

(def chart
  (statechart {:initial :project}
    (state {:id :project :initial :regions}
      (dsl/hold-cancel-correction)
      (b/hold-review)
      (b/flush-transition)
      ;; §app.outreach/send: a link and/or a note to a roster person outside Sova. The host resolves the
      ;; link and sends in the effect; its result names the outcome only.
      (dsl/act {:sova/feed :feed :event :outreach/send :checks [send-check]}
        (dsl/effect :outreach-send (fn [d] (let [e (b/evt d)]
                                             (cond-> {:person-id (get-in e [:target :id]) :by (or (:sent-by e) "operator")}
                                               (:link e) (assoc :link (:link e))
                                               (not= "" (str/trim (or (:note e) ""))) (assoc :note (str/trim (:note e))))))))
      ;; r11: an item's start joins the list (and the project watches it); a link says when one settled
      (apply transition {:sova/feed :quiet :event :started/noted}
        (started-content (fn [d] (let [e (b/evt d)] {:row (started-row d (:kind e) (:sid e)) :watch (:sid e)}))))
      (apply transition {:sova/feed :quiet :event :link/moved :cond from-started?}
        (started-content (fn [d] (let [m (b/moved d)] {:mark [(:from m) (st/settled? (:chart m) (:states m))]}))))
      (on-entry {}
        ;; project-scoped data names its project as every other chart does: the watch's ledger and
        ;; reasons (b/ledger, b/tell-watch) and the engine's drive stamp read :project-id
        (script {:expr (fn [_ d] [(ops/assign :project-id (:id d))])})
        (dsl/spawn {:chart "reconciler" :link :project :if-exists :skip
                    :id (fn [d] (b/reconciler-sid (:org-id d) (:id d)))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:id d)})})
        (dsl/spawn {:chart "watch" :link :project :watch? false :if-exists :skip
                    :id (fn [d] (b/watch-sid (:org-id d) (:id d)))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:id d)})}))

      (dsl/act {:sova/feed :feed :event :project/edit :checks [invalid]}
        (script {:expr (fn [_ d] (let [e (b/evt d)]
                                   (cond-> []
                                     (:name e) (conj (ops/assign :name (str/trim (:name e))))
                                     (:root e) (conj (ops/assign :root (:root e)))
                                     (contains? e :owner-hidden) (conj (ops/assign :owner-hidden (true? (:owner-hidden e)))))))}))
      (dsl/act {:sova/feed :feed :event :spec/freeze :checks [invalid]}
        ;; the spec's hash at the freeze: "edited outside" compares the spec with the later of this and
        ;; the last promotion's hash (server-3 P3 2)
        (script {:expr (fn [_ d] (let [ev (b/evt d)]
                                   [(ops/assign :spec (cond-> {:frozen (true? (:frozen ev)) :at (b/now-ms d)}
                                                        (:spec-hash ev) (assoc :spec-hash (:spec-hash ev))))]))}))

      ;; A gap the overseer files (`sova_idea add §gap/…`, L0) is an item; the operator's ideas never are.
      (dsl/act {:sova/feed :feed :event :gap/file :checks [invalid]}
        (dsl/spawn {:chart "item" :link :project :watch? false
                    :id (fn [d] (b/item-sid (:org-id d) (:id d) (:gap-id (b/evt d))))
                    :data (fn [d] {:org-id (:org-id d) :project-id (:id d) :id (:gap-id (b/evt d)) :idea-id (:idea-id (b/evt d))})}))

      ;; Item-less starts (the gap-less ones): a gathering…
      (dsl/act {:sova/feed :feed :event :baton/start :checks [not-archived invalid gather-cap]}
        (dsl/spawn {:chart "baton" :link :project :id (fn [d] (b/baton-sid (:org-id d) (:session-id (b/evt d)))) :data baton-data})
        (b/ledger :ledger/take "gather" (constantly 1))
        (started-content (fn [d] {:row (started-row d (baton-kind d) (b/baton-sid (:org-id d) (:session-id (b/evt d))))})))
      ;; …and a coding session.
      (dsl/act {:sova/feed :feed :event :build/start :checks [not-archived invalid gap-none-build-check create-cap]}
        (dsl/spawn {:chart "build" :link :project :id (fn [d] (b/build-sid (:org-id d) (:id d) (:session-id (b/evt d)))) :data build-data})
        (b/ledger :ledger/take "create" (constantly 1))
        (started-content (fn [d] {:row (started-row d (:kind (build-data d)) (b/build-sid (:org-id d) (:id d) (:session-id (b/evt d))))})))
      ;; sova_send to a coding session under the project root that is not a build (a build's prompt
      ;; is its own chart's build/prompt): L3, a prompt, held when unattended; the host's `invalid`
      ;; carries the session's checks (archived, a terminal holds it, delivery)
      (dsl/act {:sova/feed :feed :event :session/prompt :checks [invalid root-prompt-check prompt-cap]}
        ;; `session`, not `session-id`: an effect's own sessionId is this chart's
        (dsl/effect :prompt (fn [d] (let [ev (b/evt d)] (cond-> {:session (:session-id ev) :text (:text ev)} (:mode ev) (assoc :mode (:mode ev))))))
        (b/ledger :ledger/take "prompt" (constantly 1)))
      ;; A preview link of one of its coding sessions' apps (§app.project-overseer/previews): L1, held
      ;; when unattended, counted against no allowance. The effect mints it; turning one off is no act.
      (dsl/act {:sova/feed :feed :event :preview/start :checks [not-archived invalid preview-check]}
        (dsl/effect :preview preview-effect))

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
              (Send {:event :ledger/reset-message :targetexpr (fn [_ d] (b/watch-sid (:org-id d) (:id d))) :content (fn [_ _] {})}))
            (dsl/act {:sova/feed :feed :event :overseer/start})))

        (state {:id :stake :initial :no-stakeholder}
          (state {:id :no-stakeholder}
            (transition {:sova/feed :feed :cond (fn [_ d] (some? (:stakeholder d))) :target :stakeholder-set})
            (stake-act :stakeholder-set to-someone?)
            (stake-act :no-stakeholder (fn [e d] (not (to-someone? e d)))))
          (state {:id :stakeholder-set}
            (transition {:sova/feed :feed :event :link/moved :cond stakeholder-left? :target :stakeholder-cleared}
              (script {:expr (fn [_ d] (clear-stakeholder-ops d))}))
            (stake-act :stakeholder-set to-someone?)
            (stake-act :no-stakeholder (fn [e d] (not (to-someone? e d)))))
          ;; Needs you asks for a new one; a save of the select (someone or none) leaves it.
          (state {:id :stakeholder-cleared}
            (stake-act :stakeholder-set to-someone?)
            (stake-act :no-stakeholder (fn [e d] (not (to-someone? e d))))))

        ;; The owner-update gates, shown as states: a standing milestone since the last post, and
        ;; the 24 h since it (the checks read the same data).
        (state {:id :milestone :initial :no-milestone}
          (state {:id :no-milestone}
            (transition {:sova/feed :quiet :cond (fn [_ d] (true? (:milestone d))) :target :since-post}))
          (state {:id :since-post}
            (transition {:sova/feed :quiet :cond (fn [_ d] (not (:milestone d))) :target :no-milestone})))

        (state {:id :cooldown :initial :ready}
          (state {:id :ready}
            (transition {:sova/feed :quiet :cond cooling? :target :cooling}))
          (state {:id :cooling}
            (on-entry {} (Send {:id :cooldown-timer :event :cooldown/over
                                :delayexpr (fn [_ d] (max 0 (- (+ (or (:last-post-at d) 0) update-every-ms) (b/now-ms d))))}))
            (on-exit {} (cancel {:sendid :cooldown-timer}))
            (transition {:sova/feed :quiet :event :cooldown/over :cond (fn [e d] (not (cooling? e d))) :target :ready})
            ;; an attended post while cooling restarts the 24 h
            (transition {:sova/feed :quiet :event :cooldown/restart :target :cooling}))))

      ;; A shown conversation done, a decision promoted, a build merged (their charts send it).
      (transition {:sova/feed :quiet :event :milestone/noted :cond (fn [_ d] (not (false? (:shown (b/evt d)))))}
        (script {:expr (fn [_ d] [(ops/assign :milestone true)])}))

      ;; The post, held when unattended (r4). The 24 h and milestone gates bind unattended runs only.
      (dsl/act {:sova/feed :feed :event :owner-update/post :checks [update-check]}
        (dsl/effect :owner-update (fn [d] {:text (str/trim (:text (b/evt d)))
                                           :run (if (true? (:attended (b/evt d))) "operator" "auto")}))
        (script {:expr (fn [_ d] [(ops/assign :last-post-at (b/now-ms d)) (ops/assign :milestone false)])})
        (raise {:event :cooldown/restart})))))

(def acts
  {:project/edit      {:needs nil}
   :spec/freeze       {:needs nil}
   :project/archive   {:needs nil :people-facing true :card (fn [d] {:projects [(:id d)]})}
   :project/unarchive {:needs nil}
   :overseer/start    {:needs nil}
   :overseer/clear    {:needs nil :people-facing true :card (fn [d] {:projects [(:id d)]})}
   :stakeholder/set   {:needs nil}
   :gap/file          {:needs "L0" :tool "sova_idea"}
   :baton/start       {:needs "L1" :tool "sova_start_gathering" :people-facing true :counts "gather" :hold true :confirm-kind b/start-kind :hours b/hours-window
                       :card (fn [d] (b/start-card (:id d) d))
                       :what (fn [d] (str "A gathering session \"" (:public-title (b/evt d)) "\""))}
   :build/start       {:needs "L3" :tool "sova_create_session" :code-facing true :counts "create" :hold true :confirm-kind "build"
                       :what (fn [d] (str "A coding session \"" (or (:title (b/evt d)) "untitled") "\""))}
   :session/prompt    {:needs "L3" :tool "sova_send" :code-facing true :counts "prompt" :hold true :confirm-kind "prompt"
                       :what (fn [d] (str "A prompt to \"" (or (not-empty (:title (b/evt d))) (:session-id (b/evt d))) "\""))}
   :owner-update/post {:needs "L1" :tool "sova_owner_update" :people-facing true :hold true :confirm-kind "owner-update"
                       :what (fn [_] "An owner update")}
   :outreach/send     {:needs "L1" :tool "sova_send_to_person" :people-facing true :hold true :confirm-kind "send" :hours b/hours-window
                       :card (fn [d] (let [e (b/evt d)] {:people [(get-in e [:target :id])] :sessions (vec (keep identity [(get-in e [:link :session])]))}))
                       :what (fn [d] (str "A WhatsApp message to " (get-in (b/evt d) [:target :name])))}
   :preview/start     {:needs "L1" :tool "sova_preview" :people-facing true :hold true :confirm-kind "preview"
                       :what (fn [d] (str "A preview link: " (str/trim (or (:purpose (b/evt d)) ""))))}
   :hold/cancel       {:needs "L0" :correction true}
   :hold/approve      {:needs "L0" :correction true}})

(defn not-here [event config data]
  (case event
    :owner-update/post "That can't be done now."
    "That can't be done now."))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:name :root :archived :stakeholder :stakeholder-cleared :owner-hidden :overseer :spec :last-post-at :started]
   :acts     acts
   :not-here not-here})
