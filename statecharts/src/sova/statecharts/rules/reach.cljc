(ns sova.statecharts.rules.reach
  "r12 (q15 = C): an offer reaches each invitee only in their own working hours. Pure over the offer,
   the invitees' hours and a clock. The offer's `:reach` is `{pid {:state \"waiting\"|\"reached\" :at
   ms? :next ms?}}`: `:at` when they were reached, `:next` when their next window opens (derived, kept
   for the reads). Nobody is reached while the offer is held (rule 12): a never-reached invitee never
   learns of a lease they could not have taken."
  (:require
    [sova.statecharts.rules.hours :as hours]))

(defn reached? [offer pid] (= "reached" (get-in offer [:reach pid :state])))

(defn may-claim?
  "Whoever has been reached may claim. An offer from before r12 (no `:reach`) reached everyone."
  [offer pid]
  (or (nil? (:reach offer)) (reached? offer pid)))

(defn waiting [offer] (remove #(reached? offer %) (:to offer)))

(defn step
  "Reach whoever of the offer's waiting invitees is in hours at `now` (no hours set: always in hours;
   an offer made `:at-once`, the operator's own or in a turn they started, reaches everyone now).
   `people` is `{pid {:tz :hours}}`. Held (`paused?`), nobody is reached. Returns `{:offer :reached
   [pids] :at ms?}`: the offer with its `:reach` brought up to date, who was reached now, and when the
   next waiting invitee's window opens (nil: nobody waits, or it is held)."
  [offer people now paused?]
  (let [rows    (for [pid (:to offer) :when (not (reached? offer pid))]
                  [pid (when-not (:at-once offer) (hours/next-window (assoc (get people pid) :id pid) now))])
        reached (if paused? [] (vec (for [[pid nxt] rows :when (nil? nxt)] pid)))
        reach   (reduce (fn [m [pid nxt]]
                          (assoc m pid (if (some #{pid} reached)
                                         {:state "reached" :at now}
                                         (cond-> {:state "waiting"} nxt (assoc :next nxt)))))
                        (or (:reach offer) {}) rows)
        nexts   (keep (fn [[pid nxt]] (when-not (some #{pid} reached) nxt)) rows)]
    {:offer   (assoc offer :reach reach)
     :reached reached
     :at      (when (and (not paused?) (seq nexts)) (apply min nexts))}))
