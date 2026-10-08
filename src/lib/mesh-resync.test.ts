import assert from "node:assert/strict";
import { test } from "node:test";
import { noRecipeReason, type ResyncHost, type ResyncSelf } from "../../shared/mesh-resync";
import { jobText, resyncNote, resyncView, sheetText, tailLines } from "./mesh-resync";

const self: ResyncSelf = { id: "desk", label: "Desk", commit: "c".repeat(40) };
const host = (over: Partial<ResyncHost> = {}): ResyncHost => ({
  id: "vps",
  label: "VPS",
  state: "skewed",
  commit: "a".repeat(40),
  relation: "behind",
  distance: 12,
  recipe: "vps",
  activity: { turnsRunning: 0, workers: 0 },
  ...over,
});

test("only a skewed host that is behind gets the button", () => {
  assert.deepEqual(resyncView(host(), self), { line: "12 commits behind Desk", button: {} });
  assert.deepEqual(resyncView(host({ distance: 1 }), self).line, "1 commit behind Desk");
  for (const relation of ["ahead", "same", "diverged", "unknown"] as const) {
    assert.equal(resyncView(host({ relation }), self).button, null, relation);
    assert.ok(resyncView(host({ relation }), self).line, `${relation} still says where it is`);
  }
  assert.deepEqual(resyncView(host({ state: "up", relation: "same" }), self), { line: null, button: null });
  assert.deepEqual(resyncView(host({ state: "down", relation: "unknown" }), self), { line: null, button: null });
  assert.deepEqual(resyncView(undefined, self), { line: null, button: null });
});

test("a newer host gets the hint to update this host, never a downgrade", () => {
  assert.equal(resyncView(host({ relation: "ahead" }), self).line, "Newer than Desk. Update Desk to match it.");
});

test("disabled with its reason, said under the host: no recipe, a recipe that can't run, a build that can't be named", () => {
  const none = resyncView(host({ recipe: null }), self);
  const what = "No resync recipe for VPS on Desk: set VPS_ID in scripts/mesh-vps/local.env (or PHONE_ID in scripts/mesh-termux/local.env) to vps, or add vps to mesh-resync.json";
  assert.deepEqual(none.button, { reason: what }, "names what to set, in the sentence the start's 409 says too");
  assert.equal(noRecipeReason({ id: "vps", label: "VPS" }, "Desk"), what);
  assert.equal(none.line, `12 commits behind Desk. ${what}`);
  assert.deepEqual(resyncView(host({ recipeProblem: "scripts/mesh-vps/local.env is missing" }), self).button, { reason: "Its recipe can't run: scripts/mesh-vps/local.env is missing" });
  const blocked = resyncView(host({ recipe: null }), { ...self, blocked: "This host booted with uncommitted changes" });
  assert.deepEqual(blocked.button, { reason: "This host booted with uncommitted changes" }, "the build comes first: a recipe wouldn't help");
  assert.equal(blocked.line, "12 commits behind Desk", "this host's block is said once for the menu, not under each host");
});

test("the menu's one note: why nothing can be resynced from here, only when some host is behind", () => {
  const off = { ...self, blocked: "This host booted with uncommitted changes" };
  assert.equal(resyncNote({ self: off, hosts: [host()] }), "Resync is off: This host booted with uncommitted changes");
  assert.equal(resyncNote({ self: off, hosts: [host({ relation: "ahead" })] }), null);
  assert.equal(resyncNote({ self, hosts: [host()] }), null);
  assert.equal(resyncNote(null), null);
});

test("a running job replaces the button with its progress", () => {
  const job = { commit: self.commit!, startedAt: 0, tail: "" };
  assert.deepEqual(resyncView(host({ job: { ...job, state: "running" } }), self), { line: "Resyncing to ccccccc…", button: null });
  assert.equal(resyncView(host({ job: { ...job, state: "waiting" } }), self).button, null);
  assert.match(resyncView(host({ job: { ...job, state: "failed", error: "x" } }), self).line!, /^Last resync failed\. 12 commits behind/);
  assert.deepEqual(resyncView(host({ state: "up", relation: "same", job: { ...job, state: "done" } }), self).line, "Resynced to ccccccc");
});

test("the sheet names both commits and warns about what runs there, never refusing", () => {
  const t = sheetText(host({ activity: { turnsRunning: 1, workers: 2 } }), self);
  assert.equal(t.title, "Resync VPS?");
  assert.equal(t.what, "VPS gets ccccccc, the build Desk runs (12 commits ahead of its aaaaaaa), and restarts onto it.");
  assert.equal(t.running, "1 turn running and 2 workers working on VPS stop when it restarts.");
  assert.match(t.job, /restarting Desk's server stops it\.$/);
  assert.equal(sheetText(host(), self).running, "Nothing is running on VPS now.");
  assert.equal(sheetText(host({ activity: { turnsRunning: 0, workers: 1 } }), self).running, "1 worker working on VPS stops when it restarts.");
  assert.match(sheetText(host({ activity: undefined }), self).running, /didn't say/);
  assert.match(sheetText(host({ recipe: "termux" }), self).job, /A phone takes several minutes\./);
});

test("job words and the output tail", () => {
  const job = { commit: self.commit!, startedAt: 0, tail: "" };
  assert.equal(jobText({ ...job, state: "done" }, "VPS"), "VPS runs ccccccc now.");
  assert.equal(jobText({ ...job, state: "failed", error: "The deploy script stopped with exit 1." }, "VPS"), "The deploy script stopped with exit 1.");
  assert.equal(tailLines("a\n\nb\nc\n", 2), "b\nc");
});
