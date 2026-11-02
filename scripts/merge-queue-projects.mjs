#!/usr/bin/env node
// The merge queue on projects other than Sova (user requirement): motorsaif (target main, one test command, no
// services) and nasabii (target master, its tests need the test-repl service), each a throwaway clone under
// ~/.cache/mq-projects/<name> (made with `git clone --no-hardlinks`, origin replaced at once by a local bare repo),
// on a hermetic Sova of this worktree's committed HEAD. Node builtins only.
//
//   node scripts/merge-queue-projects.mjs --project motorsaif [--port 4828]
//   node scripts/merge-queue-projects.mjs --project nasabii   [--port 4829]
//   node scripts/merge-queue-projects.mjs --project motorsaif,nasabii --port 4830   # C1: two queues, one server, at once
//   [--only P1,P2,…] [--real-model] [--keep] [--fresh]
//
// SAFETY: against the real repos only read-only git (rev-parse). After every case the real target sha is checked
// unchanged (motorsaif main = 348559df, nasabii master = c0ef5d7); a change stops the script at once.
//
// Cases per project (P<n>.<project>):
//   P1 clean land          a comment-only change: lands; target == tested tip; origin pushed; copy beside the clone
//   P2 failure by branch   an `(is (= …))` turned to `(is (not= …))`: needs a fix, blamed on the branch, target unmoved
//   P3 failure on target   the same break committed on the target outside the queue (paused "moved outside", Resume),
//                          then a clean branch: lands, noted "master-red"; the break reverted outside after
//   P4 conflict, auto      two branches add different lines at one place in .gitignore: the second conflicts, the
//                          thread resolves it (no behaviour change), lands with a "resolved" note
//   P5 conflict, differs   two branches set one number differently: behaviour differs, Send Back
//   P6 review ok / block   the review kit declared on the target (outside, Resume): a docstring fix lands (review
//                          ok); planted debt is flagged, Send Back
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QueueClient, Results, SovaUnderTest, check, git, gitOk, guardPath, log as plog, makeBranch, parseArgs, realHead, until } from "./merge-queue-qa-lib.mjs";

const PROJECTS = {
  motorsaif: { real: join(homedir(), "webapps", "motorsaif"), target: "main", realSha: "348559df", port: 4828 },
  nasabii: { real: join(homedir(), "github", "rakiba", "projects", "nasabii"), target: "master", realSha: "c0ef5d7", port: 4829 },
};

const { opt, has } = parseArgs();
const names = opt("--project", "").split(",").filter(Boolean);
check(names.length && names.every((n) => PROJECTS[n]), `--project one of ${Object.keys(PROJECTS).join(", ")} (comma-separated for C1)`);
const PORT = Number(opt("--port", String(names.length === 1 ? PROJECTS[names[0]].port : 4830)));
const ONLY = opt("--only", "") ? new Set(opt("--only", "").split(",")) : null;
const KEEP = has("--keep");
const BASE = guardPath(join(homedir(), ".cache", "mq-projects"));
const WS = join(BASE, `run-${names.join("+")}`);
const LOGS = join(WS, "logs");
const tag = `projects:${names.join("+")}`;
const log = (...a) => plog(tag, ...a);
const sova = new SovaUnderTest({ ws: WS, port: PORT, model: opt("--model", "zai/glm-5.3"), realModel: has("--real-model"), tag });
const R = new Results(join(WS, "results.json"), tag, { fresh: has("--fresh") });

/** Stops everything when a real repo's target moved: nothing here may touch it. */
function assertRealUnchanged() {
  for (const [n, p] of Object.entries(PROJECTS)) {
    const now = realHead(p.real, p.target);
    if (now && !now.startsWith(p.realSha)) {
      console.error(`SAFETY: ${n}'s real ${p.target} moved: ${now} (expected ${p.realSha}); stopping`);
      process.exit(3);
    }
  }
}

function project(name) {
  const p = PROJECTS[name];
  const root = join(BASE, name);
  const origin = join(BASE, `${name}-origin.git`);
  const wt = join(BASE, ".worktrees");
  check(existsSync(root), `the clone ${root} exists (made by hand: git clone --no-hardlinks, origin replaced)`);
  const remotes = git(root, "remote", "-v");
  check(!/github\.com|git@/.test(remotes) && remotes.includes(origin), `${name}'s only remote is the local bare origin (${remotes})`);
  const q = new QueueClient(sova, root);
  const head = () => git(root, "rev-parse", p.target);
  const originHead = () => git(origin, "rev-parse", `refs/heads/${p.target}`);
  const branch = (b, edit, o = {}) => makeBranch(root, wt, name, `qa/${b}`, edit, { from: p.target, ...o });
  const commitOutside = (msg, edit) => {
    edit(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", msg);
    return head();
  };
  return { name, ...p, root, origin, wt, q, head, originHead, branch, commitOutside };
}

const terminal = ["landed", "needs-fix", "behaviour-differs", "review-flagged", "drafts-changed", "cancelled"];

function firstTestFile(root) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith("_test.clj") ? [join(d, e.name)] : []));
  const files = walk(join(root, "test")).sort();
  const f = files.find((x) => readFileSync(x, "utf8").includes("(is (= "));
  check(f, "a test file with (is (= …))");
  return f.slice(root.length + 1);
}
const breakTest = (rel) => (dir) => {
  const f = join(dir, rel);
  writeFileSync(f, readFileSync(f, "utf8").replace("(is (= ", "(is (not= "));
};
const commentLine = (rel, text) => (dir) => {
  const f = join(dir, rel);
  writeFileSync(f, `;; ${text}\n` + readFileSync(f, "utf8"));
};

