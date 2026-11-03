import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeQueueSettings } from "../../shared/merge-queue-settings";
import { changeLines, changesOf, rebaseDraft, checksCaption, minutes, modelWords, parseMinutes, savedWords, summaryLine, toProjectDraft } from "./merge-queue-settings";

const SHA = "97927e0c0a92041da839da63093e474719f83837";
const check = (id: string, optional = false) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), timeoutSec: 600, rerun: false, optional });
const opus = { model: "claude-code-cli/claude-opus-5-5", thinking: "medium" };
const settings = (x: Partial<MergeQueueSettings> = {}): MergeQueueSettings => ({
  at: SHA,
  projectFileDiffers: false,
  landing: { target: "master", push: null, names: { setUp: true, count: 14 } },
  checks: { mode: "declared", list: [...Array.from({ length: 9 }, (_, i) => check(`c${i}`)), check("walk", true), check("perf", true)] },
  setup: { steps: [] },
  review: { on: true, kit: ".sova/playbooks/review", files: ["PLAYBOOK.md"], model: { picked: null, effective: opus }, canTurnOn: true },
  thread: { model: { picked: null, effective: opus }, playbooks: [] },
  fixed: { reviewTimeoutMin: 20, reviewTries: 2, setupRetrySec: 60, threadMaxAgeH: 24, threadMaxContext: 0.5, checkMaxMin: 30, mergeCopy: "/w/sova-merge" },
  ...x,
});

test("the summary line says checks, review and push, as the prototype does", () => {
  assert.equal(summaryLine(settings(), true), "11 checks · review on, Opus 5.5 · pushes to origin");
  assert.equal(summaryLine(settings({ review: { ...settings().review, on: false } }), true), "11 checks · review off · pushes to origin");
  assert.equal(summaryLine(settings({ landing: { ...settings().landing, push: false } }), true), "11 checks · review on, Opus 5.5 · doesn't push");
  assert.equal(summaryLine(settings(), false), "11 checks · review on, Opus 5.5 · no remote");
  assert.equal(summaryLine(settings({ checks: { mode: "test-command", list: [] } }), true).split(" · ")[0], "The test command");
});

test("the Checks caption counts always and picked", () => {
  assert.equal(checksCaption(settings().checks), "9 always, 2 when the merge thread picks them");
  assert.equal(checksCaption({ mode: "declared", list: [check("a")] }), "Runs every time");
  assert.equal(checksCaption({ mode: "none", list: [] }), null);
});

test("a save sends only what the user changed: an absent push stays absent", () => {
  const s = settings();
  const d = toProjectDraft(s, true);
  assert.equal(d.push, true, "absent push reads On when there is an origin");
  assert.equal(changesOf(d, s, true), null, "an untouched form changes nothing");
  const edited = { ...d, review: false, checks: { ...d.checks, c1: { timeoutSec: 1500, rerun: true, optional: false }, walk: { ...d.checks.walk!, optional: false } } };
  const ch = changesOf(edited, s, true)!;
  assert.deepEqual(ch, { review: false, checks: { c1: { timeoutSec: 1500, rerun: true }, walk: { optional: false } } });
  assert.deepEqual(changeLines(ch, s), ["Review each landing: off", "C1: time limit 25 min, reruns failed files", "Walk: runs every time"]);
  // Turning push off and back on is no change.
  assert.equal(changesOf({ ...d, push: true }, s, true), null);
  assert.deepEqual(changesOf({ ...d, push: false }, s, true), { push: false });
});

test("time limits are whole minutes up to the cap", () => {
  assert.equal(parseMinutes("25", 30), 25);
  for (const bad of ["0", "31", "2.5", "", "x", "-3"]) assert.equal(parseMinutes(bad, 30), null, bad);
  assert.equal(minutes(600), "10 min");
  assert.equal(minutes(90), "1 min 30 s");
  assert.equal(minutes(45), "45 s");
});

test("a model row reads its pick, or Same as new chats with today's model", () => {
  assert.deepEqual(modelWords({ picked: null, effective: opus }), { value: "Same as new chats", today: "Opus 5.5 · medium" });
  assert.deepEqual(modelWords({ picked: { model: "zai/glm-5.3" }, effective: opus, fallbackWhy: "GLM 5.3 is off in Settings → Models" }).why, "GLM 5.3 is off in Settings → Models");
});

