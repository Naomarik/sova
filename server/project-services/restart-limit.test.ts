import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { HOUR_MS, HOURLY_LIMIT, RESTART_BURST, STABLE_RUN_SEC, SystemdDriver, type RestartFacts } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { assess, freshRecord, LIMIT_BUSY_TICK_MS, LIMIT_TICK_MS, limitsDir, readLimit, restartingOf, watchBusy, type LimitRecord, type Reached } from "./restart-limit";
import { readRegistry } from "./store";
import { FakeSystemd, referenceCount, SimUnit, type SimLimits } from "./systemd-sim.test.helper";

/**
 * The restart limit (§app.project-services/supervisor) as Sova's server holds a systemd unit to it: the count
 * from systemd's own facts against the rule as the spec words it, over failures that come and go between two
 * looks (restart-limit.ts), then the watch, status, the startup pass and the verbs that clear it, on a systemd
 * in memory (systemd-sim.test.helper.ts). The detached driver's own count: drivers.integration.test.ts.
 */

after(dropScratchAgentDir);

const T0 = 1_700_000_000_000;
const S = 1_000;

type Counter = (prev: LimitRecord | null, f: RestartFacts, now: number) => { rec: LimitRecord; reached: Reached | null };

interface Scenario {
  name: string;
  /** How long its n-th run stays up before it fails (null: for good). */
  run: (n: number) => number | null;
  limits?: SimLimits;
  /** Sova started it (a fresh count at its start), or found it running with no record (a unit from before the watch). */
  record?: "fresh" | "none";
  /** When the watch first looks, after the unit's start. */
  firstLook?: number;
  /** No looks in [from, to): the server is down, its record kept. */
  gap?: [number, number];
  /** The give-up the rule says, and how many tries (undefined: whatever the reference counts at that look). */
  expect: { rule: Reached["rule"]; tries?: number } | null;
}

const quick = () => 400;
const LEGACY: SimLimits = { burst: 5, intervalMs: 10 * S };

const SCENARIOS: Scenario[] = [
  { name: "quick failures, faster than the tick: exactly 5 in a row", run: quick, expect: { rule: "in-a-row", tries: 5 } },
  { name: "quick failures of a unit with the old 10 s start limit, which never trips", run: quick, limits: LEGACY, expect: { rule: "in-a-row", tries: 5 } },
  { name: "4 s runs", run: () => 4 * S, expect: { rule: "in-a-row", tries: 5 } },
  { name: "runs just under the stable run", run: () => STABLE_RUN_SEC * S - 1, expect: { rule: "in-a-row", tries: 5 } },
  // Under the old 10 s limit: the new one's 310 s ties with five 62 s cycles and stops it first (systemd's own limit, as the next one).
  { name: "runs exactly the stable run: each failure a fresh count, the hour catches it", run: () => STABLE_RUN_SEC * S, limits: LEGACY, expect: { rule: "in-an-hour", tries: HOURLY_LIMIT } },
  { name: "runs exactly the stable run under the new start limit, which ties and stops it first", run: () => STABLE_RUN_SEC * S, expect: { rule: "system-limit", tries: 5 } },
  { name: "slow crashers, 10 within the hour", run: () => 300 * S, expect: { rule: "in-an-hour", tries: HOURLY_LIMIT } },
  { name: "slower crashers never fit 10 in an hour", run: () => 400 * S, expect: null },
  // Mixes under the old limit: the new one counts starts within 310 s whatever ran between, so it stops these first (the next one).
  { name: "a mix: 4 quick, a stable run, then quick", run: (n) => (n === 4 ? (STABLE_RUN_SEC + 1) * S : 400), limits: LEGACY, expect: { rule: "in-a-row", tries: 5 } },
  { name: "a mix: quick failures between stable runs, 10 in the hour", run: (n) => (n % 4 === 3 ? (STABLE_RUN_SEC + 1) * S : 4 * S), limits: LEGACY, expect: { rule: "in-an-hour", tries: HOURLY_LIMIT } },
  { name: "a mix under the new start limit, which stops it first", run: (n) => (n === 4 ? (STABLE_RUN_SEC + 1) * S : 400), expect: { rule: "system-limit", tries: 5 } },
  { name: "a server restart mid-count: the record carries it on", run: () => 4 * S, gap: [5 * S, 17 * S], expect: { rule: "in-a-row", tries: 5 } },
  { name: "systemd's own limit stops it while the server is down", run: quick, gap: [3 * S, 40 * S], expect: { rule: "system-limit", tries: 5 } },
  { name: "the old start limit, looping while the server is down", run: quick, limits: LEGACY, gap: [3 * S, 40 * S], expect: { rule: "in-a-row" } },
  { name: "found looping at a server start, no record: counted from the first look, to exactly 5", run: quick, limits: LEGACY, record: "none", firstLook: 30 * S, expect: { rule: "in-a-row", tries: 5 } },
  { name: "found with no record, up and stable after old failures: no give-up", run: (n) => (n < 7 ? 400 : null), limits: LEGACY, record: "none", firstLook: 30 * 60 * S, expect: null },
];
const PHASES = [0, 250, 500, 1_000, 1_700, 3_300, 9_900];