async function cases(P) {
  const k = (id, title, fn) => R.kase(`${id}.${P.name}`, title, async (ev) => {
    try {
      await fn(ev);
    } finally {
      writeFileSync(join(LOGS, `${id}.${P.name}-view.json`), JSON.stringify(await P.q.view().catch(() => null), null, 2));
      assertRealUnchanged();
    }
  }, ONLY && !ONLY.has(id) ? new Set() : null);
  const keepRun = async (id, e) => {
    if (!e?.run) return null;
    const r = await P.q.run(e.run, 500);
    writeFileSync(join(LOGS, `${id}.${P.name}-run.json`), JSON.stringify(r, null, 2));
    return r?.run ?? null;
  };
  const testRel = firstTestFile(P.root);
  const resumeIfPaused = async () => {
    const v = await P.q.view();
    if (v?.state === "paused") await P.q.resume();
  };

  await k("P1", `${P.name}: clean land on ${P.target}`, async (ev) => {
    const b = P.branch("p1", commentLine(testRel, "qa: a comment-only change"));
    const e = await P.q.add(b.branch);
    const done = await P.q.waitState(e.id, terminal, 90 * 60_000);
    const run = await keepRun("P1", done);
    ev.state = done.state;
    ev.steps = run?.steps?.map((s) => `${s.kind}:${s.id}:${s.result}:${s.ms}ms`);
    check(done.state === "landed", `landed (${done.state}: ${done.reason ?? ""})`);
    check(run?.tip === P.head() && done.landed?.sha === P.head(), `${P.target} == the tested tip`);
    check(P.originHead() === P.head(), "pushed to the local bare origin");
    check(run?.copy === join(P.wt, `${P.name}-merge`), `the merge copy beside the clone (${run?.copy})`);
    check(!gitOk(P.root, "rev-parse", "--verify", "--quiet", "refs/heads/" + (P.target === "main" ? "master" : "main")), "no other target branch made");
  });

  await k("P2", `${P.name}: a test the branch breaks`, async (ev) => {
    const before = P.head();
    const b = P.branch("p2", breakTest(testRel));
    const e = await P.q.add(b.branch);
    const done = await P.q.waitState(e.id, terminal, 90 * 60_000);
    const run = await keepRun("P2", done);
    ev.reason = done.reason;
    check(done.state === "needs-fix", `needs a fix (${done.state})`);
    check(run?.blame === "branch", `blamed on the branch (${run?.blame})`);
    check(P.head() === before && P.originHead() === before, "target and origin unmoved");
  });

  await k("P3", `${P.name}: a test failing on ${P.target} too does not block`, async (ev) => {
    const broken = P.commitOutside("qa: a test broken on the target (outside the queue)", breakTest(testRel));
    const b = P.branch("p3", (dir) => writeFileSync(join(dir, "qa-p3.md"), "# qa p3\n"));
    const e = await P.q.add(b.branch);
    await P.q.waitView((v) => v.state === "paused", "paused: moved outside", 10 * 60_000).then(resumeIfPaused).catch(() => {});
    const done = await P.q.waitState(e.id, terminal, 120 * 60_000);
    await keepRun("P3", done);
    ev.notes = done.notes;
    check(done.state === "landed", `landed (${done.state}: ${done.reason ?? ""})`);
    check(done.notes?.some((n) => n.kind === "master-red"), "noted: fails on the target too");
    check(gitOk(P.root, "merge-base", "--is-ancestor", broken, P.head()), "on the broken target");
    // Put the target right again (outside), and let the queue go on.
    P.commitOutside("qa: revert the broken test (outside the queue)", (dir) => {
      const f = join(dir, testRel);
      writeFileSync(f, readFileSync(f, "utf8").replace("(is (not= ", "(is (= "));
    });
    await until("the queue notices", async () => (await P.q.view())?.state === "paused", 120_000, 1000).catch(() => {});
    await resumeIfPaused();
  });

  const addIgnore = (line) => (dir) => {
    const f = join(dir, ".gitignore");
    writeFileSync(f, readFileSync(f, "utf8").replace(/\n?$/, `\n${line}\n`));
  };
  await k("P4", `${P.name}: conflict, no behaviour change (both extend .gitignore)`, async (ev) => {
    const base = P.head();
    const a = P.branch("p4a", addIgnore("/qa-alpha/"), { from: base });
    const b = P.branch("p4b", addIgnore("/qa-bravo/"), { from: base });
    const ea = await P.q.add(a.branch);
    check((await P.q.waitState(ea.id, terminal, 90 * 60_000)).state === "landed", "a lands first");
    const eb = await P.q.add(b.branch);
    const done = await P.q.waitState(eb.id, terminal, 120 * 60_000);
    await keepRun("P4", done);
    ev.state = done.state;
    ev.conflict = done.conflict;
    ev.notes = done.notes;
    check(done.state === "landed", `landed after the thread's resolution (${done.state}: ${done.reason ?? ""})`);
    const gi = git(P.root, "show", `${P.target}:.gitignore`);
    check(gi.includes("/qa-alpha/") && gi.includes("/qa-bravo/"), "both lines kept");
    check(done.notes?.some((n) => n.kind === "resolved"), "a note says what it resolved");
  });

  await k("P5", `${P.name}: conflict, behaviour differs: waits, Send Back`, async (ev) => {
    const base = P.head();
    const setN = (n) => (dir) => writeFileSync(join(dir, "qa-limit.edn"), `{:qa/max-items ${n}}\n`);
    // A shared starting value on the target first, so both sides change one line.
    P.commitOutside("qa: a limit both branches change (outside the queue)", setN(10));
    await until("noticed", async () => (await P.q.view())?.state === "paused", 120_000, 1000).catch(() => {});
    await resumeIfPaused();
    const from = P.head();
    const a = P.branch("p5a", setN(20), { from });
    const b = P.branch("p5b", setN(30), { from });
    const ea = await P.q.add(a.branch);
    check((await P.q.waitState(ea.id, terminal, 90 * 60_000)).state === "landed", "a lands first");
    const before = P.head();
    const eb = await P.q.add(b.branch);
    const w = await P.q.waitState(eb.id, terminal, 120 * 60_000);
    await keepRun("P5", w);
    ev.conflict = w.conflict;
    check(w.state === "behaviour-differs", `behaviour differs (${w.state}: ${w.reason ?? ""})`);
    await P.q.answer(eb.id, "send-back");
    check((await P.q.waitState(eb.id, ["needs-fix"], 10 * 60_000)).state === "needs-fix", "handed back");
    check(P.head() === before, "target unmoved");
    void base;
  });

  await k("P6", `${P.name}: review ok, then blocking`, async (ev) => {
    P.commitOutside("qa: declare the review kit (outside the queue)", (dir) => {
      const f = join(dir, ".sova/project.json");
      const def = JSON.parse(readFileSync(f, "utf8"));
      def.merge = { ...(def.merge ?? {}), review: ".sova/playbooks/review" };
      writeFileSync(f, JSON.stringify(def, null, 2) + "\n");
    });
    await until("noticed", async () => (await P.q.view())?.state === "paused", 120_000, 1000).catch(() => {});
    await resumeIfPaused();
    const ok = P.branch("p6ok", (dir) => writeFileSync(join(dir, "qa-p6.md"), "# qa p6\n\nA documentation fix.\n"));
    const eo = await P.q.add(ok.branch);
    const lo = await P.q.waitState(eo.id, terminal, 120 * 60_000);
    ev.ok = { state: lo.state, review: lo.review };
    check(lo.state === "landed" && (!lo.review || lo.review.verdict !== "blocking"), `review ok: landed (${lo.state})`);
    const debt = P.branch("p6debt", (dir) => {
      const f = join(dir, testRel);
      const src = readFileSync(f, "utf8");
      writeFileSync(
        f,
        src +
          "\n;; HACK: give the db a moment (no idea why this is needed)\n(defn qa-settle [] (Thread/sleep 500) :ok)\n\n#_(deftest qa-disabled\n  (is (= 1 1)))\n\n(defn qa-new-handler [req] {:status 200 :body (str (:uri req))})\n",
      );
    });
    const before = P.head();
    const ed = await P.q.add(debt.branch);
    const w = await P.q.waitState(ed.id, terminal, 120 * 60_000);
    await keepRun("P6", w);
    ev.blocking = { state: w.state, review: w.review };
    check(w.state === "review-flagged", `review flagged (${w.state}: ${w.reason ?? ""})`);
    await P.q.answer(ed.id, "send-back");
    check((await P.q.waitState(ed.id, ["needs-fix"], 10 * 60_000)).state === "needs-fix", "handed back");
    check(P.head() === before, "target unmoved");
  });
}

async function main() {
  mkdirSync(LOGS, { recursive: true });
  assertRealUnchanged();
  R.set("head", sova.prepare());
  await sova.start(LOGS);
  try {
    const ps = names.map(project);
    for (const P of ps) await sova.register(P.root, `${P.name}-qa`);
    if (ps.length > 1) {
      // C1: both queues at once on this one server; each case list runs concurrently with the other.
      const t0 = Date.now();
      const spans = await Promise.all(ps.map(async (P) => {
        const s = Date.now();
        await cases(P);
        return { name: P.name, from: s - t0, to: Date.now() - t0 };
      }));
      R.set("concurrency", spans);
    } else await cases(ps[0]);
  } finally {
    if (KEEP) sova.dropAuth();
    else await sova.stop();
    assertRealUnchanged();
  }
  R.set("endedAt", new Date().toISOString());
  process.exit(R.summary() ? 1 : 0);
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
