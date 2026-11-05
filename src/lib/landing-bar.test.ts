// The landing bar's reduction (al_1): which project, its words, its step track, its actions.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry, MergeRun, RunStep } from "../../shared/merge-queue";
import type { ReleaseRecord, ReleaseStep } from "../../shared/release";
import { INVALID_TITLE, reduceLanding, runSegments, runNow, SHOWN_MS, type LandingProjectInput, type LandingQueueCut, type LandingReleaseCut } from "./landing-bar";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const SHA = "3f2a1c0".padEnd(40, "0");
const TIP = "9b81e44".padEnd(40, "0");

const step = (id: string, kind: RunStep["kind"], result: RunStep["result"], x: Partial<RunStep> = {}): RunStep => ({ id, kind, label: id.replace(/^check:/, ""), result, ms: 0, log: `${id}.log`, ...x });
const run = (steps: RunStep[], x: Partial<MergeRun> = {}): MergeRun => ({
  id: "mr_1",
  entry: "me_1",
  project: "prj_a",
  branch: "feat/mesh-bar",
  base: SHA,
  commit: TIP,
  tip: TIP,
  steps,
  checks: [],
  verdict: "running",
  startedAt: iso(60_000),
  ...x,
});
const entry = (x: Partial<MergeEntry>): MergeEntry =>
  ({ id: "me_1", project: "prj_a", target: "master", branch: "feat/x", commit: SHA, approval: { by: "land-button", at: iso(0), commit: SHA }, state: "queued", runs: [], picks: [], notes: [], createdAt: iso(0), updatedAt: iso(0), ...x }) as MergeEntry;
const queue = (x: Partial<LandingQueueCut> = {}): LandingQueueCut => ({
  project: "prj_a",
  root: "/r/a",
  target: "master",
  state: "idle",
  served: true,
  checking: [],
  waiting: [],
  needsYou: [],
  recent: [],
  heads: { target: SHA },
  at: iso(0),
  ...x,
});
const proj = (x: Partial<LandingProjectInput> = {}): LandingProjectInput => ({ id: "prj_a", root: "/r/a", name: "alpha", queue: null, release: null, ...x });
const rstep = (id: string, state: ReleaseStep["state"], x: Partial<ReleaseStep> = {}): ReleaseStep => ({ id, label: id[0]!.toUpperCase() + id.slice(1), phase: "prepare", state, ...x });
const record = (x: Partial<ReleaseRecord> = {}): ReleaseRecord =>
  ({
    id: "rl_abcdef",
    project: "/r/a",
    state: "preparing",
    version: "1.4.0",
    tag: "v1.4.0",
    channels: [],
    base: SHA,
    commit: null,
    entry: null,
    thread: { session: "s_rel" },
    steps: [],
    notes: null,
    artifacts: [],
    startedAt: iso(0),
    startedBy: "operator",
    lastReportAt: null,
    manifest: { v: 1, steps: [] },
    settings: {} as ReleaseRecord["settings"],
    ...x,
  }) as ReleaseRecord;
const release = (x: Partial<LandingReleaseCut> = {}): LandingReleaseCut => ({ project: "/r/a", initialized: true, open: null, last: null, gates: null, quiet: null, target: "master", remote: true, ...x });
/** The check segments alone. */
const checkSegs = (r: MergeRun) => runSegments(r, { landsLocally: false }).filter((s) => s.id.startsWith("check:"));
const bar = (ps: LandingProjectInput[], seen?: Map<string, number>, now = NOW) => reduceLanding(ps, now, seen).bar;

test("nothing running, nothing waiting: no bar", () => {
  assert.equal(bar([proj({ queue: queue() })]), null);
  assert.equal(bar([]), null);
});

