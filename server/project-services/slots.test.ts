import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exitOf, type VerbResult } from "../../shared/project-contract";
import { numberedPorts, slotLimitOf, slotPlan } from "../../shared/project-slots";
import { parseDefinition } from "../../shared/project-contract";
import { conformer } from "./conform";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { readRegistry } from "./store";

/**
 * The copy limit and port numbering in force (§app.project-services/instances): the main checkout's
 * saved `.sova/project.json`, never a worktree's or HEAD's; the search past blocked slots, the scratch
 * slots it skips, `cap-reached` and `slots-blocked`; a bare create/up from the main checkout
 * (§app.project-services/callers); and conformance's scratch slots under a raised, uncommitted limit
 * (§app.project-services/conform). On a host in memory (fake-host.ts) with real git.
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

test("slotPlan: scratch slots are cap + 1 and cap + 2; ordinary copies search 1 to 2 × cap + 2 around them", () => {
  assert.deepEqual(slotPlan(2), { cap: 2, scratch: [3, 4], top: 6, ordinary: [1, 2, 5, 6] });
  assert.deepEqual(slotPlan(12).scratch, [13, 14]);
  assert.equal(slotPlan(16).top, 34);
});

test("slotLimitOf reads the main checkout's saved file, else the definition in use, else the default", () => {
  const main = parseDefinition(JSON.stringify(defOf(12, 30_000)));
  const inUse = parseDefinition(JSON.stringify(defOf(4, 31_000)));
  const saved = slotLimitOf("/m", inUse, () => JSON.stringify(defOf(12, 30_000)));
  assert.equal(saved.cap, 12);
  assert.match(saved.from, /the main checkout's \.sova\/project\.json \(\/m\/\.sova\/project\.json, as saved\)/);
  assert.deepEqual(numberedPorts(inUse, saved.numbering, 3), { web: { http: 30_003 } }, "main's numbering wins");
  const missing = slotLimitOf("/m", inUse, () => {
    throw Object.assign(new Error("no"), { code: "ENOENT" });
  });
  assert.equal(missing.cap, 4);
  assert.match(missing.from, /the definition in use \(the main checkout's \.sova\/project\.json is missing\)/);
  assert.equal(missing.numbering, null);
  assert.equal(slotLimitOf("/m", null, () => "{not json").cap, 4);
  assert.match(slotLimitOf("/m", null, () => "{not json").from, /is invalid/);
  // A port only the copy declares keeps its own numbering.
  const withSide = parseDefinition(JSON.stringify(defOf(4, 31_000, { side: { cmd: ["node", "web.mjs"], ports: { tcp: { base: 32_000 } } } })));
  assert.deepEqual(numberedPorts(withSide, main, 2), { web: { http: 30_002 }, side: { tcp: 32_002 } });
});

test("a worktree's own cap and port numbering are ignored: the main checkout's saved (uncommitted) definition is in force", async () => {
  // Committed: cap 2. Saved in the main checkout, uncommitted: cap 3. The worktrees' branch says cap 1 and moves web's base.
  const { project, git, engine } = fixture(defOf(2, 33_000), defOf(3, 33_000));
  // Build the low branch's commit without touching the main checkout's saved file.
  const low = JSON.stringify(defOf(1, 33_500, { side: { cmd: ["node", "web.mjs"], ports: { tcp: { base: 34_000 } } } }), null, 2);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: project, input: low, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["mktree"], { cwd: project, input: `100644 blob ${blob}\tproject.json\n`, encoding: "utf8" }).trim();
  const top = execFileSync("git", ["ls-tree", "main"], { cwd: project, encoding: "utf8" }).split("\n").filter((l) => l && !l.endsWith("\t.sova")).join("\n");
  const root = execFileSync("git", ["mktree"], { cwd: project, input: `${top}\n040000 tree ${tree}\t.sova\n`, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", root, "-p", "main", "-m", "low"], { cwd: project, encoding: "utf8" }).trim();
  git(["branch", "-f", "low", commit]);
  const made: VerbResult[] = [];
  for (const n of [1, 2, 3]) made.push(ok(await engine.run("create", { project, branch: `sova/w${n}`, from: "low" }, op)));
  assert.deepEqual(made.map((r) => r.slot), [1, 2, 3], "3 copies: main's saved cap, not the worktree's 1 nor HEAD's 2");
  const rec = readRegistry().instances.find((i) => i.id === made[0]!.instance)!;
  assert.deepEqual(rec.ports, { web: { http: 33_001 }, side: { tcp: 34_001 } }, "web numbered by main's base; side, which main lacks, by its own");
  const fourth = await engine.run("create", { project, branch: "sova/w4", from: "low" }, op);
  assert.equal(fourth.error?.code, "cap-reached");
  assert.equal(exitOf(fourth), 2);
  assert.match(fourth.error!.message, /the copy limit is 3 \(slots\.cap in the main checkout's \.sova\/project\.json \(.*\/demo\/\.sova\/project\.json, as saved\)\)/);
  assert.match(fourth.error!.message, /already runs 3 copies of this project besides the main checkout's: slot 1 \(.+\), slot 2 \(.+\), slot 3 \(.+\)/);
});

test("the search passes slots an outside listener blocks, skips the scratch slots, and refuses cap-reached once the copies number the limit", async () => {
  const BASE = 35_000;
  const { project, host, engine } = fixture(defOf(2, BASE));
  // cap 2: scratch slots 3 and 4; ordinary 1, 2, 5, 6.
  host.listen(BASE + 1, 4_242, "/elsewhere");
  host.listen(BASE + 2, 4_243, "/other");
  const a = ok(await engine.run("create", { project, branch: "sova/a" }, op));
  assert.equal(a.slot, 5, "slots 1 and 2 are blocked and 3, 4 are conformance's: the next is 5");
  const b = ok(await engine.run("create", { project, branch: "sova/b" }, op));
  assert.equal(b.slot, 6, "a blocked slot is not counted against the limit");
  const c = await engine.run("create", { project, branch: "sova/c" }, op);
  assert.equal(c.error?.code, "cap-reached", JSON.stringify(c.error));
  assert.match(c.error!.message, /the copy limit is 2/);
  assert.match(c.error!.message, /slot 5 \(.+\), slot 6 \(.+\)/);
  // An explicit slot: a scratch slot is never a copy's, and nothing past 2 × cap + 2.
  ok(await engine.run("teardown", { instance: b.instance }, op));
  const scratch = await engine.run("create", { project, branch: "sova/d", slot: 3 }, op);
  assert.equal(scratch.error?.code, "invalid-request");
  assert.match(scratch.error!.message, /slots 3 and 4 are conformance's scratch slots/);
  const past = await engine.run("create", { project, branch: "sova/d", slot: 7 }, op);
  assert.equal(past.error?.code, "invalid-request");
  assert.match(past.error!.message, /slot is at most 6 \(2 × the copy limit 2 \+ 2; the limit is slots\.cap in the main checkout's/);
});

test("every candidate slot blocked with room under the limit: slots-blocked, naming each holder", async () => {
  const BASE = 36_000;
  const { project, host, engine } = fixture(defOf(2, BASE));
  for (const slot of [1, 2, 5]) host.listen(BASE + slot, 4_000 + slot, `/app${slot}`);
  host.listen(BASE + 6, 4_006, "");
  const r = await engine.run("create", { project, branch: "sova/a" }, op);
  assert.equal(r.error?.code, "slots-blocked", JSON.stringify(r.error));
  assert.equal(exitOf(r), 2);
  const m = r.error!.message;
  assert.match(m, /Sova runs 0 of at most 2 copies of this project \(slots\.cap in the main checkout's \.sova\/project\.json/);
  assert.match(m, /the project's copies hold: none/);
  assert.match(m, /no slot up to 6 is free \(slots 3 and 4 are conformance's scratch slots\)/);
  assert.match(m, /slot 1 needs port 36001, which pid 4001 \(\/app1\) is listening on/);
  assert.match(m, /slot 5 needs port 36005, which pid 4005 \(\/app5\) is listening on/);
  assert.match(m, /slot 6 needs port 36006, which pid 4006 is listening on/);
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

test("conform under a raised, uncommitted limit: its scratch copies land above the limit in force, never in slots 1 to 12", async () => {
  // Main checkout saved cap 12, committed cap 4; copies in slots 5 and 6 (the committed cap's scratch slots).
  const BASE = 38_000;
  const { project, engine } = fixture(defOf(4, BASE), defOf(12, BASE));
  const five = ok(await engine.run("create", { project, branch: "sova/five", slot: 5 }, op));
  const six = ok(await engine.run("create", { project, branch: "sova/six", slot: 6 }, op));
  assert.deepEqual([five.slot, six.slot], [5, 6]);
  const scratch: number[] = [];
  const run = engine.run.bind(engine);
  engine.run = async (verb, body, caller, opts) => {
    const r = await run(verb, body, caller, opts);
    if (caller.kind === "conform" && (verb === "create" || verb === "up") && r.slot !== null && !scratch.includes(r.slot)) scratch.push(r.slot);
    return r;
  };
  try {
    const r = await engine.run("conform", { project }, op);
    assert.equal(r.ok, true, JSON.stringify(r.conform?.checks.filter((c) => !c.ok)));
    assert.deepEqual(scratch.sort((x, y) => x - y), [13, 14], "cap + 1 and cap + 2 of the main checkout's saved cap, not the committed 5 and 6");
  } finally {
    engine.run = run;
  }
  assert.deepEqual(
    readRegistry().instances.filter((i) => i.project === project).map((i) => i.slot).sort(),
    [5, 6],
    "the copies in 5 and 6 are untouched; the scratch copies are gone",
  );
});
