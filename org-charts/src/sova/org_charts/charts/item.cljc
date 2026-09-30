(ns sova.org-charts.charts.item
  "The item chart (portable, `item/<org>/<p>/<g_id>`): one gap (`§gap/<name>`), from open to done
   (§app.project-overseer/gaps, /pipeline, /drive, /holds, /corrections).

   Regions (under one compound; `dropped` is final):
   - lane ‹pipeline{open · gather-starting · asking · needs-operator · deciding{unreconciled ·
     conflicted · drafted · spec-edited} · promoted{awaiting-build · build-starting · working · idle ·
     failed · merged · done}}(H*) · on-hold›
   - follow-up ‹no-follow-up · follow-up-asking · follow-up-needs-operator›: gatherings started once
     the gap is deciding or later
   - attention ‹calm · stalled›: a waiting phase past its stall clock (3 days)
   - drive ‹driving›: the acts the chart starts itself at the level in force (r3)

   Links are owned (R4): the item spawns its gatherings and builds, and watches every decision its
   gatherings record. A gap has any number of gatherings and builds; the lane routes on aggregates
   of their exported states (`rules.item`). Facts come only from `link/moved`.

   Start data: `{:org-id :project-id :id (g_…) :idea-id (§gap/…) :stall-after-ms?}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :refer [statechart]]
    [com.fulcrologic.statecharts.elements :refer [state parallel transition on-entry on-exit script Send cancel raise final history]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.item :as ri]
    [sova.org-charts.charts.rules.levels :as lv]
    [sova.org-charts.charts.rules.refusal :as r]
    [sova.org-charts.engine.dsl :as dsl]))

(def version 1)
(def default-stall-ms (* 3 24 3600 1000))
(def dropped-refusal "This idea was dropped; dropped is final. File a new idea instead.")

(defn e [d] (b/evt d))
(defn stall-ms [d phase] (or (get (:stall-after-ms d) phase) (get (:stall-after-ms d) (name phase)) default-stall-ms))

;; ---- facts ---------------------------------------------------------------------------------------

(defn- fact-of [d] (let [m (b/moved d)] {:states (set (:states m)) :exported (:exported m) :running (:running m)}))

(defn- watch-decisions
  "Decisions the item doesn't know yet: pending until their own facts come, watched from now on."
  [d ids]
  (let [new (distinct (remove (set (keys (:decisions d))) (map str ids)))]
    (concat
      (for [id new] (ops/assign [:decisions id] {:states #{} :exported {:state "pending"}}))
      (when (seq new)
        [(ops/assign :sova/directives (into (vec (:sova/directives d))
                                        (for [id new] {:op :watch :target (b/decision-sid (:org-id d) (:project-id d) id)})))]))))

(defn moved-ops
  "Keep the moved session's facts; a gathering's new decisions, and the winner a watched decision is
   superseded by, are watched from now on (the item follows the winner, as today's phase does)."
  [d]
  (let [m (b/moved d) sid (:from m) f (fact-of d)]
    (case (:chart m)
      "baton"    (into [(ops/assign [:batons sid] (merge (get-in d [:batons sid]) f))
                        (ops/assign :starting-gather (when-not (= sid (:starting-gather d)) (:starting-gather d)))]
                   (watch-decisions d (get-in m [:exported :decisions])))
      "decision" (into [(ops/assign [:decisions (b/last-part sid)] f)]
                   (let [winner (get-in m [:exported :superseded-by])]
                     (when (and (string? winner) (not (str/blank? winner)))
                       (watch-decisions d [winner]))))
      "build"    [(ops/assign [:builds sid] f) (ops/assign :starting-build nil)]
      "watch"    [(ops/assign :watch f)]
      [])))

;; ---- phases ----------------------------------------------------------------------------------------

(defn lane-gathering [d] (ri/gathering (ri/lane-batons d)))
(defn follow-gathering [d] (ri/gathering (ri/follow-up-batons d)))

(def deciding-phases {"pending" :unreconciled "conflict" :conflicted "drafted" :drafted "edited" :spec-edited})

(defn build-phase
  "Where a promoted gap is, from its builds: awaiting-build (none, or merged builds that don't cover a
   newer promoted decision), build-starting, working, failed, idle, merged, done."
  [d]
  (let [agg (ri/building d)]
    (cond
      (:starting-build d) :build-starting
      (nil? agg) :awaiting-build
      (= agg :starting) :build-starting
      (= agg :working) :working
      (= agg :failed) :failed
      (= agg :idle) :idle
      (not (ri/covers? d)) :awaiting-build
      (and (ri/all-built? d) (not (:reopened d))) :done
      :else :merged)))

(defn- mark [phase]
  (on-entry {} (script {:expr (fn [_ d] [(ops/assign :phase (name phase)) (ops/assign :phase-since (b/now-ms d))])})))

(defn- stall-clock
  "On entry arm `item/stalled` for this phase; on exit cancel it and tell the attention region."
  [phase]
  (let [timer (keyword (str "stall-" (name phase)))]
    [(on-entry {} (Send {:id timer :event :item/stalled :delayexpr (fn [_ d] (stall-ms d phase))
                         :content (fn [_ d] {:phase (name phase) :since (b/now-ms d)})}))
     (on-exit {} (cancel {:sendid timer}) (raise {:event :item/moved}))]))

(defn- reason [kind params-fn]
  (b/tell-watch (fn [d] (when-let [p (params-fn d)]
                          {:kind kind :params (assoc p :item (:idea-id d)) :key (str kind ":" (:id d) "@" (b/now-ms d))}))))

(defn- to-phase [here targets phase-fn]
  (for [t targets :when (not= t here)]
    (transition {:sova/feed :feed :cond (fn [_ d] (= t (phase-fn d))) :target t})))

(def build-states [:awaiting-build :build-starting :working :idle :failed :merged :done])

;; ---- acts ------------------------------------------------------------------------------------------

(def invalid (lv/invalid-check b/evt))
(defn archived-check [d] (when (true? (:archived (e d))) (r/refuse 409 (str (:project-name (e d)) " is archived. Unarchive it first."))))
(def gather-cap (lv/cap-check "gather" (constantly 1) b/evt))
(def create-cap (lv/cap-check "create" (constantly 1) b/evt))

(defn operator-only [what] (fn [d] (when-not (b/operator-act? d) (r/refuse 409 (str "Only the operator " what ", from the project page.")))))

(defn build-decisions
  "The decisions a build of this gap builds: the item's promoted, not yet built ones (the overseer
   may narrow the set, never widen it: R4, D12)."
  [d]
  (let [asked (seq (:decisions (e d)))]
    (vec (or asked (ri/not-built-ids d)))))

(defn decisions-check [d]
  (let [ok (set (ri/not-built-ids d))]
    (cond
      (empty? ok) (r/refuse 409 (str (:idea-id d) " has no promoted decision to build yet."))
      :else (when-let [bad (first (remove ok (map str (:decisions (e d)))))]
              (r/refuse 409 (str bad " is not a promoted, not yet built decision of " (:idea-id d) ": a build rests only on its gap's promoted decisions."))))))

(defn baton-start-data [d]
  (let [ev (e d)]
    (merge (select-keys ev [:to :targets :public-title :goal :question :briefing :model :thinking :messages-max :abilities :names :operator-name :lease-ms :offer-id :target-people])
      {:org-id (:org-id d) :project-id (:project-id d) :session-id (:session-id ev)
       :owner (if (b/operator-act? d) "operator" {:overseer-of (:project-id d)})
       :mint-link (b/operator-act? d)
       :at-once (b/at-once? d)
       :created-at (b/now-ms d)})))

(defn- started-noted
  "r11: the project keeps one list of every session it and its items started."
  [sid-fn kind-fn]
  (Send {:event :started/noted :targetexpr (fn [_ d] (b/project-sid (:org-id d) (:project-id d)))
         :content (fn [_ d] {:sid (sid-fn d) :kind (kind-fn d)})}))

(defn- gather-content []
  [(script {:expr (fn [_ d] (let [sid (b/baton-sid (:org-id d) (:session-id (e d)))
                                  follow? (contains? #{"deciding" "promoted"} (:lane-group d))]
                              [(ops/assign [:batons sid] {:states #{} :exported {} :follow-up follow?})
                               (ops/assign :starting-gather (when-not follow? sid))]))})
   (dsl/spawn {:chart "baton" :link :item :id (fn [d] (b/baton-sid (:org-id d) (:session-id (e d)))) :data baton-start-data})
   (b/ledger :ledger/take "gather" (constantly 1))
   (started-noted (fn [d] (b/baton-sid (:org-id d) (:session-id (e d)))) (fn [d] (if (>= (count (:targets (e d))) 2) "offer" "gathering")))])

(defn- build-content []
  [(script {:expr (fn [_ d] [(ops/assign :starting-build true) (ops/assign :reopened nil)])})
   (dsl/spawn {:chart "build" :link :item :id (fn [d] (b/build-sid (:org-id d) (:project-id d) (:session-id (e d))))
               :data (fn [d] (let [ev (e d)]
                               (merge (select-keys ev [:title :prompt :model :thinking :mode :folder])
                                 {:org-id (:org-id d) :project-id (:project-id d) :session-id (:session-id ev)
                                  :kind (if (b/operator-act? d) "operator-coding" "coding")
                                  :started-by (if (b/operator-act? d) "operator" "overseer")
                                  :gap (:idea-id d) :item (:id d) :decisions (build-decisions d)
                                  :prompt (or (:prompt ev) (ri/build-prompt d (build-decisions d)))
                                  :created-at (b/now-ms d)})))})
   (b/ledger :ledger/take "create" (constantly 1))
   (started-noted (fn [d] (b/build-sid (:org-id d) (:project-id d) (:session-id (e d)))) (fn [d] (if (b/operator-act? d) "operator-coding" "coding")))])

;; ---- drive (r3): the acts the chart starts itself, at the level in force -------------------------------

(defn drive-open?
  "The chart may start acts now: the gap is in its pipeline (not on hold), the project not archived."
  [env d]
  (and (b/in? env :pipeline) (not (true? (get-in d [:watch :exported :archived])))))

(defn- drove? [d k] (contains? (set (:drove d)) k))
(defn- note-drove [k-fn] (script {:expr (fn [_ d] [(ops/assign :drove (vec (take-last 200 (conj (vec (:drove d)) (k-fn d)))))])}))

(defn reconcile-key [d] (str "reconcile:" (str/join "," (ri/pending-ids d))))
(defn promote-key [d] (str "promote:" (str/join "," (ri/in-area-drafted-ids d))))
(defn build-key [d] (str "build:" (str/join "," (ri/not-built-ids d))))
(defn plan-target [p] (or (:to p) (first (:targets p))))

(defn next-plan
  "The index of the next planned gathering to start: not started yet, and not to a person whose
   attempt on this gap ended with no decision."
  [d]
  (let [started (set (:plans-started d)) blocked (set (:answered-nothing-to d))]
    (first (for [[i p] (map-indexed vector (:plans d))
                 :when (and (not (started i)) (not (blocked (plan-target p))))]
             i))))

(defn plan-key [d] (str "plan:" (next-plan d)))
(defn move-key [d] (str "move:" (first (ri/same-target-older d))))

(defn held-act? [d event] (some #(= (str (namespace event) "/" (name event)) (str (:event %))) (vals (:sova/holds d))))

(defn- drive-transitions []
  [
   ;; L2: promote the gap's drafted decisions whose author owns the area (never out of area)
   (transition {:sova/feed :quiet :cond (fn [env d] (and (drive-open? env d) (ri/at-least? d "L2") (seq (ri/in-area-drafted-ids d))
                                       (not (drove? d (promote-key d)))))}
     (note-drove promote-key)
     (dsl/drive {:event :decision/promote :target (fn [d] (b/reconciler-sid (:org-id d) (:project-id d)))
                 :data (fn [d] {:ids (ri/in-area-drafted-ids d) :gap (:idea-id d)})}))
   ;; L3: build once every live decision is promoted, none built, no build working or held
   (transition {:sova/feed :quiet :cond (fn [env d] (and (drive-open? env d) (ri/at-least? d "L3") (b/in? env :awaiting-build)
                                       (= "promoted" (ri/dphase d)) (ri/none-built? d) (seq (ri/not-built-ids d))
                                       (empty? (ri/live-builds d)) (not (held-act? d :build/start))
                                       (not (drove? d (build-key d)))))}
     (note-drove build-key)
     (dsl/drive {:event :build/start
                 :data (fn [d] {:session-id (str (:id d) "-b" (inc (count (:builds d))))
                                :title (str "Build " (:idea-id d))
                                :decisions (ri/not-built-ids d)
                                :prompt (ri/build-prompt d (ri/not-built-ids d))})}))
   ;; L1: a planned gathering (filed at L0), each once, while the lane has no live gathering; never
   ;; one to a person whose attempt on this gap ended with no decision (F8b: per target)
   (transition {:sova/feed :quiet :cond (fn [env d] (and (drive-open? env d) (ri/at-least? d "L1")
                                       (not (#{:asking :needs-operator} (lane-gathering d)))
                                       (not (b/in? env :gather-starting))
                                       (some? (next-plan d)) (not (held-act? d :gather/start)) (not (:plan-pending d))
                                       (not (drove? d (plan-key d)))))}
     (note-drove plan-key)
     ;; one planned start in flight: the next waits for its outcome (a baton, a hold, or any later event)
     (script {:expr (fn [_ d] [(ops/assign :plans-started (conj (vec (:plans-started d)) (next-plan d))) (ops/assign :plan-pending true)])})
     (dsl/drive {:event :gather/start
                 :data (fn [d] (let [i (last (:plans-started d)) p (nth (:plans d) i)]
                                 (assoc p :session-id (str (:id d) "-g" (inc i)))))}))
   ;; L1: close an own gathering nobody wrote in once a newer one to the same person is open
   (transition {:sova/feed :quiet :cond (fn [env d] (and (drive-open? env d) (ri/at-least? d "L1") (ri/same-target-older d)
                                       (not (drove? d (move-key d)))))}
     (note-drove move-key)
     (dsl/drive {:event :baton/close :target (fn [d] (first (ri/same-target-older d)))
                 :data (fn [d] {:reason (str "A newer gathering on " (:idea-id d) " to the same person covers it.")
                                :owner-project (:project-id d)})}))])

;; ---- the chart -----------------------------------------------------------------------------------------

(defn- answered-nothing
  "The lane's gatherings ended with no decision: one attempt used, and their first targets are not
   asked again by a planned gathering (r3)."
  []
  (script {:expr (fn [_ d] [(ops/assign :attempts (inc (or (:attempts d) 0)))
                            (ops/assign :answered-nothing-to
                              (vec (distinct (concat (:answered-nothing-to d)
                                                     (keep #(let [h (first (:handoffs (ri/ex %)))] (when (not= "pool" (:to h)) (:to h))) (ri/lane-batons d))
                                                     (mapcat #(:to (first (:offers (ri/ex %)))) (ri/lane-batons d))))))])}))

(defn- group [g] (on-entry {} (script {:expr (fn [_ _] [(ops/assign :lane-group g)])})))

(def chart
  (statechart {:initial :item}
    (state {:id :item :initial :live}
      (on-entry {} (dsl/watch (fn [d] (b/watch-sid (:org-id d) (:project-id d)))))
      (dsl/hold-cancel-correction)
      (b/hold-review)
      (b/flush-transition)

      (parallel {:id :live}
        (transition {:sova/feed :quiet :event :link/moved} (script {:expr (fn [_ d] (conj (moved-ops d) (ops/assign :plan-pending false)))}))
        (transition {:sova/feed :quiet :event :hold/dropped} (script {:expr (fn [_ _] [(ops/assign :plan-pending false)])}))
        (transition {:sova/feed :quiet :event :hold/cancelled} (script {:expr (fn [_ _] [(ops/assign :plan-pending false)])}))
        ;; drop agrees with the idea both ways (sova_idea status dropped at L0, the panel, the operator)
        (dsl/act {:sova/feed :feed :event :gap/drop :target :dropped :checks [invalid]}
          (script {:expr (fn [_ d] [(ops/assign :dropped-from (:phase d))])})
          (script {:expr (fn [_ d] (when-not (true? (:from-idea (e d)))
                                     (dsl/effect-ops d (dsl/effect-map :idea-status (fn [_] {:idea-id (:idea-id d) :status "dropped"}) d))))}))
        ;; a planned gathering, filed at L0: the chart starts it once the level reaches L1
        (dsl/act {:sova/feed :feed :event :gather/plan :checks [invalid]}
          (script {:expr (fn [_ d] [(ops/assign :plans (conj (vec (:plans d)) (dissoc (e d) :at :by :attended :autonomy :paused :roster-active
                                                                                     :archived :allowance :ledger :looks :at-once :card :hold-ms :invalid)))])}))
        ;; q9 corrections
        (dsl/correction {:event :correct/relink
                         :checks [(fn [d] (when-not (or (contains? (:batons d) (:session (e d))) (contains? (:builds d) (:session (e d))))
                                            (r/refuse 400 "That session is not one of this gap's.")))
                                  (fn [d] (when (lv/blank? (:to-item (e d))) (r/refuse 400 "Name the gap to move it to.")))]}
          (dsl/unwatch (fn [d] (:session (e d))))
          (script {:expr (fn [_ d] [(ops/assign :batons (dissoc (:batons d) (:session (e d))))
                                    (ops/assign :builds (dissoc (:builds d) (:session (e d))))])})
          (b/send-if :item/adopt (fn [d] (:to-item (e d))) (fn [d] {:session (:session (e d))})))
        (transition {:sova/feed :feed :event :item/adopt}
          (dsl/watch (fn [d] (:session (e d)))))

        ;; ── the lane ──────────────────────────────────────────────────────────────────────────
        (state {:id :lane :initial :pipeline}
          (state {:id :pipeline :initial :open}
            (history {:id :pipeline-h :type :deep} :open)
            (dsl/act {:sova/feed :feed :event :item/hold :target :on-hold :checks [(operator-only "holds or resumes a gap")]})

            ;; a gathering: the first attempt(s) move the lane; later ones are follow-ups
            (dsl/act {:sova/feed :feed :event :gather/start :checks [invalid archived-check gather-cap]} (gather-content))

            (state {:id :open} (mark :open) (group "open") (stall-clock :open)
              (transition {:sova/feed :feed :cond (fn [_ d] (:starting-gather d)) :target :gather-starting})
              (transition {:sova/feed :feed :cond (fn [_ d] (= :needs-operator (lane-gathering d))) :target :needs-operator})
              (transition {:sova/feed :feed :cond (fn [_ d] (= :asking (lane-gathering d))) :target :asking})
              (transition {:sova/feed :feed :cond (fn [_ d] (and (not (#{:asking :needs-operator} (lane-gathering d))) (not= "none" (ri/dphase d)))) :target :deciding}))

            (state {:id :gathering :initial :gather-starting}
              (group "gathering")
              (state {:id :gather-starting} (mark :gather-starting) (stall-clock :gather-starting)
                (transition {:sova/feed :feed :cond (fn [_ d] (and (nil? (:starting-gather d)) (= :needs-operator (lane-gathering d)))) :target :needs-operator})
                (transition {:sova/feed :feed :cond (fn [_ d] (and (nil? (:starting-gather d)) (= :asking (lane-gathering d)))) :target :asking})
                (transition {:sova/feed :feed :cond (fn [_ d] (and (nil? (:starting-gather d)) (= :ended (lane-gathering d)))) :target :asking})
                (dsl/correction {:event :correct/skip-stall :target :open}
                  (script {:expr (fn [_ d] [(ops/assign :starting-gather nil)])})))
              (state {:id :asking} (mark :asking) (stall-clock :asking)
                (transition {:sova/feed :feed :cond (fn [_ d] (= :needs-operator (lane-gathering d))) :target :needs-operator})
                (transition {:sova/feed :feed :cond (fn [_ d] (and (= :ended (lane-gathering d)) (not= "none" (ri/dphase d)))) :target :deciding})
                (transition {:sova/feed :feed :cond (fn [_ d] (and (= :ended (lane-gathering d)) (= "none" (ri/dphase d)))) :target :open}
                  (answered-nothing)))
              (state {:id :needs-operator} (mark :needs-operator) (stall-clock :needs-operator)
                (transition {:sova/feed :feed :cond (fn [_ d] (= :asking (lane-gathering d))) :target :asking})
                (transition {:sova/feed :feed :cond (fn [_ d] (and (= :ended (lane-gathering d)) (not= "none" (ri/dphase d)))) :target :deciding})
                (transition {:sova/feed :feed :cond (fn [_ d] (and (= :ended (lane-gathering d)) (= "none" (ri/dphase d)))) :target :open}
                  (answered-nothing))))

            (state {:id :deciding :initial :unreconciled}
              (group "deciding")
              (transition {:sova/feed :feed :cond (fn [_ d] (= "promoted" (ri/dphase d))) :target :promoted})
              (state {:id :unreconciled} (mark :unreconciled) (stall-clock :unreconciled) (to-phase :unreconciled (vals deciding-phases) #(deciding-phases (ri/dphase %))))
              (state {:id :conflicted} (mark :conflicted) (stall-clock :conflicted) (to-phase :conflicted (vals deciding-phases) #(deciding-phases (ri/dphase %))))
              (state {:id :drafted} (mark :drafted) (stall-clock :drafted) (to-phase :drafted (vals deciding-phases) #(deciding-phases (ri/dphase %))))
              (state {:id :spec-edited} (mark :spec-edited) (stall-clock :spec-edited) (to-phase :spec-edited (vals deciding-phases) #(deciding-phases (ri/dphase %)))))

            (state {:id :promoted :initial :awaiting-build}
              (group "promoted")
              ;; a newer, superseding or edited decision reopens it (a feed entry, no look reason: R4)
              (transition {:sova/feed :feed :cond (fn [_ d] (contains? #{"pending" "conflict" "drafted" "edited"} (ri/dphase d))) :target :deciding})
              (state {:id :awaiting-build} (mark :awaiting-build) (stall-clock :awaiting-build)
                (to-phase :awaiting-build build-states build-phase)
                (dsl/act {:sova/feed :feed :event :build/start :target :build-starting :checks [invalid archived-check decisions-check create-cap]} (build-content)))
              (state {:id :build-starting} (mark :build-starting) (stall-clock :build-starting)
                (to-phase :build-starting build-states build-phase)
                (dsl/correction {:event :correct/skip-stall :target :awaiting-build}
                  (script {:expr (fn [_ d] [(ops/assign :starting-build nil)])})))
              (state {:id :working} (mark :working) (to-phase :working build-states build-phase))
              (state {:id :idle} (mark :idle) (stall-clock :idle) (to-phase :idle build-states build-phase))
              (state {:id :failed} (mark :failed) (stall-clock :failed) (to-phase :failed build-states build-phase))
              (state {:id :merged} (mark :merged) (stall-clock :merged) (to-phase :merged build-states build-phase)
                (dsl/act {:sova/feed :feed :event :build/start :target :build-starting :checks [invalid archived-check decisions-check create-cap]} (build-content)))
              (state {:id :done} (mark :done)
                (on-entry {} (reason "item/built" (fn [_] {})))
                (to-phase :done build-states build-phase)
                (dsl/correction {:event :correct/reopen :target :awaiting-build}
                  (script {:expr (fn [_ d] [(ops/assign :reopened true)])})))))

          (state {:id :on-hold} (mark :on-hold)
            (dsl/act {:sova/feed :feed :event :item/resume :target :pipeline-h :checks [(operator-only "holds or resumes a gap")]})))

        ;; ── follow-up gatherings ─────────────────────────────────────────────────────────────────
        (state {:id :follow-up :initial :no-follow-up}
          (state {:id :no-follow-up}
            (transition {:sova/feed :feed :cond (fn [_ d] (= :asking (follow-gathering d))) :target :follow-up-asking})
            (transition {:sova/feed :feed :cond (fn [_ d] (= :needs-operator (follow-gathering d))) :target :follow-up-needs-operator}))
          (state {:id :follow-up-asking} (stall-clock :follow-up-asking)
            (transition {:sova/feed :feed :cond (fn [_ d] (= :needs-operator (follow-gathering d))) :target :follow-up-needs-operator})
            (transition {:sova/feed :feed :cond (fn [_ d] (not (#{:asking :needs-operator} (follow-gathering d)))) :target :no-follow-up}))
          (state {:id :follow-up-needs-operator} (stall-clock :follow-up-needs-operator)
            (transition {:sova/feed :feed :cond (fn [_ d] (= :asking (follow-gathering d))) :target :follow-up-asking})
            (transition {:sova/feed :feed :cond (fn [_ d] (not (#{:asking :needs-operator} (follow-gathering d)))) :target :no-follow-up})))

        ;; ── attention ─────────────────────────────────────────────────────────────────────────────
        (state {:id :attention :initial :calm}
          (state {:id :calm}
            (transition {:sova/feed :feed :event :item/stalled
                         :cond (fn [env d] (let [p (:phase (e d))]
                                             (or (= p (:phase d))
                                                 (and (str/starts-with? (str p) "follow-up") (b/in? env (keyword p))))))
                         :target :stalled}
              (reason "item/stalled" (fn [d] {:phase (:phase (e d)) :since (:since (e d))}))))
          (state {:id :stalled}
            (transition {:sova/feed :feed :event :item/moved :target :calm})))

        ;; ── drive ─────────────────────────────────────────────────────────────────────────────────
        (state {:id :drive :initial :driving}
          (state {:id :driving} (drive-transitions))))

      (final {:id :dropped}))))

(def acts
  {:gather/start       {:needs "L1" :tool "sova_start_gathering" :people-facing true :counts "gather" :hold true :confirm-kind b/start-kind :hours b/hours-window
                        :card (fn [d] (b/start-card (:project-id d) d))
                        :what (fn [d] (str "A gathering on " (:idea-id d) " (\"" (:public-title (e d)) "\")"))}
   :gather/plan        {:needs "L0" :tool "sova_start_gathering"}
   :build/start        {:needs "L3" :tool "sova_create_session" :code-facing true :counts "create" :hold true :confirm-kind "build"
                        :what (fn [d] (str "A coding session for " (:idea-id d)))}
   :gap/drop           {:needs "L0" :tool "sova_idea"}
   :item/hold          {:needs nil}
   :item/resume        {:needs nil}
   :correct/reopen     {:needs "L1" :tool "sova_correct" :correction true}
   :correct/skip-stall {:needs "L1" :tool "sova_correct" :correction true}
   :correct/relink     {:needs "L1" :tool "sova_correct" :correction true}
   :hold/cancel        {:needs "L0" :correction true}
   :hold/approve       {:needs "L0" :correction true}})

(defn not-here [event config data]
  (let [gap (:idea-id data)]
    (cond
      (contains? config :dropped) dropped-refusal
      (= event :item/hold) (str gap " is already on hold.")
      (= event :item/resume) (str gap " is not on hold.")
      (contains? config :on-hold) (str gap " is on hold: only the operator resumes it.")
      (= event :build/start) (str gap " has no promoted decision to build yet.")
      (= event :correct/reopen) (str gap " is not done.")
      (= event :correct/skip-stall) (str gap " is not waiting on a start.")
      :else "That can't be done now.")))

(def entry
  {:chart    chart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:idea-id :phase :phase-since :attempts :plans :dropped-from :reopened]
   :acts     acts
   :not-here not-here
   :final-refusal dropped-refusal
   :cold?    (fn [config _] (or (contains? config :dropped) (contains? config :done)))})
