// What the merge queue's QA scripts share (merge-queue-e2e.mjs, merge-queue-rehearsal.mjs,
// merge-queue-projects.mjs): a workspace under ~/.cache (never ~/.pi), a clone of this worktree as the Sova
// under test with its own .agent, a hermetic server as a child process on its own port, the merge verbs over
// HTTP as the operator, waits on conditions, and a results file. Node builtins only.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REAL_PI = join(homedir(), ".pi");
export const LIVE_TREE = join(homedir(), "webapps", "sova");

export function parseArgs(argv = process.argv.slice(2)) {
  const opt = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
  };
  return { opt, has: (n) => argv.includes(n), argv };
}

export function sh(cmd, argv, o = {}) {
  const r = spawnSync(cmd, argv, { cwd: o.cwd, encoding: "utf8", env: { ...process.env, ...(o.env ?? {}) }, maxBuffer: 256 * 1024 * 1024, timeout: o.timeout ?? 600_000 });
  if (r.status !== 0 && !o.allowFail) throw new Error(`${cmd} ${argv.join(" ")} (in ${o.cwd}) exited ${r.status}: ${(r.stderr || r.stdout || "").slice(-2000)}`);
  return (r.stdout ?? "").trim();
}
export const git = (cwd, ...a) => sh("git", ["-c", "user.name=mq-qa", "-c", "user.email=mq-qa@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd });
export const gitOk = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" }).status === 0;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (tag, ...a) => console.log(`[${tag} ${new Date().toISOString().slice(11, 19)}]`, ...a);

export async function until(what, fn, ms = 30 * 60_000, every = 2000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e?.fatal) throw e;
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${what}${last ? `: ${last.message}` : ""}`);
    await sleep(every);
  }
}

export const check = (cond, what) => {
  if (!cond) throw new Error(`expected: ${what}`);
};

/** A workspace of this run's own: `<base>/<name>-<port>-<runid>` (never shared by two runs: its clone, bare origin,
 *  .worktrees, merge copy, server clone and results). `--ws <dir>` reuses a given one on purpose. */
export function runWorkspace(base, name, port, given) {
  if (given) return guardPath(given);
  const id = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${process.pid}-${Math.random().toString(16).slice(2, 6)}`;
  return guardPath(join(base, `${name}-${port}-${id}`));
}

/** Refuses any path under ~/.pi or the live tree. */
export function guardPath(p) {
  const r = resolve(p);
  if (r === REAL_PI || r.startsWith(REAL_PI + "/")) throw new Error(`refusing ${p}: under ~/.pi`);
  if (r === LIVE_TREE || r.startsWith(LIVE_TREE + "/")) throw new Error(`refusing ${p}: the live tree`);
  return r;
}

export async function portFree(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });
}

