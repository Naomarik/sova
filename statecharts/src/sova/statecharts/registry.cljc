(ns sova.statecharts.registry
  "The refit's statecharts, as the engine registers them (engine/API.md §1): one entry per statechart, with
   its version, storage, exported keys, act metadata (level, tool, people-/code-facing, what it
   counts, the checks run before the state), the refusal when an act has no transition here, and
   the log's privacy rules. `options` gives the engine the level check."
  (:require
    [sova.statecharts.baton :as baton]
    [sova.statecharts.build :as build]
    [sova.statecharts.conflict :as conflict]
    [sova.statecharts.decision :as decision]
    [sova.statecharts.item :as item]
    [sova.statecharts.reconciler :as reconciler]
    [sova.statecharts.org :as org]
    [sova.statecharts.person :as person]
    [sova.statecharts.placement :as placement]
    [sova.statecharts.proj :as proj]
    [sova.statecharts.residence :as residence]
    [sova.statecharts.watch :as watch]
    [clojure.string :as str]
    [sova.statecharts.base :as b]
    [sova.statecharts.rules.levels :as lv]))

(defn card-what
  "What a people-facing act acts on, in the confirm refusal's words (overseer-org-tools requireConfirm)."
  [{:keys [people projects sessions]}]
  (str/join ", " (concat (for [p projects] (str "the project " p))
                         people
                         (for [s sessions] (str "the session " s)))))

(defn with-card-checks
  "Every people-facing act the global Overseer may make (`:card` in its metadata) runs only in the
   turn its confirm card started, listing every target: a check before the state (the GO tool layer
   checks it first; this is the statechart's backstop, §app.overseer/org-people-facing)."
  [entry]
  (update entry :acts
    (fn [acts]
      (into {} (for [[ev m] acts]
                 [ev (if-let [card-fn (:card m)]
                       (update m :pre #(into [(lv/card-check b/evt card-fn (fn [d] (card-what (card-fn d))))] %))
                       m)])))))

(def statecharts*
  {"org"       org/entry
   "residence" residence/entry
   "person"    person/entry
   "project"   proj/entry
   "placement" placement/entry
   "watch"     watch/entry
   "baton"      baton/entry
   "decision"   decision/entry
   "conflict"   conflict/entry
   "reconciler" reconciler/entry
   "item"       item/entry
   "build"      build/entry})

(def statecharts (into {} (for [[k v] statecharts*] [k (with-card-checks v)])))

(def options
  {:level-check lv/level-check})
