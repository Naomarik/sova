(ns sova.org-charts.engine.hold-policy
  "THE one switch for q10/r4/r6 holds. An act is held when its registry meta says `:hold true`, the
   hold length is above 0, and it is either chart-started (`by` chart: always) or, while
   `overseer-unattended-held?` is on, the project overseer's own unattended call. The operator's
   clicks and attended turns are never held. The held-act list is every act with `:hold true` in
   the registries (`held-acts`).")

(def overseer-unattended-held?
  "r4 (provisional, pending q11) and r6: the overseer's unattended people/code-facing calls wait in a
   hold too. Off: only chart-started acts are held."
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
         (or (= "chart" by)
             (and overseer-unattended-held? (= "overseer" by))))))

(defn held?
  "Does act `act` (its registry meta) wait in a hold under `envelope`?"
  [act envelope data]
  (boolean (and (:hold act) (pos? (hold-ms envelope data)) (held-by? envelope))))

(defn held-acts
  "`[[chart event] …]` of every act the registries mark `:hold true`, sorted."
  [charts]
  (vec (sort (for [[nm {:keys [acts]}] charts
                   [e m] acts
                   :when (:hold m)]
               [nm (str (namespace e) "/" (name e))]))))
