(ns sova.org-charts.charts.registry
  "The refit's charts, as the engine registers them (engine/API.md §1): one entry per chart, with
   its version, storage, exported keys, act metadata (level, tool, people-/code-facing, what it
   counts, the checks run before the state), the refusal when an act has no transition here, and
   the log's privacy rules. `options` gives the engine the level check."
  (:require
    [sova.org-charts.charts.baton :as baton]
    [sova.org-charts.charts.build :as build]
    [sova.org-charts.charts.conflict :as conflict]
    [sova.org-charts.charts.decision :as decision]
    [sova.org-charts.charts.item :as item]
    [sova.org-charts.charts.reconciler :as reconciler]
    [sova.org-charts.charts.org :as org]
    [sova.org-charts.charts.person :as person]
    [sova.org-charts.charts.proj :as proj]
    [sova.org-charts.charts.residence :as residence]
    [sova.org-charts.charts.watch :as watch]
    [clojure.string :as str]
    [sova.org-charts.charts.base :as b]
    [sova.org-charts.charts.rules.levels :as lv]))

(defn card-what
  "What a people-facing act acts on, in the confirm refusal's words (overseer-org-tools requireConfirm)."
  [{:keys [people projects sessions]}]
  (str/join ", " (concat (for [p projects] (str "the project " p))
                         people
                         (for [s sessions] (str "the session " s)))))

(defn with-card-checks
  "Every people-facing act the global Overseer may make (`:card` in its metadata) runs only in the
   turn its confirm card started, listing every target: a check before the state (the GO tool layer
   checks it first; this is the chart's backstop, §app.overseer/org-people-facing)."
  [entry]
  (update entry :acts
    (fn [acts]
      (into {} (for [[ev m] acts]
                 [ev (if-let [card-fn (:card m)]
                       (update m :pre #(into [(lv/card-check b/evt card-fn (fn [d] (card-what (card-fn d))))] %))
                       m)])))))

(def charts*
  {"org"       org/entry
   "residence" residence/entry
   "person"    person/entry
   "project"   proj/entry
   "watch"     watch/entry
   "baton"      baton/entry
   "decision"   decision/entry
   "conflict"   conflict/entry
   "reconciler" reconciler/entry
   "item"       item/entry
   "build"      build/entry})

(def charts (into {} (for [[k v] charts*] [k (with-card-checks v)])))

(def options
  {:level-check lv/level-check})
