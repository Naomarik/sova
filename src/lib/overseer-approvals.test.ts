// The Overseer's Approvals & Schedules words: the ⋯ row's note, the dot's predicate and the
// triggers' spoken names (§app.overseer/approvals, §design.copy-deck/overseer-head).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Permit } from "../../shared/overseer-grants";
import type { ScheduleInfo } from "../../shared/protocol";
import { approvalsNote, overseerActionsLabel, permitsAndSchedulesText, schedulesMenuLabel, waitingSchedules } from "./overseer-approvals";

const permit = (kind: Permit["kind"], status: Permit["status"] = "live"): Permit => ({
  kind,
  id: kind === "grant" ? "g_1" : "r_1",
  card: "c_1",
  option: "a",
  label: "x",
  createdAt: "2026-10-19T08:00:00Z",
  sessions: "any",
  acts: [],
  status,
  uses: [],
});
const schedule = (over: Partial<ScheduleInfo>): ScheduleInfo => ({
  id: "s1",
  root: "/p",
  projectName: "p",
  playbook: "pb",
  title: "Round",
  fires: [],
  when: "every 30m",
  state: "active",
  ...over,
});
const needs = schedule({ state: "needs-approval", pin: "p1" });
const changed = schedule({ id: "s2", state: "paused", pin: "p2", reason: "Changed since you approved it" });
const selfPaused = schedule({ id: "s3", state: "paused", pin: "p3", reason: "Paused after 10 runs nobody opened." });
const invalid = schedule({ id: "s4", state: "invalid", reason: "every takes 30m" });
const active = schedule({ id: "s5", state: "active", pin: "p5" });

test("the dot counts only schedules that offer Approve Schedule", () => {
  assert.equal(waitingSchedules([needs, changed, selfPaused]), 3);
  assert.equal(waitingSchedules([invalid, active]), 0, "not valid and approved schedules never wait");
  assert.equal(waitingSchedules(undefined), 0);
  assert.equal(waitingSchedules([]), 0);
});

test("the ⋯ row's note: waiting first, then the counts, then None", () => {
  assert.equal(approvalsNote([permit("grant")], [needs, active]), "1 needs approval");
  assert.equal(approvalsNote([], [needs, changed]), "2 need approval");
  assert.equal(approvalsNote([permit("grant")], [active, invalid]), "1 approval · 2 schedules");
  assert.equal(approvalsNote([permit("grant"), permit("rule")], []), "1 approval · 1 rule");
  assert.equal(approvalsNote([permit("grant", "expired")], []), "None", "an ended approval isn't counted");
  assert.equal(approvalsNote([], []), "None");
  // An approval or rule never makes the note urgent on its own.
  assert.equal(approvalsNote([permit("rule")], [active]), "1 rule · 1 schedule");
});

test("permitsAndSchedulesText keeps the chip's old words", () => {
  assert.equal(permitsAndSchedulesText([permit("grant")], [active, needs]), "1 approval · 2 schedules");
  assert.equal(permitsAndSchedulesText([], []), "");
});

test("the triggers' names say the dot", () => {
  assert.equal(overseerActionsLabel(0), "Overseer actions");
  assert.equal(overseerActionsLabel(1), "Overseer actions, 1 schedule needs approval");
  assert.equal(overseerActionsLabel(2), "Overseer actions, 2 schedules need approval");
  assert.equal(schedulesMenuLabel(0), "Approvals and schedules");
  assert.equal(schedulesMenuLabel(1), "Approvals and schedules, 1 schedule needs approval");
});