/** The real repo's target sha, read only (it must be the same at the end). */
export function realHead(repo, ref) {
  const r = spawnSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------- a Sova under test

/**
 * A clone of this worktree's committed HEAD at `<ws>/server`, its own .agent, node_modules copied (no network),
 * a server on `port` as a child of this process. `realModel`: the user's login copied into the clone's gitignored
 * .agent for the run (removed by stop()); every chat defaults to `model`.
 */
export class SovaUnderTest {
  constructor({ ws, port, model = "zai/glm-5.3", realModel = false, tag = "qa", env = {} }) {
    this.ws = guardPath(ws);
    this.dir = join(this.ws, "server");
    this.agent = join(this.dir, ".agent");
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.model = model;
    this.realModel = realModel;
    this.tag = tag;
    this.env = env;
    this.child = null;
    this.token = null;
    this.logFile = null;
  }

  /** mise's state (its trusted-config links) under the workspace: the user's own may be read-only in a sandbox, and
   *  a test run never adds trust entries to it. Tools still come from the user's data dir (read only). */
  miseEnv() {
    const dir = join(this.ws, "mise-state");
    mkdirSync(dir, { recursive: true });
    return { MISE_STATE_DIR: dir };
  }

  prepare() {
    mkdirSync(this.ws, { recursive: true });
    const head = git(HERE, "rev-parse", "HEAD");
    if (!existsSync(this.dir)) git(this.ws, "clone", "-q", "--no-hardlinks", HERE, this.dir);
    git(this.dir, "remote", "set-url", "origin", HERE);
    git(this.dir, "fetch", "-q", "origin", head);
    git(this.dir, "checkout", "-q", "--detach", head);
    copyNodeModules(this.dir);
    sh("mise", ["trust", this.dir], { allowFail: true, env: this.miseEnv() });
    sh("node", ["scripts/hermetic-agent-dir.mjs"], { cwd: this.dir });
    check(sh("git", ["check-ignore", ".agent/auth.json"], { cwd: this.dir, allowFail: true }) === ".agent/auth.json", ".agent is gitignored in the server clone");
    const auth = join(REAL_PI, "agent", "auth.json");
    if (this.realModel && existsSync(auth)) cpSync(auth, join(this.agent, "auth.json"));
    const sf = join(this.agent, "settings.json");
    const settings = existsSync(sf) ? JSON.parse(readFileSync(sf, "utf8")) : {};
    const [provider, ...model] = this.model.split("/");
    writeFileSync(sf, JSON.stringify({ ...settings, defaultProvider: provider, defaultModel: model.join("/") }, null, 2) + "\n");
    return head;
  }

  async start(logsDir) {
    check(await portFree(this.port), `port ${this.port} is free`);
    check(this.port !== 4800, "never the live port");
    mkdirSync(logsDir, { recursive: true });
    this.logFile = join(logsDir, `server-${this.port}-${Date.now()}.log`);
    log(this.tag, `starting Sova on ${this.port} (log ${this.logFile})`);
    this.child = spawn("scripts/start-server.sh", [], {
      cwd: this.dir,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SOVA_|PI_|CLAUDE)/.test(k))),
        PORT: String(this.port),
        PI_CODING_AGENT_DIR: this.agent,
        SOVA_UPDATES_CHECK: "off",
        SOVA_GIT_MAINTENANCE: "off",
        SOVA_PRICES_FETCH: "off",
        ...this.miseEnv(),
        ...this.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so every exit path kills the server and everything it started (chats, services).
      detached: true,
    });
    const pgid = this.child.pid;
    // Every exit path: a normal exit or an uncaught throw (the 'exit' hook, synchronous), and this script killed
    // outright (SIGKILL, a timeout): a watchdog outside the group kills the group once this script is gone.
    const reap = () => {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
    };
    process.once("exit", reap);
    this.reaps = [...(this.reaps ?? []), reap];
    spawn("sh", ["-c", `while kill -0 ${process.pid} 2>/dev/null && kill -0 -- -${pgid} 2>/dev/null; do sleep 2; done; kill -9 -- -${pgid} 2>/dev/null; exit 0`], { detached: true, stdio: "ignore" }).unref();
    this.child.stdout.on("data", (d) => appendFileSync(this.logFile, d));
    this.child.stderr.on("data", (d) => appendFileSync(this.logFile, d));
    await until("the server's health", async () => (await fetch(`${this.base}/api/health`).catch(() => null))?.ok, 180_000, 500);
    this.token = readFileSync(join(this.agent, "sova", "auth-token"), "utf8").trim();
  }

  /** The server process dies at once (SIGKILL): a crash, not a stop. */
  kill() {
    const c = this.child;
    if (!c) return;
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      c.kill("SIGKILL");
    }
  }

  async stopServer() {
    const c = this.child;
    if (!c) return;
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGTERM");
      await until("the server to stop", () => c.exitCode !== null || c.signalCode !== null, 30_000, 200).catch(() => c.kill("SIGKILL"));
    }
    // Whatever it left in its group (a chat process, a service) goes with it.
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {}
    this.child = null;
  }

  async stop() {
    await this.archiveChats().catch(() => {});
    await this.stopServer();
    this.dropAuth();
  }

  dropAuth() {
    rmSync(join(this.agent, "auth.json"), { force: true });
  }

  /** The page's own sign-in, as the browser sends it (server/auth.ts authCookieName): the merge queue's acts pass only
   *  for the user's page (§app.access/your-click), and this rig stands in for the user's clicks. */
  pageCookie() {
    return `sova_token_${createHash("sha256").update(resolve(this.agent)).digest("hex").slice(0, 8)}=${this.token ?? ""}`;
  }

  async http(method, path, body, { asPage = false } = {}) {
    const t0 = Date.now();
    let r;
    // As the page: its cookie and no token header (a token in a header is a script's mark).
    const auth = asPage ? { cookie: this.pageCookie() } : { "x-sova-token": this.token ?? "" };
    try {
      r = await fetch(this.base + path, { method, headers: { "content-type": "application/json", ...auth }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new Error(`${method} ${path} failed after ${Date.now() - t0} ms: ${e?.cause?.code ?? ""} ${e?.cause?.message ?? e?.message}`);
    }
    const ms = Date.now() - t0;
    if (ms > 5000) log(this.tag, `slow: ${method} ${path} took ${ms} ms`);
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: r.status, json };
  }

  /** One merge verb as the operator (the route the Land button uses). */
  async verb(name, body) {
    // The queue's reads go as a script; its acts as the user's page, whose clicks this rig stands in for.
    const asPage = /^merge\./.test(name) && !["merge.status", "merge.logs", "merge.try"].includes(name);
    return (await this.http("POST", `/api/project-services/${name}`, body, { asPage })).json;
  }

  /** The project's private names for the leak scan, set up as the names interview would (store.ts namesFileOf:
   *  <state>/merge-queue/<sha256(root)[:16]>/names.json). Without it the first landing's push is held "private
   *  names not set up yet", as designed. */
  seedNames(root, names = []) {
    const dir = join(this.agent, "sova", "merge-queue", createHash("sha256").update(root).digest("hex").slice(0, 16));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "names.json"), JSON.stringify({ privateNames: names }) + "\n");
  }

  async register(root, name) {
    const list = await this.http("GET", "/api/projects");
    const found = (list.json.projects ?? []).find((p) => p.root === root);
    if (found) return found.id;
    const r = await this.http("POST", "/api/projects", { root, name });
    check(r.status === 201, `project ${name} registered (${r.status} ${JSON.stringify(r.json).slice(0, 300)})`);
    return r.json.project?.id ?? r.json.id;
  }

  async archiveChats() {
    const r = await this.http("GET", "/api/sessions");
    const list = Array.isArray(r.json) ? r.json : (r.json.sessions ?? []);
    for (const s of list) if (!s.archived && s.path) await this.http("POST", "/api/sessions/archive", { path: s.path, archived: true }).catch(() => {});
  }
}

