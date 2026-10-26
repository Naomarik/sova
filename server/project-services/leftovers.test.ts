// Leftover processes on a project's copy ports (§app.overseer/copies): which are safe to stop and why, which are
// never offered, and the stop that checks again that it is the same process. Over a fake host (no process is
// signalled, no port read); git runs for real in temp folders (the unit tier allows git).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-leftovers-agent-"));

const L = await import("./leftovers");
type Host = import("./leftovers").LeftoverHost;
const { mutateRegistry } = await import("./store");

const BASE = 24_000;
const DEF = { version: 1, services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: BASE }, fixed: { fixed: 9_999 } } } } };
let parent = "";
let project = "";
const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const realGit = async (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
};

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-leftovers-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF));
  writeFileSync(join(project, "web.mjs"), "");
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  // A fresh worktree (no commits of its own), a merged one (its own commit now on main), one with a commit main doesn't
  // have, and a dirty one.
  git(["worktree", "add", "-q", "-b", "done", join(parent, "done")]);
  git(["worktree", "add", "-q", "-b", "merged", join(parent, "merged")]);
  writeFileSync(join(parent, "merged", "m.txt"), "m");
  git(["add", "-A"], join(parent, "merged"));
  git(["commit", "-q", "-m", "merged work"], join(parent, "merged"));
  git(["merge", "-q", "--ff-only", "merged"]);
  git(["worktree", "add", "-q", "-b", "open", join(parent, "open")]);
  writeFileSync(join(parent, "open", "x.txt"), "x");
  git(["add", "-A"], join(parent, "open"));
  git(["commit", "-q", "-m", "open work"], join(parent, "open"));
  git(["worktree", "add", "-q", "-b", "dirty", join(parent, "dirty")]);
  writeFileSync(join(parent, "dirty", "wip.txt"), "wip");
  mkdirSync(join(parent, "plain"));
});

