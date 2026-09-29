// Run: npx tsx --test server/resource-monitor-attrib.test.ts
// CPU fold, joins and sid memory (§app.resource-monitor/attribution); pure, no I/O.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claudeSessionId } from "../pi-config/extensions/claude-code/provider/session-records.ts";
import {
  attribute, cpuKey, foldCpu, SidMemory, type AttribProc, type CpuPrev, type CpuSample, type HostedInfo,
} from "./resource-monitor-attrib";
import { classifyArgv, type ProcEnv, type ProcStat } from "./resource-monitor-proc";

const st = (pid: number, ppid: number, o: Partial<ProcStat> = {}): ProcStat => ({
  pid, ppid, comm: "x", state: "S", pgid: o.sid ?? pid, sid: pid, utime: 0, stime: 0, cutime: 0, cstime: 0, starttime: 1000 + pid, rss: 10, ...o,
});
const sample = (s: ProcStat, fresh = false): CpuSample => ({ key: cpuKey(s), stat: s, fresh });
const delta = (f: ReturnType<typeof foldCpu>, s: ProcStat) => f.own.get(cpuKey(s))! + f.kids.get(cpuKey(s))!;

describe("foldCpu", () => {
  test("a child that lived and died between two ticks counts once, through its parent's cutime", () => {
    const worker = st(10, 1, { utime: 100 });
    let f = foldCpu(new Map(), [sample(worker)]);
    // 3s of tsc (300 ticks) ran and was reaped between ticks: only the worker's cutime shows it.
    f = foldCpu(f.next, [sample({ ...worker, utime: 110, cutime: 300 })]);
    assert.equal(delta(f, worker), 10 + 300);
  });

  test("a child seen alive and then reaped is not counted twice", () => {
    const parent = st(10, 1);
    const child = st(11, 10, { utime: 50 });
    let f = foldCpu(new Map(), [sample(parent), sample(child)]);
    f = foldCpu(f.next, [sample(parent), sample({ ...child, utime: 80 })]);
    assert.equal(delta(f, child), 30);
    // The child ran 20 more ticks and exited; the parent reaped its whole 100.
    f = foldCpu(f.next, [sample({ ...parent, cutime: 100 })]);
    assert.equal(delta(f, parent), 20, "only the part no earlier tick counted");
  });

  test("a vanished grandchild's deduction goes to its nearest live ancestor", () => {
    const a = st(10, 1), b = st(11, 10), c = st(12, 11, { utime: 40 });
    let f = foldCpu(new Map(), [sample(a), sample(b), sample(c)]);
    // b and c both gone; a reaped b, whose cutime held c's 40 plus 5 more.
    f = foldCpu(f.next, [sample({ ...a, cutime: 45 })]);
    assert.equal(delta(f, a), 5);
  });

  test("an escaped child reaped by the subreaper: the parent's delta is clamped at 0, never negative", () => {
    const parent = st(10, 1, { utime: 10 });
    const child = st(11, 10, { utime: 500 });
    let f = foldCpu(new Map(), [sample(parent), sample(child)]);
    f = foldCpu(f.next, [sample({ ...parent, utime: 12 })]);
    assert.equal(f.own.get(cpuKey(parent)), 2);
    assert.equal(f.kids.get(cpuKey(parent)), 0);
  });

  test("a parent not re-read (stale) keeps its reaped child's deduction until its next read", () => {
    const parent = st(10, 1);
    const child = st(11, 10, { utime: 60 });
    let f = foldCpu(new Map(), [sample(parent), sample(child)]);
    // The child exits while the parent is skipped: nothing is charged, the 60 is owed.
    f = foldCpu(f.next, [{ ...sample(parent), stale: true }]);
    assert.equal(delta(f, parent), 0);
    assert.equal(f.next.get(cpuKey(parent))!.pending, 60);
    // Next real read: the reaped 75 (60 already counted + 15 new) charges only the 15.
    f = foldCpu(f.next, [sample({ ...parent, cutime: 75 })]);
    assert.equal(delta(f, parent), 15);
    assert.equal(f.next.get(cpuKey(parent))!.pending, undefined);
  });

  test("a stale process that exits passes what it owed up to its own parent", () => {
    const a = st(10, 1), b = st(11, 10), c = st(12, 11, { utime: 40 });
    let f = foldCpu(new Map(), [sample(a), sample(b), sample(c)]);
    f = foldCpu(f.next, [sample(a), { ...sample(b), stale: true }]); // c exits; b owes 40
    f = foldCpu(f.next, [sample({ ...a, cutime: 50 })]); // b exits; a reaps b (10 own + c's 40)
    assert.equal(delta(f, a), 10);
  });

  test("first sighting: a fresh process counts its whole life, an old one is a baseline", () => {
    const fresh = st(20, 1, { utime: 70, cutime: 30 });
    const old = st(21, 1, { utime: 99999 });
    const f = foldCpu(new Map(), [sample(fresh, true), sample(old)]);
    assert.equal(delta(f, fresh), 100);
    assert.equal(delta(f, old), 0);
  });

  test("a reused pid is a new process (keyed by pid and starttime)", () => {
    const first = st(30, 1, { utime: 1000, starttime: 5 });
    let f = foldCpu(new Map(), [sample(first)]);
    const reused = st(30, 1, { utime: 3, starttime: 900 });
    f = foldCpu(f.next, [sample(reused, true)]);
    assert.equal(delta(f, reused), 3);
    assert.ok(![...f.next.keys()].includes(cpuKey(first)));
  });
});

