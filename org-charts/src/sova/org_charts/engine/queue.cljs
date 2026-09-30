(ns sova.org-charts.engine.queue
  "A durable in-process `EventQueue` with delayed sends and cancel.

  Ported (copied, not depended on) from escapement's `escapement.engine.queue` (cljc, HEAD 92707f0):
  per-target queues, delivery-time gating for delays, a persisted monotonic ordinal as the stable
  tie-break, and delivery in `(delivery-time, ordinal)` order. Differences from the original:

  - the clock is injected (`clock` is a 0-arity fn), so replays and tests drive time;
  - `cancel!` removes a sender's send-id from every target's queue, not only the sender's own
    (a delayed send to another session is cancellable too);
  - `snapshot`/`restore!` work per target session, so each session's snapshot carries its own
    pending events;
  - an optional `on-send` hook sees every accepted send (the engine reports cross-session sends);
  - no guardrails `>defn`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts :as sc]
    [com.fulcrologic.statecharts.events :as evts]
    [com.fulcrologic.statecharts.protocols :as sp]))

(defn- supported-type? [type]
  (or (nil? type)
    (= type ::sc/chart)
    (= type :statechart)
    (and (string? type)
      (str/starts-with? (str/lower-case type) "http://www.w3.org/tr/scxml"))))

(defn- deliver-at [evt] (::delivery-time (meta evt)))
(defn- ordinal-of [evt] (::ordinal (meta evt) 0))

(defrecord DurableQueue [session-queues next-ordinal clock on-send]
  sp/EventQueue
  (send! [_ _env {:keys [event data type target source-session-id send-id invoke-id delay
                         origin origintype] :as req}]
    (if (and (supported-type? type) (or target source-session-id))
      (let [target (or target source-session-id)
            now    (clock)
            tm     (if (and delay (pos? delay)) (+ now (js/Math.floor delay)) now)
            ord    (swap! next-ordinal inc)
            evt    (with-meta
                     (evts/new-event (cond-> {:name   event
                                              :type   (or type ::sc/chart)
                                              :target target
                                              :data   (or data {})}
                                       source-session-id (assoc ::sc/source-session-id source-session-id)
                                       (or origin source-session-id) (assoc :origin (or origin source-session-id))
                                       true (assoc :origintype (or origintype type ::sc/chart))
                                       send-id (assoc :sendid send-id ::sc/send-id send-id)
                                       invoke-id (assoc :invokeid invoke-id)))
                     {::delivery-time tm ::ordinal ord})]
        (swap! session-queues update target (fnil conj []) evt)
        (when on-send (on-send (assoc req :target target :delivery-time tm)))
        true)
      false))
  (cancel! [_ _env session-id send-id]
    (swap! session-queues
      (fn [qs]
        (reduce-kv
          (fn [acc target q]
            (assoc acc target
              (filterv (fn [e] (not (and (= send-id (::sc/send-id e))
                                         (= session-id (or (::sc/source-session-id e) target)))))
                q)))
          {} qs)))
    nil)
  (receive-events! [this env handler]
    (sp/receive-events! this env handler {}))
  (receive-events! [this env handler {:keys [session-id]}]
    (if (nil? session-id)
      (doseq [sid (keys @session-queues)]
        (sp/receive-events! this env handler {:session-id sid}))
      (let [cutoff  (clock)
            [old _] (swap-vals! session-queues
                      (fn [qs] (assoc qs session-id (filterv #(> (deliver-at %) cutoff) (get qs session-id)))))
            to-send (->> (get old session-id)
                      (filterv #(<= (deliver-at %) cutoff))
                      (sort-by (fn [e] [(deliver-at e) (ordinal-of e)])))]
        (doseq [event to-send]
          (handler env event))))))

(defn new-queue
  "A new empty queue on `clock` (a 0-arity fn returning epoch ms). `on-send`, when given, is called with
   every accepted send request (target resolved, plus `:delivery-time`)."
  ([clock] (new-queue clock nil))
  ([clock on-send] (->DurableQueue (atom {}) (atom 0) clock on-send)))

(defn next-due
  "The earliest `[delivery-time ordinal target]` among pending events whose target satisfies `pred`, or nil."
  [queue pred]
  (->> @(:session-queues queue)
    (mapcat (fn [[target q]] (when (pred target) (map (fn [e] [(deliver-at e) (ordinal-of e) target]) q))))
    (sort)
    (first)))

(defn pending
  "Pending events for `target` in delivery order (each with its metadata)."
  [queue target]
  (sort-by (fn [e] [(deliver-at e) (ordinal-of e)]) (get @(:session-queues queue) target)))

(defn event-ordinal "The queue ordinal of a pending event." [evt] (ordinal-of evt))

(defn- next-due-where
  [queue pred-target pred-event]
  (->> @(:session-queues queue)
    (mapcat (fn [[target q]]
              (when (pred-target target)
                (keep (fn [e] (when (pred-event e) [(deliver-at e) (ordinal-of e) target])) q))))
    (sort)
    (first)))

(defn take-due!
  "Remove and return the single earliest deliverable event (delivery-time <= now) across targets
   satisfying `pred` (and, when given, events satisfying `pred-event`), or nil. Taking one at a time
   keeps cross-session delivery in global `(time, ordinal)` order even when handling an event
   enqueues more."
  ([queue pred] (take-due! queue pred nil))
  ([queue pred pred-event]
  (let [now ((:clock queue))]
    (when-let [[tm ord target] (if pred-event (next-due-where queue pred pred-event) (next-due queue pred))]
      (when (<= tm now)
        (let [picked (volatile! nil)]
          (swap! (:session-queues queue) update target
            (fn [q]
              (let [[a b] (split-with #(not (and (= tm (deliver-at %)) (= ord (ordinal-of %)))) q)]
                (vreset! picked (first b))
                (into (vec a) (rest b)))))
          @picked))))))

(defn snapshot-session
  "Plain-data, EDN-serializable pending events for `target`: `[{:event … :delivery-time … :ordinal …}]`.
   Metadata is lifted into explicit keys (`pr` drops metadata)."
  [queue target]
  (mapv (fn [e] {:event (with-meta e nil) :delivery-time (deliver-at e) :ordinal (ordinal-of e)})
    (pending queue target)))

(defn restore-session!
  "Replace `target`'s pending events with `entries` (from `snapshot-session`), re-attaching metadata, and
   raise the ordinal counter to at least `ordinal` so later sends still sort after restored ones."
  [queue target entries ordinal]
  (swap! (:session-queues queue) assoc target
    (mapv (fn [{:keys [event delivery-time ordinal]}]
            (with-meta event {::delivery-time delivery-time ::ordinal (or ordinal 0)}))
      entries))
  (swap! (:next-ordinal queue) max (or ordinal 0) (reduce max 0 (map :ordinal entries)))
  queue)

(defn drop-session! [queue target] (swap! (:session-queues queue) dissoc target) nil)

(defn ordinal [queue] @(:next-ordinal queue))

(defn next-ordinal!
  "Take a fresh ordinal (unique per engine, persisted with every snapshot)."
  [queue]
  (swap! (:next-ordinal queue) inc))