test("a landing running: title, step N of M, time left, +N in line", () => {
  const r = run([step("copy", "copy", "passed"), step("merge", "merge", "passed"), step("check:unit", "check", "passed"), step("check:test:int", "check", "running")], {
    checks: [
      { id: "unit", label: "unit", source: "required" },
      { id: "test:int", label: "test:int", source: "required" },
      { id: "build", label: "build", source: "required" },
    ],
  });
  const q = queue({ state: "running", current: r, checking: [entry({ id: "me_1", state: "checking", eta: { startsInMs: 0, takesMs: 4 * 60_000 } })], waiting: [entry({ id: "me_2", branch: "feat/y" }), entry({ id: "me_3", branch: "feat/z" })] });
  const b = bar([proj({ queue: q })])!;
  assert.equal(b.top.title, "Landing feat/mesh-bar");
  assert.equal(b.top.sub, "step 7 of 11 · test:int · ~3 min left");
  assert.deepEqual(b.top.count, { text: "+2", label: "2 in line" });
  // The hover card: the step running now (with its time when it has a start) and the next in line.
  assert.equal(b.top.peek.length, 2);
  assert.ok(b.top.peek[0]!.text.startsWith("test:int"), b.top.peek[0]!.text);
  assert.equal(b.top.peek[1]!.text, "Next: feat/y");
  assert.deepEqual(
    b.top.segments.map((s) => `${s.id}:${s.state}`),
    ["copy:passed", "merge:passed", "setup:skipped", "install:skipped", "docs:skipped", "check:unit:passed", "check:test:int:running", "check:build:waiting", "land:waiting", "main-checkout:waiting", "push:waiting"],
  );
  assert.equal(b.top.lines[0]!.text, "master 3f2a1c0 + feat/mesh-bar → 9b81e44");
  assert.ok(b.top.actions.some((a) => a.kind === "link" && a.label === "View Checks" && a.href === "#/projects/prj_a/merge-queue/mr_1"));
  assert.ok(b.top.actions.some((a) => a.kind === "link" && a.label === "Open Queue" && a.href === "#/projects/prj_a/merge-queue"));
});