// ── attribution ──────────────────────────────────────────────────────────────────────────────

const SERVER = 100;
const proc = (s: ProcStat, argv: string[] = ["node", "x.js"], env: ProcEnv = {}, cwd?: string): AttribProc =>
  ({ stat: s, argv: classifyArgv(argv), env, ...(cwd ? { cwd } : {}) });
const table = (...ps: AttribProc[]) => new Map(ps.map((p) => [p.stat.pid, p]));
const hostedA = (over: Partial<HostedInfo> = {}): HostedInfo => ({
  path: "/s/a.jsonl", sessionId: "sess-a", cwd: "/work/a", workers: [], providerIds: [0, 1, 2].map((n) => claudeSessionId("sess-a", n)),
  toolInWindow: false, ...over,
});
const run = (procs: Map<number, AttribProc>, hosted: HostedInfo[], extra: { live?: Map<number, string>; sids?: SidMemory; serverEnv?: { sessionFile?: string } } = {}) =>
  attribute({ procs, serverPid: SERVER, hosted, liveRecordPids: extra.live ?? new Map(), sids: extra.sids ?? new SidMemory(new Set([SERVER])),
    ...(extra.serverEnv ? { serverEnv: extra.serverEnv } : {}) });

describe("attribute", () => {
  test("worker pid from the in-process event; its tool children (a JVM REPL) are its descendants", () => {
    const procs = table(
      proc(st(SERVER, 1), ["node", "server/index.ts"]),
      proc(st(200, SERVER), ["claude", "-p", "--model", "opus"]), // a fresh claude worker: no uuid in argv
      proc(st(201, 200), ["zsh", "-c", "clojure -M:test"]),
      proc(st(202, 201), ["java", "-cp", "x.jar", "clojure.main"]),
    );
    const { owners, inTree } = run(procs, [hostedA({ workers: [{ id: "ag_01", pid: 200 }] })]);
    assert.deepEqual(owners.get(200), { session: "/s/a.jsonl", worker: "ag_01", via: "worker-pid" });
    assert.deepEqual(owners.get(202), { session: "/s/a.jsonl", worker: "ag_01", via: "descendant" });
    assert.deepEqual([...inTree].sort(), [200, 201, 202]);
  });

  test("claude uuids: a worker's --resume id, and a hosted session's provider via claudeSessionId(id, n)", () => {
    const provider = claudeSessionId("sess-a", 2);
    const procs = table(
      proc(st(SERVER, 1)),
      proc(st(300, SERVER), ["claude", "-p", "--resume", "11111111-2222-3333-4444-555555555555"]),
      proc(st(301, SERVER), ["claude", "-p", "--session-id", provider]),
      proc(st(302, SERVER), ["claude", "-p", "--session-id", claudeSessionId("someone-else", 0)]),
    );
    const { owners } = run(procs, [hostedA({ workers: [{ id: "ag_02", sessionId: "11111111-2222-3333-4444-555555555555" }] })]);
    assert.deepEqual(owners.get(300), { session: "/s/a.jsonl", worker: "ag_02", via: "session-id" });
    assert.deepEqual(owners.get(301), { session: "/s/a.jsonl", via: "session-id" });
    // Unmatched worker-looking child of the server: its own unowned group, not dropped.
    assert.deepEqual(owners.get(302), { worker: "unowned:302", via: "descendant" });
  });

  test("pi worker via its live record's session file", () => {
    const procs = table(proc(st(SERVER, 1)), proc(st(400, SERVER), ["pi"]));
    const { owners } = run(procs, [hostedA({ workers: [{ id: "ag_03", sessionFile: "/s/worker.jsonl" }] })], { live: new Map([[400, "/s/worker.jsonl"]]) });
    assert.deepEqual(owners.get(400), { session: "/s/a.jsonl", worker: "ag_03", via: "live-record" });
  });

  test("member-mcp team env: only when exactly one session has that worker id (and team)", () => {
    const team = { teamId: "team_01", workerId: "ag_04" };
    const procs = table(proc(st(SERVER, 1)), proc(st(500, 1), ["node", "/x/subagents/member-mcp.ts"], { team }));
    const b = { ...hostedA(), path: "/s/b.jsonl", sessionId: "sess-b", providerIds: [] };
    assert.deepEqual(run(procs, [hostedA({ workers: [{ id: "ag_04", teamId: "team_01" }] })]).owners.get(500),
      { session: "/s/a.jsonl", worker: "ag_04", via: "team-env" });
    assert.equal(run(procs, [hostedA({ workers: [{ id: "ag_04" }] }), { ...b, workers: [{ id: "ag_04" }] }]).owners.get(500), undefined);
    assert.deepEqual(run(procs, [hostedA({ workers: [{ id: "ag_04", teamId: "team_09" }] }), { ...b, workers: [{ id: "ag_04", teamId: "team_01" }] }]).owners.get(500),
      { session: "/s/b.jsonl", worker: "ag_04", via: "team-env" });
  });

  test("a hosted session's bash-tool child by PI_SESSION_FILE (exact), unless the server itself inherited it", () => {
    const procs = table(
      proc(st(SERVER, 1)),
      proc(st(600, SERVER), ["bash", "-c", "pnpm test"], { sessionFile: "/s/a.jsonl" }),
      proc(st(601, 600), ["node", "tsc"], { sessionFile: "/s/a.jsonl" }), // inherited: its own evidence
      proc(st(602, 600), ["env", "-i", "make"]), // a cleared env: charged through its parent
    );
    assert.deepEqual(run(procs, [hostedA()]).owners.get(600), { session: "/s/a.jsonl", via: "env" });
    assert.deepEqual(run(procs, [hostedA()]).owners.get(601), { session: "/s/a.jsonl", via: "env" });
    assert.deepEqual(run(procs, [hostedA()]).owners.get(602), { session: "/s/a.jsonl", via: "descendant" });
    assert.equal(run(procs, [hostedA()], { serverEnv: { sessionFile: "/s/a.jsonl" } }).owners.get(600), undefined);
  });

  test("the nearest exact evidence wins over inheritance: a hosted tool that starts a pi worker's session", () => {
    const procs = table(
      proc(st(SERVER, 1)),
      proc(st(700, SERVER), ["pi"]),
      proc(st(701, 700), ["bash", "-c", "x"], { sessionFile: "/s/worker.jsonl" }),
    );
    const { owners } = run(procs, [hostedA({ workers: [{ id: "ag_05", pid: 700, sessionFile: "/s/worker.jsonl" }] })]);
    assert.deepEqual(owners.get(701), { session: "/s/a.jsonl", worker: "ag_05", via: "env" });
  });

  test("an escaped process (parent outside the unit) is not in the tree; env still charges it", () => {
    const procs = table(proc(st(SERVER, 1)), proc(st(800, 1511), ["node", "vite"], { sessionFile: "/s/a.jsonl" }));
    const { owners, inTree } = run(procs, [hostedA()]);
    assert.deepEqual(owners.get(800), { session: "/s/a.jsonl", via: "env" });
    assert.equal(inTree.has(800), false);
  });

  test("cwd is the last resort, and only when exactly one hosted session's cwd holds it", () => {
    const procs = table(proc(st(SERVER, 1)), proc(st(900, 1511), ["python3", "-m", "http.server"], {}, "/work/a/site"));
    assert.deepEqual(run(procs, [hostedA()]).owners.get(900), { session: "/s/a.jsonl", via: "cwd" });
    const twin = { ...hostedA(), path: "/s/b.jsonl", sessionId: "sess-b", providerIds: [] };
    assert.equal(run(procs, [hostedA(), twin]).owners.get(900), undefined, "two sessions share the cwd: no guess");
    const deeper = { ...twin, cwd: "/work/a/site" };
    assert.deepEqual(run(procs, [hostedA(), deeper]).owners.get(900), { session: "/s/b.jsonl", via: "cwd" }, "the longest cwd wins");
    assert.equal(run(procs, [hostedA({ cwd: "/work/ab" })]).owners.get(900), undefined, "a prefix is not a parent directory");
  });
});

