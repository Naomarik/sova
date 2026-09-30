(ns sova.statecharts.engine.matrix
  "The generic state × event × envelope matrix (design §10 bar M), for any registered statechart.

   An act's or drive event's payload may be a fn of the session's data at the checkpoint (fresh ids
   per state). `run` explores the configurations a session reaches from each start by sending the `:drive`
   events (facts, link notifications, timer advances) and every act that is accepted under some
   envelope, then, for every reached state × act × envelope, SENDS the act on a checkpoint of the
   engine and asserts:
   - accepted (taken or held) ⇔ `explain` is nil;
   - a refused send answers exactly `explain`'s sentence;
   - every refusal sentence is in `:sentences` (when given; a set, or a fn [sentence] → bool).
   The engine is rewound from checkpoints (persistent data): no EDN round trip per cell."
  (:require
    [sova.statecharts.engine.core :as core]))

(def default-sid "matrix/session")
(def ^:dynamic sid default-sid)

(defn- fresh [statecharts opts start]
  (let [eng (core/new-engine statecharts (merge {:absorb-unknown true}
                                      (select-keys opts [:level-check :stamp :max-microsteps :load-cold :absorb-unknown])))
        r   (core/start! eng sid (:statechart opts) start (:now opts 1000000))]
    [eng (:absorbed r)]))

(defn- state-key [eng key-fn]
  [(set (core/configuration eng sid)) (when key-fn (key-fn (core/data eng sid)))])

