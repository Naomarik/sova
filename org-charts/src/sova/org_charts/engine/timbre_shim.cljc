(ns sova.org-charts.engine.timbre-shim
  "Stands in for `taoensso.timbre` in the shipped bundle (shadow `:ns-aliases`, the same way
   guardrails' malli namespaces are aliased to its no-op): timbre and the encore it drags in are
   ~33 KB of the release, and the statecharts library only calls its logging macros.

   What it keeps:
   - the macros the library uses (`trace` `debug` `info` `warn` `error` `fatal` `report`, their
     `…f` forms, `log` and `spy`). trace, debug and info are elided at compile time, as the release
     build already did (`-Dtaoensso.timbre.min-level.edn=:warn`); `spy` below warn is its value.
   - timbre's appender contract for what is left: `set-config!`, `merge-config!`, `set-min-level!`,
     and each enabled appender's `:fn` called with `{:level :vargs :?err :msg_}` (a first argument
     that is an error becomes `:?err`, as in timbre). The engine's capture of warnings and errors
     into each call's `errors` is such an appender.
   Nothing here prints: with no appender a warning goes nowhere."
  #?(:cljs (:require-macros [sova.org-charts.engine.timbre-shim]))
  (:require [clojure.string :as str]))

(def ^:private ranks {:trace 0 :debug 1 :info 2 :warn 3 :error 4 :fatal 5 :report 6})

(defn- rank [level] (get ranks level 3))

#?(:cljs
   (do
     (defonce ^:dynamic *config* {:min-level :warn :appenders {}})

     (defn set-config! [config] (set! *config* config) config)

     (defn merge-config! [config]
       (set-config! (merge-with (fn [a b] (if (and (map? a) (map? b)) (merge-with merge a b) b)) *config* config)))

     (defn set-min-level! [level] (set-config! (assoc *config* :min-level level)))

     (defn -log!
       "Hand one call to every enabled appender at or under `level`."
       [level args]
       (let [{:keys [min-level appenders]} *config*]
         (when (>= (rank level) (rank (or min-level :trace)))
           (let [[a0 & more] args
                 err?  (instance? js/Error a0)
                 vargs (vec (if err? more args))
                 data  {:level level :vargs vargs :?err (when err? a0)
                        :msg_  (delay (str/join " " (map #(if (nil? %) "nil" (str %)) vargs)))}]
             (doseq [[_ {:keys [enabled?] f :fn ap-min :min-level}] appenders
                     :when (and enabled? f (>= (rank level) (rank (or ap-min :trace))))]
               (f data)))))
       nil)))

#?(:clj
   (do
     (def ^:private elided #{:trace :debug :info})

     (defn- emit [level args]
       (when-not (elided level) `(-log! ~level [~@args])))

     (defmacro log [level & args] (emit level args))
     (defmacro trace [& args] (emit :trace args))
     (defmacro debug [& args] (emit :debug args))
     (defmacro info [& args] (emit :info args))
     (defmacro warn [& args] (emit :warn args))
     (defmacro error [& args] (emit :error args))
     (defmacro fatal [& args] (emit :fatal args))
     (defmacro report [& args] (emit :report args))
     (defmacro tracef [& args] (emit :trace args))
     (defmacro debugf [& args] (emit :debug args))
     (defmacro infof [& args] (emit :info args))
     ;; no format: the pattern and its arguments are logged as they are
     (defmacro warnf [& args] (emit :warn args))
     (defmacro errorf [& args] (emit :error args))

     (defmacro spy
       "(spy form), (spy level form), (spy level name form): the form's value, logged at or above warn."
       [& args]
       (let [[level nm form] (case (count args)
                               1 [:debug nil (first args)]
                               2 [(first args) nil (second args)]
                               [(first args) (second args) (last args)])]
         (if (elided level)
           form
           `(let [v# ~form] (-log! ~level [~@(when nm [nm]) v#]) v#))))))
