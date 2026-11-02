#!/usr/bin/env node
// The merge queue's rehearsal (team brief, TESTING): replay Sova's recent real landings from master's history
// through the queue in a throwaway clone, each landing to the same tree master had, then planted faults that must
// each end as the design says, with logs. Node builtins only. Never touches ~/.pi, the live tree or the real master.
//
//   ~/.cache/mq-rehearsal/server        the Sova under test (this worktree's committed HEAD), its own .agent
//   ~/.cache/mq-rehearsal/sova          the project: a clone of master, reset to the oldest replayed landing's base,
//                                       a local bare origin (sova-origin.git), never GitHub
//   ~/.cache/mq-rehearsal/results.json  one record per case; logs/ the views and run logs
//
//   node scripts/merge-queue-rehearsal.mjs [--count 10] [--only R1,R2,…] [--port 4827] [--real-model] [--keep] [--fresh]
//
// Landings: master only ever fast-forwards to a branch tip that merged master last, so the tips master stood at
// are recovered by walking back: T0 = master; T(k+1) = the master side of the newest merge on T(k)'s first-parent
// chain (the second parent of "Merge … master into feat/…"; the first parent of "Merge branch 'feat/…'"). Each
// replay approves the branch ref rehearsal/L<k> = T(k) onto the clone's master (whose tree equals T(k+1)'s) and
// must land a tree equal to T(k)'s (spec docs aside: a difference only under .sova/spec is reported, not failed).
// Old definitions have no `merge` section, so the queue runs them on their `test.run` (Sova's unit tier).
//
// Planted faults, after the replay (each ends as designed, with the run's logs kept):
//   R2 setup broken on master   a commit outside the queue breaks scripts/hermetic-agent-dir.mjs: the queue pauses
//                               "master moved outside", then on Resume setup fails on master too: retried once,
//                               paused (machine), nobody blamed, no chat told; master fixed outside + Resume: lands
//   R3 flaky test               a branch adds a test failing on its first run only: noted flaky, lands
//   R4 server killed            the server is SIGKILLed while a branch is checking (or at the landing fault point
//                               when the build has one): on restart it lands exactly once, origin pushed once
//   R5 blocking review          the review kit declared on master (outside, then Resume) and a branch with planted
//                               debt: Review flagged, Send Back, master unmoved (needs --real-model)
//   R6 master moved outside     a commit on master while a branch is checking: void, paused and flagged; Resume:
//                               rebuilt on the new master, lands
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HERE, LIVE_TREE, QueueClient, Results, SovaUnderTest, check, copyNodeModules, git, gitOk, guardPath, log as plog, makeBranch, parseArgs, realHead, sh, until } from "./merge-queue-qa-lib.mjs";

const { opt, has } = parseArgs();
const PORT = Number(opt("--port", "4827"));
const COUNT = Number(opt("--count", "10"));
const ONLY = opt("--only", "") ? new Set(opt("--only", "").split(",")) : null;
const KEEP = has("--keep");
const FRESH = has("--fresh");
const WS = guardPath(join(homedir(), ".cache", "mq-rehearsal"));
const PROJECT = join(WS, "sova");
const ORIGIN = join(WS, "sova-origin.git");
const WT = join(WS, ".worktrees");
const LOGS = join(WS, "logs");
const log = (...a) => plog("rehearsal", ...a);
const sova = new SovaUnderTest({ ws: WS, port: PORT, model: opt("--model", "zai/glm-5.3"), realModel: has("--real-model"), tag: "rehearsal" });
const R = new Results(join(WS, "results.json"), "rehearsal", { fresh: FRESH });
const q = new QueueClient(sova, PROJECT);
const kase = (id, title, fn) => R.kase(id, title, fn, ONLY);
const REAL_MASTER = realHead(LIVE_TREE, "master");
const head = () => git(PROJECT, "rev-parse", "master");
const originHead = () => git(ORIGIN, "rev-parse", "refs/heads/master");
const tree = (ref) => git(PROJECT, "rev-parse", `${ref}^{tree}`);
const terminal = ["landed", "needs-fix", "behaviour-differs", "review-flagged", "drafts-changed", "cancelled"];

/** The tips master stood at, newest first: T0 = master, then the master side of each landing's last merge-in. */
function landingTips(repo, count) {
  const tips = [git(repo, "rev-parse", "master")];
  while (tips.length < count + 1) {
    const cur = tips.at(-1);
    const merges = git(repo, "rev-list", "--first-parent", "--merges", "--parents", "-n", "1", cur);
    if (!merges) break;
    const [m, p1, p2] = merges.split(" ");
    const subject = git(repo, "log", "-1", "--format=%s", m);
    const masterSide = /^Merge (branch '(refs\/heads\/)?master'|master\b|remote-tracking branch 'origin\/master')/.test(subject) ? p2 : p1;
    if (!masterSide || masterSide === cur) break;
    // The master side must be an ancestor of cur (it is, by construction) and older.
    tips.push(masterSide);
  }
  return tips;
}

