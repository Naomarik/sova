// merge.live / merge.restart (restart.ts): what the running server owes after landings, read from Git with the
// target's rule (server/restart-paths.ts), and the restart itself with every outside step stood in (no unit, no
// systemd, no build: `schedule` and `run` record what they were asked). In-process, Git only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { realGit } from "./guard";
import { HOLD_MS } from "./queue";
import { checkRestartAtStart, PENDING_STALE_MS, planRestart, RESTART_FILE, type RestartDeps, type RestartQueue, restartSelf, withoutRestartOutcome } from "./restart";

type Plan = Awaited<ReturnType<typeof planRestart>>;
const plan = (o: { repo: string; live: string; target: string }): Promise<Plan & { restart: string[]; build: string[] }> =>
  planRestart(realGit, o.repo, o.live, execFileSync("git", ["rev-parse", `refs/heads/${o.target}`], { cwd: o.repo, encoding: "utf8" }).trim(), o.target).then((p) => ({ ...p, restart: p.restartFiles ?? [], build: p.buildFiles ?? [] }));

function repo() {
  const dir = scratchRoot("restart-sova-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  const put = (files: Record<string, string>, msg: string) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const first = put({ "README.md": "x\n" }, "first");
  return { dir, git, put, first };
}

test("plan: the landed files since the live commit decide: nothing, a page build, a restart (with the install it needs)", async () => {
  const r = repo();
  const at = (live: string) => plan({ repo: r.dir, live, target: "master" });
  assert.equal((await at(r.first)).action, "nothing", "the live server runs the tip");
  const docs = r.put({ "docs/a.md": "a\n", "server/x.test.ts": "t\n" }, "docs and tests");
  assert.equal((await at(r.first)).action, "nothing");
  r.put({ "src/app.tsx": "app\n" }, "page");
  const page = await at(r.first);
  assert.deepEqual([page.action, page.build, page.install], ["build", ["src/app.tsx"], false]);
  r.put({ "src/lib/message.ts": "m\n" }, "a src file the server imports");
  const imported = await at(r.first);
  assert.deepEqual([imported.action, imported.restart], ["restart", ["src/lib/message.ts"]]);
  assert.equal(imported.install, false);
  assert.equal((await at(docs)).action, "restart", "every landing since the live commit counts, not only the newest");
  const lock = r.put({ "pnpm-lock.yaml": "lock\n" }, "packages");
  const pkgs = await at(r.first);
  assert.equal(pkgs.install, true);
  assert.equal((await at(lock)).action, "nothing", "already live");
});

test("plan: unknown when the main checkout isn't on the target's tip; an unknown live commit owes a restart with an install", async () => {
  const r = repo();
  r.put({ "server/a.ts": "a\n" }, "server");
  r.git("checkout", "-q", "--detach", r.first);
  const off = (await plan({ repo: r.dir, live: r.first, target: "master" }));
  assert.equal(off.action, "unknown");
  assert.match(off.why, /main checkout is at/);
  r.git("checkout", "-q", "master");
  const foreign = (await plan({ repo: r.dir, live: "f".repeat(40), target: "master" }));
  assert.deepEqual([foreign.action, foreign.install], ["restart", true]);
});

test("plan: a release's version bump alone (package.json's version, CHANGELOG.md) owes nothing; a new dependency owes a restart with an install", async () => {
  const r = repo();
  const pkg = (o: object) => `${JSON.stringify({ name: "x", version: "1.0.0", dependencies: { a: "1.0.0" }, ...o }, null, 2)}\n`;
  const base = r.put({ "package.json": pkg({}) }, "package");
  r.put({ "package.json": pkg({ version: "1.1.0" }), "CHANGELOG.md": "## v1.1.0\n" }, "Release v1.1.0");
  const bump = (await plan({ repo: r.dir, live: base, target: "master" }));
  assert.deepEqual([bump.action, bump.install, bump.restart], ["nothing", false, []]);
  const released = r.git("rev-parse", "HEAD");
  r.put({ "package.json": pkg({ version: "1.1.0", dependencies: { a: "1.0.0", b: "2.0.0" } }) }, "adds b");
  const dep = (await plan({ repo: r.dir, live: released, target: "master" }));
  assert.deepEqual([dep.action, dep.install, dep.restart], ["restart", true, ["package.json"]]);
  // From before the release, the dependency still counts: the bump alone is what is left out.
  assert.equal(((await plan({ repo: r.dir, live: base, target: "master" }))).install, true);
});


/** A queue stood in: its hold, notes and log, recorded. */
function fakeQueue(root: string, o: { busy?: boolean; release?: boolean } = {}) {
  const dir = scratchRoot("restart-queue-");
  const held: string[] = [];
  const notes = new Map<string, string>([["mq_1", "Changes server code; Sova restarts itself once the queue is idle."]]);
  const q: RestartQueue = {
    root,
    target: "master",
    store: { dir },
    targetHead: async () => execFileSync("git", ["rev-parse", "refs/heads/master"], { cwd: root, encoding: "utf8" }).trim(),
    restartFacts: () => ({ busy: !!o.busy, release: !!o.release, landed: { id: "mq_1", branch: "feat/x" } }),
    hold: async (a) => (held.push(a), { changed: true }),
    note: async (id, text) => (notes.set(id, text), { notes: [{ kind: "thread", text }] }),
    entryNote: (id) => notes.get(id) ?? "",
    logLine: () => {},
  };
  return { q, held, notes, dir };
}

function deps(root: string, live: string, o: { failBuild?: boolean } = {}) {
  const ran: string[][] = [];
  const scheduled: string[] = [];
  let start = { startedAt: "2026-11-07T10:00:00.000Z", head: live as string | null };
  const d: RestartDeps = {
    git: realGit,
    start: () => start,
    checkout: () => root,
    unitOf: async () => "sova-standin-test.service",
    runsAs: async (unit) => unit === "sova-standin-test.service",
    schedule: async (unit) => (scheduled.push(unit), null),
    run: async (argv) => (ran.push(argv), { code: o.failBuild && argv.includes("build") ? 1 : 0, timedOut: false, aborted: false, ms: 1, out: o.failBuild ? "src/x.ts(1,1): error TS1005: ';' expected." : "ok" }),
  };
  return { d, ran, scheduled, restartedOn: (head: string | null) => (start = { startedAt: "2026-11-07T10:05:00.000Z", head }) };
}

test("restart: server files landed → hold, install when owed, build, the unit restarted later; the next start checks the expected head and notes the landing", async () => {
  const r = repo();
  const tip = r.put({ "server/a.ts": "a\n", "pnpm-lock.yaml": "l\n" }, "server + lock");
  const { q, held, notes, dir } = fakeQueue(r.dir);
  const { d, ran, scheduled, restartedOn } = deps(r.dir, r.first);
  const out = await restartSelf(q, d);
  assert.equal(out.outcome, "restarting", out.why);
  assert.equal(out.expect, tip);
  assert.deepEqual(ran, [["pnpm", "install", "--frozen-lockfile"], ["pnpm", "run", "build"]]);
  assert.deepEqual(scheduled, ["sova-standin-test.service"], "the definition's adopted unit, never one named here");
  assert.deepEqual(held, ["set", "set"], "held before the install, renewed after the build");
  assert.ok(existsSync(join(dir, RESTART_FILE)));
  // The same start (the restart hasn't happened yet) leaves the record.
  assert.equal(await checkRestartAtStart(q, d), null);
  assert.equal((await restartSelf(q, d)).outcome, "nothing", "a restart already on its way");
  restartedOn(tip);
  const seen = await checkRestartAtStart(q, d);
  assert.deepEqual(seen, { ok: true, expect: tip, head: tip });
  assert.deepEqual(held, ["set", "set", "clear"]);
  assert.match(notes.get("mq_1")!, /^Changes server code; Sova restarts itself once the queue is idle\. Restarted Sova after landing feat\/x\.$/);
  assert.equal(existsSync(join(dir, RESTART_FILE)), false);
});

test("restart: a start on another commit says so in the note", async () => {
  const r = repo();
  r.put({ "server/a.ts": "a\n" }, "server");
  const { q, notes } = fakeQueue(r.dir);
  const { d, restartedOn } = deps(r.dir, r.first);
  assert.equal((await restartSelf(q, d)).outcome, "restarting");
  restartedOn(r.first);
  assert.equal((await checkRestartAtStart(q, d))?.ok, false);
  assert.match(notes.get("mq_1")!, /Restart after landing feat\/x didn't come back on [0-9a-f]{7}: it started on [0-9a-f]{7}\. Check sova-standin-test\.service\./);
});

test("restart: nothing while busy, during a release, for another project, or with nothing owed; a failed build lifts the hold and restarts nothing", async () => {
  const r = repo();
  r.put({ "server/a.ts": "a\n" }, "server");
  assert.equal((await restartSelf(fakeQueue(r.dir, { busy: true }).q, deps(r.dir, r.first).d)).outcome, "nothing");
  assert.equal((await restartSelf(fakeQueue(r.dir, { release: true }).q, deps(r.dir, r.first).d)).outcome, "nothing");
  const other = deps(r.dir, r.first);
  other.d.checkout = () => "/somewhere/else";
  assert.match((await restartSelf(fakeQueue(r.dir).q, other.d)).why, /doesn't run from/);
  const tip = r.git("rev-parse", "HEAD");
  assert.equal((await restartSelf(fakeQueue(r.dir).q, deps(r.dir, tip).d)).outcome, "nothing");
  const f = fakeQueue(r.dir);
  const bad = deps(r.dir, r.first, { failBuild: true });
  const out = await restartSelf(f.q, bad.d);
  assert.deepEqual([out.outcome, out.step], ["failed", "build"]);
  assert.match(out.why, /error TS1005/);
  assert.deepEqual(f.held, ["set", "clear"]);
  assert.deepEqual(bad.scheduled, []);
  assert.equal(f.notes.get("mq_1"), "Changes server code; Sova restarts itself once the queue is idle. Not restarted: build failed after landing feat/x: src/x.ts(1,1): error TS1005: ';' expected.", "Sova notes the failure itself");
});

test("restart: a build that failed, then passed at the next Idle, leaves one outcome on the note: the latest", async () => {
  const r = repo();
  const tip = r.put({ "server/a.ts": "a\n" }, "server");
  const f = fakeQueue(r.dir);
  assert.equal((await restartSelf(f.q, deps(r.dir, r.first, { failBuild: true }).d)).outcome, "failed");
  assert.equal((await restartSelf(f.q, deps(r.dir, r.first, { failBuild: true }).d)).outcome, "failed");
  assert.equal(f.notes.get("mq_1")!.match(/Not restarted: /g)?.length, 1, "a second failure replaces the first");
  const good = deps(r.dir, r.first);
  assert.equal((await restartSelf(f.q, good.d)).outcome, "restarting");
  good.restartedOn(tip);
  assert.equal((await checkRestartAtStart(f.q, good.d))?.ok, true);
  assert.equal(f.notes.get("mq_1"), "Changes server code; Sova restarts itself once the queue is idle. Restarted Sova after landing feat/x.");
});

test("withoutRestartOutcome: the note up to its first restart outcome line, whoever wrote it", () => {
  const before = "Changes server code; Sova restarts itself once the queue is idle.";
  for (const outcome of ["Not restarted: build failed after landing feat/x: error TS1005: ';' expected.", "The page build failed after landing feat/x: vite: x.ts not found.", "Restarted Sova after landing feat/x.", "Restart after landing feat/x didn't come back on abc1234: it started on def5678. Check u.service."])
    assert.equal(withoutRestartOutcome(`${before} ${outcome}`), before, outcome);
  assert.equal(withoutRestartOutcome(before), before);
  assert.equal(withoutRestartOutcome("Restarted Sova after landing feat/x."), "");
});

test("restart: page files only → the page is built, nothing held or restarted", async () => {
  const r = repo();
  r.put({ "src/app.tsx": "app\n" }, "page");
  const f = fakeQueue(r.dir);
  const x = deps(r.dir, r.first);
  const out = await restartSelf(f.q, x.d);
  assert.equal(out.outcome, "built");
  assert.deepEqual(x.ran, [["pnpm", "run", "build"]]);
  assert.deepEqual([f.held, x.scheduled], [[], []]);
});

test("restart: a server that isn't the unit's main process restarts nothing (a hermetic server whose definition adopts the live unit)", async () => {
  const r = repo();
  r.put({ "server/a.ts": "a\n" }, "server");
  const f = fakeQueue(r.dir);
  const x = deps(r.dir, r.first);
  x.d.runsAs = async () => false;
  const out = await restartSelf(f.q, x.d);
  assert.equal(out.outcome, "nothing");
  assert.match(out.why, /this server isn't run by sova-standin-test\.service: nothing restarts/);
  assert.deepEqual([x.ran, x.scheduled, f.held], [[], [], []], "no build, no hold, no restart");
});

test("restart: a scheduled restart that never happened goes stale after a while, and the next call plans again", async () => {
  const r = repo();
  r.put({ "server/a.ts": "a\n" }, "server");
  const f = fakeQueue(r.dir);
  let now = Date.parse("2026-11-07T10:00:00.000Z");
  const x = deps(r.dir, r.first);
  x.d.now = () => now;
  assert.equal((await restartSelf(f.q, x.d)).outcome, "restarting");
  now += 60_000;
  assert.equal((await restartSelf(f.q, x.d)).why, "a restart is already on its way");
  now += PENDING_STALE_MS;
  assert.equal((await restartSelf(f.q, x.d)).outcome, "restarting");
  assert.equal(x.scheduled.length, 2);
});

test("restart: an install and build longer than the hold renew it, so it is still in force when the restart is scheduled", async () => {
  const r = repo();
  r.put({ "server/a.ts": "a\n", "pnpm-lock.yaml": "l\n" }, "server + lock");
  const f = fakeQueue(r.dir);
  let now = Date.parse("2026-11-07T10:00:00.000Z");
  // The queue's hold as queue.ts keeps it: `set` holds until now + HOLD_MS, and lapses after.
  let until = 0;
  f.q.hold = async (a) => ((until = a === "set" ? now + HOLD_MS : 0), { changed: true });
  const x = deps(r.dir, r.first);
  x.d.now = () => now;
  const run = x.d.run!;
  // Install and build take 4 minutes each: together past HOLD_MS.
  x.d.run = async (argv, cwd, ms) => ((now += 4 * 60_000), run(argv, cwd, ms));
  let heldAtSchedule: boolean | null = null;
  const schedule = x.d.schedule;
  x.d.schedule = async (unit) => ((heldAtSchedule = until > now), schedule(unit));
  assert.equal((await restartSelf(f.q, x.d)).outcome, "restarting");
  assert.ok(now - Date.parse("2026-11-07T10:00:00.000Z") > HOLD_MS, "the install and build outlasted one hold");
  assert.equal(heldAtSchedule, true, "the hold is still in force when the restart is scheduled");
});
