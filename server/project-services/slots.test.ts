import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exitOf, type VerbResult } from "../../shared/project-contract";
import { copyLimitOf, numberedPorts, overLimitSentence, slotLayoutOf, unavailableSentence } from "../../shared/project-slots";
import { parseDefinition } from "../../shared/project-contract";
import { conformer } from "./conform";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { machineCopyLimit, setMachineCopyLimit } from "./copy-limit";
import { readRegistry } from "./store";

/**
 * Slots, port numbering and the copy limit (§app.project-services/instances): copies take slots from
 * the fixed range 1 to 16 and conformance 17 and 18, whatever the limit; the port numbering is the main
 * checkout's saved `.sova/project.json`, never a worktree's or HEAD's; the limit in force is this
 * machine's own value, else that file's, and counts running copies only; `cap-reached` at create and at
 * the start of a copy that runs nothing, `slots-blocked`; a bare create/up from the main checkout
 * (§app.project-services/callers); conformance's scratch slots (§app.project-services/conform).
 * On a host in memory (fake-host.ts) with real git.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-slots-agent-"));

const op: Caller = { kind: "operator" };
const roots: string[] = [];

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

const defOf = (cap: number, base: number, extra: object = {}) => ({
  version: 1,
  slots: { cap },
  services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base, stride: 1 } } }, ...extra },
});

/** A fresh project: its definition committed, then (when `saved` differs) saved over in the main checkout uncommitted. */
function fixture(committed: object, saved?: object) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-slots-proj-")));
  roots.push(parent);
  const project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, "web.mjs"), "");
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(committed, null, 2));
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  if (saved) writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(saved, null, 2));
  const host = new FakeHost();
  const engine = new ProjectEngine(host.deps());
  engine.conformer = conformer(engine);
  return { project, git, host, engine };
}

const ok = (r: VerbResult) => {
  assert.equal(r.ok, true, JSON.stringify(r.error));
  return r;
};

/** Motorsaif's shape: web's nrepl (7850, stride 20) meets cljs's test-http (8020, stride 11) only in slots 14 and 10. */
const MOTORSAIF_SHAPE = {
  version: 1,
  services: {
    db: { cmd: ["x"], ports: { port: { base: 4334, stride: 20 }, h2: { base: 4335, stride: 20 } } },
    redis: { cmd: ["x"], ports: { port: { base: 6375, stride: 20 } } },
    cljs: { cmd: ["x"], ports: { nrepl: { base: 9100, stride: 20 }, http: { base: 9830, stride: 20 }, "test-http": { base: 8020, stride: 11 } } },
    web: { cmd: ["x"], ports: { http: { base: 4100, stride: 20 }, nrepl: { base: 7850, stride: 20 } } },
    "test-repl": { cmd: ["x"], ports: { nrepl: { base: 7852, stride: 20 } } },
  },
};