export function copyNodeModules(dir, from = HERE) {
  if (existsSync(join(dir, "node_modules"))) return;
  sh("node", [join(HERE, "scripts/copy-tree.mjs"), join(from, "node_modules"), join(dir, "node_modules")], { cwd: dir, timeout: 900_000 });
}

// ---------------------------------------------------------------- one project's queue

export class QueueClient {
  /** States an entry rests in until someone acts: a wait for anything else ends at once. */
  static FINAL = ["landed", "needs-fix", "cancelled", "behaviour-differs", "review-flagged", "unattributed", "drafts-changed"];
  constructor(sova, root) {
    this.sova = sova;
    this.root = root;
  }
  async view() {
    const r = await this.sova.verb("merge.status", { project: this.root });
    return r.merge?.view ?? null;
  }
  static entriesOf(v) {
    return [...(v?.waiting ?? []), ...(v?.needsYou ?? []), ...(v?.needsFix ?? []), ...(v?.recent ?? []).map((r) => r.entry)];
  }
  async entry(id) {
    const v = await this.view();
    const e = QueueClient.entriesOf(v).find((x) => x.id === id);
    if (e) return e;
    if (v?.current?.entry === id) return { id, state: "checking", run: v.current.id };
    return null;
  }
  /** Waits for the entry to reach one of `states`; a pause no caller resumes (machine, master red, reviewer,
   *  recovery) fails at once with its reason instead of waiting out `ms`. `allowPause` lists kinds to sit through. */
  async waitState(id, states, ms = 60 * 60_000, { allowPause = ["master-moved", "operator"] } = {}) {
    return until(`entry ${id} in ${states.join("|")}`, async () => {
      const v = await this.view();
      const found = QueueClient.entriesOf(v).find((x) => x.id === id) ?? (v?.current?.entry === id ? { id, state: "checking", run: v.current.id } : null);
      if (found && states.includes(found.state)) return found;
      if (found && QueueClient.FINAL.includes(found.state)) {
        const err = new Error(`entry ${id} ended ${found.state} (waiting for ${states.join("|")}): ${found.reason ?? found.review?.text ?? ""}`.slice(0, 600));
        err.fatal = true;
        throw err;
      }
      if (v?.state === "paused" && v.paused && !allowPause.includes(v.paused.kind)) {
        const err = new Error(`the queue paused (${v.paused.kind}): ${v.paused.why}`);
        err.fatal = true;
        throw err;
      }
      return null;
    }, ms);
  }
  async waitView(pred, what, ms = 30 * 60_000) {
    return until(what, async () => {
      const v = await this.view();
      return v && pred(v) ? v : null;
    }, ms);
  }
  async add(branch, extra = {}) {
    const r = await this.sova.verb("merge.add", { project: this.root, branch, ...extra });
    check(r.ok !== false && r.merge?.entry, `merge.add ${branch} accepted (${JSON.stringify(r.error ?? r).slice(0, 400)})`);
    return r.merge.entry;
  }
  async answer(entry, answer) {
    const r = await this.sova.verb("merge.answer", { entry, answer });
    check(r.ok !== false, `merge.answer ${answer} accepted (${JSON.stringify(r.error ?? "")})`);
    return r.merge?.entry;
  }
  async resume() {
    const r = await this.sova.verb("merge.resume", { project: this.root });
    check(r.ok !== false, `merge.resume accepted (${JSON.stringify(r.error ?? "")})`);
  }
  async run(id, lines = 400) {
    const r = await this.sova.verb("merge.logs", { run: id, lines });
    return r.merge ?? null;
  }
}

