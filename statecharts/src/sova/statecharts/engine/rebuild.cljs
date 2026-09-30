(ns sova.statecharts.engine.rebuild
  "`statecharts rebuild --verify` (operator ruling r9): replay one session's transition log from its
   start on the current statecharts, on a scratch engine where every other session is a sink, and compare
   the result with its snapshot: states, running flag, links, watchers, its own timers, holds. A
   diagnostic: it restores nothing and writes nothing. The log is scrubbed (design §5.5: no message
   text, contact values or About text), so a guard that read one may take another way; that shows
   as a difference, never as a repair.

   A row (kebab keys, as the host's log reader gives them through the API): `:at` (unique per org),
   `:t` (the engine's own time when `at` was moved on), `:event` \"ns/name\", `:envelope` (the
   event's data, scrubbed), `:start` (a host start's data), `:invoke-id`, `:refused`, `:after`."
  (:require [sova.statecharts.engine.core :as core]))

(def compared
  "What must be equal, in the order differences are listed."
  [:configuration :running :links :watchers :timers :holds])

(defn- nm [k]
  (cond (keyword? k) (if-let [n (namespace k)] (str n "/" (name k)) (name k))
        (nil? k) nil
        :else (str k)))

(defn- logged?
  "The host logs exactly these steps (a saved, refused or held one)."
  [step]
  (boolean (or (:saved step) (:refused step) (:held step))))

(defn- time-of [row] (or (:t row) (:at row)))

(defn- same-step? [step row]
  (and (= (nm (:event step)) (:event row))
       (= (boolean (:refused step)) (boolean (:refused row)))))

(defn verify-session
  "Replay `rows` (session `sid`'s log rows) and compare with `snapshot-text` (nil: none).
   → {:session :statechart :rows :same :differences [{:what :replayed :snapshot}] :divergence}; the
   divergence is the first step where the replay went another way (or an engine error)."
  [statecharts sid rows snapshot-text]
  (let [rows     (vec (sort-by :at rows))
        n        (count rows)
        st       (atom {:consumed #{} :cursor 0 :divergence nil})
        cursor!  (fn [] (let [{:keys [consumed cursor]} @st
                              i (loop [i cursor] (if (and (< i n) (contains? consumed i)) (recur (inc i)) i))]
                          (swap! st assoc :cursor i)
                          (when (< i n) i)))
        note!    (fn [d] (when-not (:divergence @st) (swap! st assoc :divergence d)))
        consume! (fn [i] (swap! st update :consumed conj i))
        match!   (fn [{:keys [steps]}]
                   (doseq [step steps :when (and (= sid (:session-id step)) (logged? step))]
                     (let [i (cursor!) row (when i (rows i))]
                       (if (and row (same-step? step row))
                         (do (consume! i)
                             (when (and (:after row) (not= (vec (map nm (:after step))) (vec (:after row))))
                               (note! {:at (:at row) :event (:event row) :logged (:after row) :replayed (mapv nm (:after step))})))
                         (note! {:at (:at row) :event (:event row) :replayed-event (nm (:event step))
                                 :why (if row "The replay took another step here." "The replay took a step the log doesn't have.")})))))
        ;; a held act's release and a statechart-driven act get the envelope their logged row carries
        stamp    (fn [target event _payload _ctx]
                   (if (= target sid)
                     (let [i (cursor!)
                           j (when i (first (filter #(and (not (contains? (:consumed @st) %)) (= (nm event) (:event (rows %))))
                                              (range i n))))]
                       (or (when j (:envelope (rows j))) {}))
                     {}))
        eng      (core/new-engine statecharts {:absorb-unknown true :stamp stamp})
        first-row (first rows)
        started? (= "sova/started" (:event first-row))]
    (when started?
      (try
        (match! (core/start! eng sid (:statechart first-row) (or (:start first-row) (:envelope first-row) {}) (time-of first-row)))
        (catch :default e (note! {:at (:at first-row) :event "sova/started" :error (ex-message e)})))
      (consume! 0)
      (doseq [i (range 1 n)]
        (when-not (contains? (:consumed @st) i)
          (let [row (rows i) t (time-of row) env (or (:envelope row) {})]
            (try
              ;; what came due first, except before a resume: the host resumes, then fires past-due timers
              (when-not (= "sova/resumed" (:event row))
                (match! (core/fire-due! eng t)))
              (when-not (contains? (:consumed @st) i)
                (match!
                  (case (:event row)
                    "sova/watched"   (core/replay-watch! eng (:watcher env) sid true {:now t})
                    "sova/unwatched" (core/replay-watch! eng (:watcher env) sid false {:now t})
                    "sova/resumed"   (core/resume! eng [sid] {:now t})
                    "sova/set-state" (core/set-state! eng sid (select-keys env [:states :patch :reason])
                                       (select-keys env [:by :via :attended]) {:now t})
                    (core/send! eng sid (keyword (:event row)) env {:now t :invoke-id (:invoke-id row)}))))
              (catch :default e (note! {:at (:at row) :event (:event row) :error (ex-message e)})))
            (when-not (contains? (:consumed @st) i)
              (note! {:at (:at row) :event (:event row) :why "The replay didn't take this event."})
              (consume! i))))))
    (let [replayed (when started? (core/session-outline eng sid))
          snap     (when snapshot-text (core/outline statecharts snapshot-text))
          diffs    (cond
                     (not started?) [{:what :start :why "The log doesn't reach back to its start."}]
                     (nil? snap) [{:what :snapshot :why "It has log rows but no snapshot."}]
                     :else (vec (for [k compared :when (not= (get replayed k) (get snap k))]
                                  {:what k :replayed (get replayed k) :snapshot (get snap k)})))]
      {:session     sid
       :statechart       (or (:statechart first-row) (when snapshot-text (:statechart (core/peek-snapshot statecharts snapshot-text))))
       :rows        n
       :same        (empty? diffs)
       :differences diffs
       :divergence  (:divergence @st)})))
