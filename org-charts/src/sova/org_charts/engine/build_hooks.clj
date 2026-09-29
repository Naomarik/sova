(ns sova.org-charts.engine.build-hooks
  "shadow-cljs build hooks for a byte-reproducible release bundle.

   The reader names `#(…)` arguments with Clojure's JVM-global id counter (`p1__<n>#`), and
   cljs.spec.alpha (loaded by statecharts) interns such forms as constants. Whatever ran in the JVM
   before compilation moves that counter, the names change, and the constants' order shifts Closure's
   renaming throughout the bundle. Resetting the counter just before a sequential compile makes the
   output depend only on the sources.")

(defn fixed-gensym-counter
  {:shadow.build/stage :compile-prepare}
  [build-state]
  (let [f (.getDeclaredField clojure.lang.RT "id")]
    (.setAccessible f true)
    (.set ^java.util.concurrent.atomic.AtomicInteger (.get f nil) 1000000))
  build-state)
