(ns sova.statecharts.refit.acts-golden
  "Golden act metadata (generated from acts-table; reviewed against q10/r4/r6 holds, al_3's powers and
   tools, F2 counts, F-185 cards, r7 hours): a flipped hold, power, count, tool, facing, card or hours
   fails registry-test. Regenerate only with a reviewed change.")

(def golden
  {
   ["project" ":deploy/run"] {:code-facing true, :hold true, :power "deploy", :tool "sova_project_verbs", :what? true}
   ["project" ":services/reset"] {:power "copiesReset", :tool "sova_project_verbs"}
   ["watch" ":operator/powers-set"] {}
   ["baton" ":baton/abilities"] {}
   ["baton" ":baton/close"] {:card? true, :hold true, :people-facing true, :power "gather", :tool "sova_close_gathering", :what? true}
   ["baton" ":baton/extend"] {}
   ["placement" ":outreach/send"] {:card? true, :hold true, :hours? true, :people-facing true, :power "whatsapp", :tool "sova_send_to_person", :what? true}
   ["baton" ":baton/goal-done"] {}
   ["baton" ":baton/hand-to"] {:hours? true}
   ["baton" ":baton/handoff"] {:card? true, :hours? true, :people-facing true}
   ["baton" ":baton/hide"] {}
   ["baton" ":baton/message"] {}
   ["baton" ":baton/offer"] {:card? true, :hours? true, :people-facing true}
   ["baton" ":baton/propose"] {}
   ["baton" ":baton/record-decision"] {}
   ["baton" ":baton/take-back"] {:card? true, :people-facing true}
   ["baton" ":baton/withdraw"] {}
   ["baton" ":baton/wrapup-retry"] {}
   ["baton" ":hold/cancel"] {:correction true, :power "always"}
   ["build" ":build/merge"] {}
   ["build" ":build/prompt"] {:code-facing true, :counts "prompt", :hold true, :power "codingPrompt", :tool "sova_send", :what? true}
   ["build" ":build/remove-worktree"] {}
   ["build" ":correct/merged"] {:correction true, :power "markMerged", :tool "sova_correct"}
   ["build" ":hold/cancel"] {:correction true, :power "always"}
   ["conflict" ":conflict/reroute"] {:card? true, :hours? true, :people-facing true}
   ["conflict" ":conflict/settle"] {}
   ["conflict" ":hold/cancel"] {:correction true, :power "always"}
   ["decision" ":decision/owner-area"] {}
   ["decision" ":decision/settle-text"] {}
   ["decision" ":hold/cancel"] {:correction true, :power "always"}
   ["item" ":build/start"] {:code-facing true, :counts "create", :hold true, :power "codingStart", :tool "sova_create_session", :what? true}
   ["item" ":correct/relink"] {:correction true, :power "bookkeeping", :tool "sova_correct"}
   ["item" ":correct/reopen"] {:correction true, :power "bookkeeping", :tool "sova_correct"}
   ["item" ":correct/skip-stall"] {:correction true, :power "bookkeeping", :tool "sova_correct"}
   ["item" ":gap/drop"] {:power "always", :tool "sova_idea"}
   ["item" ":gather/plan"] {:power "always", :tool "sova_start_gathering"}
   ["item" ":gather/start"] {:card? true, :counts "gather", :hold true, :hours? true, :people-facing true, :power "gather", :tool "sova_start_gathering", :what? true}
   ["item" ":hold/cancel"] {:correction true, :power "always"}
   ["item" ":item/hold"] {}
   ["item" ":item/resume"] {}
   ["org" ":hold/cancel"] {:correction true, :power "always"}
   ["org" ":org/hours"] {}
   ["org" ":org/rename"] {}
   ["org" ":owner/set"] {}
   ["org" ":person/add"] {}
   ["org" ":project/place"] {}
   ["person" ":hold/cancel"] {:correction true, :power "always"}
   ["person" ":person/approve"] {:hold true, :people-facing true, :power "roster", :tool "sova_roster", :what? true}
   ["person" ":person/decline"] {:hold true, :people-facing true, :power "roster", :tool "sova_roster", :what? true}
   ["person" ":person/edit"] {}
   ["person" ":person/leave"] {:card? true, :people-facing true}
   ["person" ":person/revert"] {:card? true, :people-facing true}
   ["placement" ":baton/start"] {:card? true, :counts "gather", :hold true, :hours? true, :people-facing true, :power "gather", :tool "sova_start_gathering", :what? true}
   ["project" ":build/start"] {:code-facing true, :counts "create", :hold true, :power "codingStart", :tool "sova_create_session", :what? true}
   ["placement" ":gap/file"] {:power "always", :tool "sova_idea"}
   ["placement" ":hold/cancel"] {:correction true, :power "always"}
   ["placement" ":placement/edit"] {}
   ["project" ":hold/cancel"] {:correction true, :power "always"}
   ["project" ":overseer/clear"] {:card? true, :people-facing true}
   ["project" ":overseer/start"] {}
   ["placement" ":owner-update/post"] {:hold true, :people-facing true, :power "ownerUpdates", :tool "sova_owner_update", :what? true}
   ["project" ":preview/start"] {:hold true, :people-facing true, :power "share", :tool "sova_preview", :what? true}
   ["project" ":project/archive"] {:card? true, :people-facing true}
   ["project" ":project/edit"] {}
   ["project" ":project/unarchive"] {}
   ["project" ":services/down"] {:power "always", :tool "sova_project_verbs"}
   ["project" ":services/run"] {:power "copiesRun", :tool "sova_project_verbs"}
   ["project" ":services/share"] {:hold true, :people-facing true, :power "share", :tool "sova_project_verbs", :what? true}
   ["project" ":verbs/onboard"] {:code-facing true, :counts "create", :hold true, :power "onboard", :tool "sova_project_verbs", :what? true}
   ["project" ":session/prompt"] {:code-facing true, :counts "prompt", :hold true, :power "codingPrompt", :tool "sova_send", :what? true}
   ["placement" ":spec/freeze"] {}
   ["placement" ":stakeholder/set"] {}
   ["reconciler" ":correct/clear-failed"] {:correction true, :power "bookkeeping", :tool "sova_correct"}
   ["reconciler" ":decision/promote"] {:code-facing true, :counts "promote", :hold true, :power "promote", :tool "sova_promote", :what? true}
   ["reconciler" ":draft/rewrite"] {}
   ["reconciler" ":hold/cancel"] {:correction true, :power "always"}
   ["reconciler" ":reconcile/request"] {:power "always", :tool "sova_reconcile"}
   ["residence" ":attach/confirm"] {}
   ["residence" ":commit/now"] {}
   ["residence" ":org/detach"] {}
   ["watch" ":operator/level-set"] {}
   ["watch" ":operator/run-now"] {}})
