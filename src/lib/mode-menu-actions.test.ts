// A project mode's commands and hooks in the mode menu (§chat.mode-menu/project-mode-commands,
// §chat.mode-menu/project-mode-hooks): what its row and its approval say. A mode with only tools reads exactly as
// before (the same functions' answers, checked against the ones that existed).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectMinorInfo } from "../../shared/protocol";
import { APPROVAL_FOOT, approvalFootFor, approvalLead, approvalLeadFor, bareProgramsNote, hookWhen, hooksLead, HOOKS_NEED_NOTE, projectRowState, runsCount } from "./mode-menu";

const pm = (over: Partial<ProjectMinorInfo> = {}): ProjectMinorInfo => ({ id: "rel", description: "Release", workers: false, tools: [], dir: "/r/.sova/minor-modes/rel", ...over });
const tool = { name: "status", description: "Status", command: ["./status.sh"] };
const cmd = { name: "check", description: "Check", command: ["node", "./check.mjs"] };
const hook = { on: "turn.ended" as const, command: ["sh", "./notify.sh"] };

test("a mode with only tools: the lead, the foot and the row note are what they were", () => {
  const m = pm({ tools: [tool, tool] });
  assert.equal(approvalLeadFor("rel", "sova", m), approvalLead("rel", "sova", m.tools));
  assert.equal(approvalFootFor(m), APPROVAL_FOOT);
  assert.equal(runsCount(m), "2 tools");
  assert.equal(projectRowState(pm({ tools: [tool], needsApproval: true }), false).note, "Asks before turning on: it runs 1 tool.");
});

test("a mode with commands and hooks says all it runs, in the lead, the foot and the row", () => {
  const m = pm({ tools: [tool], commands: [cmd], hooks: [hook, hook] });
  assert.equal(runsCount(m), "1 tool, 1 command and 2 hooks");
  assert.equal(
    approvalLeadFor("rel", "sova", m),
    "rel comes from sova's files. Turning it on lets the model run 1 tool, you and scripts run 1 command, and 2 hooks run after things happen in this chat, in this chat's folder.",
  );
  assert.equal(approvalLeadFor("rel", undefined, pm({ hooks: [hook] })), "rel comes from this project's files. Turning it on lets 1 hook run after things happen in this chat, in this chat's folder.");
  assert.match(approvalFootFor(m), /covers what it runs and every file/);
  assert.equal(projectRowState(pm({ hooks: [hook], needsApproval: true }), false).note, "Asks before turning on: it runs 1 hook.");
  assert.equal(bareProgramsNote([...m.tools, ...m.commands!, ...m.hooks!]), "node and sh are this machine's own programs, so the approval doesn't cover them.");
  assert.equal(hookWhen("turn.ended"), "After each reply");
  assert.equal(hookWhen("turn.started"), "When a reply starts");
});

test("an on mode whose hooks wait for you says so; one whose hooks are paused says that", () => {
  const waiting = projectRowState(pm({ hooks: [hook], hooksNeedApproval: true }), true);
  assert.deepEqual(waiting, { kind: "hooks", note: HOOKS_NEED_NOTE, canToggle: true });
  assert.equal(projectRowState(pm({ hooks: [hook], hooksNeedApproval: true }), false).kind, "ok", "off, nothing waits");
  const paused = projectRowState(pm({ hooks: [hook], hookNote: "Hooks paused: a hook ran 10 times in 10 minutes." }), true);
  assert.equal(paused.note, "Hooks paused: a hook ran 10 times in 10 minutes.");
  // A change since turn-on or tools changed outranks it: those say what to do first.
  assert.equal(projectRowState(pm({ hooks: [hook], hooksNeedApproval: true, changed: true }), true).kind, "changed");
  assert.match(hooksLead("rel"), /Someone other than you turned it on, and only you can approve its hooks/);
  assert.doesNotMatch(hooksLead("rel"), /Overseer/);
});
