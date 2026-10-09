#!/usr/bin/env bb
;; .sova/bin/test for a Clojure project with a warm test nREPL (references/recipes.md).
;; Sova runs it as `<this> <selector>...` in the instance's checkout: a selector is a namespace
;; (`app.core-test`) or a var (`app.core-test/adds`); none runs every test namespace under the
;; test dirs (tools.namespace finds them). It reloads those test namespaces, runs
;; clojure.test in the instance's own test nREPL, prints the run's output, and writes the counts
;; to $SOVA_OUT: `passed` counts tests, `failed` and `errors` clojure.test's failed and errored
;; assertions. Exit 0 only when at least one test ran and nothing failed.
;;
;; Copy templates/bb.edn beside it: bb then ignores the project's bb.edn, whose :deps it would
;; otherwise resolve under ~/.deps.clj and ~/.clojure.
;; Adapt: PORT_ENV (the test REPL service's SOVA_PORT_<SERVICE>_<PORT>) and TEST_DIRS.
(require '[bencode.core :as b] '[cheshire.core :as json] '[clojure.string :as str])
(import '[java.net Socket])

(def PORT_ENV "SOVA_PORT_TEST_REPL_NREPL")
(def TEST_DIRS ["test/clj"])

(def port (some-> (System/getenv PORT_ENV) parse-long))
(when-not port
  (binding [*out* *err*] (println (str PORT_ENV " is not set: is the test REPL service in test.requires?")))
  (System/exit 2))

(def selectors *command-line-args*)
;; The form the REPL evaluates: plain text, so the project's REPL needs nothing but clojure.test
;; and tools.namespace (to find test namespaces when no selector is given).
(def form
  (str
   "(do (require 'clojure.test 'clojure.java.io 'clojure.string)"
   " (let [sels " (pr-str (vec selectors))
   "       dirs " (pr-str TEST_DIRS)
   "       nses (if (seq sels)"
   "              (distinct (map (fn [s] (symbol (first (clojure.string/split s #\"/\")))) sels))"
   "              (mapcat (fn [d] ((requiring-resolve 'clojure.tools.namespace.find/find-namespaces-in-dir) (clojure.java.io/file d))) dirs))"
   "       vars (keep (fn [s] (when (clojure.string/includes? s \"/\") (symbol s))) sels)]"
   ;; :reload the test namespaces only: :reload-all would reload libraries too (core.async's
   ;; protocols break). Source edits reach the REPL when apply restarts it (reload "restart").
   "   (doseq [n nses] (require n :reload))"
   "   (if (seq vars)"
   "     (binding [clojure.test/*report-counters* (ref clojure.test/*initial-report-counters*)]"
   "       (clojure.test/test-vars (map resolve vars))"
   "       (select-keys @clojure.test/*report-counters* [:test :pass :fail :error]))"
   "     (select-keys (apply clojure.test/run-tests nses) [:test :pass :fail :error]))))"))

(defn bytes->str [x] (if (bytes? x) (String. ^bytes x "UTF-8") x))

(defn eval! [code]
  (with-open [s (Socket. "127.0.0.1" (int port))]
    (let [out (.getOutputStream s)
          in (java.io.PushbackInputStream. (.getInputStream s))]
      (b/write-bencode out {"op" "eval" "code" code "id" "sova-test"})
      (loop [acc {:out "" :value nil :ex nil}]
        (let [msg (update-vals (b/read-bencode in) (fn [v] (if (sequential? v) (mapv bytes->str v) (bytes->str v))))
              acc (cond-> acc
                    (msg "out") (update :out str (msg "out"))
                    (msg "err") (update :out str (msg "err"))
                    (msg "value") (assoc :value (msg "value"))
                    (msg "ex") (assoc :ex (msg "ex")))]
          (if (some #{"done"} (msg "status")) acc (recur acc)))))))

(def r (eval! form))
(print (:out r))
(flush)
(def summary (when (and (:value r) (not (:ex r))) (read-string (:value r))))
(def failures
  (->> (re-seq #"(?m)^(FAIL|ERROR) in \(([^)]+)\) \(([^:)]+):(\d+)\)" (:out r))
       (map (fn [[_ _ nm file line]] {:name nm :file file :line (parse-long line)}))
       (take 50)
       vec))
(def ran (or (:test summary) 0))
(def failing (count (distinct (map :name failures))))
(def ok? (and summary (pos? ran) (zero? (:fail summary)) (zero? (:error summary))))
(when-let [f (System/getenv "SOVA_OUT")]
  (spit f (json/generate-string
           (cond
             (nil? summary) {:passed 0 :failed 0 :errors 1 :failures [{:name "test run" :message (str (:ex r) " " (subs (:out r) 0 (min 2000 (count (:out r)))))}]}
             ;; A selection that runs no test proves nothing: it is an error, never a pass.
             (zero? ran) {:passed 0 :failed 0 :errors 1 :failures [{:name "test run" :message "no tests ran"}]}
             :else {:passed (max 0 (- ran failing)) :failed (:fail summary) :errors (:error summary) :failures failures}))))
(System/exit (if ok? 0 1))