/** The watch over one unit, a look a tick apart (sooner while it is failing or in a try), until a give-up or 3 hours:
    where the count first differs from the reference's, and the give-up with the reference's at that look. */
function watch(sc: Scenario, phase: number, counter: Counter = assess) {
  const u = new SimUnit(T0, sc.run, sc.limits);
  let rec: LimitRecord | null = sc.record === "none" ? null : freshRecord(T0);
  let t = T0 + (sc.firstLook ?? 0) + phase;
  // Found with no record: when its earlier failures happened is unknowable, so only those from the run it is in (or
  // failed) at the first look on count: a service that failed now and then never gives up on old restarts. The
  // reference leaves them out too, on purpose.
  const since = sc.record === "none" ? u.facts(t).startAt! : Number.NEGATIVE_INFINITY;
  while (t <= T0 + 3 * HOUR_MS) {
    let busy = false;
    if (!sc.gap || t < T0 + sc.gap[0] || t >= T0 + sc.gap[1]) {
      const ref = referenceCount(u, t, since);
      // The record goes through its file's JSON, as across a server restart.
      const a = counter(rec && (JSON.parse(JSON.stringify(rec)) as LimitRecord), u.facts(t), t);
      const at = `${(t - T0) / S} s`;
      if (a.reached || ref.rule) return { at, got: a.reached, want: ref };
      if (a.rec.inRow !== ref.inRow || a.rec.recent.length !== ref.recent) return { at, differs: { got: [a.rec.inRow, a.rec.recent.length], want: [ref.inRow, ref.recent] } };
      rec = a.rec;
      busy = watchBusy(a.rec, u.facts(t), t);
    }
    t += busy ? LIMIT_BUSY_TICK_MS : LIMIT_TICK_MS;
  }
  return { at: "never", got: null, want: null };
}

test("the count follows the rule exactly, from systemd's facts, whatever happens between two looks", () => {
  for (const sc of SCENARIOS)
    for (const phase of PHASES) {
      const w = watch(sc, phase);
      const where = `${sc.name} (first look +${phase} ms), at ${w.at}`;
      assert.equal(w.differs, undefined, `${where}: the count differs from the rule's: ${JSON.stringify(w.differs)}`);
      assert.equal(w.got?.rule ?? null, w.want?.rule ?? null, `${where}: gave up as the rule says`);
      assert.equal(w.got?.rule ?? null, sc.expect?.rule ?? null, `${where}: the scenario's give-up`);
      if (!w.got || !w.want) continue;
      const refTries = w.want.rule === "system-limit" ? 5 : w.want.rule === "in-a-row" ? w.want.inRow : w.want.recent;
      assert.equal(w.got.tries, refTries, `${where}: tries`);
      if (sc.expect?.tries !== undefined) assert.equal(w.got.tries, sc.expect.tries, `${where}: counted exactly to the limit`);
    }
});

test("a counter that samples the unit's state instead misses failures between its looks", () => {
  // The stand-in the promise forbids: one failure per look that finds the unit failing on a run not yet counted.
  const sampling: Counter = (prev, f, now) => {
    const rec = { ...(prev ?? freshRecord(now)), at: now };
    if (f.failing && f.startAt !== rec.runAt) {
      rec.inRow++;
      rec.runAt = f.startAt;
    }
    return { rec, reached: rec.inRow >= RESTART_BURST ? { rule: "in-a-row", tries: rec.inRow, at: now, exit: f.exit } : null };
  };
  const misses = PHASES.filter((p) => watch(SCENARIOS[1]!, p, sampling).differs || watch(SCENARIOS[1]!, p, sampling).got?.tries !== 5);
  assert.ok(misses.length > 0, "the rule check catches it");
});

test("no record (a unit from before the watch): its old restarts never count, only the failure its facts prove", () => {
  const now = T0 + 30 * 24 * HOUR_MS;
  // Flaky over weeks, 7 restarts, back up 10 s ago: nothing to give up on, no try shown.
  const up = assess(null, { restarts: 7, failing: false, limitHit: false, startAt: now - 10 * S, exitAt: now - 12 * S, exit: 3, burst: 5 }, now);
  assert.equal(up.reached, null);
  assert.equal(restartingOf(up.rec.inRow), undefined);
  // Failing now after days up: one failure, try 2 waited for.
  const down = assess(null, { restarts: 7, failing: true, limitHit: false, startAt: now - 3 * 24 * HOUR_MS, exitAt: now - S, exit: 3, burst: 5 }, now);
  assert.equal(down.reached, null);
  assert.deepEqual(restartingOf(down.rec.inRow), { try: 2, of: 5 });
  // Failing now after a quick run: still only the one it proves.
  assert.equal(assess(null, { restarts: 40, failing: true, limitHit: false, startAt: now - 1_400, exitAt: now - S, exit: 3, burst: 5 }, now).rec.inRow, 1);
});

