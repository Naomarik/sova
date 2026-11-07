import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectGlance, ProjectGlanceQueue, ProjectGlanceRelease } from "../../shared/projects";
import { cardRuntime, DASH, memoryBar, MIN_BAR_PART, READING, releaseRow } from "./home-glance";

const GB = 1e9;
const glance = (x: Partial<ProjectGlance> = {}): ProjectGlance => ({ projectId: "prj_a", merge: "unserved", queue: null, slots: { running: 0, cap: 4 }, memory: { chatsBytes: 0, copiesBytes: 0 }, release: null, ...x });
const queue = (x: Partial<ProjectGlanceQueue> = {}): ProjectGlanceQueue => ({ ready: 0, inLine: 0, waiting: 0, target: "master", at: "2026-11-05T12:00:00.000Z", ...x });
const NOW = Date.parse("2026-11-05T12:10:00.000Z");

test("before the first glance (or while it fails) the runtime rows read — and no progress shows", () => {
  const r = cardRuntime(undefined, NOW);
  assert.equal(r.ready.count, DASH);
  assert.equal(r.slots, null);
  assert.equal(r.memory.text, DASH);
  assert.deepEqual([r.memory.bar, r.memory.parts], [null, null], "no bar, no hover text");
  assert.deepEqual(r.progress, []);
});

test("zero wording: Ready 0, slots 0 of 4 with 4 dark pips, memory 0 MB idle, caption idle", () => {
  const r = cardRuntime(glance({ merge: "served", queue: queue() }), NOW);
  assert.deepEqual(r.ready, { count: "0", link: true, inLine: null, dot: false, muted: true });
  assert.deepEqual(r.slots, { pips: [false, false, false, false], text: "0 of 4", muted: true });
  assert.deepEqual({ text: r.memory.text, muted: r.memory.muted }, { text: "0 MB idle", muted: true });
  assert.equal(r.caption, "idle");
  assert.equal(r.hasSetup, true);
  assert.deepEqual(r.memory.bar, { chats: 0, slots: 0 }, "idle: an empty bar, neither part drawn");
  assert.equal(r.memory.parts, null, "idle: no hover text, 0 MB idle says it");
});

test("an unserved project's Ready reads — and links nowhere; a served one being read reads …; a served one counts", () => {
  assert.deepEqual(cardRuntime(glance({ queue: null }), NOW).ready, { count: DASH, link: false, inLine: null, dot: false, muted: true });
  assert.deepEqual(cardRuntime(glance({ merge: "reading" }), NOW).ready, { count: READING, link: true, inLine: null, dot: false, muted: true });
  assert.notEqual(READING, DASH);
  const r = cardRuntime(glance({ merge: "served", queue: queue({ ready: 2, inLine: 3, waiting: 2 }) }), NOW);
  assert.deepEqual(r.ready, { count: "2", link: true, inLine: "· 3 in line", dot: true, muted: false });
});

test("a project with no project file: slots —, caption no project setup, memory still its chats', not a link", () => {
  const r = cardRuntime(glance({ slots: null, memory: { chatsBytes: 640e6, copiesBytes: 0 } }), NOW);
  assert.equal(r.slots, null);
  assert.equal(r.caption, "no project setup");
  assert.equal(r.memory.text, "640 MB");
  assert.equal(r.hasSetup, false);
});

test("memory: chats plus copies in one figure, the bar the full-width mix of the two", () => {
  const r = cardRuntime(glance({ slots: { running: 3, cap: 12 }, memory: { chatsBytes: 1.6 * GB, copiesBytes: 0.8 * GB } }), NOW);
  assert.equal(r.memory.text, "2.4 GB");
  assert.equal(r.caption, "2.4 GB");
  assert.deepEqual(r.memory.bar, { chats: 0.667, slots: 0.333 }, "two thirds chats, one third slots, the whole bar");
  assert.equal(r.memory.parts, "Chats 1.6 GB · Running slots 800 MB");
  assert.equal(r.slots!.text, "3 of 12");
  assert.equal(r.slots!.pips.filter(Boolean).length, 3);
});

test("landing: step n of m (the meter's segments), time left, the meter, and who waits", () => {
  const q = queue({
    inLine: 3,
    waiting: 2,
    landing: {
      branch: "feat/plan-cards",
      startedAt: "2026-11-05T12:05:00.000Z",
      takesMs: 11 * 60_000,
      steps: [
        { id: "copy", kind: "copy", label: "Merge copy", result: "passed" },
        { id: "merge", kind: "merge", label: "Merge", result: "passed" },
        { id: "check:unit", kind: "check", label: "unit", result: "passed" },
        { id: "check:int", kind: "check", label: "int", result: "running" },
      ],
      checks: [
        { id: "unit", label: "unit" },
        { id: "int", label: "int" },
        { id: "build", label: "build" },
      ],
    },
  });
  const [row] = cardRuntime(glance({ queue: q }), NOW).progress;
  assert.equal(row!.kind, "landing");
  assert.equal(row!.text, "feat/plan-cards · step 7 of 11"); // every segment the meter draws, as the landing bar counts
  assert.equal(row!.segments.length, 11);
  assert.equal(row!.meta, "~6 min left");
  assert.equal(row!.detail, "started 5 min ago · takes ~11 min · 2 in line");
  assert.ok(row!.segments.includes("running") && row!.segments.includes("passed"));
  assert.equal(row!.tab, "merge-queue");
});