function changedBetween(a, b) {
  const out = git(PROJECT, "diff", "--name-only", a, b);
  return out ? out.split("\n") : [];
}

function prepare() {
  mkdirSync(LOGS, { recursive: true });
  if (FRESH) for (const p of [sova.dir, PROJECT, ORIGIN, WT]) rmSync(p, { recursive: true, force: true });
  const feature = sova.prepare();
  R.set("head", feature);
  if (!existsSync(PROJECT)) {
    // A clone of master (read-only on the source), its origin replaced at once by a local bare repository.
    git(WS, "clone", "-q", "--no-hardlinks", "--branch", "master", HERE, PROJECT);
    git(PROJECT, "remote", "remove", "origin");
  }
  check(!git(PROJECT, "remote", "-v").includes("github.com"), "the clone's remotes never name GitHub");
  copyNodeModules(PROJECT);
  sh("mise", ["trust", PROJECT], { allowFail: true });
}

/** Put the clone's master at `base` (and a fresh bare origin there): the replay's starting point. */
function resetTo(base) {
  git(PROJECT, "checkout", "-q", "-B", "master", base);
  git(PROJECT, "reset", "-q", "--hard", base);
  rmSync(ORIGIN, { recursive: true, force: true });
  git(WS, "init", "-q", "--bare", "-b", "master", ORIGIN);
  if (!gitOk(PROJECT, "remote", "get-url", "origin")) git(PROJECT, "remote", "add", "origin", ORIGIN);
  git(PROJECT, "push", "-q", "-f", "origin", "master");
  git(PROJECT, "fetch", "-q", "origin");
}

async function keepLogs(id, entry) {
  writeFileSync(join(LOGS, `${id}-view.json`), JSON.stringify(await q.view(), null, 2));
  if (!entry?.run) return null;
  const r = await q.run(entry.run, 500);
  writeFileSync(join(LOGS, `${id}-run.json`), JSON.stringify(r, null, 2));
  return r?.run ?? null;
}
const branch = (name, edit, opts = {}) => makeBranch(PROJECT, WT, "sova-rh", `rehearsal/${name}`, edit, opts);
const mergesOf = (commit, from) => git(PROJECT, "rev-list", "--first-parent", `${from}..master`).split("\n").filter((c) => c && gitOk(PROJECT, "merge-base", "--is-ancestor", commit, c) && git(PROJECT, "rev-list", "--parents", "-n", "1", c).split(" ").slice(2).includes(commit)).length;

async function replay() {
  const all = landingTips(PROJECT, COUNT);
  const tips = all.slice(0, COUNT + 1).reverse(); // oldest first: tips[0] is the base
  R.set("landings", tips.map((t) => `${t.slice(0, 10)} ${git(PROJECT, "log", "-1", "--format=%s", t).slice(0, 80)}`));
  log(`replaying ${tips.length - 1} landings from ${tips[0].slice(0, 10)} to ${tips.at(-1).slice(0, 10)}`);
  resetTo(tips[0]);
  for (let k = 1; k < tips.length; k++) {
    const t = tips[k];
    await kase(`R1.${k}`, `replay landing ${t.slice(0, 10)}: ${git(PROJECT, "log", "-1", "--format=%s", t).slice(0, 70)}`, async (ev) => {
      const ref = `rehearsal/L${k}`;
      git(PROJECT, "branch", "-f", ref, t);
      const before = head();
      ev.base = before;
      ev.changed = changedBetween(tips[k - 1], t).length;
      const e = await q.add(ref);
      const done = await q.waitState(e.id, terminal, 90 * 60_000);
      const run = await keepLogs(`R1.${k}`, done);
      ev.state = done.state;
      ev.reason = done.reason;
      ev.notes = done.notes;
      ev.steps = run?.steps?.map((s) => `${s.kind}:${s.id}:${s.result}:${s.ms}ms`);
      check(done.state === "landed", `landed (got ${done.state}: ${done.reason ?? ""})`);
      check(done.landed?.sha === head() && run?.tip === head(), "master == the tested tip");
      if (tree("master") !== tree(t)) {
        const diff = changedBetween("master", t);
        ev.treeDiff = diff;
        check(diff.every((p) => p.startsWith(".sova/spec/")), `the landed tree equals master's then (spec docs aside); differs in ${diff.slice(0, 10).join(", ")}`);
        ev.specDocsAside = true;
      }
      check(originHead() === head(), "origin pushed");
      check(git(PROJECT, "rev-parse", "HEAD") === head(), "the main checkout followed");
      check(mergesOf(t, before) <= 1, "landed once");
    });
    const last = R.cur.cases.at(-1);
    if (last && !last.ok) {
      // Keep the replay going from the real tree so one miss doesn't fail every later landing.
      log(`re-basing the clone on ${t.slice(0, 10)} after a miss`);
      resetTo(t);
    }
  }
}

