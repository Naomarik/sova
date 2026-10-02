(ns sova.statecharts.refit.asks-golden
  "r14 golden table (from asks-table, reviewed against r14's lists): every transition that sends the
   watch a reason → what it asks of the overseer. True: the reasons that ask something of it (a conflict
   to route, a resolved conflict, a gathering someone wrote in closed, drafted decisions the statechart won't
   promote itself, a review, a stall, its sessions' news); false: the statechart's own promotion; the named
   rules resolve at send time. A flip, or a new or removed reason-sending transition, fails asks-test;
   regenerate only with a reviewed change.")

(def golden
  {
   ["baton" ":baton" [":baton/propose"] "[]" 0] true
   ["baton" ":baton" [":hold/waiting"] "[]" 0] true
   ["baton" ":done" [":baton/close"] "[:closed]" 0] :unwritten-false
   ["baton" ":open" [":baton/close"] "[:closed]" 0] :unwritten-false
   ["baton" ":open" [":baton/goal-done"] "[:done]" 0] true
   ["baton" ":open" [":baton/hand-to"] "[:with-operator]" 0] true
   ["build" ":build" [":hold/waiting"] "[]" 0] true
   ["placement" ":placement" [":hold/waiting"] "[]" 0] true
   ["build" ":merging" [":effect/done"] "[:merge-idle]" 0] true
   ["build" ":merging" [":effect/failed"] "[:merge-idle]" 0] true
   ["build" ":setting-mode" [":effect/failed"] "[:ready]" 0] true
   ["build" ":working" [":turn/ended"] "[:turn-failed]" 0] true
   ["build" ":working" [":turn/ended"] "[:turn-idle]" 0] true
   ["conflict" ":routed-to-operator" [":conflict/settle"] "[:settled]" 0] true
   ["conflict" ":routed-to-person" [":conflict/settle"] "[:settled]" 0] true
   ["conflict" ":unrouted" [":conflict/settle"] "[:settled]" 0] true
   ["item" ":calm" [":item/stalled"] "[:stalled]" 0] true
   ["item" ":item" [":hold/waiting"] "[]" 0] true
   ["person" ":person" [":hold/waiting"] "[]" 0] true
   ["project" ":project" [":hold/waiting"] "[]" 0] true
   ["reconciler" ":reconciler" [":effect/done"] "[]" 0] false
   ["reconciler" ":reconciler" [":hold/waiting"] "[]" 0] true
   ["reconciler" ":running" [":reconcile/finished"] "[:failed]" 0] {"reconcile/conflict" true "reconcile/resolved" true "reconcile/drafted" :unless-auto-promoted}
   ["reconciler" ":running" [":reconcile/finished"] "[:idle]" 0] {"reconcile/conflict" true "reconcile/resolved" true "reconcile/drafted" :unless-auto-promoted}
   ["reconciler" ":running" [":reconcile/finished"] "[:running]" 0] {"reconcile/conflict" true "reconcile/resolved" true "reconcile/drafted" :unless-auto-promoted}
   ["runtime" ":awaiting-approval" [] "[:failed]" 0] true
   ["runtime" ":awaiting-approval" [] "[:registered]" 0] false
   ["runtime" ":awaiting-approval" [] "[:stale]" 0] true
   ["runtime" ":conforming" [] "[:failed]" 0] true
   ["runtime" ":conforming" [] "[:registered]" 0] false
   ["runtime" ":conforming" [] "[:stale]" 0] true
   ["runtime" ":failed" [] "[:registered]" 0] false
   ["runtime" ":failed" [] "[:stale]" 0] true
   ["runtime" ":proposed" [":link/moved"] "[:idle]" 0] {"runtime/playbook-done" :overseer-started}
   ["runtime" ":registered" [] "[:failed]" 0] true
   ["runtime" ":registered" [] "[:stale]" 0] true
   ["runtime" ":running" [":link/moved"] "[:idle]" 0] {"runtime/playbook-done" :overseer-started}
   ["runtime" ":running" [":link/moved"] "[:proposed]" 0] false
   ["runtime" ":stale" [] "[:failed]" 0] true
   ["runtime" ":stale" [] "[:registered]" 0] false
   ["runtime" ":unregistered" [] "[:failed]" 0] true
   ["runtime" ":unregistered" [] "[:registered]" 0] false
   ["runtime" ":unregistered" [] "[:stale]" 0] true})