test("frozen for a release: its own row while landings wait and nothing runs; the release's own check says who waits", () => {
  const frozen = cardRuntime(glance({ merge: "served", queue: queue({ waiting: 2, inLine: 2, frozen: { tag: "v0.42", version: "0.42", waiting: 2 } }) }), NOW).progress;
  assert.deepEqual(
    frozen.map((r) => [r.lead, r.text, r.meta, r.detail]),
    [["Merge queue", "Frozen for a release", "2 waiting", "master is frozen for release v0.42"]],
  );
  const own = cardRuntime(
    glance({ merge: "served", queue: queue({ waiting: 2, inLine: 3, frozen: { tag: "v0.42", version: "0.42", waiting: 2 }, landing: { branch: "sova/release-v0.42", startedAt: "2026-11-05T12:09:00.000Z", takesMs: null, steps: [], checks: [], release: true } }) }), NOW).progress;
  assert.equal(own.length, 1);
  assert.equal(own[0]!.detail, "started 1 min ago · 2 waiting for v0.42");
  assert.equal(own[0]!.meta, null);
});

const rel = (state: ProjectGlanceRelease["state"], states: ProjectGlanceRelease["steps"][number]["state"][], tag: string | null = "v1.3"): ProjectGlanceRelease => ({
  id: "rl_1",
  state,
  version: tag ? tag.slice(1) : null,
  tag,
  steps: states.map((s, i) => ({ id: i === 4 ? "publish" : `s${i}`, label: `Step ${i}`, phase: i < 3 ? "prepare" : i === 3 ? "check" : i === 4 ? "sova" : "after", state: s })),
});

test("release: New release until tagged, the Releases tab's state words, Held for you while its step is held", () => {
  const r = releaseRow(rel("preparing", ["done", "running", "waiting", "waiting", "waiting", "waiting"], null));
  assert.equal(r.text, "New release · Step 2 of 6");
  assert.deepEqual(r.chip, { word: "Preparing", tone: "accent" });
  assert.equal(r.detail, "Step 1 · 1 done");
  assert.deepEqual(r.segments, ["passed", "running", "waiting", "waiting", "waiting", "waiting"]);
  const held = releaseRow(rel("checking", ["done", "done", "done", "held", "waiting", "waiting"]));
  assert.deepEqual([held.text, held.chip!.word, held.detail], ["v1.3 · Step 4 of 6", "Held for you", "Step 3, held for you · 3 done"]);
  assert.equal(releaseRow(rel("ready", ["done", "done", "done", "done", "waiting", "waiting"])).chip!.word, "Ready to publish");
  assert.equal(releaseRow(rel("ready", ["done", "done", "done", "done", "failed", "waiting"])).chip!.word, "Publish failed");
  assert.equal(releaseRow(rel("publishing", ["done", "done", "done", "done", "running", "waiting"])).chip!.word, "Publishing");
  assert.equal(releaseRow(rel("published", ["done", "done", "done", "done", "done", "running"])).chip!.word, "Published, finishing");
  assert.equal(releaseRow(rel("withdrawn", ["done", "done", "done", "done", "done", "done"])).chip!.word, "Withdrawn, finishing");
});

test("memory bar: the mix fills the whole bar; a small nonzero part keeps MIN_BAR_PART, taken from the larger; idle empty", () => {
  const mix = memoryBar(1.5 * GB, 2.7 * GB);
  assert.deepEqual(mix, { chats: 0.357, slots: 0.643 }, "1.5 of 4.2 GB chats, 2.7 of 4.2 GB slots");
  assert.equal(mix.chats + mix.slots, 1, "full width whatever the machine's memory");
  // 100 MB of chats beside 2.7 GB of slots: the chats' 3.6 % is drawn at the minimum, the slots give it up.
  assert.deepEqual(memoryBar(0.1 * GB, 2.7 * GB), { chats: MIN_BAR_PART, slots: 1 - MIN_BAR_PART });
  assert.deepEqual(memoryBar(3 * GB, 1e6), { chats: 1 - MIN_BAR_PART, slots: MIN_BAR_PART }, "a tiny slots part still shows");
  assert.deepEqual(memoryBar(3 * GB, 0), { chats: 1, slots: 0 }, "chats only: the whole bar chats, no slots part");
  assert.deepEqual(memoryBar(0, 2.7 * GB), { chats: 0, slots: 1 }, "slots only: the whole bar slots");
  assert.deepEqual(memoryBar(0, 0), { chats: 0, slots: 0 }, "idle: nothing drawn");
});

test("memory row: the hover text names both parts, a zero part as 0 MB; one figure, the total", () => {
  const only = cardRuntime(glance({ memory: { chatsBytes: 0, copiesBytes: 2.7 * GB } }), NOW);
  assert.equal(only.memory.parts, "Chats 0 MB · Running slots 2.7 GB");
  assert.equal(only.memory.text, "2.7 GB", "one figure, the total");
  assert.deepEqual(only.memory.bar, { chats: 0, slots: 1 });
  const both = cardRuntime(glance({ memory: { chatsBytes: 1.5 * GB, copiesBytes: 2.7 * GB } }), NOW);
  assert.deepEqual([both.memory.bar, both.memory.parts, both.memory.text], [{ chats: 0.357, slots: 0.643 }, "Chats 1.5 GB · Running slots 2.7 GB", "4.2 GB"]);
});