describe("sid memory", () => {
  test("a nohup'd process reparented out of the tree keeps its session through its sid", () => {
    const sids = new SidMemory(new Set([SERVER]));
    const hosted = [hostedA({ workers: [{ id: "ag_06", pid: 200 }] })];
    // Tick 1: the worker's bash tool (its own sid 210) starts a dev server in the background.
    let procs = table(
      proc(st(SERVER, 1)),
      proc(st(200, SERVER), ["claude", "-p"]),
      proc(st(210, 200, { sid: 210 }), ["bash", "-c", "nohup pnpm dev &"]),
      proc(st(211, 210, { sid: 210 }), ["node", "vite"]),
    );
    let r = run(procs, hosted, { sids });
    sids.learn(procs, r.owners, 1_000);
    // Tick 2: the shell exited, vite was reparented to systemd --user (1511).
    procs = table(proc(st(SERVER, 1)), proc(st(200, SERVER), ["claude", "-p"]), proc(st(211, 1511, { sid: 210 }), ["node", "vite"]));
    r = run(procs, hosted, { sids });
    assert.deepEqual(r.owners.get(211), { session: "/s/a.jsonl", worker: "ag_06", via: "sid" });
    assert.equal(r.inTree.has(211), false);
  });

  test("never learned: the server's own sid, heuristic matches, and a sid two owners share", () => {
    const sids = new SidMemory(new Set([SERVER]));
    const procs = table(
      proc(st(SERVER, 1)),
      proc(st(200, SERVER, { sid: SERVER }), ["claude", "-p"]),
      proc(st(201, SERVER, { sid: 250 }), ["bash"], { sessionFile: "/s/a.jsonl" }),
      proc(st(202, SERVER, { sid: 250 }), ["bash"], { sessionFile: "/s/b.jsonl" }),
    );
    const hosted = [hostedA({ workers: [{ id: "ag_07", pid: 200 }] }), { ...hostedA(), path: "/s/b.jsonl", sessionId: "sess-b", providerIds: [] }];
    sids.learn(procs, run(procs, hosted, { sids }).owners, 1);
    const orphan = (sid: number) => st(300, 1511, { sid, starttime: 999_999 });
    assert.equal(sids.lookup(orphan(SERVER), procs), undefined);
    assert.equal(sids.lookup(orphan(250), procs), undefined, "conflicted");
  });

  test("a reused sid number (new leader, or a process older than the session) is not trusted", () => {
    const sids = new SidMemory();
    const leader = st(210, 200, { sid: 210, starttime: 5000 });
    const procs = table(proc(leader, ["bash"], { sessionFile: "/s/a.jsonl" }));
    sids.learn(procs, run(procs, [hostedA()], { sids }).owners, 1);
    assert.deepEqual(sids.lookup(st(211, 1, { sid: 210, starttime: 6000 }), procs), { session: "/s/a.jsonl" });
    assert.equal(sids.lookup(st(211, 1, { sid: 210, starttime: 4000 }), procs), undefined, "older than the leader");
    const newLeader = table(proc(st(210, 1, { sid: 210, starttime: 9000 })));
    assert.equal(sids.lookup(st(212, 1, { sid: 210, starttime: 9500 }), newLeader), undefined, "the sid has a different leader now");
  });

  test("entries expire after the TTL once no member is alive", () => {
    const sids = new SidMemory(new Set(), 1000);
    const procs = table(proc(st(210, 1, { sid: 210 }), ["bash"], { sessionFile: "/s/a.jsonl" }));
    sids.learn(procs, run(procs, [hostedA()], { sids }).owners, 0);
    assert.equal(sids.size, 1);
    sids.learn(new Map(), new Map(), 500);
    assert.equal(sids.size, 1);
    sids.learn(new Map(), new Map(), 1500);
    assert.equal(sids.size, 0);
  });
});

test("the fold's prev map is exactly the live set (bounded memory)", () => {
  const prev = new Map<string, CpuPrev>();
  for (let i = 0; i < 100; i++) prev.set(`${i}:1`, { pid: i, ppid: 1, us: 0, c: 0 });
  const f = foldCpu(prev, [sample(st(5, 1, { starttime: 1 }))]);
  assert.equal(f.next.size, 1);
});
