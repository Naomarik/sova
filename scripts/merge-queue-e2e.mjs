#!/usr/bin/env node
// The merge queue end to end on a hermetic Sova, against a throwaway clone of Sova's own repository with its
// real checks (team brief, TESTING). Node builtins only. Never touches ~/.pi, the live tree or the real master:
//
//   ~/.cache/mq-e2e/server       a clone of this worktree's committed HEAD: the Sova under test, its own .agent
//   ~/.cache/mq-e2e/sova         the project: a clone whose master IS this worktree's HEAD (so its checks are the
//                                branch's), origin removed and replaced by ~/.cache/mq-e2e/sova-origin.git
//   ~/.cache/mq-e2e/.worktrees/  the project's branch worktrees and the queue's merge copy (sova-merge)
//   ~/.cache/mq-e2e/results.json one record per case; logs/ holds each case's view and run logs
//
// node_modules is copied from this worktree (scripts/copy-tree.mjs): no network. The server is a child of this
// script on SOVA_PORT (default 4826), stopped at the end.
//
//   node scripts/merge-queue-e2e.mjs [--only E1,E2,…] [--keep] [--port N] [--model zai/glm-5.3] [--real-model] [--fresh]
//
// --real-model copies the user's login (~/.pi/agent/auth.json, read only) into the server clone's gitignored .agent
// for the run and deletes it at the end on every path; every chat defaults to --model (zai/glm-5.3) before its
// first prompt and is archived at the end. Without it, the thread and reviewer cases (E1's note, E4-E6) need a model
// and fail with what they saw.
//
// Cases (each ends as the design says, or the case fails with what it saw):
//   E1 ok        a doc change + a spec draft (with its note), approved by the Land route: lands, docs official,
//                master == tested tip, origin pushed, every step logged from "copy", the merge thread's note
//   E2 red       a unit test the branch breaks: needs a fix, blamed on the branch, master unmoved
//   E3 setup     the branch breaks a setup step (hermetic-agent-dir.mjs): blamed on the branch, setup log kept
//   E4 conflict  two branches both extend one list: the second conflicts, the thread resolves it (no behaviour
//                change), it lands with a note saying what it resolved
//   E5 differs   two branches set one constant to different values: "Behaviour differs · waiting for you";
//                Send Back hands it back, master unmoved
//   E6 review    planted tech debt (commented-out block, a HACK with a fixed sleep, untested behaviour): "Review
//                flagged · waiting for you"; Send Back
// Exit 0 when every case selected passed.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HERE, LIVE_TREE, QueueClient, REAL_PI, Results, SovaUnderTest, check, copyNodeModules, git, guardPath, log as plog, makeBranch, parseArgs, realHead, sh, until } from "./merge-queue-qa-lib.mjs";

const { opt, has } = parseArgs();
const PORT = Number(opt("--port", process.env.SOVA_PORT || "4826"));
const ONLY = opt("--only", "") ? new Set(opt("--only", "").split(",")) : null;
const KEEP = has("--keep");
const FRESH = has("--fresh");
const E2E = guardPath(join(homedir(), ".cache", "mq-e2e"));
const PROJECT = join(E2E, "sova");
const ORIGIN = join(E2E, "sova-origin.git");
const WT = join(E2E, ".worktrees");
const LOGS = join(E2E, "logs");
const log = (...a) => plog("e2e", ...a);
const sova = new SovaUnderTest({ ws: E2E, port: PORT, model: opt("--model", "zai/glm-5.3"), realModel: has("--real-model"), tag: "e2e" });
const R = new Results(join(E2E, "results.json"), "e2e", { fresh: FRESH });
const q = new QueueClient(sova, PROJECT);
const kase = (id, title, fn) => R.kase(id, title, fn, ONLY);
const REAL_MASTER = realHead(LIVE_TREE, "master");