test("the saved line names the commit, and the push only when there is one", () => {
  assert.equal(savedWords("master", "1a2b3c4d5e6f", true), "Saved to master as 1a2b3c4; pushed with the next landing.");
  assert.equal(savedWords("main", "1a2b3c4d5e6f", false), "Saved to main as 1a2b3c4.");
});

test("a newer read of master keeps the user's edits and moves every field they left alone", () => {
  const base = toProjectDraft(settings(), true);
  const mine = { ...base, review: false, checks: { ...base.checks, c1: { ...base.checks.c1!, timeoutSec: 1500 } } };
  const freshS = settings({ landing: { ...settings().landing, push: false } });
  const fresh = { ...toProjectDraft(freshS, true), checks: { ...toProjectDraft(freshS, true).checks, c1: { timeoutSec: 900, rerun: true, optional: false }, c2: { timeoutSec: 300, rerun: false, optional: false } } };
  const got = rebaseDraft(mine, base, fresh);
  assert.equal(got.push, false, "push follows master");
  assert.equal(got.review, false, "the user's review edit stays");
  assert.deepEqual(got.checks.c1, { timeoutSec: 1500, rerun: true, optional: false }, "their time limit stays; rerun follows master");
  assert.deepEqual(got.checks.c2, { timeoutSec: 300, rerun: false, optional: false });
});

test("staged project-file edits hold Settings' close, never join Save Changes, and go when the dialog closes", async () => {
  const { heldEdits, dirtyForms, resetAllDrafts } = await import("./settings-draft");
  const { stageEdit, stagedDirty, stagedEdit } = await import("./merge-queue-settings-draft");
  const s = settings();
  const d = toProjectDraft(s, true);
  stageEdit({ project: "prj_1", base: s, hasOrigin: true, draft: d });
  assert.equal(stagedDirty(), false, "an edit that changes nothing holds nothing");
  assert.deepEqual(heldEdits(), []);
  stageEdit({ project: "prj_1", base: s, hasOrigin: true, draft: { ...d, review: false } });
  assert.deepEqual(heldEdits().map((h) => [h.tab, h.label]), [["merge-queue", "Merge Queue"]]);
  assert.ok(!dirtyForms().some((f) => f.tab === "merge-queue"), "the footer's Save Changes never writes it");
  resetAllDrafts();
  assert.equal(stagedEdit(), null);
  assert.deepEqual(heldEdits(), []);
});

test("a refusal reads the server's words, whichever envelope", async () => {
  const { refusalWords } = await import("./merge-queue-settings");
  const api = (body: unknown) => Object.assign(new Error("409 Conflict"), { body });
  assert.equal(refusalWords(api({ error: { code: "dirty", message: "Commit or discard the edit in the project folder first" } })), "Commit or discard the edit in the project folder first");
  assert.equal(refusalWords(api({ error: "No project prj_x." })), "No project prj_x.");
  assert.equal(refusalWords(api(undefined)), "409 Conflict");
});

test("the merge thread's Instructions caption shows only when the project folder's playbook differs from the target", async () => {
  const { threadFolderCaption } = await import("./merge-queue-settings");
  const method = { label: "Sova's method", source: { kind: "builtin" as const, id: "merge-queue-method" } };
  const own = (differsFromFolder?: boolean) => ({ label: "This project's own", source: { kind: "project" as const, project: "prj_1", ref: SHA, dir: ".sova/playbooks/merge-queue" }, ...(differsFromFolder === undefined ? {} : { differsFromFolder }) });
  const with_ = (playbooks: MergeQueueSettings["thread"]["playbooks"]) => settings({ thread: { ...settings().thread, playbooks } });
  assert.equal(threadFolderCaption(with_([method, own(true)])), "The merge thread reads the project folder's copy, which differs from master.");
  assert.equal(threadFolderCaption(with_([method, own(false)])), null);
  assert.equal(threadFolderCaption(with_([method, own()])), null);
  assert.equal(threadFolderCaption(with_([])), null);
});
