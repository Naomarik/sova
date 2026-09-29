(ns sova.org-charts.charts.rules.refusal
  "A refusal, in the engine's check shape (engine/API.md §2): today's sentence with the HTTP status
   its route answers (400 · 404 · 409 · 410), an optional machine `code` the client acts on (`held`,
   `taken`, `budget`…) and an optional `tail` that only the model reads (never logged). Every rule
   returns nil or one of these.")

(defn refuse
  "A refusal `{:sentence s :status n}` (+ `:code`, `:tail`)."
  ([status sentence] {:sentence sentence :status status})
  ([status sentence & {:keys [code tail]}]
   (cond-> {:sentence sentence :status status}
     code (assoc :code code)
     tail (assoc :tail tail))))

(defn refusal? [x] (and (map? x) (string? (:sentence x))))

(defn said
  "What the model reads: the sentence, then its tail."
  [x]
  (when (refusal? x) (if (:tail x) (str (:sentence x) " " (:tail x)) (:sentence x))))

(defn first-refusal
  "The first refusal of `checks` (each `(fn [ctx])` → refusal or nil), in their order."
  [checks ctx]
  (some #(let [r (% ctx)] (when (refusal? r) r)) checks))
