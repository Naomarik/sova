import assert from "node:assert/strict";
import { test } from "node:test";
import type { UpdatesState } from "../../shared/protocol";
import { gatedForms } from "./settings-draft";
import { headMoved, resultLine, runningLine, upgradeLabel } from "./updates";
import { fromUpdatesDraft, rebaseUpdates, sameUpdates, toUpdatesDraft, updatesProblem } from "./updates-draft";

/** The Updates form and the section's words: what runs, what a check found, the reload note. */

test("the Updates form is a Save-gated form on General", () => {
  const form = gatedForms().find((f) => f.label === "Updates");
  assert.ok(form, "joined the registry");
  assert.equal(form.tab, "general");
});

test("a branch source keeps its name; an empty one holds Save with a sentence naming the form", () => {
  const d = toUpdatesDraft({ source: { kind: "branch", branch: "feat/x" }, autoCheck: true, autoUpgrade: false });
  assert.deepEqual(d, { source: "branch", branch: "feat/x", autoCheck: true, autoUpgrade: false });
  assert.deepEqual(fromUpdatesDraft({ ...d, branch: " feat/y " }).source, { kind: "branch", branch: "feat/y" });
  assert.equal(updatesProblem({ ...d, branch: "  " }), "Updates: Name the branch.");
  assert.equal(updatesProblem({ ...d, source: "stable", branch: "" }), null, "a name left over from a branch choice holds nothing");
  const stable = { source: { kind: "stable" as const }, autoCheck: true, autoUpgrade: false };
  assert.equal(sameUpdates({ ...toUpdatesDraft(stable), branch: "left over" }, stable), true);
  assert.equal(sameUpdates({ ...toUpdatesDraft(stable), autoUpgrade: true }, stable), false);
});

const running = (over: Partial<UpdatesState["running"]> = {}): UpdatesState["running"] => ({
  head: "a".repeat(40),
  startedHead: "a".repeat(40),
  version: null,
  baseVersion: "v0.3.2",
  pastBase: 86,
  branch: "master",
  kind: "developer",
  canUpgrade: true,
  whyNot: null,
  ...over,
});

test("what runs, in one line", () => {
  assert.equal(runningLine(running({ version: "v0.3.2", kind: "installer", branch: null, pastBase: 0 })), "Sova v0.3.2 · stable release");
  assert.equal(runningLine(running()), "master · 86 changes past v0.3.2");
  assert.equal(runningLine(running({ branch: null, pastBase: 1 })), "detached · 1 change past v0.3.2");
});

test("the button names the act, and the result line says what was found", () => {
  const t = { sha: "b".repeat(40), label: "v0.3.3", version: "v0.3.3", count: 4, subject: "Release v0.3.3", notes: null, notesUrl: null };
  assert.equal(upgradeLabel({ kind: "stable" }, t, running()), "Upgrade to v0.3.3");
  assert.equal(upgradeLabel({ kind: "master" }, { ...t, label: "master", version: null }, running({ branch: "feat/x" })), "Switch to master");
  assert.equal(upgradeLabel({ kind: "master" }, { ...t, label: "master", version: null }, running()), "Upgrade to Latest master");
  assert.equal(resultLine({ state: "available", target: t }, { kind: "stable" }), "Update available: v0.3.3");
  assert.equal(resultLine({ state: "available", target: { ...t, version: null, label: "feat/x", count: 12, subject: "Fix it" } }, { kind: "branch", branch: "feat/x" }), "12 new commits · latest: Fix it");
  assert.equal(resultLine({ state: "up-to-date" }, { kind: "master" }), "Up to date with master.");
});

test("the reload note: only when the running commit moved since the page loaded", () => {
  assert.equal(headMoved("a", "a"), false);
  assert.equal(headMoved("a", "b"), true);
  assert.equal(headMoved(null, "b"), false, "a page that never knew a commit has nothing to compare");
  assert.equal(headMoved("a", null), false, "a server that can't say isn't a new one");
});

test("settings saved elsewhere move the fields you left alone, never the ones you changed: nothing reads unsaved by itself", () => {
  const base = { source: { kind: "stable" as const }, autoCheck: true, autoUpgrade: false };
  const fresh = { source: { kind: "branch" as const, branch: "feat/x" }, autoCheck: false, autoUpgrade: false };
  const untouched = rebaseUpdates(toUpdatesDraft(base), base, fresh);
  assert.equal(sameUpdates(untouched, fresh), true, "a draft nobody edited is the server's again");
  const edited = rebaseUpdates({ ...toUpdatesDraft(base), autoUpgrade: true }, base, fresh);
  assert.deepEqual(edited, { source: "branch", branch: "feat/x", autoCheck: false, autoUpgrade: true });
});