test("restarting: the try under way or waited for is the failures in a row plus 1, while within the limit", () => {
  assert.equal(restartingOf(0), undefined);
  for (let n = 1; n < RESTART_BURST; n++) assert.deepEqual(restartingOf(n), { try: n + 1, of: 5 });
  assert.equal(restartingOf(RESTART_BURST), undefined, "at the limit it gave up");
});

// ---- the watch, status and the verbs, on a systemd in memory ------------------------------------------

const op: Caller = { kind: "operator" };
const host = new FakeHost();
const systemd = new FakeSystemd(() => host.clock.now());
const newEngine = () => new ProjectEngine(host.deps({ driver: new SystemdDriver(systemd.exec) }));
let engine: ProjectEngine;
let parent = "";
let demo = "";
let unit = "";
let inst = "";

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-restart-limit-")));
  demo = join(parent, "demo");
  mkdirSync(join(demo, ".sova"), { recursive: true });
  writeFileSync(join(demo, ".sova", "project.json"), JSON.stringify({ version: 1, slots: { cap: 2 }, services: { web: { cmd: ["node", "web.mjs"] } } }));
  writeFileSync(join(demo, "web.mjs"), "");
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: demo });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = newEngine();
});
after(() => rmSync(parent, { recursive: true, force: true }));

/** Step the clock as the watch's timer would and look, until `done` or `max` looks; the first look comes soon, as after
    a start (or the server's own start). */
async function looks(e: ProjectEngine, done: (did: string[]) => boolean | Promise<boolean>, max = 200): Promise<string[]> {
  const all: string[] = [];
  let busy = true;
  for (let i = 0; i < max; i++) {
    await host.clock.sleep(busy ? LIMIT_BUSY_TICK_MS : LIMIT_TICK_MS);
    const t = await e.limitTick();
    all.push(...t.did);
    busy = t.busy;
    if (await done(t.did)) break;
  }
  return all;
}
const web = async (e = engine) => (await e.run("status", { instance: inst }, op)).services.find((s) => s.name === "web")!;
const GAVE_UP = "failed 5 times in a row and stopped retrying; it waits to be started again";

test("the watch gives up on a crash loop at its 5th failure in a row: status says restarting, then failed with the give-up; its unit is stopped", async () => {
  const up = await engine.run("up", { project: demo }, op);
  assert.equal(up.ok, true, up.error?.message);
  inst = up.instance!;
  unit = engine.unitOf(inst, "web");
  assert.equal(readLimit(unit)?.seen, 0, "a start is a fresh count");
  const sim = systemd.units.get(unit)!;
  sim.behave(host.clock.now(), quick);
  // Its first failure, waiting 2 s to start again: status reads systemd's facts, before any look of the watch.
  await host.clock.sleep(S);
  const first = await web();
  assert.deepEqual([first.state, first.restarting], ["starting", { try: 2, of: 5 }]);
  const seen = new Set<string>();
  const did = await looks(engine, async (d) => {
    const s = await web();
    seen.add(`${s.state}${s.restarting ? `: try ${s.restarting.try} of ${s.restarting.of}` : ""}`);
    return d.length > 0;
  });
  assert.deepEqual(did, [`${unit}: ${GAVE_UP}`]);
  // Between its tries `restarting`; while a try's run is up and serving, none.
  assert.ok(seen.has("starting: try 5 of 5"), [...seen].join(", "));
  assert.ok(seen.has("ready") && ![...seen].some((x) => x.startsWith("ready:")), [...seen].join(", "));
  assert.ok(readRegistry().instances.find((i) => i.id === inst)!.giveUps?.web, "recorded in Sova's record of the copy");
  assert.equal(systemd.units.has(unit), false, "nothing of it left running: stopped and unloaded");
  const s = await web();
  assert.equal(s.state, "failed");
  assert.equal(s.gaveUp, true);
  assert.equal(s.detail, GAVE_UP);
  assert.equal(s.restarting, undefined);
  assert.deepEqual(s.giveUp, {
    rule: "in-a-row",
    tries: 5,
    at: new Date(sim.runs[4]!.end!).toISOString(),
    exit: 3,
    lines: ["run 3 failed: boom", "run 4 up", "run 4 failed: boom", "run 5 up", "run 5 failed: boom"],
  });
});

