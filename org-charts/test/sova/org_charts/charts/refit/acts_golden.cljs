(ns sova.org-charts.charts.refit.acts-golden
  "Golden act metadata (generated from acts-table; reviewed against q10/r4/r6 holds, today's levels and
   tools, F2 counts, F-185 cards, r7 hours, r8 kinds): a flipped hold, level, count, tool, facing, card,
   hours or kind fails registry-test. Regenerate only with a reviewed change.")

(def golden
  {
   ["baton" ":baton/abilities"] {}
   ["baton" ":baton/close"] {:card? true, :confirm? true, :hold true, :needs "L1", :people-facing true, :tool "sova_close_gathering", :what? true}
   ["baton" ":baton/extend"] {}
   ["project" ":outreach/send"] {:card? true, :confirm? true, :hold true, :hours? true, :needs "L1", :people-facing true, :tool "sova_send_to_person", :what? true}
   ["baton" ":baton/goal-done"] {}
   ["baton" ":baton/hand-to"] {:hours? true}
   ["baton" ":baton/handoff"] {:card? true, :hours? true, :people-facing true}
   ["baton" ":baton/hide"] {}
   ["baton" ":baton/message"] {}
   ["baton" ":baton/offer"] {:card? true, :confirm? true, :hours? true, :people-facing true}
   ["baton" ":baton/propose"] {}
   ["baton" ":baton/record-decision"] {}
   ["baton" ":baton/take-back"] {:card? true, :people-facing true}
   ["baton" ":baton/withdraw"] {}
   ["baton" ":baton/wrapup-retry"] {}
   ["baton" ":hold/approve"] {:correction true, :needs "L0"}
   ["baton" ":hold/cancel"] {:correction true, :needs "L0"}
   ["build" ":build/merge"] {}
   ["build" ":build/prompt"] {:code-facing true, :confirm? true, :counts "prompt", :hold true, :needs "L3", :tool "sova_send", :what? true}
   ["build" ":build/remove-worktree"] {}
   ["build" ":correct/merged"] {:correction true, :needs "L2", :tool "sova_correct"}
   ["build" ":hold/approve"] {:correction true, :needs "L0"}
   ["build" ":hold/cancel"] {:correction true, :needs "L0"}
   ["conflict" ":conflict/reroute"] {:card? true, :hours? true, :people-facing true}
   ["conflict" ":conflict/settle"] {}
   ["conflict" ":hold/cancel"] {:correction true, :needs "L0"}
   ["decision" ":decision/owner-area"] {}
   ["decision" ":decision/settle-text"] {}
   ["decision" ":hold/cancel"] {:correction true, :needs "L0"}
   ["item" ":build/start"] {:code-facing true, :confirm? true, :counts "create", :hold true, :needs "L3", :tool "sova_create_session", :what? true}
   ["item" ":correct/relink"] {:correction true, :needs "L1", :tool "sova_correct"}
   ["item" ":correct/reopen"] {:correction true, :needs "L1", :tool "sova_correct"}
   ["item" ":correct/skip-stall"] {:correction true, :needs "L1", :tool "sova_correct"}
   ["item" ":gap/drop"] {:needs "L0", :tool "sova_idea"}
   ["item" ":gather/plan"] {:needs "L0", :tool "sova_start_gathering"}
   ["item" ":gather/start"] {:card? true, :confirm? true, :counts "gather", :hold true, :hours? true, :needs "L1", :people-facing true, :tool "sova_start_gathering", :what? true}
   ["item" ":hold/approve"] {:correction true, :needs "L0"}
   ["item" ":hold/cancel"] {:correction true, :needs "L0"}
   ["item" ":item/hold"] {}
   ["item" ":item/resume"] {}
   ["org" ":hold/cancel"] {:correction true, :needs "L0"}
   ["org" ":org/hours"] {}
   ["org" ":org/rename"] {}
   ["org" ":owner/set"] {}
   ["org" ":person/add"] {}
   ["org" ":project/add"] {}
   ["person" ":hold/approve"] {:correction true, :needs "L0"}
   ["person" ":hold/cancel"] {:correction true, :needs "L0"}
   ["person" ":person/approve"] {:confirm? true, :hold true, :needs "L2", :people-facing true, :tool "sova_roster", :what? true}
   ["person" ":person/decline"] {:confirm? true, :hold true, :needs "L2", :people-facing true, :tool "sova_roster", :what? true}
   ["person" ":person/edit"] {}
   ["person" ":person/leave"] {:card? true, :people-facing true}
   ["person" ":person/revert"] {:card? true, :people-facing true}
   ["project" ":baton/start"] {:card? true, :confirm? true, :counts "gather", :hold true, :hours? true, :needs "L1", :people-facing true, :tool "sova_start_gathering", :what? true}
   ["project" ":build/start"] {:code-facing true, :confirm? true, :counts "create", :hold true, :needs "L3", :tool "sova_create_session", :what? true}
   ["project" ":gap/file"] {:needs "L0", :tool "sova_idea"}
   ["project" ":hold/approve"] {:correction true, :needs "L0"}
   ["project" ":hold/cancel"] {:correction true, :needs "L0"}
   ["project" ":overseer/clear"] {:card? true, :people-facing true}
   ["project" ":overseer/start"] {}
   ["project" ":owner-update/post"] {:confirm? true, :hold true, :needs "L1", :people-facing true, :tool "sova_owner_update", :what? true}
   ["project" ":preview/start"] {:confirm? true, :hold true, :needs "L1", :people-facing true, :tool "sova_preview", :what? true}
   ["project" ":project/archive"] {:card? true, :people-facing true}
   ["project" ":project/edit"] {}
   ["project" ":project/unarchive"] {}
   ["project" ":session/prompt"] {:code-facing true, :confirm? true, :counts "prompt", :hold true, :needs "L3", :tool "sova_send", :what? true}
   ["project" ":spec/freeze"] {}
   ["project" ":stakeholder/set"] {}
   ["reconciler" ":correct/clear-failed"] {:correction true, :needs "L1", :tool "sova_correct"}
   ["reconciler" ":decision/promote"] {:code-facing true, :confirm? true, :counts "promote", :hold true, :needs "L2", :tool "sova_promote", :what? true}
   ["reconciler" ":draft/rewrite"] {}
   ["reconciler" ":hold/approve"] {:correction true, :needs "L0"}
   ["reconciler" ":hold/cancel"] {:correction true, :needs "L0"}
   ["reconciler" ":reconcile/request"] {:needs "L1", :tool "sova_reconcile"}
   ["residence" ":attach/confirm"] {}
   ["residence" ":commit/now"] {}
   ["residence" ":org/detach"] {}
   ["watch" ":operator/level-set"] {}
   ["watch" ":operator/run-now"] {}})