(defn- step-of [r event]
  (first (filter #(and (= sid (:session-id %)) (= event (:event %))) (:steps r))))

(defn- attempt
  "Send `[event payload]` under `envelope`: {:accepted? :refused :absorbed :error}."
  [eng now [event payload] envelope]
  (try
    (let [r    (core/send! eng sid event (merge payload envelope) {:now now})
          step (step-of r event)]
      {:accepted? (boolean (and step (not (:refused step)) (not (:ignored step))))
       :refused   (:refused step)
       :absorbed  (:absorbed r)})
    (catch :default e {:error (ex-message e)})))

(defn- drive-one
  "Deliver a drive item: {:absorbed [...]} or {:error message}."
  [eng now item]
  (let [[k x] item]
    (try
      (let [x (if (fn? x) (x (core/data eng sid)) x)
            r (if (= k :fire)
                (core/fire-due! eng (+ now x))
                (core/send! eng sid k (or x {}) {:now now}))]
        {:absorbed (:absorbed r)})
      (catch :default e {:error (ex-message e)}))))

(defn- sentence-ok? [sentences s]
  (cond (nil? sentences) true (set? sentences) (contains? sentences s) (fn? sentences) (boolean (sentences s)) :else true))

(defn- in-world? [world s]
  (cond (nil? world) false (set? world) (contains? world s) (fn? world) (boolean (world s)) :else false))

(defn shadowed
  "The payload keys the envelope also carries with another value (sorted): the host refuses such an
   act as a caller's bug (OrgPayloadError), since merged the envelope's value would hide the payload's."
  [payload envelope]
  (vec (sort (filter (fn [k] (and (some? (get payload k)) (some? (get envelope k)) (not= (get payload k) (get envelope k))))
               (keys payload)))))

(defn run
  "opts: `:statecharts` (the registry map), `:statechart` (name), `:starts` [start-data …], `:drive`
   [[event payload] | [:fire ms] …], `:acts` [[event payload] …], `:envelopes` {name envelope},
   `:sentences` (set or fn), `:level-check`, `:stamp`, `:key` (fn [data] → extra state key, default
   none: configurations only), `:max-configs` (default 5000), `:now`, `:sid` (the session under
   test's id, default \"matrix/session\"), `:load-cold` (fn [sid] → snapshot text | nil).
   A payload or an envelope may be a fn of the session's data at the checkpoint (fresh ids, a real
   stamp's counts).

   The world: a session the statechart sends to, watches, spawns next to or drives that exists nowhere
   becomes a sink (`:absorb-unknown`, default true), where production throws
   `sova/unknown-session`. So every absorbed id must be named in `:world` (a set or a pred): an
   absorbed id outside it is a failure. `:absorbed` in the report lists them all.

   Failures: an act payload key the envelope carries with another value (the host throws on it), an
   act send that throws, an explain that throws, a drive that throws, taken while
   explain refuses, refused while explain is nil, a different sentence, a sentence outside the
   catalogue, an absorbed session outside the world.
   Returns `{:configs :cells :accepted :refused :failures [{…}] :reached #{configuration}
   :absorbed #{sid} :truncated}`."
  [{:keys [statecharts starts drive acts envelopes sentences max-configs now world] :as opts}]
  (binding [sid (or (:sid opts) default-sid)]
  (let [now      (or now 1000000)
        maxc     (or max-configs 5000)
        key-fn   (:key opts)
        failures (volatile! [])
        cells    (volatile! 0)
        acc      (volatile! 0)
        ref      (volatile! 0)
        reached  (volatile! #{})
        absorbed (volatile! #{})
        n        (volatile! 0)
        absorb!  (fn [ids where]
                   (doseq [a ids]
                     (vswap! absorbed conj a)
                     (when-not (in-world? world a)
                       (vswap! failures conj (merge where {:why "sent to a session outside the world" :session a})))))]
    (doseq [start (or (seq starts) [{}])]
      (let [[eng started] (fresh statecharts opts start)
            seen (volatile! #{})]
        (absorb! started {:start start})
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
                    (let [nexts (volatile! [])]
                      ;; the cells: every act × envelope, sent on this state
                      (doseq [act acts
                              [ename env] envelopes]
                        (core/rewind! eng cp)
                        (vswap! cells inc)
                        (let [[event p] act
                              at      {:state (first k) :act event :envelope ename}
                              data    (core/data eng sid)
                              payload (if (fn? p) (p data) p)
                              envelope (if (fn? env) (env data) env)
                              shadow  (shadowed payload envelope)
                              ex      (when-not (seq shadow)
                                        (try {:r (core/explain eng sid event (merge payload envelope) {:now now})}
                                          (catch :default e {:error (ex-message e)})))]
                          (cond
                            ;; the host throws on it (OrgPayloadError): the payload's value would be lost
                            (seq shadow)
                            (vswap! failures conj (assoc at :why "a payload key shadows the envelope's" :keys shadow))
                            (:error ex)
                            (vswap! failures conj (assoc at :why "explain threw" :error (:error ex)))
                            :else
                            (let [r   (:r ex)
                                  out (attempt eng now [event payload] envelope)]
                              (absorb! (:absorbed out) at)
                              (cond
                                (:error out)
                                (vswap! failures conj (assoc at :why "the send threw" :error (:error out)))
                                (:accepted? out)
                                (do (vswap! acc inc)
                                    (when r (vswap! failures conj (assoc at :why "taken, but explain refuses" :explain (:sentence r))))
                                    (vswap! nexts conj (core/checkpoint eng)))
                                :else
                                (do (vswap! ref inc)
                                    (cond
                                      (nil? r)
                                      (vswap! failures conj (assoc at :why "refused, but explain is nil" :refused (:sentence (:refused out))))
                                      (and (:refused out) (not= (:sentence r) (:sentence (:refused out))))
                                      (vswap! failures conj (assoc at :why "the send's sentence differs from explain's"
                                                              :explain (:sentence r) :refused (:sentence (:refused out))))
                                      (not (sentence-ok? sentences (:sentence r)))
                                      (vswap! failures conj (assoc at :why "a sentence outside the catalogue" :explain (:sentence r))))))))))
                      ;; the drives: facts, notifications, timers
                      (doseq [item drive]
                        (core/rewind! eng cp)
                        (let [out (drive-one eng now item)
                              at  {:state (first k) :drive (first item)}]
                          (if (:error out)
                            (vswap! failures conj (assoc at :why "a drive threw" :error (:error out)))
                            (do (absorb! (:absorbed out) at)
                                (vswap! nexts conj (core/checkpoint eng))))))
                      (recur (into (subvec (vec frontier) 1) @nexts))))))))))
      nil)
    {:configs @n :cells @cells :accepted @acc :refused @ref :failures @failures :reached @reached
     :absorbed @absorbed :truncated (>= @n maxc)})))

(defn clean?
  "True when the report has no failure and was not truncated."
  [report]
  (and (empty? (:failures report)) (not (:truncated report))))
