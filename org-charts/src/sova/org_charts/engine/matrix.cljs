(ns sova.org-charts.engine.matrix
  "The generic state × event × envelope matrix (design §10 bar M), for any registered chart.

   `run` explores the configurations a session reaches from each start by sending the `:drive`
   events (facts, link notifications, timer advances) and every act that is accepted under some
   envelope, then, for every reached state × act × envelope, SENDS the act on a checkpoint of the
   engine and asserts:
   - accepted (taken or held) ⇔ `explain` is nil;
   - a refused send answers exactly `explain`'s sentence;
   - every refusal sentence is in `:sentences` (when given; a set, or a fn [sentence] → bool).
   The engine is rewound from checkpoints (persistent data): no EDN round trip per cell."
  (:require
    [sova.org-charts.engine.core :as core]))

(def default-sid "matrix/session")
(def ^:dynamic sid default-sid)

(defn- fresh [charts opts start]
  (let [eng (core/new-engine charts (merge {:absorb-unknown true}
                                      (select-keys opts [:level-check :stamp :max-microsteps :load-cold :absorb-unknown])))]
    (core/start! eng sid (:chart opts) start (:now opts 1000000))
    eng))

(defn- state-key [eng key-fn]
  [(set (core/configuration eng sid)) (when key-fn (key-fn (core/data eng sid)))])

(defn- step-of [r event]
  (first (filter #(and (= sid (:session-id %)) (= event (:event %))) (:steps r))))

(defn- attempt
  "Send `[event payload]` under `envelope`: {:accepted? :refused :error}."
  [eng now [event payload] envelope]
  (try
    (let [r    (core/send! eng sid event (merge payload envelope) {:now now})
          step (step-of r event)]
      {:accepted? (boolean (and step (not (:refused step)) (not (:ignored step))))
       :refused   (:refused step)
       :ignored   (boolean (:ignored step))})
    (catch :default e {:error (ex-message e)})))

(defn- drive-one [eng now item]
  (let [[k x y] item]
    (try
      (if (= k :fire)
        (core/fire-due! eng (+ now x))
        (core/send! eng sid k (or x {}) {:now now}))
      true
      (catch :default _ false))))

(defn- sentence-ok? [sentences s]
  (cond (nil? sentences) true (set? sentences) (contains? sentences s) (fn? sentences) (boolean (sentences s)) :else true))

(defn run
  "opts: `:charts` (the registry map), `:chart` (name), `:starts` [start-data …], `:drive`
   [[event payload] | [:fire ms] …], `:acts` [[event payload] …], `:envelopes` {name envelope},
   `:sentences` (set or fn), `:level-check`, `:stamp`, `:key` (fn [data] → extra state key, default
   none: configurations only), `:max-configs` (default 5000), `:now`, `:sid` (the session under
   test's id, default \"matrix/session\"), `:load-cold` (fn [sid] → snapshot text | nil) and
   `:absorb-unknown` (default true: a session that exists nowhere is a sink that takes every event,
   so the chart's sends, watches and drives to its world never throw).
   Returns `{:configs n :cells n :accepted n :refused n :failures [{…}] :reached #{configuration}}`."
  [{:keys [charts starts drive acts envelopes sentences max-configs now] :as opts}]
  (binding [sid (or (:sid opts) default-sid)]
  (let [now      (or now 1000000)
        maxc     (or max-configs 5000)
        key-fn   (:key opts)
        failures (volatile! [])
        cells    (volatile! 0)
        acc      (volatile! 0)
        ref      (volatile! 0)
        reached  (volatile! #{})
        n        (volatile! 0)]
    (doseq [start (or (seq starts) [{}])]
      (let [eng  (fresh charts opts start)
            seen (volatile! #{})]
        (loop [frontier [(core/checkpoint eng)]]
          (when (and (seq frontier) (< @n maxc))
            (let [cp (first frontier)]
              (core/rewind! eng cp)
              (let [k (state-key eng key-fn)]
                (if (contains? @seen k)
                  (recur (subvec (vec frontier) 1))
                  (do
                    (vswap! seen conj k)
                    (vswap! n inc)
                    (vswap! reached conj (first k))
                    ;; the cells: every act × envelope, sent on this state
                    (let [nexts (volatile! [])]
                      (doseq [act acts
                              [ename envelope] envelopes]
                        (core/rewind! eng cp)
                        (let [[event payload] act
                              r   (core/explain eng sid event (merge payload envelope) {:now now})
                              out (attempt eng now act envelope)]
                          (vswap! cells inc)
                          (cond
                            (:error out)
                            (vswap! failures conj {:state (first k) :act event :envelope ename :why "the send threw" :error (:error out)})
                            (:accepted? out)
                            (do (vswap! acc inc)
                                (when r (vswap! failures conj {:state (first k) :act event :envelope ename
                                                               :why "taken, but explain refuses" :explain (:sentence r)}))
                                (vswap! nexts conj (core/checkpoint eng)))
                            :else
                            (do (vswap! ref inc)
                                (cond
                                  (nil? r)
                                  (vswap! failures conj {:state (first k) :act event :envelope ename
                                                         :why "refused, but explain is nil" :refused (:sentence (:refused out))})
                                  (and (:refused out) (not= (:sentence r) (:sentence (:refused out))))
                                  (vswap! failures conj {:state (first k) :act event :envelope ename
                                                         :why "the send's sentence differs from explain's"
                                                         :explain (:sentence r) :refused (:sentence (:refused out))})
                                  (not (sentence-ok? sentences (:sentence r)))
                                  (vswap! failures conj {:state (first k) :act event :envelope ename
                                                         :why "a sentence outside the catalogue" :explain (:sentence r)}))))))
                      (doseq [item drive]
                        (core/rewind! eng cp)
                        (when (drive-one eng now item)
                          (vswap! nexts conj (core/checkpoint eng))))
                      (recur (into (subvec (vec frontier) 1) @nexts))))))))))
      nil)
    {:configs @n :cells @cells :accepted @acc :refused @ref :failures @failures :reached @reached
     :truncated (>= @n maxc)})))

(defn clean?
  "True when the report has no failure and was not truncated."
  [report]
  (and (empty? (:failures report)) (not (:truncated report))))
