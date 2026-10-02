(ns sova.statecharts.refit.seam-test
  "The seam between the project layer and the org layer (General Projects): the project-layer statecharts
   (project, watch, build, runtime) and everything they require, transitively, never reach an org-layer
   statechart, never build an org-layer session id and never read an org key. The org layer may address
   the project layer; the project layer never addresses the org layer. (The TS side has its own
   dependency-graph test.)"
  (:require
    [cljs.test :refer [deftest is testing]]
    [clojure.string :as str]
    [sova.statecharts.registry :as registry]))

(def project-layer
  "The project-layer statecharts: registry name → namespace."
  {"project" "sova.statecharts.proj" "watch" "sova.statecharts.watch" "build" "sova.statecharts.build"
   "runtime" "sova.statecharts.runtime"})

(def org-layer-ns
  "Namespaces of the org layer: its statecharts and the rules only they use."
  #{"sova.statecharts.org" "sova.statecharts.residence" "sova.statecharts.person" "sova.statecharts.placement"
    "sova.statecharts.baton" "sova.statecharts.item" "sova.statecharts.decision" "sova.statecharts.conflict"
    "sova.statecharts.reconciler" "sova.statecharts.rules.person" "sova.statecharts.rules.baton"
    "sova.statecharts.rules.item" "sova.statecharts.rules.reach"})

(def org-sid-builders
  #"\b(?:b|base)/(?:org|residence|person|placement|baton|item|decision|conflict|reconciler)-sid\b")

(def org-keys
  "Keys only the org layer holds: never read (or written) by a project-layer statechart."
  #":(?:org-id|stakeholder|stakeholder-cleared|stakeholder-history|owner-hidden|last-post-at|milestone|owner-active)\b")

(def fs (js/require "fs"))
(def path (js/require "path"))

(defn- src-root []
  (let [cands [(.resolve path (.cwd js/process) "src") (.resolve path js/__dirname "../../src")]]
    (or (first (filter #(.existsSync fs (.join path % "sova" "statecharts" "registry.cljc")) cands))
        (throw (ex-info "statecharts/src not found" {:tried cands})))))

(defn- file-of [ns-name]
  (let [base (.join path (src-root) (str/replace (str/replace ns-name "." "/") "-" "_"))]
    (first (filter #(.existsSync fs %) [(str base ".cljc") (str base ".cljs")]))))

(defn- source [ns-name] (some-> (file-of ns-name) (#(.readFileSync fs % "utf8"))))

(defn- ns-form
  "The text of the file's `(ns …)` form (up to its balanced close)."
  [text]
  (let [start (str/index-of text "(ns ")]
    (loop [i start depth 0 in-str false esc false]
      (let [c (.charAt text i)]
        (cond
          (>= i (count text)) (subs text start)
          esc (recur (inc i) depth in-str false)
          (and in-str (= c "\\")) (recur (inc i) depth in-str true)
          (= c "\"") (recur (inc i) depth (not in-str) false)
          in-str (recur (inc i) depth in-str false)
          (= c "(") (recur (inc i) (inc depth) in-str false)
          (= c ")") (if (= 1 depth) (subs text start (inc i)) (recur (inc i) (dec depth) in-str false))
          :else (recur (inc i) depth in-str false))))))

(defn- requires
  "The sova.statecharts namespaces `ns-name` requires (its own sources only)."
  [ns-name]
  (some->> (source ns-name) ns-form (re-seq #"\[(sova\.statecharts\.[\w.\-]+)") (map second) set))

(defn- reach
  "Every sova.statecharts namespace `ns-name` reaches through its requires, with the path to it."
  [ns-name]
  (loop [todo [[ns-name [ns-name]]] seen {}]
    (if-let [[n p] (first todo)]
      (if (contains? seen n)
        (recur (rest todo) seen)
        (recur (concat (rest todo) (for [r (requires n)] [r (conj p r)])) (assoc seen n p)))
      seen)))

(deftest the-sources-are-found
  (doseq [[_ n] project-layer] (is (some? (source n)) n))
  (is (contains? (requires "sova.statecharts.proj") "sova.statecharts.base") "requires are read"))

(deftest no-project-layer-statechart-reaches-the-org-layer
  (doseq [[nm n] project-layer
          [reached p] (reach n)]
    (is (not (contains? org-layer-ns reached)) (str nm " reaches " reached " via " (str/join " → " p)))))

(deftest no-project-layer-statechart-builds-an-org-sid-or-reads-an-org-key
  (doseq [[nm n] project-layer
          :let [text (source n)]]
    (is (empty? (re-seq org-sid-builders text)) (str nm ": " (pr-str (re-seq org-sid-builders text))))
    (is (empty? (re-seq org-keys text)) (str nm ": " (pr-str (re-seq org-keys text))))))

(deftest the-project-layers-interface-names-no-org
  (doseq [[nm _] project-layer
          :let [{:keys [exported acts]} (get registry/statecharts nm)]]
    (is (empty? (filter #(re-matches org-keys (str %)) exported)) (str nm " exports " (pr-str exported)))
    (is (not-any? #{:stakeholder/set :owner-update/post :outreach/send :baton/start :gap/file :spec/freeze :milestone/noted :placement/edit}
          (keys acts))
        (str nm " acts"))))

(deftest the-seam-test-sees-a-crossing
  ;; the checks themselves: a crossing in a project-layer source is caught
  (is (seq (re-seq org-sid-builders "(b/placement-sid (:org-id d) p)")))
  (is (seq (re-seq org-keys "(:org-id d)")))
  (is (contains? (set (keys (reach "sova.statecharts.registry"))) "sova.statecharts.placement") "the walk follows requires"))
