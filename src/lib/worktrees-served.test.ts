// The Worktrees modal and the session pane in a repo the merge queue serves and in one it doesn't (al_1 a5):
// each row as the server sends it (SessionWorktreeInfo: mergeServed only when served, mergeProject for any listed
// project), through the words, buttons and modal head the components draw (WorktreesModal.tsx: rowButtons drives
// every button, modalHead the intro and the paused line).
import assert from "node:assert/strict";
import { test } from "node:test";
import { controlWords, modalHead, queueRow, rowButtons, rowsSummary, type MergeProjectInfo, type QueueRowInput } from "./merge-queue";

const SHA = "b".repeat(40);
const finished = { path: "/w", branch: "feat/x", state: "ready" as const };
const project = (x: Partial<MergeProjectInfo> = {}): MergeProjectInfo => ({ id: "prj_1", root: "/r", target: "master", checks: "declared", review: false, ...x });
const row = (x: Partial<QueueRowInput>): QueueRowInput => ({ status: "active", exists: true, branch: "feat/x", readiness: finished, ...x });

/** Each kind of repo's row, exactly as the server fills it. */
const served = row({ branch: "feat/served", mergeServed: true, mergeProject: project(), readiness: { ...finished, landing: { state: "ready", commit: SHA } } });
const unlisted = row({ branch: "feat/plain" });
const listedUnset = row({ branch: "feat/listed", mergeProject: project({ checks: "unset", target: "main" }) });
const unlistedDirty = row({ branch: "feat/dirty", readiness: { ...finished, state: "in-progress", dirtyCount: 2 } });
const PLAIN = "Say “land it” in the chat to merge it into main.";
const QUEUE_WORDS = /Ready to land|Landing specs|\bLand\b|queue/;

/** What a row draws: its chip, its line and its buttons (projectIdOf: mergeProject, else the entry's). */
const drawn = (w: QueueRowInput) => {
  const r = queueRow(w);
  return { chip: r.label, line: r.reason, buttons: rowButtons(r, w.mergeProject?.id ?? w.queue?.project) };
};

test("a served project's finished branch: Ready, with Land", () => {
  assert.deepEqual(drawn(served), { chip: "Ready", line: undefined, buttons: ["Land"] });
});

test("an unlisted repo's finished branch: Ready to merge, the plain-merge line, no Land, no queue words", () => {
  const d = drawn(unlisted);
  assert.deepEqual(d, { chip: "Ready to merge", line: PLAIN, buttons: [] });
  assert.doesNotMatch(`${d.chip} ${d.line}`.replace(PLAIN, ""), QUEUE_WORDS);
});

test("a listed project with no merge setup: Ready to merge, the plain-merge line, and Set Up Queue (never Land)", () => {
  assert.deepEqual(drawn(listedUnset), { chip: "Ready to merge", line: PLAIN, buttons: ["Set Up Queue"] });
});

test("uncommitted work in an unserved repo: commit it in the chat, no mention of Land", () => {
  assert.deepEqual(drawn(unlistedDirty), { chip: "Uncommitted", line: "Commit it in its chat.", buttons: [] });
  assert.equal(drawn({ ...unlistedDirty, mergeServed: true, mergeProject: project() }).line, "Commit it in its chat, then Land.");
});

test("Land keys on mergeServed alone: a listed project with checks but no mergeServed shows no Land", () => {
  assert.deepEqual(drawn(row({ mergeProject: project() })).buttons, []);
});

test("the modal's head: the queue's intro and paused line only where some row is served", () => {
  assert.deepEqual(modalHead([unlisted, listedUnset, unlistedDirty]), { intro: null, paused: null });
  const both = modalHead([unlisted, { ...served, mergeProject: project({ paused: "you paused it" }) }]);
  // One line in the dialog's foot (fold layout): what Land does and what lands, no target named.
  assert.equal(both.intro, "Land queues a branch; it lands as the commit that was tested.");
  assert.equal(both.paused, "The queue is paused: you paused it. Land still takes your approval; it's checked once the queue resumes.");
  // A listed-not-set-up project's paused facts never speak for the queue: no row there is served.
  assert.equal(modalHead([{ ...listedUnset, mergeProject: project({ checks: "unset", paused: "x" }) }]).paused, null);
});

test("the modal draws exactly these: every row button and the head come from rowButtons and modalHead", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../components/WorktreesModal.tsx", import.meta.url), "utf8");
  // No button decides on its own: a check on row().action or row().tryAgain would bypass rowButtons.
  assert.doesNotMatch(src, /row\(\)\.(action|tryAgain|answerInChat|remove)\b/);
  for (const b of ["Land", "Set Up Queue", "Accept", "Land Anyway", "Try Again", "Answer in Chat", "Remove from Queue"]) assert.ok(src.includes(`buttons().includes("${b}")`), b);
  // The retired buttons are drawn nowhere in the modal (al_3).
  for (const gone of ["Send Back", "Land This Commit Again", "Land Newest Commit"]) assert.ok(!src.includes(gone), gone);
  assert.ok(src.includes("modalHead(props.rows)") && !/Land queues a branch/.test(src), "the intro's words live in modalHead only");
});

test("the control and the summary count a Ready-to-merge row as ready", () => {
  const rows = [unlisted, listedUnset, unlistedDirty].map((w) => queueRow(w));
  assert.equal(rowsSummary(rows), "2 ready · 1 uncommitted");
  assert.deepEqual(controlWords(rows), { text: "2 ready", n: 2, dot: "ok" });
});
