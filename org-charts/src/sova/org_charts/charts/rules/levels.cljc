(ns sova.org-charts.charts.rules.levels
  "L0–L3, attended vs unattended, effectiveAutonomy's forced L0, the at-once caps and the two
   allowances, as pure checks over the act's envelope (design §4.1–4.4). The sentences are today's
   (server/project-overseer-tools.ts TOOL_NEEDS, autonomyRefusal, overRefusal; project-overseer-store.ts
   effectiveAutonomy, levelAtLeast), byte for byte.

   The envelope (stamped by the host inside the org's serialized step): `:by` operator | overseer |
   system | model | person | wrapup | chart, `:via` overseer, `:attended`, `:autonomy` (the setting),
   `:paused`, `:roster-active`, `:archived`, `:allowance {kind {:used :max}}` (the ledger this turn
   draws on), `:ledger` message | day, `:looks {:used :max}`, `:at-once {:gatherings-open
   :gatherings-cap :coding-running :coding-cap}`, `:card`, `:hold-ms`, `:invalid`."
  (:require
    [clojure.string :as str]
    [sova.org-charts.charts.rules.refusal :as r]))

(def levels ["L0" "L1" "L2" "L3"])
(def rank (zipmap levels (range)))

(defn level-at-least?
  "levelAtLeast: `have` ranks at or above `need` (an unknown level ranks −1)."
  [have need]
  (>= (get rank (some-> have name) -1) (get rank (some-> need name) 99)))

(def empty-roster-reason "The roster has no active people yet, so the overseer only proposes (L0).")
(def paused-reason "Paused at L0: this organization was attached on this host. Set its level to resume.")

(defn effective-autonomy
  "effectiveAutonomy: paused wins, then an empty roster, else the setting (default L1)."
  [{:keys [autonomy paused roster-active]}]
  (cond
    paused {:autonomy "L0" :reason paused-reason}
    (not roster-active) {:autonomy "L0" :reason empty-roster-reason}
    :else {:autonomy (name (or autonomy "L1"))}))

(def tool-needs
  "TOOL_NEEDS, verbatim (a test pins it against the registry's acts). `sova_roster` approve/decline
   is L2, per op."
  {"sova_project" "read" "sova_decisions" "read" "sova_list_sessions" "read" "sova_read_session" "read"
   "sova_roster" "read" "sova_pipeline" "read" "sova_previews" "read"
   "sova_todos" "operator" "sova_todo" "operator"
   "sova_note" "L0" "sova_card" "L0" "sova_idea" "L0"
   "sova_start_gathering" "L1" "sova_offer" "L1" "sova_close_gathering" "L1" "sova_reconcile" "L1" "sova_owner_update" "L1" "sova_preview" "L1"
   "sova_promote" "L2"
   "sova_create_session" "L3" "sova_send" "L3"})

(defn operator? [envelope] (= "operator" (some-> (:by envelope) name)))
(defn chart? [envelope] (= "chart" (some-> (:by envelope) name)))
(defn attended? [envelope] (true? (:attended envelope)))

(defn autonomy-refusal
  "autonomyRefusal(tool, need, attended, effective): the sentence, or nil."
  [tool need attended {:keys [autonomy reason]}]
  (cond
    (or attended (= need "read")) nil
    (= need "operator")
    (if (= tool "sova_todos")
      "The to-do list is the operator's own: you read it only when the operator asks, in a turn they started. Don't act on their to-dos or ideas on your own."
      (str tool " changes the operator's own to-do list, so it runs only in a turn the operator started. Raise a sova_card card with what you would change."))
    (level-at-least? autonomy need) nil
    :else
    (str "This run was not started by the operator, and your autonomy here is " autonomy
      (when reason (str " (" reason ")")) "; "
      tool " needs " need ". Do not retry it. File what you would do as an idea (sova_idea, tag gap) or raise a sova_card card that says what and why; "
      "the operator's click starts a turn in which you may act.")))

(defn level-check
  "The engine's `:level-check` option: nil for the operator's own click and for acts of nobody's
   level (a person, a gathering model, the wrap-up, the system); the overseer's and the chart's
   own acts against the level in force. A chart act is never attended."
  [tool need envelope]
  (let [by (some-> (:by envelope) name)]
    (when (and need (contains? #{"overseer" "chart"} by))
      (autonomy-refusal tool need (and (= by "overseer") (attended? envelope)) (effective-autonomy envelope)))))

;; ---- caps --------------------------------------------------------------------------------------

(def limit-what
  {"gather" "gathering sessions started" "promote" "decisions promoted"
   "create" "coding sessions started" "prompt" "prompts to coding sessions"})

(defn over-allowance
  "PoLimits.take: taking `n` of `kind` would pass the ledger's max (nil max = Unlimited)."
  [envelope kind n]
  (let [{:keys [used max]} (get-in envelope [:allowance (keyword kind)])
        used (or used 0)]
    (when (and (some? max) (> (+ used n) max))
      {:ledger (or (some-> (:ledger envelope) name) (if (attended? envelope) "message" "day")) :kind kind :max max :used used})))

(defn over-refusal
  "overRefusal: the sentence and the model's tail."
  [{:keys [ledger kind max used]}]
  (let [what (limit-what kind)]
    (if (= ledger "day")
      (r/refuse 409 (str "Today's allowance is used: " used " of " max " " what " on its own. It looks again at midnight.")
        :code "allowance"
        :tail "Nothing starts before then. Tell the operator what is waiting; don't promise an earlier look.")
      (r/refuse 409 (str "This message's allowance is used: " used " of " max " " what " per message you send.")
        :code "allowance"
        :tail "Stop here and tell the operator what is done and what is left, or ask with sova_card."))))

(defn at-once-refusal
  "The at-once refusals of gather() and sova_create_session (both kinds of run), or nil."
  [envelope kind]
  (let [{:keys [gatherings-open gatherings-cap coding-running coding-cap]} (:at-once envelope)]
    (case kind
      "gather" (when (and (some? gatherings-cap) (>= (or gatherings-open 0) gatherings-cap))
                 (r/refuse 409 (str (or gatherings-open 0) " of its gathering sessions are open, and the limit is " gatherings-cap " at once.")
                   :code "at-once"
                   :tail "One reaching its goal or being closed is a reason to look again; don't promise when."))
      "create" (when (and (some? coding-cap) (>= (or coding-running 0) coding-cap))
                 (r/refuse 409 (str (or coding-running 0) " of its coding sessions are running, and the limit is " coding-cap " at once.")
                   :code "at-once"
                   :tail "One finishing its turn is a reason to look again; don't promise when."))
      nil)))

(defn cap-check
  "At once, then the allowance for `(n-fn data)` of `kind`: never for the operator's own click.
   Checked when an act is held and again when it comes back (F2: the host's counts include every
   pending hold of the kind but the one being released, so a hold reserves its slot); the ledger
   counts the act only on the transition that takes it."
  [kind n-fn evt]
  (fn [data]
    (let [e (evt data)]
      (when-not (operator? e)
        (or (at-once-refusal e kind)
            (some-> (over-allowance e kind (n-fn data)) over-refusal))))))

;; ---- small shared checks ---------------------------------------------------------------------------

(defn blank? [s] (or (nil? s) (and (string? s) (str/blank? s))))

(defn invalid-check
  "The tool's (or route's) own argument refusal, which only the host can judge (name resolution,
   abilities and mode ceilings, a folder, field shapes): the host stamps its sentence as `:invalid`,
   and the chart refuses with it where the tool checks it. `:invalid-status` its HTTP status."
  [evt]
  (fn [data]
    (let [e (evt data) v (:invalid e)]
      (when-not (blank? v) (r/refuse (or (:invalid-status e) 400) v)))))

(def people-facing-refusal-prefix "This reaches people or ends something: ask with sova_card, listing ")

(defn card-check
  "The global Overseer's people-facing acts (`via` overseer) run only in the turn a confirm card's
   click started, whose items list every target (§app.overseer/org-people-facing). `targets-fn`
   gives `{:people [..] :projects [..] :sessions [..]}` and `what` names them."
  [evt targets-fn what]
  (fn [data]
    (let [e (evt data)]
      (when-let [want (and (= "overseer" (some-> (:via e) name)) (targets-fn data))]
        (let [card (:card e)
              ok?  (and (map? card)
                        (every? (set (:people card)) (:people want))
                        (every? (set (:projects card)) (:projects want))
                        (every? (set (:sessions card)) (:sessions want)))]
          (when-not ok?
            (r/refuse 409 (str people-facing-refusal-prefix (what data) " in its items, and act in the turn the user's click starts."))))))))
