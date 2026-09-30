(ns sova.org-charts.charts.rules.started
  "r11 (F-146 changed on purpose): the sessions a project started — gatherings, offers and coding
   sessions, its own and its items' — as one ordered list, oldest first, capped at 200. Past the
   cap the oldest SETTLED one is retired; a live one never is, so the list exceeds 200 only while more
   than 200 are live, and trims back as they settle. Pure.")

(def cap 200)

(defn settled?
  "From a started session's configuration (its link notification): a gathering or offer done or
   closed whose wrap-up has ended (done or skipped: a failed one may be retried); a build merged or
   its worktree removed, with no turn running; anything retired."
  [chart states]
  (let [s (set states)]
    (boolean
      (or (contains? s :retired)
          (case chart
            "baton" (and (or (contains? s :done) (contains? s :closed))
                         (or (contains? s :wrapup-done) (contains? s :wrapup-skipped)))
            "build" (and (or (contains? s :merged) (contains? s :tree-removed)) (not (contains? s :working)))
            false)))))

(defn note
  "A newly started session at the end of the list (once)."
  [rows {:keys [sid] :as row}]
  (if (some #(= sid (:sid %)) rows) (vec rows) (conj (vec rows) (assoc row :settled false))))

(defn mark
  "A started session's settledness from its link notification."
  [rows sid settled]
  (mapv #(if (= sid (:sid %)) (assoc % :settled settled) %) rows))

(defn trim
  "While over the cap, the oldest settled rows leave: `{:rows kept :retire [sid …]}`."
  [rows]
  (loop [rows (vec rows) out []]
    (let [i (when (> (count rows) cap) (first (keep-indexed #(when (:settled %2) %1) rows)))]
      (if (nil? i)
        {:rows rows :retire out}
        (recur (into (subvec rows 0 i) (subvec rows (inc i))) (conj out (:sid (nth rows i))))))))
