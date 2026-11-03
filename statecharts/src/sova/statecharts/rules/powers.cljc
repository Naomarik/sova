(ns sova.statecharts.rules.powers
  "The powers (al_3; §app.project-overseer/autonomy-levels): what may happen without the operator, as one
   On/Off switch per power in two columns, enforced on every act. Mirrors shared/powers.ts (a server test
   pins the labels and the act map against it).

   Act metadata `:power` is a power id as the wire spells it (camelCase: \"codingStart\"), or \"always\",
   or \"operator\". The envelope (stamped by the host inside the org's serialized step) carries `:by`,
   `:attended`, `:powers` (the caller's column as set: kebab keys, `{:coding-start true …}`), `:column`,
   and the brakes' facts: `:paused` (the attach brake) and `:ceiling` (`{:reason}` or nil: the empty-roster
   brake, already dropped by the host when Resume lifted it). Watch data carries both columns for the
   drives (`:settings :powers {:overseer {…} :assistant {…}}`)."
  (:require
    [clojure.string :as str]
    [sova.statecharts.rules.refusal :as r]))

(def powers
  ["gather" "whatsapp" "ownerUpdates" "roster" "promote" "bookkeeping" "codingStart" "codingPrompt"
   "onboard" "markMerged" "copiesRun" "copiesReset" "share" "deploy"])

(def info
  "Per power: its old level (the carry-over), whether the Project Assistant column can have it, its label,
   and its label in the Project Assistant column where that differs (`:assistant-label`)."
  {"gather"       {:old "L1" :assistant true  :label "Start, offer and close gatherings" :assistant-label "Open feature request chats with the owner"}
   "whatsapp"     {:old "L1" :assistant false :label "Message people on WhatsApp"}
   "ownerUpdates" {:old "L1" :assistant false :label "Post owner updates"}
   "roster"       {:old "L2" :assistant false :label "Approve or decline proposed people"}
   "promote"      {:old "L2" :assistant false :label "Promote decisions into the spec"}
   "bookkeeping"  {:old "L1" :assistant false :label "Fix the pipeline's bookkeeping"}
   "codingStart"  {:old "L3" :assistant true  :label "Start coding sessions"}
   "codingPrompt" {:old "L3" :assistant true  :label "Send coding sessions prompts"}
   "onboard"      {:old "L3" :assistant false :label "Set up the project's verbs"}
   "markMerged"   {:old "L2" :assistant false :label "Mark a build merged"}
   "copiesRun"    {:old "L3" :assistant true  :label "Create, start and update running copies"}
   "copiesReset"  {:old "L3" :assistant false :label "Reset or tear down running copies"}
   "share"        {:old "L1" :assistant false :label "Share a version to try"}
   "deploy"       {:old nil  :assistant true  :label "Deploy (the project's own recipe)"}})

(def levels ["L0" "L1" "L2" "L3"])
(def ^:private rank (zipmap levels (range)))

(defn power-key
  "The envelope's (kebab keyword) key for a power id: \"codingStart\" → :coding-start."
  [p]
  (keyword (str/replace (name p) #"[A-Z]" #(str "-" (str/lower-case %)))))

(defn carry-over
  "The carry-over of a level (al_3 q4): each power whose old level is at or below it On, every other Off.
   Kebab keys, as the envelope and the watch hold them."
  [level]
  (let [have (get rank (some-> level name) 1)]
    (into {} (for [p powers :let [old (:old (info p))]]
               [(power-key p) (boolean (and old (<= (rank old) have)))]))))

(def all-off (into {} (for [p powers] [(power-key p) false])))

(defn derived-level
  "The never-looser level of a column: the highest L whose every power with an old level ≤ L is On."
  [m]
  (reduce (fn [out l]
            (if (every? (fn [p] (let [old (:old (info p))]
                                  (or (nil? old) (> (rank old) (rank l)) (true? (get m (power-key p))))))
                  powers)
              l
              (reduced out)))
    "L0" (rest levels)))

;; ---- the brakes ------------------------------------------------------------------------------------

(def paused-reason "Paused: this organization was attached on this host. Press Resume to let it act on its own again.")
(def empty-roster-reason "The roster has no active people yet.")

(defn brake
  "The brake in force for an envelope (or watch data): the attach pause, then the empty-roster ceiling;
   `{:kind :reason}` or nil. Under a brake every power of both columns acts as Off."
  [{:keys [paused ceiling]}]
  (cond
    paused {:kind "paused" :reason paused-reason}
    (map? ceiling) {:kind "empty-roster" :reason (or (not-empty (:reason ceiling)) empty-roster-reason)}
    :else nil))

;; ---- the check -------------------------------------------------------------------------------------

(defn column-of
  "The column an act's caller is checked against: the Project Assistant's for `by` assistant, else the
   overseer's (its own acts and the statecharts')."
  [envelope]
  (if (= "assistant" (some-> (:by envelope) name)) "assistant" "overseer"))

(def checked-by #{"overseer" "statechart" "assistant"})

(defn operator? [envelope] (= "operator" (some-> (:by envelope) name)))

(defn unrestricted?
  "The operator is never restricted (al_3 q3): their own act, and any turn they started (an attended
   overseer turn, the global Overseer's message in their turn, their own turn in the Project Assistant's
   chat). A statechart act is never attended."
  [envelope]
  (let [by (some-> (:by envelope) name)]
    (or (= "operator" by)
        (and (true? (:attended envelope)) (not= "statechart" by)))))

(defn label-of
  "A power's label in a column (shared/powers.ts powerLabel): the Project Assistant's own words where it has them."
  [power column]
  (let [i (info power)]
    (if (= "assistant" column) (or (:assistant-label i) (:label i)) (:label i))))

(defn off-sentence
  "The refusal of an act whose power is Off in the caller's column (shared/powers.ts powerOffSentence)."
  [power column]
  (let [label (label-of power column)]
    (if (= "assistant" column)
      (str label " is off for the Project Assistant. Do not retry it. Tell the owner it went to the team: it reaches the operator as a request.")
      (str label " is off for the overseer on its own. Do not retry it. File what you would do as an idea (sova_idea) or raise a sova_card card that says what and why; the operator's click starts a turn in which you may act."))))

(defn brake-sentence
  [{:keys [reason]} column]
  (if (= "assistant" column)
    (str "Nothing happens without the operator right now: " reason " Tell the owner it went to the team: it reaches the operator as a request.")
    (str "Nothing happens on its own right now: " reason " File what you would do as an idea (sova_idea) or raise a sova_card card; the operator's click starts a turn in which you may act.")))

(defn operator-only-sentence [tool]
  (if (= tool "sova_todos")
    "The to-do list is the operator's own: you read it only when the operator asks, in a turn they started. Don't act on their to-dos or ideas on your own."
    (str tool " runs only in a turn the operator started. Raise a sova_card card with what you would change.")))

(defn on?
  "Is `power` On in `m` (a kebab-keyed column)?"
  [m power]
  (true? (get m (power-key power))))

(defn column
  "The caller's column of an envelope: its `:powers`; an envelope with none (an older host's stamp, a
   trace recorded before switches) reads its `:autonomy` level's carry-over, and the Project Assistant's
   column is all Off then."
  [envelope]
  (or (:powers envelope)
      (if (= "assistant" (column-of envelope)) all-off (carry-over (or (some-> (:autonomy envelope) name) "L1")))))

(defn power-check
  "The engine's act check (`:level-check` option): nil, or the refusal of act `tool` of power `power`
   under `envelope`. Always-allowed acts and the operator's own pass; `operator` acts pass only for
   the operator; the overseer's, the statecharts' and the Project Assistant's acts need their power On
   in the caller's column and no brake. Other callers (a person, a gathering model, the wrap-up, the
   system) are nobody's column."
  [tool power envelope]
  (let [p  (some-> power name)
        by (some-> (:by envelope) name)]
    (cond
      (nil? p) nil
      (= p "always") nil
      (unrestricted? envelope) nil
      (= p "operator") (when (checked-by by) (r/refuse 409 (operator-only-sentence tool) :code "operator"))
      (not (checked-by by)) nil
      :else
      (let [col (column-of envelope)]
        (if-let [b (brake envelope)]
          (r/refuse 409 (brake-sentence b col) :code "brake")
          (when-not (on? (column envelope) p)
            (r/refuse 409 (off-sentence p col) :code "power-off")))))))

;; ---- drives (the statecharts' own acts read the watch's overseer column) -----------------------------

(defn drive-on?
  "A drive of `power` may fire: the watch's overseer column has it On and no brake. `w` is the watch's
   exported data (`:settings :powers :overseer`, `:paused`, `:ceiling`, `:settings :empty-roster-resumed`).
   A watch saved before switches (`:settings :autonomy` only) reads its level's carry-over."
  [w power]
  (let [s       (:settings w)
        col     (or (get-in s [:powers :overseer]) (carry-over (or (:autonomy s) "L1")))
        ceiling (when-not (true? (:empty-roster-resumed s)) (:ceiling w))]
    (and (nil? (brake {:paused (:paused w) :ceiling ceiling}))
         (on? col power))))

(defn drive-off-note
  "The gap timeline's note when a drive of `power` stays put because it is Off or braked."
  [power]
  (str (:label (info power)) " is off for the overseer on its own."))
