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
    [sova.org-charts.charts.rules.levels :as lv]))

(def charts
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

(def options
  {:level-check lv/level-check})