test("through a server restart: still failed, the startup pass leaves it failed and starts nothing; up runs it again with a fresh count", async () => {
  engine = newEngine();
  const gen = readRegistry().instances.find((i) => i.id === inst)!.generation;
  const did = await engine.reconcile();
  assert.ok(did.includes(`${inst}: left web failed (it gave up restarting; it starts again on up)`), JSON.stringify(did));
  assert.equal(systemd.units.has(unit), false, "not started again");
  assert.equal(readRegistry().instances.find((i) => i.id === inst)!.generation, gen);
  assert.deepEqual(await looks(engine, () => false, 3), [], "the watch leaves it");
  assert.equal((await web()).giveUp?.rule, "in-a-row");
  systemd.lengthOf = () => () => null;
  const up = await engine.run("up", { instance: inst }, op);
  assert.equal(up.ok, true, up.error?.message);
  const s = await web();
  assert.equal(s.state, "ready");
  assert.equal(s.gaveUp, undefined);
  assert.equal(s.giveUp, undefined);
  assert.equal(readRegistry().instances.find((i) => i.id === inst)!.giveUps, undefined, "the give-up is cleared");
  assert.equal(readLimit(unit)?.inRow, 0);
});

test("a server restart mid-count: the count goes on from the record, to exactly 5", async () => {
  systemd.units.get(unit)!.behave(host.clock.now(), () => 4 * S);
  await looks(engine, () => (readLimit(unit)?.inRow ?? 0) >= 3);
  assert.equal(readLimit(unit)?.inRow, 3);
  engine = newEngine();
  const did = await looks(engine, (d) => d.length > 0);
  assert.deepEqual(did, [`${unit}: ${GAVE_UP}`]);
});

test("down clears the give-up: stopped, and the startup pass leaves it stopped", async () => {
  const down = await engine.run("down", { instance: inst }, op);
  assert.equal(down.ok, true, down.error?.message);
  const s = await web();
  assert.equal(s.state, "stopped");
  assert.equal(s.giveUp, undefined);
  assert.equal(existsSync(join(limitsDir(), `${unit}.json`)), false, "nothing of its count is kept");
  assert.equal(readRegistry().instances.find((i) => i.id === inst)!.giveUps, undefined);
  assert.ok(!(await newEngine().reconcile()).some((d) => d.includes("web")), "nothing to start or leave");
});

test("an apply restart is a fresh count", async () => {
  systemd.lengthOf = () => () => null;
  assert.equal((await engine.run("up", { instance: inst }, op)).ok, true);
  systemd.units.get(unit)!.behave(host.clock.now(), () => 4 * S);
  await looks(engine, () => (readLimit(unit)?.inRow ?? 0) >= 3);
  systemd.lengthOf = () => () => null;
  const ap = await engine.run("apply", { instance: inst, restart: true }, op);
  assert.equal(ap.ok, true, ap.error?.message);
  assert.equal(readLimit(unit)?.inRow, 0);
  assert.equal((await web()).restarting, undefined);
});

test("a unit from before the watch (the old 10 s start limit), already looping at a server start, is counted from the first look and gives up at exactly 5; another state root's units are never touched", async () => {
  assert.equal((await engine.run("down", { instance: inst }, op)).ok, true);
  // Loaded as an older server left it: looping 0.4 s / 2 s under the old limit, which never trips; no count record.
  systemd.load(unit, new SimUnit(host.clock.now() - 30 * S, quick, LEGACY));
  const foreign = unit.replace(/^sova-svc-[0-9a-f]{6}-/, "sova-svc-ffffff-");
  systemd.load(foreign, new SimUnit(host.clock.now() - 30 * S, quick, LEGACY));
  engine = newEngine();
  const did = await looks(engine, (d) => d.length > 0, 30);
  assert.deepEqual(did, [`${unit}: ${GAVE_UP}`]);
  assert.equal(systemd.units.has(unit), false);
  assert.equal(systemd.units.has(foreign), true, "another Sova's unit runs on");
  assert.ok(!systemd.calls.some((c) => c.some((a) => a.includes("ffffff"))), "never even read");
});

test("a unit from before the watch that failed now and then over weeks, back up 10 s ago: never given up on, no try shown", async () => {
  assert.equal((await engine.run("down", { instance: inst }, op)).ok, true);
  const DAY = 24 * HOUR_MS;
  // Seven runs of a day each, each failing, then the eighth, up for good, started 10 s ago.
  systemd.load(unit, new SimUnit(host.clock.now() - 7 * (DAY + 2 * S) - 10 * S, (n) => (n < 7 ? DAY : null), LEGACY));
  assert.equal(systemd.units.get(unit)!.facts(host.clock.now()).restarts, 7);
  engine = newEngine();
  assert.deepEqual(await looks(engine, () => false, 20), []);
  assert.equal(systemd.units.has(unit), true, "it runs on");
  assert.equal(readLimit(unit)?.inRow, 0);
});
