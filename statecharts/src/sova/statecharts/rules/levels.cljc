(ns sova.statecharts.rules.levels
  "The at-once caps and the two allowances, the global Overseer's confirm-card check and the host's
   argument refusals, as pure checks over the act's envelope (design §4.1–4.4). What a caller may do
   without the operator is rules/powers.cljc's (the levels L0–L3 are gone, al_3; `level-at-least?`
   stays only to read snapshots saved before switches).

   The envelope (stamped by the host inside the org's serialized step): `:by` operator | overseer |
   system | model | person | wrapup | statechart | assistant, `:via` overseer, `:attended`, `:powers`,
   `:paused`, `:ceiling` (`{:reason}` or nil), `:archived`, `:allowance {kind {:used :max}}` (the ledger this turn
   draws on), `:ledger` message | day, `:looks {:used :max}`, `:at-once {:gatherings-open
   :gatherings-cap :coding-running :coding-cap}`, `:card`, `:hold-ms`, `:invalid`."
  (:require
    [clojure.string :as str]
    [sova.statecharts.rules.refusal :as r]))

(def levels ["L0" "L1" "L2" "L3"])
(def rank (zipmap levels (range)))

(defn level-at-least?
  "levelAtLeast: `have` ranks at or above `need` (an unknown level ranks −1)."
  [have need]
  (>= (get rank (some-> have name) -1) (get rank (some-> need name) 99)))

(defn operator? [envelope] (= "operator" (some-> (:by envelope) name)))
(defn attended? [envelope] (true? (:attended envelope)))

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
   and the statechart refuses with it where the tool checks it. `:invalid-status` its HTTP status."
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