// ---------------------------------------------------------------- results

export class Results {
  constructor(file, tag, { fresh = false } = {}) {
    this.file = file;
    this.tag = tag;
    mkdirSync(dirname(file), { recursive: true });
    this.all = existsSync(file) && !fresh ? JSON.parse(readFileSync(file, "utf8")) : { runs: [] };
    this.cur = { startedAt: new Date().toISOString(), cases: [] };
    this.all.runs.push(this.cur);
  }
  save() {
    writeFileSync(this.file, JSON.stringify(this.all, null, 2) + "\n");
  }
  set(k, v) {
    this.cur[k] = v;
    this.save();
  }
  async kase(id, title, fn, only = null) {
    if (only && !only.has(id)) return null;
    log(this.tag, `${id} ${title}`);
    const t0 = Date.now();
    const rec = { id, title, ok: false, ms: 0, evidence: {}, error: null };
    this.cur.cases.push(rec);
    this.save();
    try {
      await fn(rec.evidence);
      rec.ok = true;
      log(this.tag, `${id} PASS (${Math.round((Date.now() - t0) / 1000)} s)`);
    } catch (e) {
      rec.error = String(e?.stack ?? e);
      log(this.tag, `${id} FAIL: ${e?.message ?? e}`);
    }
    rec.ms = Date.now() - t0;
    this.save();
    return rec;
  }
  summary() {
    const failed = this.cur.cases.filter((c) => !c.ok);
    log(this.tag, `done: ${this.cur.cases.length - failed.length}/${this.cur.cases.length} passed`);
    for (const f of failed) log(this.tag, `  FAIL ${f.id}: ${String(f.error).split("\n")[0]}`);
    return failed.length;
  }
}

/** A branch `name` in its own worktree at `<wtDir>/<prefix>-<slug>`, cut from `from`, with one commit by `edit(dir)`. */
export function makeBranch(project, wtDir, prefix, name, edit, { from = "master", message } = {}) {
  const b = name;
  const dir = join(wtDir, `${prefix}-${name.replace(/[^a-z0-9-]/gi, "-")}`);
  if (existsSync(dir)) spawnSync("git", ["-C", project, "worktree", "remove", "--force", dir]);
  spawnSync("git", ["-C", project, "branch", "-D", b]);
  git(project, "worktree", "add", "-q", "-b", b, dir, from);
  edit(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message ?? `qa: ${name}`);
  return { branch: b, dir, commit: git(dir, "rev-parse", "HEAD") };
}