after(() => {
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

/** A host whose port `port` is held by the process `procs[port]`. */
function fakeHost(procs: Record<number, { pid: number; cwd: string; start?: string; cgroup?: string; cmd?: string; ppid?: number }>, over: Partial<Host> = {}): Host & { stopped: string[]; signals: string[] } {
  const byPid = new Map(Object.values(procs).map((p) => [p.pid, p]));
  const stopped: string[] = [];
  const signals: string[] = [];
  let t = 0;
  return {
    platform: "linux",
    portOwner: (port) => (procs[port] ? { pid: procs[port]!.pid, cwd: procs[port]!.cwd } : "none"),
    startOf: (pid) => byPid.get(pid)?.start ?? (byPid.has(pid) ? "100" : null),
    cgroup: (pid) => (pid === 1000 ? "0::/user.slice/user@1000.service/app.slice/sova-runtime.service\n" : byPid.get(pid)?.cgroup ?? "0::/user.slice/user@1000.service/app.slice/app-term.scope\n"),
    cmdline: (pid) => byPid.get(pid)?.cmd ?? "node\0server.mjs\0",
    ppid: (pid) => byPid.get(pid)?.ppid ?? 1,
    exists: (p) => !p.endsWith(" (deleted)") && !p.includes("missing"),
    git: realGit,
    isChatProcess: () => false,
    ownedByCopy: () => false,
    selfPid: 1000,
    redact: (s) => s.replace(/secret-\w+/g, "[redacted]"),
    registry: () => ({ version: 1, instances: [], shared: [] }),
    stopUnit: async (u) => (stopped.push(u), delete procs[portOf(procs, u)], { code: 0, stderr: "" }),
    signal: (pid, sig) => {
      signals.push(`${sig}:${pid}`);
      for (const [port, p] of Object.entries(procs)) if (p.pid === pid) delete procs[Number(port)];
    },
    sleep: async () => void (t += 100),
    now: () => t,
    ...over,
    stopped,
    signals,
  };
}
const portOf = (procs: Record<number, { cgroup?: string }>, unit: string) => Number(Object.entries(procs).find(([, p]) => p.cgroup?.includes(unit))?.[0]);

test("the copy ports are each usable slot's numbered ports; a fixed port is no copy's", () => {
  const r = L.copyPortsOf(project)!;
  assert.deepEqual(r.ports.slice(0, 3), [{ slot: 1, port: BASE + 1 }, { slot: 2, port: BASE + 2 }, { slot: 3, port: BASE + 3 }]);
  assert.ok(!r.ports.some((p) => p.port === 9_999));
  assert.equal(L.copyPortsOf(join(parent, "plain")), null, "no definition: no copy ports");
});

test("safe to stop: a deleted or missing folder, a worktree whose own commits are merged; anything else is in use, with why", async () => {
  const h = fakeHost({});
  assert.deepEqual(await L.judgeFolder(project, "/x/y (deleted)", h), { safe: true, reason: "folder-gone" });
  assert.deepEqual(await L.judgeFolder(project, join(parent, "missing"), h), { safe: true, reason: "folder-gone" });
  assert.deepEqual(await L.judgeFolder(project, join(parent, "plain"), h), { safe: false, why: "it runs outside any git checkout" });
  assert.deepEqual(await L.judgeFolder(project, join(parent, "done"), h), { safe: false, why: "its branch has no commits of its own" }, "a worktree just cut, HEAD on main's commit");
  assert.deepEqual(await L.judgeFolder(project, join(parent, "merged"), h), { safe: true, reason: "branch-on-main" });
  assert.deepEqual(await L.judgeFolder(project, join(parent, "open"), h), { safe: false, why: "its branch has commits not on the main checkout's branch" });
  assert.deepEqual(await L.judgeFolder(project, join(parent, "dirty"), h), { safe: false, why: "its worktree has uncommitted edits" });
  assert.deepEqual(await L.judgeFolder(project, project, h), { safe: false, why: "it runs in the project's main checkout" });
  const copy = { ...h, registry: () => ({ version: 1 as const, instances: [{ id: "demo-1", checkout: join(parent, "done") } as never], shared: [] }) };
  assert.deepEqual(await L.judgeFolder(project, join(parent, "done"), copy), { safe: false, why: "it runs in the folder of copy demo-1" });
  // git that can't run says nothing about the folder.
  assert.deepEqual(await L.judgeFolder(project, join(parent, "plain"), { ...h, git: async () => ({ code: 1, stdout: "" }) }), { safe: false, why: "its folder can't be read with git" });
});

test("never offered: Sova's server and its children, sova-runtime.service, a chat process, a copy's unit, slot 0's adopted unit", () => {
  const h = fakeHost({ 1: { pid: 2000, cwd: "/", ppid: 1000 }, 2: { pid: 2001, cwd: "/", ppid: 2000 } });
  assert.equal(L.protectedWhy(1000, h), "Sova's own server");
  assert.equal(L.protectedWhy(2001, h), "Sova's own server", "a grandchild of the server");
  const cg = (text: string) => ({ ...h, cgroup: (pid: number) => (pid === 1000 ? "0::/a/b/term.scope\n" : text) });
  assert.match(L.protectedWhy(3000, cg("0::/user.slice/user@1000.service/app.slice/sova-runtime.service\n"))!, /sova-runtime\.service/);
  assert.equal(L.protectedWhy(3000, cg("0::/user.slice/user@1000.service/app.slice/sova-svc-abc123-demo-1-web.service\n")), "a copy's own process");
  assert.equal(L.protectedWhy(3000, cg("0::/user.slice/user@1000.service/sova-chats.slice/sova-chat-abc-1.service\n")), "a process a chat started", "reparented, still in the chat's unit");
  assert.equal(L.protectedWhy(3000, { ...cg("0::/x.scope\n"), isChatProcess: (p: number) => p === 3000 }), "a chat process");
  const chain = { ...cg("0::/x.scope\n"), ppid: (p: number) => (p === 3000 ? 2990 : p === 2990 ? 2980 : 1), isChatProcess: (p: number) => p === 2980 };
  assert.equal(L.protectedWhy(3000, chain), "a process a chat started", "a chat's grandchild: a server it started by hand");
  assert.equal(L.protectedWhy(3000, { ...cg("0::/x.scope\n"), ownedByCopy: (p: number) => p === 3000 }), "a copy's own process", "a detached copy's, by the supervisor's records");
  assert.equal(L.protectedWhy(3000, cg("0::/user.slice/user@1000.service/app.slice/myapp.service\n"), ["myapp"]), "slot 0's adopted unit myapp");
  assert.equal(L.unitOfCgroup("0::/user.slice/user@1000.service/app.slice/dev-web.service\n"), "dev-web.service");
});

test("the finder lists each holder with its verdict; a copy's own process is left out; elsewhere it says it can't tell", async () => {
  const h = fakeHost({
    [BASE + 1]: { pid: 4001, cwd: join(parent, "merged"), cmd: "node\0web.mjs\0--token=secret-abc\0" },
    [BASE + 2]: { pid: 4002, cwd: join(parent, "open") },
    [BASE + 3]: { pid: 4003, cwd: "/", cgroup: "0::/u/sova-svc-ff-demo-2-web.service\n" },
    [BASE + 4]: { pid: 4004, cwd: "/old/wt (deleted)", cgroup: "0::/user.slice/user@1000.service/app.slice/dev-web.service\n" },
    [BASE + 5]: { pid: 4005, cwd: join(parent, "plain") },
  });
  const r = await L.findLeftovers(project, h);
  assert.ok(!("error" in r));
  const rows = (r as { rows: import("./leftovers").LeftoverView[] }).rows;
  assert.deepEqual(rows.map((x) => [x.port, x.slot, x.verdict.safe]), [[BASE + 1, 1, true], [BASE + 2, 2, false], [BASE + 4, 4, true], [BASE + 5, 5, false]]);
  assert.equal(rows[0]!.command, "node web.mjs --token=[redacted]", "redacted");
  assert.equal(rows[2]!.unit, "dev-web.service");
  assert.match(L.leftoverLine(rows[0]!), /safe to stop: its branch is already merged/);
  assert.deepEqual(await L.findLeftovers(project, { ...h, platform: "darwin" }), { error: L.LEFTOVER_UNSUPPORTED });
  assert.equal(L.LEFTOVER_UNSUPPORTED, "Sova can't tell which process holds a port on this computer.");
});

test("stop-leftover checks it is still the same process and still safe; a unit of its own is stopped whole, else signals", async () => {
  const procs = { [BASE + 1]: { pid: 5001, cwd: "/a/gone (deleted)", start: "777" } } as Record<number, { pid: number; cwd: string; start?: string; cgroup?: string }>;
  const h = fakeHost(procs);
  // The pid was reused: another start time.
  assert.deepEqual(await L.stopLeftover({ project, port: BASE + 1, pid: 5001, start: "776" }, h), { ok: false, text: L.LEFTOVER_CHANGED });
  assert.deepEqual(h.signals, [], "nothing was signalled");
  const ok = await L.stopLeftover({ project, port: BASE + 1, pid: 5001, start: "777" }, h);
  assert.deepEqual(ok, { ok: true, text: `Stopped pid 5001: port ${BASE + 1} of slot 1 is free.` });
  assert.deepEqual(h.signals, ["SIGTERM:5001"]);
  // A process that ignores SIGTERM gets SIGKILL after 5 s, only while it is still the same process.
  const stubborn = { [BASE + 2]: { pid: 5002, cwd: "/b/gone (deleted)", start: "1" } } as Record<number, { pid: number; cwd: string; start?: string }>;
  const h2 = fakeHost(stubborn, {});
  h2.signal = (pid, sig) => {
    h2.signals.push(`${sig}:${pid}`);
    if (sig === "SIGKILL") delete stubborn[BASE + 2];
  };
  const killed = await L.stopLeftover({ project, port: BASE + 2, pid: 5002, start: "1" }, h2);
  assert.equal(killed.ok, true, killed.text);
  assert.deepEqual(h2.signals, ["SIGTERM:5002", "SIGKILL:5002"]);
  // Its own user service: stopped whole, never signalled.
  const svc = { [BASE + 3]: { pid: 5003, cwd: "/c/gone (deleted)", cgroup: "0::/user.slice/user@1000.service/app.slice/dev-web.service\n" } } as Record<number, { pid: number; cwd: string; cgroup?: string }>;
  const h3 = fakeHost(svc);
  const unit = await L.stopLeftover({ project, port: BASE + 3, pid: 5003, start: "100" }, h3);
  assert.equal(unit.ok, true, unit.text);
  assert.deepEqual([h3.stopped, h3.signals], [["dev-web.service"], []]);
  // No longer safe (its folder became a live worktree): refused, nothing stopped.
  const moved = { [BASE + 4]: { pid: 5004, cwd: join(parent, "open") } } as Record<number, { pid: number; cwd: string }>;
  const h4 = fakeHost(moved);
  const no = await L.stopLeftover({ project, port: BASE + 4, pid: 5004, start: "100" }, h4);
  assert.equal(no.ok, false);
  assert.equal(no.text, "It is no longer safe to stop: its branch has commits not on the main checkout's branch. Nothing was stopped.");
  assert.deepEqual(h4.signals, []);
});

test("a copy's own registered checkout is never a leftover's folder", async () => {
  mutateRegistry((r) => void r.instances.push({ id: "demo-reg", project, checkout: join(parent, "done"), branch: "done", slot: 1, generation: 0, createdBy: "operator", createdAt: "", cutWorktree: false, desired: {}, prints: {}, data: {}, ports: {} }));
  const { readRegistry } = await import("./store");
  const v = await L.judgeFolder(project, join(parent, "done"), { exists: () => true, git: realGit, registry: () => readRegistry() });
  assert.deepEqual(v, { safe: false, why: "it runs in the folder of copy demo-reg" });
});

test("a server a chat started by hand in a fresh worktree is never offered, though its folder is clean and on main's commit", async () => {
  const procs = { [BASE + 6]: { pid: 6001, cwd: join(parent, "done"), ppid: 6000 } } as Record<number, { pid: number; cwd: string; ppid?: number }>;
  const h = fakeHost(procs, { isChatProcess: (p) => p === 6000 });
  const r = (await L.judgePort(project, 6, BASE + 6, h)) as import("./leftovers").LeftoverView;
  assert.deepEqual(r.verdict, { safe: false, why: "a process a chat started" });
  // Even in a genuinely merged worktree.
  const m = (await L.judgePort(project, 6, BASE + 6, fakeHost({ [BASE + 6]: { pid: 6001, cwd: join(parent, "merged"), ppid: 6000 } }, { isChatProcess: (p) => p === 6000 }))) as import("./leftovers").LeftoverView;
  assert.equal(m.verdict.safe, false);
});

test("a card refuses a process outside any git checkout, and lists one whose folder is gone", async () => {
  const { leftoverItem } = await import("../overseer-copies");
  const h = fakeHost({ [BASE + 1]: { pid: 7001, cwd: join(parent, "plain") }, [BASE + 2]: { pid: 7002, cwd: "/x/wt (deleted)" } });
  const refused = await leftoverItem(project, BASE + 1, h, () => "Demo");
  assert.ok("refused" in refused);
  assert.match((refused as { refused: string }).refused, /which is in use: it runs outside any git checkout/);
  const row = await leftoverItem(project, BASE + 2, h, () => "Demo");
  assert.equal((row as { reason?: string }).reason, "folder-gone");
});
