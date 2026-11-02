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
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const PORT = Number(opt("--port", process.env.SOVA_PORT || "4826"));
const ONLY = opt("--only", "") ? new Set(opt("--only", "").split(",")) : null;
const KEEP = args.includes("--keep");
const FRESH = args.includes("--fresh");
const MODEL = opt("--model", "zai/glm-5.3");
const REAL_MODEL = args.includes("--real-model");
const E2E = join(homedir(), ".cache", "mq-e2e");
const SERVER = join(E2E, "server");
const PROJECT = join(E2E, "sova");
const ORIGIN = join(E2E, "sova-origin.git");
const WT = join(E2E, ".worktrees");
const LOGS = join(E2E, "logs");
const RESULTS = join(E2E, "results.json");
const AGENT = join(SERVER, ".agent");
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REAL_PI = join(homedir(), ".pi");

for (const p of [E2E, SERVER, PROJECT, WT]) if (resolve(p).startsWith(REAL_PI + "/")) throw new Error(`refusing ${p}: under ~/.pi`);

// ---------------------------------------------------------------- small helpers

function sh(cmd, argv, o = {}) {
  const r = spawnSync(cmd, argv, { cwd: o.cwd ?? E2E, encoding: "utf8", env: { ...process.env, ...(o.env ?? {}) }, maxBuffer: 256 * 1024 * 1024, timeout: o.timeout ?? 600_000 });
  if (r.status !== 0 && !o.allowFail) throw new Error(`${cmd} ${argv.join(" ")} (in ${o.cwd ?? E2E}) exited ${r.status}: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}
const git = (cwd, ...a) => sh("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function until(what, fn, ms = 30 * 60_000, every = 2000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await sleep(every);
  }
}

let token = null;
async function http(method, path, body) {
  token ??= readFileSync(join(AGENT, "sova", "auth-token"), "utf8").trim();
  const r = await fetch(BASE_URL + path, { method, headers: { "content-type": "application/json", "x-sova-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json };
}
/** One merge verb as the operator (the Land button's route). */
async function verb(name, body) {
  const r = await http("POST", `/api/project-services/${name}`, body);
  return r.json;
}

// ---------------------------------------------------------------- results

const results = existsSync(RESULTS) && !FRESH ? JSON.parse(readFileSync(RESULTS, "utf8")) : { runs: [] };
const thisRun = { startedAt: new Date().toISOString(), head: "", cases: [] };
results.runs.push(thisRun);
const save = () => writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");

async function kase(id, title, fn) {
  if (ONLY && !ONLY.has(id)) return;
  log(`${id} ${title}`);
  const t0 = Date.now();
  const rec = { id, title, ok: false, ms: 0, evidence: {}, error: null };
  thisRun.cases.push(rec);
  try {
    await fn(rec.evidence);
    rec.ok = true;
    log(`${id} PASS (${Math.round((Date.now() - t0) / 1000)} s)`);
  } catch (e) {
    rec.error = String(e?.stack ?? e);
    log(`${id} FAIL: ${e?.message ?? e}`);
  }
  rec.ms = Date.now() - t0;
  save();
}
const check = (cond, what) => {
  if (!cond) throw new Error(`expected: ${what}`);
};

// ---------------------------------------------------------------- prepare

const REAL_MASTER = (() => {
  // The live tree's master, read-only: it must be the same at the end.
  const r = spawnSync("git", ["-C", join(homedir(), "webapps", "sova"), "rev-parse", "master"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
})();

function prepare() {
  mkdirSync(E2E, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  const head = git(HERE, "rev-parse", "HEAD");
  thisRun.head = head;
  log(`feature HEAD ${head.slice(0, 10)}; real master ${REAL_MASTER?.slice(0, 10)}`);
  if (FRESH) for (const p of [SERVER, PROJECT, ORIGIN, WT]) rmSync(p, { recursive: true, force: true });

  // The Sova under test.
  if (!existsSync(SERVER)) git(E2E, "clone", "-q", "--no-hardlinks", HERE, SERVER);
  git(SERVER, "remote", "set-url", "origin", HERE);
  git(SERVER, "fetch", "-q", "origin", head);
  git(SERVER, "checkout", "-q", "--detach", head);
  // The project: master = the feature HEAD, a local bare origin, never GitHub.
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
  for (const dir of [SERVER, PROJECT]) {
    if (!existsSync(join(dir, "node_modules"))) {
      log(`copying node_modules into ${dir}`);
      sh("node", [join(HERE, "scripts/copy-tree.mjs"), join(HERE, "node_modules"), join(dir, "node_modules")], { cwd: dir, timeout: 900_000 });
    }
    sh("mise", ["trust", dir], { allowFail: true });
  }
  sh("node", ["scripts/hermetic-agent-dir.mjs"], { cwd: SERVER });
  // A real model for the merge thread and the reviewer (--real-model; the operator allowed copying the login into
  // this hermetic .agent, gitignored, deleted at the end). Every chat defaults to MODEL before its first prompt.
  check(sh("git", ["check-ignore", ".agent/auth.json"], { cwd: SERVER, allowFail: true }) === ".agent/auth.json", ".agent is gitignored in the server clone");
  const auth = join(homedir(), ".pi", "agent", "auth.json");
  if (REAL_MODEL && existsSync(auth)) cpSync(auth, join(AGENT, "auth.json"));
  const sf = join(AGENT, "settings.json");
  const settings = existsSync(sf) ? JSON.parse(readFileSync(sf, "utf8")) : {};
  const [provider, ...model] = MODEL.split("/");
  writeFileSync(sf, JSON.stringify({ ...settings, defaultProvider: provider, defaultModel: model.join("/") }, null, 2) + "\n");
}

/** The copied login goes as soon as the runs end, on every path. */
function dropAuth() {
  rmSync(join(AGENT, "auth.json"), { force: true });
}

// ---------------------------------------------------------------- the server

let server = null;
async function startServer() {
  const out = join(LOGS, `server-${Date.now()}.log`);
  log(`starting Sova on ${PORT} (log ${out})`);
  server = spawn("scripts/start-server.sh", [], {
    cwd: SERVER,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SOVA_|PI_|CLAUDE)/.test(k))),
      PORT: String(PORT),
      PI_CODING_AGENT_DIR: AGENT,
      SOVA_UPDATES_CHECK: "off",
      SOVA_GIT_MAINTENANCE: "off",
      SOVA_PRICES_FETCH: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => appendFileSync(out, d));
  server.stderr.on("data", (d) => appendFileSync(out, d));
  await until("the server's health", async () => (await fetch(`${BASE_URL}/api/health`).catch(() => null))?.ok, 180_000, 500);
}
async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  await until("the server to stop", () => server.exitCode !== null || server.signalCode !== null, 30_000, 200).catch(() => server.kill("SIGKILL"));
  server = null;
}

// ---------------------------------------------------------------- the project and its branches

let projectId = null;
async function register() {
  const list = await http("GET", "/api/projects");
  const found = (list.json.projects ?? []).find((p) => p.root === PROJECT);
  if (found) return (projectId = found.id);
  const r = await http("POST", "/api/projects", { root: PROJECT, name: "sova-e2e" });
  check(r.status === 201, `project registered (${r.status} ${JSON.stringify(r.json)})`);
  projectId = r.json.project?.id ?? r.json.id;
  return projectId;
}

function branch(name, edit, opts = {}) {
  const b = `e2e/${name}`;
  const dir = join(WT, `sova-e2e-${name}`);
  if (existsSync(dir)) {
    git(PROJECT, "worktree", "remove", "--force", dir);
  }
  spawnSync("git", ["-C", PROJECT, "branch", "-D", b]);
  git(PROJECT, "worktree", "add", "-q", "-b", b, dir, opts.from ?? "master");
  edit(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `e2e: ${name}`);
  return { branch: b, dir, commit: git(dir, "rev-parse", "HEAD") };
}

const status = async () => (await verb("merge.status", { project: PROJECT })).merge?.view;
const allEntries = (v) => [...(v?.waiting ?? []), ...(v?.needsYou ?? []), ...(v?.needsFix ?? []), ...(v?.recent ?? []).map((r) => r.entry)];
async function entryOf(id) {
  const v = await status();
  const e = allEntries(v).find((x) => x.id === id);
  if (e) return e;
  if (v?.current?.entry === id) return { id, state: "checking" };
  return null;
}
async function waitState(id, states, ms) {
  return until(`entry ${id} in ${states.join("|")}`, async () => {
    const e = await entryOf(id);
    return e && states.includes(e.state) ? e : null;
  }, ms);
}
async function add(b, extra = {}) {
  const r = await verb("merge.add", { project: PROJECT, branch: b.branch, ...extra });
  check(r.ok !== false && r.merge?.entry, `merge.add accepted (${JSON.stringify(r.error ?? r).slice(0, 400)})`);
  return r.merge.entry;
}
async function keepLogs(caseId, entry) {
  const v = await status();
  writeFileSync(join(LOGS, `${caseId}-view.json`), JSON.stringify(v, null, 2));
  const runId = entry?.run;
  if (!runId) return;
  const r = await verb("merge.logs", { run: runId, lines: 500 });
  writeFileSync(join(LOGS, `${caseId}-run.json`), JSON.stringify(r.merge ?? r, null, 2));
  return r.merge?.run;
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
  check(!String(run?.copy).startsWith(REAL_PI) && !String(run?.copy).startsWith(AGENT), "never under a state root");
  check(run?.steps?.[0]?.kind === "copy", `the first step is the copy (${run?.steps?.[0]?.kind})`);
  check(git(PROJECT, "rev-parse", "HEAD") === head(), "the main checkout followed master");
  ev.steps = run.steps.map((s) => `${s.kind}:${s.id}:${s.result}:${s.ms}ms${s.why ? ` (${s.why})` : ""}`);
  return run;
}

// ---------------------------------------------------------------- the cases

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
  await startServer();
  try {
    await register();
    log(`project ${projectId} at ${PROJECT}`);
    await cases();
  } finally {
    writeFileSync(join(LOGS, "final-view.json"), JSON.stringify(await status().catch(() => null), null, 2));
    await archiveChats().catch((e) => log(`archiving chats: ${e.message}`));
    if (!KEEP) await stopServer();
    if (!KEEP) dropAuth();
  }
  const after = spawnSync("git", ["-C", join(homedir(), "webapps", "sova"), "rev-parse", "master"], { encoding: "utf8" }).stdout?.trim();
  thisRun.realMasterUnchanged = after === REAL_MASTER;
  thisRun.endedAt = new Date().toISOString();
  save();
  const failed = thisRun.cases.filter((c) => !c.ok);
  log(`done: ${thisRun.cases.length - failed.length}/${thisRun.cases.length} passed; real master unchanged: ${thisRun.realMasterUnchanged}`);
  for (const f of failed) log(`  FAIL ${f.id}: ${String(f.error).split("\n")[0]}`);
  process.exit(failed.length || !thisRun.realMasterUnchanged ? 1 : 0);
}

/** Archive every chat this run's server made (the merge thread, reviewers): throwaway sessions never stay open. */
async function archiveChats() {
  const r = await http("GET", "/api/sessions");
  const list = Array.isArray(r.json) ? r.json : (r.json.sessions ?? []);
  for (const s of list) if (!s.archived && s.path) await http("POST", "/api/sessions/archive", { path: s.path, archived: true }).catch(() => {});
}

process.on("SIGINT", async () => {
  await stopServer();
  dropAuth();
  process.exit(130);
});

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  dropAuth();
  process.exit(2);
});