test("the layout: copies take the usable slots of 1 to 16, conformance the two lowest clear slots from 17", () => {
  const plain = slotLayoutOf(parseDefinition(JSON.stringify(defOf(4, 30_000))), null);
  assert.deepEqual([plain.ordinary, plain.unavailable, plain.scratch, plain.scratchNote], [Array.from({ length: 16 }, (_, i) => i + 1), [], [17, 18], null]);
  // Motorsaif: web's nrepl in slot 14 (8130) is cljs's test-http in slot 10.
  const m = slotLayoutOf(parseDefinition(JSON.stringify(MOTORSAIF_SHAPE)), null);
  assert.ok(m.ordinary.includes(10) && !m.ordinary.includes(14), JSON.stringify(m));
  assert.deepEqual(m.unavailable.find((u) => u.slot === 14), { slot: 14, why: "its ports overlap slot 10's" });
  assert.equal(unavailableSentence({ slot: 14, why: "its ports overlap slot 10's" }), "Slot 14 is unavailable: its ports overlap slot 10's.");
  // 3000/3010 at stride 1: slot 10 meets slot 0, 11 meets 1, …: only 1 to 9 are usable.
  const tight = parseDefinition(JSON.stringify({ version: 1, slots: { cap: 4 }, services: { web: { cmd: ["x"], ports: { http: { base: 3000 } } }, api: { cmd: ["y"], ports: { http: { base: 3010 } } } } }));
  const t = slotLayoutOf(tight, null);
  assert.deepEqual(t.ordinary, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(t.unavailable[0], { slot: 10, why: "its ports overlap slot 0's" });
  // Its scratch slots meet no usable place's ports nor each other's.
  const portsOf = (slot: number) => [3000 + slot, 3010 + slot];
  const used = new Set([0, ...t.ordinary].flatMap(portsOf));
  for (const sl of t.scratch) for (const p of portsOf(sl)) assert.ok(!used.has(p), `scratch ${sl} port ${p}`);
  assert.ok(t.scratch[0] >= 17 && t.scratch[1] > t.scratch[0] && portsOf(t.scratch[0]).every((p) => !portsOf(t.scratch[1]).includes(p)), JSON.stringify(t.scratch));
  assert.equal(t.scratchNote, null);
  // Fixed ports are the same everywhere by design and never make a place unusable.
  const fixed = parseDefinition(JSON.stringify(defOf(2, 30_000, { side: { cmd: ["x"], scope: "shared", ports: { p: { fixed: 30_005 } } } })));
  assert.equal(slotLayoutOf(fixed, null).ordinary.length, 16);
  // No two clear slots within 65535: 17 and 18, said so.
  const top = slotLayoutOf(parseDefinition(JSON.stringify({ version: 1, slots: { cap: 1 }, services: { w: { cmd: ["x"], ports: { p: { base: 65_518 } } } } })), null);
  assert.deepEqual(top.scratch, [17, 18]);
  assert.match(top.scratchNote ?? "", /conformance uses 17 and 18, whose ports overlap/);
});

test("copyLimitOf: this machine's value, else the main checkout's saved file, else the definition in use, else 4", () => {
  const main = parseDefinition(JSON.stringify(defOf(12, 30_000)));
  const inUse = parseDefinition(JSON.stringify(defOf(4, 31_000)));
  const read = () => JSON.stringify(defOf(12, 30_000));
  const saved = copyLimitOf("/m", { inUse, read });
  assert.deepEqual([saved.cap, saved.source, saved.fileCap], [12, "file", 12]);
  assert.match(saved.from, /from the project's file \(the main checkout's \.sova\/project\.json, as saved\)/);
  assert.deepEqual(numberedPorts(inUse, saved.numbering, 3), { web: { http: 30_003 } }, "main's numbering wins");
  const machine = copyLimitOf("/m", { inUse, read, machine: 3 });
  assert.deepEqual([machine.cap, machine.source, machine.from, machine.fileCap], [3, "machine", "set on this machine", 12]);
  assert.deepEqual(numberedPorts(inUse, machine.numbering, 3), { web: { http: 30_003 } }, "the machine's value numbers nothing");
  const missing = copyLimitOf("/m", {
    inUse,
    read: () => {
      throw Object.assign(new Error("no"), { code: "ENOENT" });
    },
  });
  assert.deepEqual([missing.cap, missing.source, missing.fileCap, missing.numbering], [4, "in-use", null, null]);
  assert.match(missing.from, /the definition in use \(the main checkout's \.sova\/project\.json is missing\)/);
  const broken = copyLimitOf("/m", { read: () => "{not json" });
  assert.deepEqual([broken.cap, broken.source], [4, "default"]);
  assert.match(broken.from, /is invalid/);
  // A port only the copy declares keeps its own numbering.
  const withSide = parseDefinition(JSON.stringify(defOf(4, 31_000, { side: { cmd: ["node", "web.mjs"], ports: { tcp: { base: 32_000 } } } })));
  assert.deepEqual(numberedPorts(withSide, main, 2), { web: { http: 30_002 }, side: { tcp: 32_002 } });
});

test("overLimitSentence: room, at the limit, and above it", () => {
  assert.equal(overLimitSentence(1, 2), null);
  assert.equal(overLimitSentence(12, 12), "12 copies are running, and this machine allows 12 at once: stop one first.");
  assert.equal(overLimitSentence(1, 1), "1 copy is running, and this machine allows 1 at once: stop one first.");
  assert.equal(overLimitSentence(14, 12), "14 running, 2 over the limit of 12: no new copy starts until 3 stop.");
  assert.equal(overLimitSentence(13, 12), "13 running, 1 over the limit of 12: no new copy starts until 2 stop.");
});

test("b1: only running copies count; at the limit a stopped copy's start and a new create are refused with the sentence", async () => {
  const { project, engine } = fixture(defOf(2, 33_000));
  const a = ok(await engine.run("up", { project, branch: "sova/a" }, op));
  const b = ok(await engine.run("up", { project, branch: "sova/b" }, op));
  assert.deepEqual([a.slot, b.slot, a.state, b.state], [1, 2, "running", "running"]);
  ok(await engine.run("down", { instance: a.instance }, op));
  ok(await engine.run("down", { instance: b.instance }, op));
  // Two copies exist, both stopped: they keep their places and don't count.
  const c = ok(await engine.run("up", { project, branch: "sova/c" }, op));
  assert.deepEqual([c.slot, c.state], [3, "running"], "a third copy is created and starts");
  ok(await engine.run("up", { instance: a.instance }, op));
  // Two run now (a and c): starting the stopped b is refused, and so is a new copy.
  const startB = await engine.run("up", { instance: b.instance }, op);
  assert.equal(startB.error?.code, "cap-reached", JSON.stringify(startB.error));
  assert.equal(exitOf(startB), 2);
  assert.ok(startB.error!.message.startsWith("2 copies are running, and this machine allows 2 at once: stop one first."), startB.error!.message);
  assert.match(startB.error!.message, /Running: slot 1 \(sova\/a, .+\), slot 3 \(sova\/c, .+\)\. The limit of 2 is from the project's file/);
  const bRec = readRegistry().instances.find((i) => i.id === b.instance)!;
  assert.deepEqual(Object.values(bRec.desired), ["stopped"], "the refused start wanted nothing");
  const d = await engine.run("create", { project, branch: "sova/d" }, op);
  assert.equal(d.error?.code, "cap-reached");
  assert.equal(readRegistry().instances.filter((i) => i.project === project).length, 3, "nothing was made");
  // A copy that already runs is no new start: up of a running copy is fine.
  ok(await engine.run("up", { instance: a.instance }, op));
  ok(await engine.run("apply", { instance: a.instance }, op));
});

test("b2: this machine's limit overrides the file's (file 4, machine 12): a fifth running copy is created", async () => {
  const { project, engine } = fixture(defOf(4, 34_000));
  try {
    for (const n of [1, 2, 3, 4]) ok(await engine.run("up", { project, branch: `sova/w${n}` }, op));
    assert.equal((await engine.run("up", { project, branch: "sova/w5" }, op)).error?.code, "cap-reached", "the file's 4");
    setMachineCopyLimit(project, 12);
    assert.equal(machineCopyLimit(project), 12);
    const fifth = ok(await engine.run("up", { project, branch: "sova/w5" }, op));
    assert.deepEqual([fifth.slot, fifth.state], [5, "running"]);
    // Lowered under what runs: nothing stops, and the next start says how far over it is.
    setMachineCopyLimit(project, 3);
    const regs = readRegistry().instances.filter((i) => i.project === project && i.slot !== 0);
    assert.equal(regs.filter((i) => Object.values(i.desired).includes("running")).length, 5, "nothing was stopped");
    const sixth = await engine.run("create", { project, branch: "sova/w6" }, op);
    assert.equal(sixth.error?.code, "cap-reached");
    assert.ok(sixth.error!.message.startsWith("5 running, 2 over the limit of 3: no new copy starts until 3 stop."), sixth.error!.message);
    assert.match(sixth.error!.message, /The limit of 3 is set on this machine/);
  } finally {
    setMachineCopyLimit(project, null);
  }
});

test("a worktree's own port numbering is ignored: the main checkout's saved (uncommitted) definition numbers every copy", async () => {
  // Committed: base 33500. Saved in the main checkout, uncommitted: base 33000. The worktrees' branch moves web's base and adds side.
  const { project, git, engine } = fixture(defOf(2, 33_500), defOf(3, 33_200));
  const low = JSON.stringify(defOf(1, 33_700, { side: { cmd: ["node", "web.mjs"], ports: { tcp: { base: 39_000 } } } }), null, 2);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: project, input: low, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["mktree"], { cwd: project, input: `100644 blob ${blob}\tproject.json\n`, encoding: "utf8" }).trim();
  const top = execFileSync("git", ["ls-tree", "main"], { cwd: project, encoding: "utf8" }).split("\n").filter((l) => l && !l.endsWith("\t.sova")).join("\n");
  const root = execFileSync("git", ["mktree"], { cwd: project, input: `${top}\n040000 tree ${tree}\t.sova\n`, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", root, "-p", "main", "-m", "low"], { cwd: project, encoding: "utf8" }).trim();
  git(["branch", "-f", "low", commit]);
  const made: VerbResult[] = [];
  for (const n of [1, 2, 3]) made.push(ok(await engine.run("up", { project, branch: `sova/w${n}`, from: "low" }, op)));
  assert.deepEqual(made.map((r) => r.slot), [1, 2, 3], "3 running copies: main's saved cap, not the worktree's 1 nor HEAD's 2");
  const rec = readRegistry().instances.find((i) => i.id === made[0]!.instance)!;
  assert.deepEqual(rec.ports, { web: { http: 33_201 }, side: { tcp: 39_001 } }, "web numbered by main's saved base; side, which main lacks, by its own");
  const fourth = await engine.run("create", { project, branch: "sova/w4", from: "low" }, op);
  assert.equal(fourth.error?.code, "cap-reached");
  assert.match(fourth.error!.message, /^3 copies are running, and this machine allows 3 at once: stop one first\./);
});

test("the search passes slots an outside listener blocks; an explicit slot is 1 to 16, never a scratch slot", async () => {
  const BASE = 35_000;
  const { project, host, engine } = fixture(defOf(2, BASE));
  host.listen(BASE + 1, 4_242, "/elsewhere");
  host.listen(BASE + 2, 4_243, "/other");
  const a = ok(await engine.run("create", { project, branch: "sova/a" }, op));
  assert.equal(a.slot, 3, "slots 1 and 2 are blocked: the next is 3, whatever the cap");
  const scratch = await engine.run("create", { project, branch: "sova/d", slot: 17 }, op);
  assert.equal(scratch.error?.code, "invalid-request");
  assert.match(scratch.error!.message, /slot 17 is not given to a copy: slots 17 and 18 are conformance's scratch slots; copies take 1 to 16/);
  const past = await engine.run("create", { project, branch: "sova/d", slot: 19 }, op);
  assert.equal(past.error?.code, "invalid-request");
  assert.match(past.error!.message, /slot is at most 16: copies take 1 to 16, and slots 17 and 18 are conformance/);
  const high = ok(await engine.run("create", { project, branch: "sova/e", slot: 16 }, op));
  assert.equal(high.slot, 16, "any slot of the fixed range, above the cap too");
});

test("an unusable slot is skipped and refused when asked for, naming the overlap", async () => {
  const { project, host, engine } = fixture({ version: 1, slots: { cap: 4 }, services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: 42_000 } } }, api: { cmd: ["node", "web.mjs"], ports: { http: { base: 42_010 } } } } });
  const asked = await engine.run("create", { project, branch: "sova/ten", slot: 10 }, op);
  assert.equal(asked.error?.code, "invalid-request");
  assert.match(asked.error!.message, /^Slot 10 is unavailable: its ports overlap slot 0's\./);
  for (let slot = 1; slot <= 9; slot++) host.listen(42_000 + slot, 5_000 + slot, `/x${slot}`);
  const r = await engine.run("create", { project, branch: "sova/a" }, op);
  assert.equal(r.error?.code, "slots-blocked", JSON.stringify(r.error));
  assert.match(r.error!.message, /no usable slot of 1 to 16 is free for a copy/);
  assert.match(r.error!.message, /Slot 10 is unavailable: its ports overlap slot 0's/);
  assert.doesNotMatch(r.error!.message, /slot 10 needs port/, "slot 10 was never tried");
});

test("every slot of 1 to 16 blocked with room under the limit: slots-blocked, naming each holder", async () => {
  const BASE = 36_000;
  const { project, host, engine } = fixture(defOf(2, BASE));
  for (let slot = 1; slot <= 15; slot++) host.listen(BASE + slot, 4_000 + slot, `/app${slot}`);
  host.listen(BASE + 16, 4_016, "");
  const r = await engine.run("create", { project, branch: "sova/a" }, op);
  assert.equal(r.error?.code, "slots-blocked", JSON.stringify(r.error));
  assert.equal(exitOf(r), 2);
  const m = r.error!.message;
  assert.match(m, /no usable slot of 1 to 16 is free for a copy \(slots 17 and 18 are conformance's scratch slots; the project's copies hold: none\)/);
  assert.match(m, /slot 1 needs port 36001, which pid 4001 \(\/app1\) is listening on/);
  assert.match(m, /slot 16 needs port 36016, which pid 4016 is listening on/);
  assert.doesNotMatch(m, /slot 17/);
  assert.equal(readRegistry().instances.filter((i) => i.project === project).length, 0, "nothing was made");
});

test("a bare create/up from the main checkout names the session's tracked worktrees; without any it stays forbidden", async () => {
  const { project, engine } = fixture(defOf(4, 37_000));
  const wt = ok(await engine.run("create", { project, branch: "sova/mine" }, op));
  const tracked: Caller = { kind: "session", id: "s1", root: project, own: [wt.checkout!, "/elsewhere/other-tree"] };
  const r = await engine.run("up", { project }, tracked);
  assert.equal(r.error?.code, "invalid-request");
  assert.match(r.error!.message, /this session runs in the main checkout, which is never a session's: name one of its worktrees with checkout/);
  assert.ok(r.error!.message.includes(`(${wt.checkout!}, /elsewhere/other-tree)`), r.error!.message);
  assert.equal((await engine.run("up", { project }, { kind: "session", id: "s2", root: project, own: [project] })).error?.code, "forbidden");
  // A worktree named (as the tool fills it from a worktree's cwd) is the session's own: it runs.
  ok(await engine.run("create", { project, checkout: wt.checkout! }, { kind: "session", id: "s1", root: project, own: [wt.checkout!] }));
});

test("conform takes slots 17 and 18 whatever the limit, with copies running at the limit and the limit changed", async () => {
  const BASE = 38_000;
  const { project, engine } = fixture(defOf(2, BASE));
  const five = ok(await engine.run("up", { project, branch: "sova/five", slot: 5 }, op));
  const six = ok(await engine.run("up", { project, branch: "sova/six", slot: 6 }, op));
  assert.deepEqual([five.slot, six.slot], [5, 6]);
  const seen: number[][] = [];
  const run = engine.run.bind(engine);
  for (const machine of [null, 12]) {
    setMachineCopyLimit(project, machine);
    const scratch: number[] = [];
    engine.run = async (verb, body, caller, opts) => {
      const r = await run(verb, body, caller, opts);
      if (caller.kind === "conform" && (verb === "create" || verb === "up") && r.slot !== null && !scratch.includes(r.slot)) scratch.push(r.slot);
      return r;
    };
    try {
      const r = await engine.run("conform", { project }, op);
      assert.equal(r.ok, true, JSON.stringify(r.conform?.checks.filter((c) => !c.ok)));
    } finally {
      engine.run = run;
    }
    seen.push(scratch.sort((x, y) => x - y));
  }
  setMachineCopyLimit(project, null);
  assert.deepEqual(seen, [[17, 18], [17, 18]], "the same scratch slots under the file's 2 (both running) and the machine's 12");
  assert.deepEqual(
    readRegistry().instances.filter((i) => i.project === project).map((i) => i.slot).sort(),
    [5, 6],
    "the copies in 5 and 6 are untouched; the scratch copies are gone",
  );
});
