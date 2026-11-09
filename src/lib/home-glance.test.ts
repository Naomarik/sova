import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectGlance, ProjectGlanceQueue, ProjectGlanceRelease } from "../../shared/projects";
import { overLimitSentence } from "../../shared/project-slots";
import { cardRuntime, DASH, memoryBar, MIN_BAR_PART, READING, releaseRow, retirementWords } from "./home-glance";

const GB = 1e9;
type Copies = NonNullable<ProjectGlance["slots"]>;
/** Four usable places under a limit of 4; `running` also fills that many places unless `runningPlaces` says; the rest are free. */
const copies = (x: Partial<Copies> = {}): Copies => {
  const held = { running: 0, cap: 4, usable: 4, stopped: 0, elsewhere: 0, ...x };
  const runningPlaces = x.runningPlaces ?? held.running;
  return { ...held, runningPlaces, free: x.free === undefined ? held.usable - runningPlaces - held.stopped - held.elsewhere : x.free };
};
const glance = (x: Partial<ProjectGlance> = {}): ProjectGlance => ({ projectId: "prj_a", merge: "unserved", queue: null, slots: copies(), memory: { chatsBytes: 0, copiesBytes: 0 }, release: null, ...x });
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

test("zero wording: Ready 0, copies 0 running with 4 free pips, memory 0 MB idle, caption idle", () => {
  const r = cardRuntime(glance({ merge: "served", queue: queue() }), NOW);
  assert.deepEqual(r.ready, { count: "0", link: true, inLine: null, dot: false, muted: true });
  assert.deepEqual(r.slots!.pips, ["free", "free", "free", "free"]);
  assert.deepEqual([r.slots!.text, r.slots!.muted], ["0 running", true]);
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
  const r = cardRuntime(glance({ slots: copies({ running: 3, cap: 12, usable: 16 }), memory: { chatsBytes: 1.6 * GB, copiesBytes: 0.8 * GB } }), NOW);
  assert.equal(r.memory.text, "2.4 GB");
  assert.equal(r.caption, "2.4 GB");
  assert.deepEqual(r.memory.bar, { chats: 0.667, slots: 0.333 }, "two thirds chats, one third slots, the whole bar");
  assert.equal(r.memory.parts, "Chats 1.6 GB · Copies 800 MB");
});

const row = (c: Copies) => cardRuntime(glance({ slots: c }), NOW).slots!;
const GROUP_ORDER = ["running", "stopped", "elsewhere", "free", "unchecked"];
const ELSEWHERE_WORDS = "Used elsewhere: another program has the ports these places need, so a new copy can't go there. Stopping this project's copies won't free them.";

test("copies: one pip per usable place, grouped running, stopped, elsewhere, free, whatever the mix", () => {
  for (const [running, stopped, elsewhere] of [[0, 0, 0], [1, 2, 3], [16, 0, 0], [0, 16, 0], [0, 0, 16], [5, 0, 11]] as const) {
    const free = 16 - running - stopped - elsewhere;
    const { pips } = row(copies({ running, cap: 16, usable: 16, stopped, elsewhere }));
    assert.equal(pips.length, 16);
    assert.deepEqual([running, stopped, elsewhere, free], ["running", "stopped", "elsewhere", "free"].map((l) => pips.filter((p) => p === l).length));
    const ranks = pips.map((p) => GROUP_ORDER.indexOf(p));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  }
});

test("copies: a project with fewer usable places draws only those", () => {
  const r = row(copies({ running: 1, usable: 9, cap: 12 }));
  assert.equal(r.pips.length, 9);
  assert.equal(r.pips.filter((p) => p === "free").length, 8);
});

test("the figure reads at limit exactly once the count reaches the limit, and the count is the limit's, not the pips'", () => {
  assert.equal(row(copies({ running: 3 })).text, "3 running");
  assert.equal(row(copies({ running: 4 })).text, "4 at limit");
  const beyondPlaces = row(copies({ running: 5, runningPlaces: 4 }));
  assert.equal(beyondPlaces.text, "5 at limit", "a running record outside the usable slots still counts");
  assert.equal(beyondPlaces.pips.filter((p) => p === "running").length, 4, "and draws no pip");
  assert.ok(beyondPlaces.title.startsWith("5 running,"), "the hover gives the limit's count too");
  assert.equal(row(copies({ running: 1 })).muted, false);
});

test("the figure says at limit exactly when the copy limit's own rule refuses a start", () => {
  for (let cap = 1; cap <= 16; cap++) {
    for (let running = 0; running <= cap + 2; running++) {
      assert.equal(row(copies({ running, cap, usable: 16, runningPlaces: Math.min(running, 16) })).text.endsWith("at limit"), overLimitSentence(running, cap) !== null, `${running} of ${cap}`);
    }
  }
});

test("hover: the counts and the limit, the used-elsewhere sentences only while a place is used elsewhere", () => {
  assert.equal(row(copies({ running: 1, usable: 16, cap: 12, stopped: 2 })).title, "1 running, 2 stopped but holding a place, 0 used elsewhere, 13 free. Up to 12 can run at once.");
  assert.equal(row(copies({ running: 1, usable: 16, cap: 12, elsewhere: 3 })).title, `1 running, 0 stopped but holding a place, 3 used elsewhere, 12 free. Up to 12 can run at once. ${ELSEWHERE_WORDS}`);
});

test("not checked: no free pip, no free count, and it says so; other Sova copies still count as used elsewhere", () => {
  const r = row(copies({ running: 1, usable: 8, stopped: 1, elsewhere: 2, free: null }));
  assert.deepEqual(r.pips, ["running", "stopped", "elsewhere", "elsewhere", "unchecked", "unchecked", "unchecked", "unchecked"]);
  assert.equal(r.title, `1 running, 1 stopped but holding a place, 2 used elsewhere. Up to 4 can run at once. ${ELSEWHERE_WORDS} Other programs were not checked.`);
  assert.equal(row(copies({ usable: 2, free: null })).title, "0 running, 0 stopped but holding a place, 0 used elsewhere. Up to 4 can run at once. Other programs were not checked.");
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
  assert.equal(only.memory.parts, "Chats 0 MB · Copies 2.7 GB");
  assert.equal(only.memory.text, "2.7 GB", "one figure, the total");
  assert.deepEqual(only.memory.bar, { chats: 0, slots: 1 });
  const both = cardRuntime(glance({ memory: { chatsBytes: 1.5 * GB, copiesBytes: 2.7 * GB } }), NOW);
  assert.deepEqual([both.memory.bar, both.memory.parts, both.memory.text], [{ chats: 0.357, slots: 0.643 }, "Chats 1.5 GB · Copies 2.7 GB", "4.2 GB"]);
});

test("the card's retirement line: retired then held, either left out at 0, nothing at all with neither", () => {
  assert.equal(retirementWords({}), null);
  assert.equal(retirementWords({ retired: 0, held: 0 }), null);
  assert.equal(retirementWords({ retired: 4 }), "4 retired");
  assert.equal(retirementWords({ held: 2 }), "2 held");
  assert.equal(retirementWords({ retired: 4, held: 2 }), "4 retired · 2 held");
});