async function faults() {
  // R6 first: the flag and Resume are the other faults' plumbing.
  await kase("R6", "master moved outside the queue during a run: void, paused + flagged, Resume lands", async (ev) => {
    const b = branch("r6", (dir) => writeFileSync(join(dir, "docs-r6.md"), "# rehearsal r6\n"));
    const e = await q.add(b.branch);
    await until("r6 checking", async () => (await q.view())?.current?.entry === e.id, 30 * 60_000, 1000);
    // Let it get past setup, into its checks, before moving master.
    await until("r6 in its checks", async () => (await q.view())?.current?.steps?.some((s) => s.kind === "check" && s.result === "running"), 30 * 60_000, 1000);
    writeFileSync(join(PROJECT, "outside-r6.md"), "moved outside the queue\n");
    git(PROJECT, "add", "outside-r6.md");
    git(PROJECT, "commit", "-q", "-m", "rehearsal: a commit on master outside the queue");
    const outside = head();
    const v = await q.waitView((v) => v.state === "paused", "paused", 10 * 60_000);
    ev.paused = v.paused;
    check(v.paused?.kind === "master-moved", `paused: master moved (${v.paused?.kind}: ${v.paused?.why})`);
    check(/master moved outside the queue/i.test(v.paused?.why ?? ""), "flagged in words");
    check(head() === outside, "the outside move stands");
    check(["queued"].includes((await q.entry(e.id))?.state), "back in line, not blamed");
    await q.resume();
    const done = await q.waitState(e.id, terminal, 60 * 60_000);
    await keepLogs("R6", done);
    check(done.state === "landed", `landed after Resume (${done.state})`);
    check(gitOk(PROJECT, "merge-base", "--is-ancestor", outside, head()), "rebuilt on the new master");
  });

  await kase("R3", "a flaky test: noted, lands", async (ev) => {
    const marker = join(WS, `flaky-${Date.now()}`);
    const b = branch("r3", (dir) =>
      writeFileSync(
        join(dir, "shared/qa-flaky.test.ts"),
        `import { test } from "node:test";\nimport { existsSync, writeFileSync } from "node:fs";\nimport assert from "node:assert/strict";\ntest("rehearsal: flaky on its first run", () => { const m = ${JSON.stringify(marker)}; const first = !existsSync(m); writeFileSync(m, "ran"); assert.equal(first, false); });\n`,
      ),
    );
    const e = await q.add(b.branch);
    const done = await q.waitState(e.id, terminal, 60 * 60_000);
    await keepLogs("R3", done);
    ev.notes = done.notes;
    check(done.state === "landed", `landed (${done.state}: ${done.reason ?? ""})`);
    check(done.notes?.some((n) => n.kind === "flaky" && /qa-flaky/.test(n.text)), "noted flaky");
  });

  await kase("R4", "the server killed mid-landing: lands exactly once, pushed once", async (ev) => {
    const before = head();
    const b = branch("r4", (dir) => writeFileSync(join(dir, "docs-r4.md"), "# rehearsal r4\n"));
    const e = await q.add(b.branch);
    // The landing fault point when the build has one (the queue dies right after writing its landing intent);
    // otherwise, killed while the branch is checking.
    await until("r4 in its checks", async () => (await q.view())?.current?.steps?.some((s) => s.kind === "check"), 30 * 60_000, 500);
    ev.killedAt = (await q.view())?.current?.steps?.filter((s) => s.result === "running").map((s) => s.id);
    sova.kill();
    await until("the server gone", () => sova.child?.exitCode !== null || sova.child?.signalCode !== null, 30_000, 100);
    sova.child = null;
    await sova.start(LOGS);
    const done = await q.waitState(e.id, terminal, 60 * 60_000);
    await keepLogs("R4", done);
    check(done.state === "landed", `landed after the restart (${done.state})`);
    check(mergesOf(b.commit, before) === 1, "exactly one merge of the branch on master");
    check(originHead() === head(), "pushed");
    const recent = (await q.view())?.recent?.filter((r) => r.entry.id === e.id) ?? [];
    check(recent.length === 1, `recorded landed once (${recent.length})`);
  });

  await kase("R2", "setup broken on master: retried once, paused, nobody blamed; fixed + Resume lands", async (ev) => {
    const f = join(PROJECT, "scripts/hermetic-agent-dir.mjs");
    const good = readFileSync(f, "utf8");
    const lines = good.split("\n");
    const at = lines.findIndex((l) => !l.startsWith("#!") && !l.startsWith("//") && !l.startsWith("import") && l.trim() !== "");
    lines.splice(at, 0, 'console.error("rehearsal: setup broken on master"); process.exit(1);');
    writeFileSync(f, lines.join("\n"));
    git(PROJECT, "commit", "-q", "-am", "rehearsal: break setup on master (outside the queue)");
    const b = branch("r2", (dir) => writeFileSync(join(dir, "docs-r2.md"), "# rehearsal r2\n"));
    const e = await q.add(b.branch);
    // The outside move is noticed first (paused, master moved); Resume, then setup fails on master too.
    const v1 = await q.waitView((v) => v.state === "paused", "paused", 30 * 60_000);
    if (v1.paused?.kind === "master-moved") await q.resume();
    const v = await q.waitView((v) => v.state === "paused" && v.paused?.kind !== "master-moved", "paused for the machine", 60 * 60_000);
    ev.paused = v.paused;
    check(v.paused?.kind === "machine", `paused: machine (${v.paused?.kind}: ${v.paused?.why})`);
    const en = await q.entry(e.id);
    check(en?.state === "queued", `back in line, not blamed (${en?.state})`);
    const run = await keepLogs("R2", en);
    const setups = run?.steps?.filter((s) => s.kind === "setup") ?? [];
    ev.setups = setups.map((s) => `${s.id}:${s.result}`);
    check(run?.blame !== "branch", "never the branch's");
    // Fixed outside, Resume (twice: the fix is itself an outside move).
    writeFileSync(f, good);
    git(PROJECT, "commit", "-q", "-am", "rehearsal: fix setup on master (outside the queue)");
    await q.resume();
    const v2 = await q.waitView((v) => v.state !== "paused" || v.paused?.kind === "master-moved", "resumed or flagged again", 10 * 60_000);
    if (v2.state === "paused") await q.resume();
    const done = await q.waitState(e.id, terminal, 60 * 60_000);
    check(done.state === "landed", `landed once fixed (${done.state})`);
  });

  await kase("R5", "a blocking review: Review flagged, Send Back, master unmoved", async (ev) => {
    // Declare the review kit on master (outside the queue), from this worktree's kit.
    const kit = join(HERE, ".sova/playbooks/review");
    check(existsSync(kit), "the feature ships a review kit at .sova/playbooks/review");
    sh("cp", ["-r", kit, join(PROJECT, ".sova/playbooks/")]);
    const pj = join(PROJECT, ".sova/project.json");
    const def = JSON.parse(readFileSync(pj, "utf8"));
    def.merge = { ...(def.merge ?? {}), review: ".sova/playbooks/review" };
    writeFileSync(pj, JSON.stringify(def, null, 2) + "\n");
    git(PROJECT, "add", ".sova/playbooks/review", ".sova/project.json");
    git(PROJECT, "commit", "-q", "-m", "rehearsal: declare the review kit (outside the queue)");
    if ((await q.view())?.state === "paused") await q.resume();
    const b = branch("r5", (dir) =>
      writeFileSync(
        join(dir, "server/qa-debt.ts"),
        "// HACK: wait for the disk to settle (no idea why this is needed)\nexport async function settle(): Promise<void> {\n  await new Promise((r) => setTimeout(r, 5000));\n}\n\n// export function settleOld() {\n//   return 1;\n// }\n\nexport async function settle2(): Promise<void> {\n  await new Promise((r) => setTimeout(r, 5000));\n}\n",
      ),
    );
    const before = head();
    const e = await q.add(b.branch);
    let w = await q.waitState(e.id, [...terminal], 90 * 60_000);
    if (w.state === "queued") w = await q.waitState(e.id, terminal, 90 * 60_000);
    await keepLogs("R5", w);
    ev.review = w.review;
    check(w.state === "review-flagged", `review flagged (${w.state}: ${w.reason ?? ""})`);
    await q.answer(e.id, "send-back");
    const s = await q.waitState(e.id, ["needs-fix"], 10 * 60_000);
    ev.after = s.state;
    check(head() === before, "master unmoved");
  });
}

async function main() {
  prepare();
  await sova.start(LOGS);
  try {
    await sova.register(PROJECT, "sova-rehearsal");
    await replay();
    await faults();
  } finally {
    writeFileSync(join(LOGS, "final-view.json"), JSON.stringify(await q.view().catch(() => null), null, 2));
    if (KEEP) sova.dropAuth();
    else await sova.stop();
  }
  const ok = realHead(LIVE_TREE, "master") === REAL_MASTER;
  R.set("realMasterUnchanged", ok);
  R.set("endedAt", new Date().toISOString());
  const failed = R.summary();
  log(`real master unchanged: ${ok}`);
  process.exit(failed || !ok ? 1 : 0);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => {
  await sova.stop().catch(() => {});
  process.exit(130);
});

main().catch(async (e) => {
  console.error(e);
  await sova.stop().catch(() => {});
  process.exit(2);
});
