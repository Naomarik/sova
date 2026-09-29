(ns sova.org-charts.engine.no-spec
  "Stands in for `cljs.spec.alpha` in the shipped bundle (shadow `:ns-aliases`). The statecharts
   library's CLJS code uses spec only to register an `fdef` for its own `in-state-context` macro
   (v20150901-impl), which nothing checks at runtime: ~8 KB of spec for one registration. Every
   macro here expands to nothing; guardrails, the other spec user, is already aliased to its no-op."
  #?(:cljs (:require-macros [sova.org-charts.engine.no-spec])))

#?(:clj
   (defmacro fdef [& _] nil))
