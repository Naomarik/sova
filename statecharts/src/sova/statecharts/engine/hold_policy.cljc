(ns sova.statecharts.engine.hold-policy
  "THE one switch for q10/r4/r6 holds. An act is held when its registry meta says `:hold true`, the
   hold length is above 0, and it is either statechart-started (`by` statechart: always) or, while
   `overseer-unattended-held?` is on, the project overseer's own unattended call. The operator's
   clicks and attended turns are never held. The held-act list is every act with `:hold true` in
   the registries (`held-acts`).")

(def overseer-unattended-held?
  "r4 (provisional, pending q11) and r6: the overseer's unattended people/code-facing calls wait in a
   hold too. Off: only statechart-started acts are held."
  true)

(def operator-acts-wait-for-hours?
  "r7 (provisional, pending q13): the operator's own clicks wait for a person's working hours too.
   Off: they send at once, with an off-hours fact the UI shows."
  false)

(def unreviewed-holds-wait?
  "r8/q12: a confirm-required hold (its act's kind is in the project's confirm list) waits past its
   end until the overseer approves or cancels it. Off: it goes ahead at its end like any hold."
  true)

(def at-once-field
  "The at-once count a held act of a `:counts` kind reserves a slot in (F2)."
  {"gather" :gatherings-open "create" :coding-running})

(def default-hold-ms (* 10 60 1000))

(defn- by-of [envelope] (let [b (:by envelope)] (if (keyword? b) (name b) b)))

(defn hold-ms
  "The hold's length: the envelope's `:hold-ms` (the host stamps the project's setting), else data
   `:sova/hold-ms`, else 10 min. 0 = no hold."
  [envelope data]
  (let [v (or (:hold-ms envelope) (:sova/hold-ms data))]
    (if (number? v) v default-hold-ms)))

(defn held-by?
  "Is an act made under `envelope` one the policy holds (whatever the act)?"
  [envelope]
  (let [by (by-of envelope)]
    (and (not (true? (:attended envelope)))
         (or (= "statechart" by)
             (and overseer-unattended-held? (= "overseer" by))))))

(defn held?
  "Does act `act` (its registry meta) wait in a hold under `envelope`?"
  [act envelope data]
  (boolean (and (:hold act) (pos? (hold-ms envelope data)) (held-by? envelope))))

(defn held-acts
  "`[[statechart event] …]` of every act the registries mark `:hold true`, sorted."
  [statecharts]
  (vec (sort (for [[nm {:keys [acts]}] statecharts
                   [e m] acts
                   :when (:hold m)]
               [nm (str (namespace e) "/" (name e))]))))

(defn hours-wait-by?
  "r7: does an act under `envelope` wait for the person's working hours? Statechart-started and the
   overseer's unattended acts do; attended turns never; the operator's clicks per the switch."
  [envelope]
  (let [by (by-of envelope)]
    (cond
      (true? (:attended envelope)) false
      (= "operator" by) operator-acts-wait-for-hours?
      :else (contains? #{"statechart" "overseer"} by))))

(defn confirm-required?
  "q12: is an act of confirm kind `kind` in the envelope's confirm list (`:confirm-kinds`)?"
  [kind envelope]
  (boolean (and kind (some #(= (name kind) (name %)) (:confirm-kinds envelope)))))

(defn waits-unreviewed?
  "Does a hold wait past its end until approved (the switch; confirm-required holds only)?"
  [hold]
  (boolean (and unreviewed-holds-wait? (:confirm hold))))