function prepare() {
  mkdirSync(LOGS, { recursive: true });
  if (FRESH) for (const p of [sova.dir, PROJECT, ORIGIN, WT]) rmSync(p, { recursive: true, force: true });
  const head = sova.prepare();
  R.set("head", head);
  log(`feature HEAD ${head.slice(0, 10)}; real master ${REAL_MASTER?.slice(0, 10)}`);
  // The project: master = the feature HEAD (its checks are the branch's), a local bare origin, never GitHub.
  if (!existsSync(PROJECT)) {
    git(E2E, "clone", "-q", "--no-hardlinks", HERE, PROJECT);
    git(PROJECT, "remote", "remove", "origin");
    git(PROJECT, "checkout", "-q", "-B", "master", head);
    git(E2E, "init", "-q", "--bare", "-b", "master", ORIGIN);
    git(PROJECT, "remote", "add", "origin", ORIGIN);
    git(PROJECT, "push", "-q", "origin", "master");
    git(PROJECT, "fetch", "-q", "origin");
  }
  check(!git(PROJECT, "remote", "-v").includes("github.com"), "the project's remotes never name GitHub");
  copyNodeModules(PROJECT);
  sh("mise", ["trust", PROJECT], { allowFail: true });
}

const branch = (name, edit, opts = {}) => makeBranch(PROJECT, WT, "sova-e2e", `e2e/${name}`, edit, opts);
const status = () => q.view();
const entryOf = (id) => q.entry(id);
const waitState = (id, states, ms) => q.waitState(id, states, ms);
const add = (b, extra = {}) => q.add(b.branch, extra);
const verb = (name, body) => sova.verb(name, body);
async function keepLogs(caseId, entry) {
  const v = await status();
  writeFileSync(join(LOGS, `${caseId}-view.json`), JSON.stringify(v, null, 2));
  const runId = entry?.run;
  if (!runId) return;
  const r = await q.run(runId, 500);
  writeFileSync(join(LOGS, `${caseId}-run.json`), JSON.stringify(r, null, 2));
  return r?.run;
}
const head = () => git(PROJECT, "rev-parse", "master");
const originHead = () => git(ORIGIN, "rev-parse", "refs/heads/master");

/** The common landed assertions: master == the run's tip, pushed, copy beside the project, steps logged from copy. */
async function assertLanded(ev, caseId, e) {
  const run = await keepLogs(caseId, e);
  ev.entry = e.id;
  ev.landed = e.landed;
  ev.notes = e.notes;
  check(e.landed?.sha === head(), `master (${head().slice(0, 10)}) == the landed sha (${e.landed?.sha?.slice(0, 10)})`);
  check(run?.tip === head(), `master == the run's tested tip (${run?.tip?.slice(0, 10)})`);
  check(originHead() === head(), `origin pushed (${originHead().slice(0, 10)})`);
  check(run?.copy === join(WT, "sova-merge"), `the merge copy beside the project (${run?.copy})`);
  check(!String(run?.copy).startsWith(REAL_PI) && !String(run?.copy).startsWith(sova.agent), "never under a state root");
  check(run?.steps?.[0]?.kind === "copy", `the first step is the copy (${run?.steps?.[0]?.kind})`);
  check(git(PROJECT, "rev-parse", "HEAD") === head(), "the main checkout followed master");
  ev.steps = run.steps.map((s) => `${s.kind}:${s.id}:${s.result}:${s.ms}ms${s.why ? ` (${s.why})` : ""}`);
  return run;
}

