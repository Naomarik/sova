(ns sova.org-charts.engine.bounded
  "A step limit for the library's processor: one event (or a start) may take at most `limit`
   microsteps, and the next one throws a typed error instead of looping.

   The library's own guard only logs after 1,000 eventless iterations, and `before-event!` repeats
   that up to 1,000 times, so an eventless cycle in a chart (mutant M34: `landed` → merged →
   `running?` → working → `landed` …) blocks the caller for minutes. Under Guard that caller would
   be Sova's event loop.

   How it counts: every microstep executes one set of enabled transitions, which the algorithm first
   writes into the working memory's volatile (`::sc/enabled-transitions`). The processor below is the
   library's own (`v20150901`, same three methods), except that its working-memory volatile counts
   each newly selected, non-empty transition set. Nothing else in the algorithm changes."
  (:require
    [com.fulcrologic.statecharts :as sc]
    [com.fulcrologic.statecharts.algorithms.v20150901-impl :as impl]
    [com.fulcrologic.statecharts.protocols :as sp]))

(def default-max-microsteps
  "Far above any real step (the charts' longest fact cascade is a handful of microsteps) and far
   below the library's own guard."
  200)

(def error-type :sova/step-limit)

(defn step-limit-error?
  [e]
  (= error-type (:type (ex-data e))))

(deftype StepCounter [^:mutable state ^:mutable n limit trip]
  IDeref
  (-deref [_] state)
  IVolatile
  (-vreset! [_ v]
    (let [t (::sc/enabled-transitions v)]
      (when (and (seq t) (not (identical? t (::sc/enabled-transitions state))))
        (set! n (inc n))
        (when (> n limit) (trip n v))))
    (set! state v)
    v))

(defn- event-name [event] (if (map? event) (:name event) event))

(defn- id-str [k] (if (keyword? k) (subs (str k) 1) (str k)))

(defn- counted
  "`env` (a processing env) with its working-memory volatile replaced by a counting one."
  [env limit event]
  (let [trip (fn [n wm]
               (throw (ex-info (str "Step limit: session " (::sc/session-id wm) " took more than " limit
                                 " microsteps on " (id-str (event-name event))
                                 " (an eventless cycle in its chart?)")
                        {:type          error-type
                         :limit         limit
                         :microsteps    n
                         :session-id    (::sc/session-id wm)
                         :event         (event-name event)
                         :configuration (vec (sort (map id-str (::sc/configuration wm))))
                         :transitions   (vec (map id-str (::sc/enabled-transitions wm)))})))
        c    (->StepCounter @(::sc/vwmem env) 0 limit trip)]
    [(assoc env ::sc/vwmem c) c]))

(deftype BoundedProcessor [limit last]
  sp/Processor
  (start! [_ env statechart-src params]
    (let [[env c] (counted (impl/processing-env env statechart-src params) limit :sova/started)
          wm      (impl/initialize! env (assoc params ::sc/statechart-src statechart-src))]
      (reset! last (.-n ^StepCounter c))
      wm))
  (process-event! [_ env wmem event]
    (let [[env c] (counted (impl/processing-env env (::sc/statechart-src wmem) wmem) limit event)
          wm      (impl/process-event! env event)]
      (reset! last (.-n ^StepCounter c))
      wm))
  (exit! [_ env wmem skip-done-event?]
    (let [env (impl/processing-env env (::sc/statechart-src wmem) wmem)]
      (impl/exit-interpreter! env skip-done-event?)
      nil)))

(defn microsteps "Microsteps the last call on `processor` took." [processor] @(.-last ^BoundedProcessor processor))

(defn new-processor
  "The library's v20150901 processor with at most `limit` microsteps per event (default
   `default-max-microsteps`)."
  ([] (new-processor default-max-microsteps))
  ([limit] (->BoundedProcessor (or limit default-max-microsteps) (atom 0))))
