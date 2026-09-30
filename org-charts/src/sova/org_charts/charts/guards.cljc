(ns sova.org-charts.charts.guards
  "The L0–L3 dial and the caps as guards, with today's refusal sentences.

   Mirrors server/project-overseer-tools.ts (TOOL_NEEDS, autonomyRefusal, overRefusal, the at-once
   refusals) and server/project-overseer-store.ts (effectiveAutonomy, levelAtLeast) exactly. Each
   check is pure over the event's envelope and returns today's refusal sentence or nil; the charts'
   conditions are \"no check refuses\" (work-item/checks), so a guard and its explanation are one
   piece of code. `explain` answers the host's trial."
  (:require
    [clojure.string :as str]
    [sova.org-charts.charts.common :as c]))

;; ---- levels ------------------------------------------------------------------------------------

(def levels ["L0" "L1" "L2" "L3"])
(def rank (zipmap levels (range)))

(defn level-at-least?
  "levelAtLeast: `have` ranks at or above `need`."
  [have need]
  (>= (get rank (name (or have "L0")) -1) (get rank (name need) 99)))

(def empty-roster-reason "The roster has no active people yet, so the overseer only proposes (L0).")
(def paused-reason "Paused at L0: this organization was attached on this host. Set its level to resume.")

(defn effective-autonomy
  "effectiveAutonomy: L0 while paused by an attach on this host, L0 while the roster has no active
   person, else the setting. `{:autonomy :paused :roster-active}` → `{:autonomy :reason?}`."
  [{:keys [autonomy paused roster-active]}]
  (cond
    paused (let [_ autonomy] {:autonomy "L0" :reason paused-reason})
    (not roster-active) {:autonomy "L0" :reason empty-roster-reason}
    :else {:autonomy (name (or autonomy "L1"))}))

;; ---- TOOL_NEEDS ----------------------------------------------------------------------------------

(def tool-needs
  "TOOL_NEEDS (server/project-overseer-tools.ts), verbatim. `sova_roster` approve/decline is L2
   (checked per op)."
  {"sova_project"         "read"
   "sova_decisions"       "read"
   "sova_list_sessions"   "read"
   "sova_read_session"    "read"
   "sova_roster"          "read"
   "sova_todos"           "operator"
   "sova_note"            "L0"
   "sova_card"            "L0"
   "sova_idea"            "L0"
   "sova_start_gathering" "L1"
   "sova_owner_update"    "L1"
   "sova_offer"           "L1"
   "sova_close_gathering" "L1"
   "sova_reconcile"       "L1"
   "sova_promote"         "L2"
   "sova_create_session"  "L3"
   "sova_send"            "L3"
   "sova_todo"            "operator"})

(defn autonomy-refusal
  "autonomyRefusal(name, need, attended, effective), verbatim: the sentence, or nil."
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

(defn tool-refusal
  "The autonomy refusal for a tool call under this envelope (any tool, item-bound or not)."
  ([tool envelope] (tool-refusal tool envelope nil))
  ([tool envelope op]
   (let [need (if (and (= tool "sova_roster") (#{"approve" "decline"} op)) "L2" (get tool-needs tool "operator"))]
     (autonomy-refusal tool need (true? (:attended envelope)) (effective-autonomy envelope)))))

;; ---- caps ------------------------------------------------------------------------------------------

(def limit-what
  {"gather" "gathering sessions started" "promote" "decisions promoted"
   "create" "coding sessions started" "prompt" "prompts to coding sessions"})

(defn allowance-of [envelope kind]
  (get-in envelope [:allowance (keyword kind)]))

(defn over-allowance
  "PoLimits.take's check: taking `n` of `kind` from the ledger the turn draws on would exceed it.
   Returns `{:ledger :kind :max :used}` or nil. No `:allowance` for the kind means no limit known."
  [envelope kind n]
  (let [{:keys [used max]} (allowance-of envelope kind)
        used (or used 0)]
    (when (and (some? max) (> (+ used n) max))
      {:ledger (if (:attended envelope) "message" "day") :kind (name kind) :max max :used used})))

(defn over-refusal
  "overRefusal: `{:said :tail}` for an allowance over."
  [{:keys [ledger kind max used]}]
  (let [what (limit-what kind)]
    (if (= ledger "day")
      {:said (str "Today's allowance is used: " used " of " max " " what " on its own. It looks again at midnight.")
       :tail "Nothing starts before then. Tell the operator what is waiting; don't promise an earlier look."}
      {:said (str "This message's allowance is used: " used " of " max " " what " per message you send.")
       :tail "Stop here and tell the operator what is done and what is left, or ask with sova_card."})))

(defn at-once-refusal
  "The at-once refusals of gather() and sova_create_session, or nil."
  [envelope kind]
  (let [{:keys [gatherings-open gatherings-cap coding-running coding-cap]} (:at-once envelope)]
    (case kind
      "gather" (when (and gatherings-cap (>= (or gatherings-open 0) gatherings-cap))
                 {:said (str gatherings-open " of its gathering sessions are open, and the limit is " gatherings-cap " at once.")
                  :tail "One reaching its goal or being closed is a reason to look again; don't promise when."})
      "create" (when (and coding-cap (>= (or coding-running 0) coding-cap))
                 {:said (str coding-running " of its coding sessions are running, and the limit is " coding-cap " at once.")
                  :tail "One finishing its turn is a reason to look again; don't promise when."})
      nil)))

;; ---- the guards, as chart conditions -----------------------------------------------------------------

(defn operator-act?
  "The operator's own click on the page (not a tool call in their turn)."
  [envelope]
  (= "operator" (some-> (:by envelope) name)))

;; ---- explain ---------------------------------------------------------------------------------------

(defn- with-tail [{:keys [said tail]}] (if tail (str said " " tail) said))

(defn level-refusal
  "The level refusal for `tool` at `need` under `envelope`, or nil (the operator's click never is)."
  [tool need envelope]
  (when-not (operator-act? envelope)
    (autonomy-refusal tool need (true? (:attended envelope)) (effective-autonomy envelope))))

(defn cap-refusal
  "The first cap refusal (at-once, then the allowance for `n`), as the model reads it, or nil."
  [kind envelope n]
  (or (some-> (at-once-refusal envelope kind) with-tail)
      (some-> (over-allowance envelope kind n) over-refusal with-tail)))

(defn operator-only-refusal [what]
  (str "Only the operator " what ", from the project page."))

(defn blank? [s] (or (nil? s) (and (string? s) (str/blank? s))))

;; ---- explain (the engine's trial) ---------------------------------------------------------------------

(defmulti explain*
  "Per chart: the sentence an act gets when the chart would not take it, or nil. `data` is the
   session's data model with `:sova/configuration` (active states) and `:sova/running?`."
  (fn [chart _event _data _envelope] (keyword (name chart))))

(defmethod explain* :default [_ _ _ _] nil)

(defn explain
  "Why `event` with `envelope` would be refused on a session of `chart` (\"project\" | \"work-item\"),
   or nil. The chart namespaces add their methods: require them first."
  [chart event data envelope]
  (explain* chart (keyword event) data envelope))