async function cases() {
  await kase("E1", "a good branch with a spec draft lands; docs official; note", async (ev) => {
    const b = branch("ok", (dir) => {
      appendFileSync(join(dir, "README.md"), "\n<!-- e2e: a one-line doc change -->\n");
    });
    // A spec draft with its note (as a chat writes one): one sentence added to the first claim file.
    const cli = join(b.dir, "pi-config/extensions/spec/core/sova-spec-draft.mjs");
    sh("node", [cli, "new", "e2e-ok", "--root", b.dir, "--write", "--json"], { cwd: b.dir });
    const claims = join(b.dir, ".sova/spec/drafts/e2e-ok/spec/claims");
    const md = sh("bash", ["-c", `find ${claims} -name '*.md' | sort | head -1`]);
    const id = readFileSync(md, "utf8").match(/^# (§\S+)/m)?.[1];
    check(id, `a claim id in ${md}`);
    appendFileSync(md, "\nThe e2e probe sentence: added by the merge queue end to end.\n");
    sh("node", [cli, "evidence", "e2e-ok", "--id", id, "--by", "e2e", "--verification", "e2e: read back after landing", "--note", "--root", b.dir, "--write", "--json"], { cwd: b.dir });
    ev.claim = id;
    const before = head();
    const e = await add(b);
    ev.approved = e.approval;
    const done = await waitState(e.id, ["landed", "needs-fix", "conflict", "behaviour-differs", "review-flagged", "drafts-changed"], 90 * 60_000);
    check(done.state === "landed", `landed (got ${done.state}: ${done.reason ?? ""})`);
    const run = await assertLanded(ev, "E1", done);
    const rel = md.slice(b.dir.length + 1).replace(".sova/spec/drafts/e2e-ok/spec/", ".sova/spec/");
    check(git(PROJECT, "show", `master:${rel}`).includes("The e2e probe sentence"), "the draft became official docs in the landed tree");
    const kinds = run.steps.map((s) => s.kind);
    check(kinds.indexOf("docs") > -1 && kinds.indexOf("docs") < kinds.indexOf("check"), `docs before checks (${kinds.join(",")})`);
    ev.firstParents = git(PROJECT, "rev-list", "--first-parent", `${before}..master`).split("\n");
    // The note is the merge thread's (off the critical path): wait a little after landing for it.
    const noted = await until("the merge thread's note", async () => {
      const x = await entryOf(e.id);
      return x?.notes?.some((n) => n.kind === "thread") ? x : null;
    }, 10 * 60_000, 5000).catch(() => null);
    ev.threadNote = noted?.notes?.find((n) => n.kind === "thread")?.text ?? null;
    check(ev.threadNote, "the merge thread left a note");
  });

  await kase("E2", "a broken unit test: needs a fix, blamed on the branch", async (ev) => {
    const b = branch("red", (dir) => {
      writeFileSync(join(dir, "shared/e2e-red.test.ts"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("e2e: the branch broke this", () => assert.equal(1 + 1, 3));\n');
    });
    const before = head();
    const e = await add(b);
    const done = await waitState(e.id, ["landed", "needs-fix", "behaviour-differs", "review-flagged"], 90 * 60_000);
    const run = await keepLogs("E2", done);
    ev.reason = done.reason;
    check(done.state === "needs-fix", `needs a fix (got ${done.state})`);
    check(/e2e-red/.test(done.reason ?? ""), `the reason names the test (${done.reason})`);
    check(run?.blame === "branch", `blamed on the branch (${run?.blame})`);
    check(run?.steps?.some((s) => s.kind === "rerun-master"), "rerun on master alone");
    check(head() === before && originHead() === before, "master and origin unmoved");
  });

  await kase("E3", "the branch breaks setup: blamed on the branch, setup log kept", async (ev) => {
    const b = branch("setup", (dir) => {
      const f = join(dir, "scripts/hermetic-agent-dir.mjs");
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n");
      const at = lines.findIndex((l) => !l.startsWith("#!") && !l.startsWith("//") && !l.startsWith("import") && l.trim() !== "");
      lines.splice(at, 0, 'console.error("e2e: setup broken by the branch"); process.exit(1);');
      writeFileSync(f, lines.join("\n"));
    });
    const before = head();
    const e = await add(b);
    const done = await waitState(e.id, ["landed", "needs-fix"], 60 * 60_000);
    const run = await keepLogs("E3", done);
    ev.reason = done.reason;
    check(done.state === "needs-fix", `needs a fix (got ${done.state})`);
    check(run?.blame === "branch", `blamed on the branch (${run?.blame})`);
    const st = run?.steps?.find((s) => s.kind === "setup" && s.result === "failed");
    check(st, "a failed setup step");
    const lg = await verb("merge.logs", { run: run.id, step: st.id, lines: 500 });
    ev.setupLog = (lg.merge?.lines ?? []).slice(-5);
    check((lg.merge?.lines ?? []).some((l) => /setup broken by the branch/.test(l)), "the setup log holds the failure");
    check(head() === before, "master unmoved");
    check((await status()).state !== "paused", "the queue did not pause for a branch's own breakage");
  });

  // A bullet list both branches extend at the same place: README.md's last "- " line.
  const extendList = (word) => (dir) => {
    const f = join(dir, "README.md");
    const lines = readFileSync(f, "utf8").split("\n");
    let at = -1;
    lines.forEach((l, i) => {
      if (/^- /.test(l)) at = i;
    });
    lines.splice(at + 1, 0, `- e2e ${word}: an added list item`);
    writeFileSync(f, lines.join("\n"));
  };

  await kase("E4", "conflict, no behaviour change: the thread resolves, it lands with a note", async (ev) => {
    const base = head();
    const a = branch("list-a", extendList("alpha"), { from: base });
    const b = branch("list-b", extendList("bravo"), { from: base });
    const ea = await add(a);
    check((await waitState(ea.id, ["landed", "needs-fix"], 90 * 60_000)).state === "landed", "a lands first");
    const eb = await add(b);
    const done = await waitState(eb.id, ["landed", "needs-fix", "behaviour-differs"], 120 * 60_000);
    await keepLogs("E4", done);
    ev.state = done.state;
    ev.conflict = done.conflict;
    ev.notes = done.notes;
    check(done.state === "landed", `landed after the thread's resolution (got ${done.state}: ${done.reason ?? ""})`);
    const readme = git(PROJECT, "show", "master:README.md");
    check(readme.includes("e2e alpha") && readme.includes("e2e bravo"), "both list items kept");
    check(done.notes?.some((n) => n.kind === "resolved"), "a note says what it resolved and why");
    await assertLanded(ev, "E4", done);
  });

  await kase("E5", "conflict, behaviour differs: waits for the user; Send Back", async (ev) => {
    const base = head();
    const setConst = (v) => (dir) => {
      const f = join(dir, "shared/merge-queue.ts");
      writeFileSync(f, readFileSync(f, "utf8").replace(/export const NOTE_MAX = \d+;/, `export const NOTE_MAX = ${v};`));
    };
    const a = branch("max-a", setConst(280), { from: base });
    const b = branch("max-b", setConst(320), { from: base });
    const ea = await add(a);
    check((await waitState(ea.id, ["landed", "needs-fix"], 90 * 60_000)).state === "landed", "a lands first");
    const before = head();
    const eb = await add(b);
    const w = await waitState(eb.id, ["behaviour-differs", "landed", "needs-fix"], 60 * 60_000);
    await keepLogs("E5", w);
    ev.conflict = w.conflict;
    check(w.state === "behaviour-differs", `behaviour differs, waiting (got ${w.state})`);
    check(w.conflict?.ours && w.conflict?.theirs && w.conflict?.proposal, "both sides and a proposal in plain words");
    const r = await verb("merge.answer", { entry: eb.id, answer: "send-back" });
    check(r.ok !== false, `send-back accepted ${JSON.stringify(r.error ?? "")}`);
    const s = await waitState(eb.id, ["needs-fix"], 5 * 60_000);
    ev.after = s.state;
    check(head() === before, "master unmoved");
  });

  await kase("E6", "review flags planted tech debt: waits for the user; Send Back", async (ev) => {
    const b = branch("debt", (dir) => {
      writeFileSync(
        join(dir, "server/e2e-debt.ts"),
        [
          "// HACK: wait for the disk to settle before reading the queue (no idea why this is needed)",
          "export async function readQueueSoon(read: () => string): Promise<string> {",
          "  await new Promise((r) => setTimeout(r, 5000));",
          "  return read();",
          "}",
          "",
          "// export function readQueueOld(read: () => string): string {",
          "//   const x = read();",
          "//   return x;",
          "// }",
          "",
          "export function readQueueSoon2(read: () => string): Promise<string> {",
          "  return new Promise((r) => setTimeout(() => r(read()), 5000));",
          "}",
          "",
        ].join("\n"),
      );
    });
    const before = head();
    const e = await add(b);
    const w = await waitState(e.id, ["review-flagged", "landed", "needs-fix"], 120 * 60_000);
    await keepLogs("E6", w);
    ev.review = w.review;
    check(w.state === "review-flagged", `review flagged (got ${w.state}: ${w.reason ?? ""})`);
    check(head() === before, "nothing landed meanwhile");
    const r = await verb("merge.answer", { entry: e.id, answer: "send-back" });
    check(r.ok !== false, "send-back accepted");
    await waitState(e.id, ["needs-fix"], 5 * 60_000);
    check(head() === before, "master unmoved");
  });
}

// ---------------------------------------------------------------- main

async function main() {
  prepare();
  await sova.start(LOGS);
  try {
    await sova.register(PROJECT, "sova-e2e");
    await cases();
  } finally {
    writeFileSync(join(LOGS, "final-view.json"), JSON.stringify(await status().catch(() => null), null, 2));
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