test("no eta, or an eta already passed: no 'left'", () => {
  const r = run([step("check:unit", "check", "running")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  assert.equal(runNow(r, undefined, NOW), "step 6 of 9 · unit");
  assert.equal(runNow(r, { startsInMs: 0, takesMs: 1000 }, NOW), "step 6 of 9 · unit");
});

test("reruns fold into their check's segment, which runs again; never a segment of their own", () => {
  const r = run([step("copy", "copy", "passed"), step("check:unit", "check", "failed"), step("rerun-tip:unit", "rerun-tip", "running")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  assert.deepEqual(runSegments(r, { landsLocally: false }).map((s) => `${s.id}:${s.state}`), ["copy:passed", "merge:skipped", "setup:skipped", "install:skipped", "docs:skipped", "check:unit:running"]);
  const passed = run([step("check:unit", "check", "failed"), step("rerun-tip:unit", "rerun-tip", "passed")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  assert.deepEqual(checkSegs(passed).map((s) => s.state), ["passed"]);
  const master = run([step("check:unit", "check", "failed"), step("rerun-master:copy", "rerun-master", "passed"), step("rerun-master:unit", "rerun-master", "running")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  assert.deepEqual(checkSegs(master).map((s) => `${s.id}:${s.state}`), ["check:unit:running"]);
  assert.equal(runSegments(master).filter((s) => s.id.startsWith("rerun")).length, 0);
  const masterDone = run([step("check:unit", "check", "failed"), step("rerun-master:unit", "rerun-master", "passed")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  assert.deepEqual(checkSegs(masterDone).map((s) => s.state), ["failed"]);
  // While the rerun runs, the sub line still names its check.
  assert.equal(runNow(r, undefined, NOW), "step 6 of 9 · unit");
});

test("fixed steps: waiting before they run, skipped once a later step started; no push without origin; none after the checks for a request run", () => {
  const early = run([step("copy", "copy", "running")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  assert.deepEqual(runSegments(early).map((s) => `${s.id}:${s.state}`), ["copy:running", "merge:waiting", "setup:waiting", "install:waiting", "docs:waiting", "check:unit:waiting", "land:waiting", "main-checkout:waiting", "push:waiting"]);
  const setup = run([step("copy", "copy", "passed"), step("merge", "merge", "passed"), step("setup:db", "setup", "running")]);
  assert.deepEqual(runSegments(setup, { push: false }).map((s) => `${s.id}:${s.state}`), ["copy:passed", "merge:passed", "setup:db:running", "install:waiting", "docs:waiting", "land:waiting", "main-checkout:waiting", "push:skipped"]);
  assert.ok(!runSegments(setup, { landsLocally: false }).some((s) => s.id === "land"));
});

test("review is never a segment nor in the row: the detail and the hover card say it; notice never shows", () => {
  const r = run([step("check:unit", "check", "running"), step("review", "review", "running"), step("notice", "notice", "passed")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  const b = bar([proj({ queue: queue({ state: "running", current: r }) })])!;
  assert.deepEqual(b.top.segments.filter((s) => s.id.startsWith("check:")).map((s) => s.id), ["check:unit"]);
  assert.ok(!b.top.segments.some((s) => s.id === "review" || s.id === "notice"));
  assert.ok(!("review" in b.top));
  assert.ok(b.top.lines.some((l) => l.text === "Review running"));
  assert.ok(b.top.peek.some((l) => l.text === "Review running"));
});

test("a check added mid-run adds a segment and grows the total", () => {
  const checks = [{ id: "unit", label: "unit", source: "required" as const }];
  const before = run([step("check:unit", "check", "running")], { checks });
  assert.equal(runNow(before, undefined, NOW), "step 6 of 9 · unit");
  const after = run([step("check:unit", "check", "running")], { checks: [...checks, { id: "e2e", label: "e2e", source: "picked" as const }] });
  assert.equal(runNow(after, undefined, NOW), "step 6 of 10 · unit");
  assert.deepEqual(checkSegs(after).map((s) => s.id), ["check:unit", "check:e2e"]);
  // Started but not in the run's list (the list came before the pick): still counted, once.
  const started = run([step("check:unit", "check", "passed"), step("check:e2e", "check", "running")], { checks });
  assert.equal(runNow(started, undefined, NOW), "step 7 of 10 · e2e");
  assert.equal(checkSegs(started).length, 2);
});

test("merge needs-you while a landing runs: no chip and no count on the running bar, listed only in the detail", () => {
  const r = run([step("check:unit", "check", "running")]);
  const q = queue({ state: "running", current: r, needsYou: [entry({ id: "me_9", branch: "feat/flag", state: "review-flagged", reason: "the reviewer said blocking" })] });
  const b = bar([proj({ queue: q })])!;
  assert.equal(b.top.kind, "landing");
  assert.equal(b.top.count, undefined);
  assert.ok(!("needsChip" in b.top));
  assert.ok(!b.name.includes("needs you"), b.name);
  assert.ok(!b.top.peek.some((l) => l.text.includes("feat/flag")));
  assert.ok(b.top.lines.some((l) => l.text.startsWith("feat/flag · Review flagged")));
});

test("merge needs-you with nothing running takes the whole bar, in the tab's words, its actions opening the tab", () => {
  const q = queue({ needsYou: [entry({ id: "me_9", branch: "feat/flag", state: "behaviour-differs", run: "mr_7" })] });
  const b = bar([proj({ queue: q })])!;
  assert.equal(b.top.kind, "merge-needs");
  assert.equal(b.top.tone, "warn");
  assert.equal(b.top.title, "Behaviour differs · waiting for you");
  assert.equal(b.top.sub, "feat/flag");
  assert.ok(!b.top.lines.some((l) => l.text.startsWith("feat/flag")), "the detail doesn't repeat the face");
  const labels = b.top.actions.map((a) => a.label);
  assert.deepEqual(labels.slice(0, 2), ["Accept", "Send Back"]);
  for (const a of b.top.actions) assert.equal(a.kind, "link");
  assert.ok(b.top.actions.some((a) => a.kind === "link" && a.href === "#/projects/prj_a/merge-queue/mr_7"));
});

test("several merge needs-you with nothing running: the first takes the bar, the rest one short count", () => {
  const q = queue({ needsYou: [entry({ id: "me_8", branch: "feat/a", state: "drafts-changed" }), entry({ id: "me_9", branch: "feat/b", state: "review-flagged" })] });
  const b = bar([proj({ queue: q })])!;
  assert.equal(b.top.kind, "merge-needs");
  assert.equal(b.top.icon, "alert-circle");
  assert.deepEqual(b.top.count, { text: "+1", label: "1 more needs you" });
});

test("a conflict the thread is judging is not needs-you: at most a detail line", () => {
  const q = queue({ needsYou: [entry({ branch: "feat/c", state: "conflict" })] });
  assert.equal(bar([proj({ queue: q })]), null);
  const r = run([step("check:unit", "check", "running")]);
  const b = bar([proj({ queue: queue({ state: "running", current: r, needsYou: [entry({ branch: "feat/c", state: "conflict" })] }) })])!;
  assert.equal(b.top.count, undefined);
  assert.ok(b.top.lines.some((l) => l.text === "feat/c · conflict being judged"));
});

test("paused: always shown, even with nothing in line, with Resume Queue", () => {
  const b = bar([proj({ queue: queue({ state: "paused", paused: { kind: "operator", why: "", at: iso(0) } }) })])!;
  assert.equal(b.top.kind, "paused");
  assert.equal(b.top.title, "Paused by you");
  assert.ok(b.top.actions.some((a) => a.kind === "resume" && a.root === "/r/a"));
  assert.ok(b.top.actions.some((a) => a.label === "Open Queue"));
  const moved = bar([proj({ queue: queue({ state: "paused", paused: { kind: "master-moved", why: "master moved outside the queue: the run was voided", at: iso(0) } }) })])!;
  assert.equal(moved.top.sub, "master moved outside the queue: the run was voided");
  assert.ok(!moved.top.lines.some((l) => l.text.includes("the run was voided")), "the reason is said once");
});

test("definition-invalid: its own words, Open Queue only, no Resume", () => {
  const q = queue({ state: "paused", invalid: "$.merge: unknown key", paused: { kind: "definition-invalid", why: "x", at: iso(0) } });
  const b = bar([proj({ queue: q })])!;
  assert.equal(b.top.title, INVALID_TITLE);
  assert.equal(b.top.title, "Queue settings are broken: nothing runs until they are fixed");
  assert.deepEqual(b.top.actions.map((a) => a.label), ["Open Queue"]);
});

test("just landed: ~1 minute, pushed or not, the thread's note word for word; gone after", () => {
  const landed = (pushed: "pushed" | "not-pushed", msAgo: number, why?: string) =>
    queue({ recent: [{ entry: entry({ id: "me_5", branch: "feat/x", state: "landed", landed: { sha: TIP, from: SHA, at: iso(msAgo), pushed, ...(why ? { pushWhy: why } : {}) }, notes: [{ kind: "thread", text: "changes server code; restart Sova to pick it up", at: iso(0) }] }), run: { id: "mr_5", verdict: "passed", startedAt: iso(0) } }] });
  const b = bar([proj({ queue: landed("pushed", 10_000) })])!;
  assert.equal(b.top.title, "Landed feat/x");
  assert.equal(b.top.sub, "as 9b81e44 · pushed");
  assert.equal(b.top.tone, "success");
  assert.deepEqual(b.top.lines.map((l) => l.text), ["changes server code; restart Sova to pick it up"]);
  assert.deepEqual(b.top.peek.map((l) => l.text), ["changes server code; restart Sova to pick it up"], "the hover card carries the note");
  assert.equal(b.top.count, undefined);
  const np = bar([proj({ queue: landed("not-pushed", 10_000, "held for a release") })])!;
  assert.equal(np.top.sub, "as 9b81e44 · not pushed: held for a release");
  assert.equal(np.top.tone, "warn");
  assert.equal(bar([proj({ queue: landed("pushed", SHOWN_MS + 1) })]), null);
  // Seen long ago (a reload after it went): never shown again.
  assert.equal(bar([proj({ queue: landed("pushed", 10_000) })], new Map([["landed:me_5", NOW - SHOWN_MS - 5]])), null);
  // Its key is handed back so the store remembers it.
  assert.deepEqual(reduceLanding([proj({ queue: landed("pushed", 10_000) })], NOW).shown, ["landed:me_5"]);
});

test("the next run starting retires the landing before it at once", () => {
  const q = queue({ state: "running", current: run([step("copy", "copy", "running")]), recent: [{ entry: entry({ id: "me_5", state: "landed", landed: { sha: TIP, from: SHA, at: iso(5_000), pushed: "pushed" } }) }] });
  const r = reduceLanding([proj({ queue: q })], NOW);
  assert.equal(r.bar?.top.kind, "landing");
  assert.ok(r.retire.includes("landed:me_5"));
});

test("PR projects: 'Pull request opened · #N' for the minute; an open request waiting on the host doesn't keep the bar", () => {
  const req = entry({ id: "me_p", branch: "feat/pr", state: "requested", updatedAt: iso(5_000), request: { how: "github-pr", branch: "feat/pr", base: "main", number: 12, url: "https://github.com/o/r/pull/12" } });
  const b = bar([proj({ queue: queue({ waitingOnHost: [req] }) })])!;
  assert.equal(b.top.title, "Pull request opened · #12");
  assert.equal(b.top.tone, "success");
  const old = { ...req, updatedAt: iso(SHOWN_MS + 10) };
  assert.equal(bar([proj({ queue: queue({ waitingOnHost: [old] }) })]), null);
  // A host check bumping updatedAt later doesn't bring it back: the first sight starts its minute.
  assert.equal(bar([proj({ queue: queue({ waitingOnHost: [req] }) })], new Map([["host:me_p:requested", NOW - SHOWN_MS - 1]])), null);
  const pushed = entry({ id: "me_q", branch: "feat/q", state: "pushed", updatedAt: iso(1_000), request: { how: "push-branch", branch: "feat/q", base: "main" } });
  const pb = bar([proj({ queue: queue({ waitingOnHost: [pushed] }) })])!;
  assert.equal(pb.top.title, "Pushed feat/q");
  assert.equal(pb.top.sub, "on origin · opens into main");
});

const plan = (states: Partial<Record<string, ReleaseStep["state"]>> = {}): ReleaseStep[] => [
  rstep("version", states.version ?? "done"),
  rstep("changelog", states.changelog ?? "running"),
  rstep("commit", states.commit ?? "waiting"),
  { id: "checks", label: "Gating checks", phase: "sova", state: states.checks ?? "waiting" },
  rstep("tryout", states.tryout ?? "waiting", { phase: "check", held: true }),
  { id: "publish", label: "Publish", phase: "sova", state: states.publish ?? "waiting" },
  rstep("announce", states.announce ?? "waiting", { phase: "after" }),
  rstep("unpublish", "waiting", { phase: "withdraw" }),
];

test("release running: its step track in plan order, withdraw steps never; Step N of M; the frozen count", () => {
  const rel = release({ open: record({ steps: plan() }) });
  const b = bar([proj({ queue: queue({ waiting: [entry({ id: "w1" }), entry({ id: "w2" })] }), release: rel })])!;
  assert.equal(b.top.kind, "release");
  assert.equal(b.top.title, "Releasing v1.4.0");
  assert.equal(b.top.sub, "Step 2 of 7 · Changelog");
  assert.deepEqual(b.top.count, { text: "+2", label: "2 waiting for the release" });
  assert.ok(!b.top.peek.some((l) => l.text.includes("wait")), "the count says it, once");
  const alone = bar([proj({ release: rel })])!;
  assert.equal(alone.top.count, undefined, "nothing waiting: no count");
  assert.ok(alone.top.peek.some((l) => l.text === "Landings wait until it publishes"));
  assert.deepEqual(b.top.segments.map((s) => s.id), ["version", "changelog", "commit", "checks", "tryout", "publish", "announce"]);
  assert.ok(b.top.actions.some((a) => a.label === "Open Releases" && a.kind === "link" && a.href === "#/projects/prj_a/releases"));
  assert.ok(b.top.actions.some((a) => a.label === "Open Release Chat"));
  const unnamed = bar([proj({ release: release({ open: record({ version: null, tag: null, steps: plan({ version: "running", changelog: "waiting" }) }) }) })])!;
  assert.equal(unnamed.top.title, "Releasing a new version");
});

test("release gating checks: the segment carries the queue run's progress and the sub line its check", () => {
  const r = run([step("check:unit", "check", "passed"), step("check:build", "check", "running")], { id: "mr_r", entry: "me_rel", checks: [{ id: "unit", label: "unit", source: "release" }, { id: "build", label: "build", source: "release" }] });
  const rec = record({ entry: "me_rel", state: "checking", steps: plan({ changelog: "done", commit: "done", checks: "running" }).map((s) => (s.id === "checks" ? { ...s, run: "mr_r" } : s)) });
  const b = bar([proj({ queue: queue({ state: "running", current: r }), release: release({ open: rec }) })])!;
  assert.equal(b.top.kind, "release");
  assert.equal(b.top.sub, "Step 4 of 7 · Gating checks · step 7 of 7 · build");
  assert.equal(b.top.segments.find((s) => s.id === "checks")?.progress, 0.5);
});

test("a held release step is warn and needs you, with Continue in place; a failed one Retry Step", () => {
  const held = bar([proj({ release: release({ open: record({ state: "checking", steps: plan({ changelog: "done", commit: "done", checks: "done", tryout: "held" }) }) }) })])!;
  assert.equal(held.top.kind, "release-needs");
  assert.equal(held.top.tone, "warn");
  assert.equal(held.top.title, "Tryout is held for you");
  assert.equal(held.top.segments.find((s) => s.id === "tryout")?.state, "held");
  assert.ok(held.top.actions.some((a) => a.kind === "continue" && a.step === "tryout" && a.release === "rl_abcdef"));
  const failed = bar([proj({ release: release({ open: record({ steps: plan({ changelog: "failed" }) }) }) })])!;
  assert.equal(failed.top.title, "Changelog failed");
  assert.ok(failed.top.actions.some((a) => a.kind === "retry" && a.step === "changelog"));
  // Publish and Abandon are never in the bar.
  for (const a of [...held.top.actions, ...failed.top.actions]) assert.ok(!/Publish|Abandon/.test(a.label));
});

test("ready to publish, the power's countdown, a quiet chat", () => {
  const ready = record({ state: "ready", steps: plan({ changelog: "done", commit: "done", checks: "done", tryout: "done" }), power: { heldUntil: new Date(NOW + 161_000).toISOString(), act: "publish" } });
  const b = bar([proj({ release: release({ open: ready, gates: { checksPassed: true, stepsDone: true, notes: true, why: [] } }) })])!;
  assert.equal(b.top.title, "Ready to publish · v1.4.0");
  assert.equal(b.top.sub, "Publishes in 2:41");
  const quiet = bar([proj({ release: release({ open: record({ steps: plan() }), quiet: { minutes: 30 } }) })])!;
  assert.equal(quiet.top.title, "No word from the release chat for 30 min");
});

test("published: its minute, pushed or this machine only; after steps keep it; a failed after step needs you", () => {
  const pub = (states: Partial<Record<string, ReleaseStep["state"]>>, msAgo: number, pushed: "pushed" | "no-remote" = "pushed") =>
    release({ last: record({ state: "published", steps: plan({ changelog: "done", commit: "done", checks: "done", tryout: "done", publish: "done", ...states }), publish: { at: iso(msAgo), by: "operator", pushed, channelsFrom: {} } }) });
  assert.equal(bar([proj({ release: pub({ announce: "done" }, 5_000) })])!.top.title, "Published v1.4.0");
  assert.equal(bar([proj({ release: pub({ announce: "done" }, 5_000) })])!.top.sub, "pushed to origin");
  assert.equal(bar([proj({ release: pub({ announce: "done" }, 5_000, "no-remote") })])!.top.sub, "on this machine only");
  assert.equal(bar([proj({ release: pub({ announce: "done" }, SHOWN_MS + 1) })]), null);
  assert.equal(bar([proj({ release: pub({ announce: "running" }, SHOWN_MS * 5) })])!.top.title, "Published, finishing · Announce");
  const f = bar([proj({ release: pub({ announce: "failed" }, SHOWN_MS * 5) })])!;
  assert.equal(f.top.kind, "release-needs");
  assert.ok(f.top.actions.some((a) => a.kind === "retry"));
});

test("priority across projects: release needs-you > merge needs-you > release > landing > paused > landed; +N project", () => {
  const landing = proj({ id: "p_land", name: "land", queue: queue({ state: "running", current: run([step("copy", "copy", "running")]) }) });
  const paused = proj({ id: "p_pause", name: "pause", queue: queue({ state: "paused", paused: { kind: "operator", why: "", at: iso(0) } }) });
  const landed = proj({ id: "p_done", name: "done", queue: queue({ recent: [{ entry: entry({ id: "me_d", state: "landed", landed: { sha: TIP, from: SHA, at: iso(1000), pushed: "pushed" } }) }] }) });
  const rel = proj({ id: "p_rel", name: "rel", release: release({ open: record({ steps: plan() }) }) });
  const mneeds = proj({ id: "p_mn", name: "mn", queue: queue({ needsYou: [entry({ state: "drafts-changed" })] }) });
  const rneeds = proj({ id: "p_rn", name: "rn", release: release({ open: record({ steps: plan({ changelog: "failed" }) }) }) });
  const order = [landed, paused, landing, rel, mneeds, rneeds];
  const kinds: string[] = [];
  for (let i = order.length; i > 0; i--) kinds.push(bar(order.slice(0, i))!.top.project);
  assert.deepEqual(kinds, ["p_rn", "p_mn", "p_rel", "p_land", "p_pause", "p_done"]);
  const two = bar([landed, landing])!;
  assert.equal(two.top.project, "p_land");
  assert.equal(two.more, 1);
  assert.equal(two.top.count, undefined, "the other projects are no count on the row");
  assert.ok(!two.name.includes("project"), "the other projects are in the hover card and the detail only");
  assert.deepEqual(two.all.map((b) => b.project), ["p_land", "p_done"]);
  assert.equal(bar([landed, landing, paused])!.more, 2);
});

test("a release takes its project's bar over the queue's landing (q4)", () => {
  const r = run([step("check:unit", "check", "running")]);
  const b = bar([proj({ queue: queue({ state: "running", current: r }), release: release({ open: record({ steps: plan() }) }) })])!;
  assert.equal(b.all.length, 1);
  assert.equal(b.top.kind, "release");
});

test("the accessible name says the title and the sub line", () => {
  const b = bar([proj({ queue: queue({ state: "paused", paused: { kind: "operator", why: "", at: iso(0) } }) })])!;
  assert.equal(b.name, "Paused by you. Nothing in line");
  const r = run([step("check:unit", "check", "running")], { checks: [{ id: "unit", label: "unit", source: "required" }] });
  const l = bar([proj({ queue: queue({ state: "running", current: r, waiting: [entry({ id: "w" })] }) })])!;
  assert.equal(l.name, "Landing feat/mesh-bar. step 6 of 9 · unit. 1 in line");
});

/** The counter counts every segment drawn: M is the track's length, N the running (or next waiting) one's place. */
function assertCounter(r: MergeRun, o: { landsLocally?: boolean; push?: boolean }, id: string) {
  const segs = runSegments(r, o);
  const m = /^step (\d+) of (\d+) · (.+)$/.exec(runNow(r, undefined, NOW, o));
  assert.ok(m, runNow(r, undefined, NOW, o));
  assert.equal(Number(m[2]), segs.length);
  const i = segs.findIndex((s) => s.id === id);
  assert.ok(i >= 0, id);
  assert.equal(Number(m[1]), i + 1);
  assert.equal(m[3], segs[i]!.label);
}

test("the counter counts every segment: usual run, installing, no push, a check added mid-run, between steps", () => {
  const checks = [{ id: "unit", label: "unit", source: "required" as const }, { id: "build", label: "build", source: "required" as const }];
  const usual = run([step("copy", "copy", "passed"), step("merge", "merge", "passed"), step("check:unit", "check", "running")], { checks });
  assertCounter(usual, {}, "check:unit");
  assert.deepEqual(runSegments(usual).filter((s) => s.state === "skipped").map((s) => s.id), ["setup", "install", "docs"]);
  const installs = run([step("copy", "copy", "passed"), step("merge", "merge", "passed"), step("install", "install", "running")], { checks });
  assertCounter(installs, {}, "install");
  const noPush = run([step("copy", "copy", "passed"), step("check:unit", "check", "passed"), step("check:build", "check", "running")], { checks });
  assertCounter(noPush, { push: false }, "check:build");
  assert.equal(runSegments(noPush, { push: false }).at(-1)!.state, "skipped");
  const before = runSegments(usual).length;
  const added = run(usual.steps, { checks: [...checks, { id: "e2e", label: "e2e", source: "picked" as const }] });
  assertCounter(added, {}, "check:unit");
  assert.equal(runSegments(added).length, before + 1);
  const between = run([step("copy", "copy", "passed"), step("merge", "merge", "passed"), step("check:unit", "check", "passed")], { checks });
  assertCounter(between, {}, "check:build");
  assert.equal(runNow(run([], { checks }), undefined, NOW), "Starting");
});
