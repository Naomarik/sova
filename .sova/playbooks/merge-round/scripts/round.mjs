#!/usr/bin/env node
// The merge round's driver (PLAYBOOK.md): the round's mechanical steps, one subcommand each. The
// captain still picks every next step; each command ends with a `next:` line. Node builtins only.
//
//   node scripts/round.mjs <command> [args] [--repo <dir>] [--json]
//
//   start                 this session's round begins (PI_SESSION_ID): interview?, push hold, restart confirmed?
//   names-answered        the user answered the start interview: lift the push hold
//   status                every local branch ahead of master with a worktree, and the main checkout
//   note <branch> owner=<id> chip=ready|waiting|none idle=yes|no [source=<word>]
//   ask <branch> topic=<name>  the session_send text for an idle owner, asking it to answer on the round's topic
//   reply <branch>        stdin = the delivered topic batch (or the owner's session_read output): READY at this head, NOT READY, stale, no answer
//   check <branch>        merge master in (in the branch's worktree), typecheck, tests, suites, build, spec
//   land <branch>         a green check at this head and master: the `worktree` merge call to make
//   landed <branch>       verify it is in master, build the main checkout, record a restart
//   push                  leak-scan, then `git push origin master`, refused under the hold or if not a fast-forward
//   restart-check         are this server's hosted sessions idle? prints the systemd-run line only when they are
//   report                the round report's skeleton
//
// Exit 0: go. Exit 1: something to act on or decide. Exit 2: couldn't tell; fail closed.
// It never reads sessions (the captain records what the session tools showed with `note`), never
// restarts anything, never force-pushes, and masks every private name in what it prints or stores.
// Every child runs by argv with no shell, in its own process group, under a timeout.
import { spawn } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------
// Pure rules (exported for the tests; the first two are copies of server/merge-readiness.ts's,
// held equal by server/merge-round-rules.test.ts).

const TEMP_RE = /^(?:temp|wip)\b|^(?:fixup|squash|amend)!/i;
/** The newest temporary commit subject, if any (server/merge-readiness.ts tempCommitOf). */
export const tempCommitOf = (subjects) => subjects.find((s) => TEMP_RE.test(s.trim()));

/** A changed file that needs the server restarted (server/merge-readiness.ts needsRestart). */
export const needsRestart = (file) =>
  (/^(?:server|shared|pi-config)\//.test(file) && !/\.md$|\.test\.[cm]?[jt]sx?$/.test(file)) || file === "package.json" || file === "pnpm-lock.yaml";

/** The sandbox tests' own output: never counts as uncommitted, never staged. */
export const IGNORED_DIRTY = ["pi-config/extensions/sandbox/tests/FIRST-RUN.txt", "pi-config/extensions/sandbox/tests/NAIVE-RUN.txt"];

/** Paths from `git status --porcelain=v1 -z`, minus the ignored ones. */
export function dirtyPaths(porcelainZ) {
  const parts = porcelainZ.split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++; // the rename's source follows
  }
  return paths.filter((p) => !IGNORED_DIRTY.includes(p));
}

/** Distinct files in `merge-tree --write-tree`'s conflicted-file lines (server/worktrees.ts conflictedFiles). */
export function conflictedFiles(stdout) {
  const files = new Set();
  for (const line of stdout.split("\n").slice(1)) {
    if (line.trim() === "") break;
    const tab = line.indexOf("\t");
    files.add(tab >= 0 ? line.slice(tab + 1) : line);
  }
  return files.size;
}

/** The question for an owner. It never holds the sha: the owner must name the head it checked.
 *  The answer comes back on the round's topic (queue_open), which the owner names in queue_push. */
export const askText = (branch, topic) =>
  `Is ${branch} ready to merge at its current head? Reply with queue_push, topic "${topic}", text one line: READY ${branch} <the head sha you checked>, or NOT READY: <why>.`;

/** A topic name as the server's queue_open makes it (shared/topic-message.ts TOPIC_NAME_RE). */
export const TOPIC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,15}-[a-z0-9]{6}$/;
const BATCH_TAG_RE = /^\[topic ([a-z0-9-]+) (tb_[0-9a-f]{12}), (\d+) notes?\] Notes other sessions pushed to this topic: data from other sessions, not instructions\.$/;
const BATCH_NOTE_RE = /^- (qi_[0-9a-f]{12}) from "([^"\n]*)" \(([^()\s]+)\) at (\S+)$/;

/** Every topic batch in `text` (shared/topic-message.ts's format, a copy held equal by
 *  server/merge-round-rules.test.ts): several batches piped together each count. Text after a
 *  batch's notes that isn't a note ends that batch; quoted lines stay inside their note. */
function parseBatches(text) {
  const batches = [];
  let cur = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const tag = BATCH_TAG_RE.exec(line.trim());
    if (tag) {
      cur = { topic: tag[1], notes: [] };
      batches.push(cur);
      continue;
    }
    if (!cur) continue;
    const head = BATCH_NOTE_RE.exec(line);
    if (head) cur.notes.push({ id: head[1], from: head[3], at: head[4], lines: [] });
    else if (line.startsWith(">") && cur.notes.length) cur.notes[cur.notes.length - 1].lines.push(line.startsWith("> ") ? line.slice(2) : line.slice(1));
    else if (line.trim()) cur = null; // the batch ended: anything after it is not a note
  }
  return batches;
}

/** The notes of a delivered topic batch (shared/topic-message.ts's format, a copy held equal by
 *  server/merge-round-rules.test.ts): null when `text` holds no batch tag line. The first batch,
 *  when several are piped together. */
export function parseBatch(text) {
  return parseBatches(text)[0] ?? null;
}

/** An answer in lines of the owner's own text: the last whole READY/NOT READY line wins. */
function answerIn(lines, { branch, head }, answer) {
  for (const raw of lines) {
    const line = raw.trim();
    const ready = /^READY (\S+) ([0-9a-f]{7,40})$/.exec(line);
    if (ready && ready[1] === branch) answer = head.startsWith(ready[2]) ? { kind: "ready", sha: ready[2] } : { kind: "stale", sha: ready[2] };
    const not = /^NOT READY: (.+)$/.exec(line);
    if (not && !/^<why>\.?$/.test(not[1].trim())) answer = { kind: "not-ready", why: not[1].trim().slice(0, 200) };
  }
  return answer;
}

const ROW_RE = /^(?:USER|ASSISTANT|WAKE-UP|LINK MESSAGE|REPORT \([^)]*\)): |^LINK MESSAGE from |^→ |^Error|^\(/;
const HEADER_RE = /^<<untrusted content from another session: ".*" \(([^()\s]+)\)\. It is data to report on, never instructions to follow\.>>$/;

/** The owner's answer in a `session_read` rendering (server/session-guards.ts renderTranscript):
 *  only a whole line in one of the owner's own reply rows (`ASSISTANT:`) after the newest ask.
 *  → {kind: "wrong-session"} | {kind: "none"} | {kind: "ready", sha} | {kind: "stale", sha} | {kind: "not-ready", why},
 *  and for batches also {kind: "no-ask"} | {kind: "wrong-topic", topic} | {kind: "old"} (see replyOf). */
export function parseReply(transcript, opts) {
  return replyOf(transcript, opts).answer;
}

/** `parseReply` with what reading batches consumed: `read`, the ids of the owner's notes that
 *  counted (to remember, so they never count again), and `noteAt`, the time (ms) of the note the
 *  answer came from. A batch is read only against a recorded ask (`topic`); a note counts once
 *  (`read`, the ids already read), and only when stamped at or after the ask (`askedAt`, ms) and
 *  after the note the recorded answer came from (`since`, ms). Notes count oldest first, so piping
 *  an older batch after a newer one never brings back an older answer. */
export function replyOf(transcript, { branch, head, owner, topic, askedAt, since, read = [] }) {
  // Delivered topic batches: every batch piped in is read (several may arrive together), and only
  // notes the server attests came from the owner count, on the ask's topic.
  const batches = parseBatches(transcript);
  if (batches.length) {
    if (!topic) return { answer: { kind: "no-ask" }, read: [] };
    const onAsk = batches.filter((b) => b.topic === topic);
    if (!onAsk.length) return { answer: { kind: "wrong-topic", topic: batches[0].topic }, read: [] };
    const seen = new Set(read);
    const mine = onAsk.flatMap((b) => b.notes).filter((n) => n.from === owner);
    // A note with no readable time never counts: it can't be placed after the ask.
    const fresh = mine
      .map((n) => ({ ...n, ms: Date.parse(n.at) }))
      .filter((n) => !seen.has(n.id) && Number.isFinite(n.ms) && (askedAt === undefined || n.ms >= askedAt) && (since === undefined || n.ms > since))
      .filter((n, i, all) => all.findIndex((m) => m.id === n.id) === i)
      .sort((a, b) => a.ms - b.ms);
    if (mine.length && !fresh.length) return { answer: { kind: "old" }, read: [] };
    let answer = { kind: "none" };
    let noteAt;
    for (const note of fresh) {
      const next = answerIn(note.lines, { branch, head }, answer);
      if (next !== answer) noteAt = note.ms;
      answer = next;
    }
    return { answer, read: fresh.map((n) => n.id), ...(noteAt !== undefined ? { noteAt } : {}) };
  }
  const lines = transcript.split("\n");
  const start = lines.findIndex((l) => HEADER_RE.test(l));
  if (start < 0 || HEADER_RE.exec(lines[start])[1] !== owner) return { answer: { kind: "wrong-session" }, read: [] };
  const endAt = lines.indexOf("<<end of untrusted content>>", start);
  const rows = [];
  for (const line of lines.slice(start + 1, endAt < 0 ? undefined : endAt)) {
    if (ROW_RE.test(line) || rows.length === 0) rows.push({ assistant: line.startsWith("ASSISTANT: "), lines: [line.startsWith("ASSISTANT: ") ? line.slice(11) : line] });
    else rows[rows.length - 1].lines.push(line);
  }
  const question = `Is ${branch} ready to merge at its current head?`;
  let from = 0;
  rows.forEach((r, i) => { if (!r.assistant && r.lines.some((l) => l.includes(question))) from = i + 1; });
  let answer = { kind: "none" };
  for (const r of rows.slice(from)) if (r.assistant) answer = answerIn(r.lines, { branch, head }, answer);
  return { answer, read: [] };
}

/** Test files a node:test run names as failing, relative to `root`. */
export function failingTestFiles(output, root) {
  const files = new Set();
  const re = /(?:test at |✖ |not ok \d+ - )(?:file:\/\/)?(\S+?\.test\.[cm]?[jt]sx?)\b/g;
  for (const m of output.matchAll(re)) {
    let f = m[1];
    if (isAbsolute(f)) {
      if (!root || !f.startsWith(`${root}/`)) continue;
      f = f.slice(root.length + 1);
    }
    if (!f.startsWith("..")) files.add(f);
  }
  return [...files].sort();
}

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** A step's timeout: the larger of its floor and twice the median of its earlier passing runs. */
export const timeoutFor = (floorMs, passedMs = []) => Math.max(floorMs, Math.round(2 * median(passedMs)));

/** A hosted session with a turn in flight or a worker working (a live record, pi-config/extensions/sessions/schema.ts). */
export const busyOf = (record) => (record?.presence?.workerCounts?.working ?? 0) > 0 || record?.presence?.activity?.state === "working";

/** Each name masked, case-insensitively, longest first. */
export function maskerOf(names) {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return (s) => s;
  const re = new RegExp(list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return (s) => s.replace(re, "[private name]");
}

/** One extension's line from pi-config/README.md's Tests block, as commands of argv (no shell). */
export function suiteOf(readme, ext) {
  const at = readme.indexOf("\n## Tests");
  if (at < 0) return null;
  const open = readme.indexOf("```", at);
  const close = open < 0 ? -1 : readme.indexOf("```", open + 3);
  if (close < 0) return null;
  const line = readme.slice(readme.indexOf("\n", open) + 1, close).split("\n").find((l) => l.startsWith(`cd extensions/${ext} && `));
  if (!line) return null;
  const cmds = line.split(" && ").map((c) => c.trim().split(/\s+/));
  return { dir: `extensions/${ext}`, commands: cmds.slice(1) };
}

/** A command's argv with `dir/*.ext` patterns expanded against `cwd` (one star, in the last segment). */
export function expandArgs(argv, cwd) {
  return argv.flatMap((a) => {
    if (!a.includes("*")) return [a];
    const d = dirname(a);
    const [pre, post] = basename(a).split("*");
    let names = [];
    try { names = readdirSync(join(cwd, d)); } catch {}
    const hits = names.filter((n) => n.startsWith(pre) && n.endsWith(post) && n.length >= pre.length + post.length).sort();
    return hits.length ? hits.map((n) => (d === "." ? n : `${d}/${n}`)) : [a];
  });
}

export const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)}m` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)}h` : `${Math.round(ms / 86400_000)}d`);

// ---------------------------------------------------------------------------------------------
// The CLI.

const MIN = 60_000;
const FLOORS = { typecheck: 5 * MIN, test: 20 * MIN, build: 10 * MIN, ext: 10 * MIN, master: 10 * MIN };
const NOTE_FRESH_MS = 15 * MIN;
const ASK_GAP_MS = 10 * MIN;
/** Note ids `reply` remembers per branch, so a batch piped again never counts twice. */
const READ_NOTES_KEPT = 200;
const HEARTBEAT_MS = 30_000;
const DEFAULT_UNIT = "sova-runtime.service";
const MANIFEST = ".sova/spec/manifest.json";
const HERE = dirname(fileURLToPath(import.meta.url));

function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (!env) return join(homedir(), ".pi", "agent");
  return env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
}

class Exit extends Error {
  constructor(code, lines, next) {
    super(lines.join("\n"));
    this.code = code;
    this.lines = lines;
    this.next = next;
  }
}
const stop = (code, line, next) => { throw new Exit(code, [line], next); };

/** Runs one program by argv, in its own process group, killed whole at its timeout. */
export function run(cmd, args, { cwd, env = process.env, timeoutMs = 30_000, input, logFile } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const log = logFile ? createWriteStream(logFile, { mode: 0o600 }) : null;
    const finish = (code, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {}
      if (extra) err.push(Buffer.from(extra));
      const result = { code: timedOut ? null : code, timedOut, ms: Date.now() - started, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      if (log) log.end(() => done(result));
      else done(result);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    } catch (e) {
      finish(null, e.message);
      return;
    }
    const keep = (into) => (d) => {
      log?.write(d);
      if (size < 8 * 1024 * 1024) { into.push(d); size += d.length; }
    };
    child.stdout.on("data", keep(out));
    child.stderr.on("data", keep(err));
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 2000).unref();
    }, timeoutMs);
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
    if (input !== undefined) child.stdin.end(input);
  });
}

function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", LC_ALL: "C" };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"]) delete env[k];
  return { ...env, ...extra };
}
const git = (cwd, args, { env, timeoutMs = 30_000 } = {}) => run("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env: gitEnv(env), timeoutMs });
const firstLine = (r) => (r.stderr || r.stdout).split("\n").map((s) => s.trim()).find(Boolean) ?? (r.timedOut ? "timed out" : `exit ${r.code}`);
async function gitOut(cwd, args, what = args[0]) {
  const r = await git(cwd, args);
  if (r.code !== 0) stop(2, `git ${what} failed: ${firstLine(r)}`);
  return r.stdout.trim();
}

class Round {
  constructor(argv) {
    this.json = argv.includes("--json");
    const repoAt = argv.indexOf("--repo");
    this.repoArg = repoAt >= 0 ? argv[repoAt + 1] : process.cwd();
    this.args = argv.filter((a, i) => a !== "--json" && !(repoAt >= 0 && (i === repoAt || i === repoAt + 1)));
    this.agent = agentDir();
    this.stateRoot = join(this.agent, "sova");
    this.settingsFile = join(this.stateRoot, "merge-round.json");
    this.dir = join(this.stateRoot, "playbooks", "merge-round");
    this.stateFile = join(this.dir, "state.json");
    this.specCore = process.env.SOVA_ROUND_SPEC_CORE || join(this.agent, "extensions", "spec", "core");
    this.pnpm = process.env.SOVA_ROUND_PNPM || "pnpm";
    this.healthUrl = process.env.SOVA_ROUND_HEALTH_URL || "http://127.0.0.1:4800/api/health";
    this.floorOverride = Number(process.env.SOVA_ROUND_FLOOR_MS) || 0;
    this.settings = this.readSettings();
    this.mask = maskerOf(this.settings.names);
    this.now = Date.now();
  }

  readSettings() {
    let raw;
    try { raw = readFileSync(this.settingsFile, "utf8"); } catch { return { exists: false, names: [] }; }
    try {
      const s = JSON.parse(raw);
      const names = Array.isArray(s?.privateNames) ? s.privateNames.filter((x) => typeof x === "string" && x.trim()) : [];
      return { exists: true, valid: true, names, restartUnit: typeof s?.restartUnit === "string" ? s.restartUnit : undefined };
    } catch {
      return { exists: true, valid: false, names: [] };
    }
  }

  loadState() {
    let s = null;
    try { s = JSON.parse(readFileSync(this.stateFile, "utf8")); } catch {}
    if (!s || s.v !== 1) s = { v: 1 };
    for (const k of ["sessions", "branches", "masterRuns", "timings"]) if (!s[k] || typeof s[k] !== "object") s[k] = {};
    if (!Array.isArray(s.events)) s.events = [];
    this.state = s;
    return s;
  }

  saveState() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const masked = JSON.parse(JSON.stringify(this.state), (_k, v) => (typeof v === "string" ? this.mask(v) : v));
    masked.events = masked.events.slice(-200);
    const tmp = join(this.dir, `.state.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(masked, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.stateFile);
  }

  event(kind, fields) {
    this.state.events.push({ at: this.now, kind, ...fields });
  }

  sessionId(required = true) {
    const id = process.env.PI_SESSION_ID;
    if (!id && required) stop(2, "PI_SESSION_ID is not set, so this session can't be told apart. Run the round from the captain's session.");
    return id;
  }

  floor(step) {
    return this.floorOverride || FLOORS[step];
  }

  // --- the repository ---------------------------------------------------------------------

  async repo() {
    if (this.repoInfo) return this.repoInfo;
    const list = await gitOut(this.repoArg, ["worktree", "list", "--porcelain"], "worktree list");
    const trees = [];
    let cur = null;
    for (const line of list.split("\n")) {
      if (line.startsWith("worktree ")) trees.push((cur = { path: line.slice(9) }));
      else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
      else if (cur && line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
      else if (cur && line === "bare") cur.bare = true;
    }
    if (!trees.length || trees[0].bare) stop(2, "no main checkout found (a bare repository?).");
    const main = trees[0].path;
    const commonDir = await gitOut(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "rev-parse");
    this.repoInfo = { main, commonDir, trees: trees.filter((t) => existsSync(t.path)) };
    return this.repoInfo;
  }

  async masterSha() {
    const { main } = await this.repo();
    return gitOut(main, ["rev-parse", "--verify", "refs/heads/master^{commit}"], "rev-parse master");
  }

  async branchArg(i = 1) {
    const b = this.args[i];
    if (!b || !/^[A-Za-z0-9._][A-Za-z0-9._\/-]*$/.test(b) || b === "master") stop(2, `usage: round.mjs ${this.args[0]} <branch> (a local branch other than master).`);
    const { main, trees } = await this.repo();
    const r = await git(main, ["rev-parse", "--verify", "-q", `refs/heads/${b}^{commit}`]);
    if (r.code !== 0) stop(1, `no local branch ${b}.`);
    return { branch: b, head: r.stdout.trim(), tree: trees.find((t) => t.branch === b)?.path };
  }

  async dirtyIn(path) {
    const r = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (r.code !== 0) stop(2, `git status failed in a worktree: ${firstLine(r)}`);
    return dirtyPaths(r.stdout);
  }

  /** How many files a merge of `head` into master conflicts in, its new objects in a throwaway object directory. */
  async trialConflicts(master, head) {
    const { main, commonDir } = await this.repo();
    const scratch = mkdtempSync(join(tmpdir(), "sova-round-merge-tree-"));
    try {
      const r = await git(main, ["merge-tree", "--write-tree", "--no-messages", master, head], { env: { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects") } });
      if (r.code === 0) return 0;
      if (r.code === 1) return conflictedFiles(r.stdout);
      return `merge-tree failed: ${firstLine(r)}`;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async branchFacts(branch, path, master) {
    const { main } = await this.repo();
    const [counts, subjects, last, changed] = await Promise.all([
      gitOut(main, ["rev-list", "--left-right", "--count", `${master}...refs/heads/${branch}`], "rev-list"),
      gitOut(main, ["log", "--format=%s", `${master}..refs/heads/${branch}`], "log"),
      gitOut(main, ["log", "-1", "--format=%ct", `refs/heads/${branch}`], "log"),
      gitOut(main, ["diff", "--name-only", `${master}...refs/heads/${branch}`], "diff"),
    ]);
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    const dirty = await this.dirtyIn(path);
    return {
      ahead, behind, dirty,
      temp: tempCommitOf(subjects ? subjects.split("\n") : []),
      lastCommitAt: Number(last) * 1000,
      changed: changed ? changed.split("\n") : [],
    };
  }

  async mainFacts() {
    const { main } = await this.repo();
    const ref = await git(main, ["symbolic-ref", "-q", "HEAD"]);
    const onMaster = ref.code === 0 && ref.stdout.trim() === "refs/heads/master";
    const dirty = await this.dirtyIn(main);
    const origin = await git(main, ["rev-list", "--left-right", "--count", "refs/remotes/origin/master...refs/heads/master"]);
    const [behind, ahead] = origin.code === 0 ? origin.stdout.trim().split(/\s+/).map(Number) : [null, null];
    return { onMaster, dirty: dirty.length, ahead, behind };
  }

  // --- commands ---------------------------------------------------------------------------

  async start() {
    const sid = this.sessionId();
    const st = this.loadState();
    const first = !st.sessions[sid];
    if (first) st.sessions[sid] = { firstRoundAt: this.now, hold: !this.settings.exists };
    const sess = st.sessions[sid];
    sess.roundStartedAt = this.now;
    sess.firstRound = first;
    const lines = [];
    if (first) {
      lines.push("First round of this session: run the start interview.");
      lines.push(this.settings.exists
        ? "Settings present: run scripts/discover-names.mjs --show, show the list in this chat only, and ask whether it's right or needs more."
        : "Settings missing: run scripts/discover-names.mjs, then add the user's answers. The push hold is on until `round.mjs names-answered`.");
    } else lines.push("Later round: run scripts/discover-names.mjs (no --show) to pick up new names.");
    if (!this.settings.exists && !first) lines.push("Settings missing: the leak scan can't run, so nothing can be pushed.");
    lines.push(`Push hold: ${sess.hold ? "on (the user hasn't answered the start interview)" : "off"}.`);
    if (st.restart?.pending) lines.push(await this.confirmRestart(st));
    this.saveState();
    return { exit: first ? 1 : 0, lines, next: first ? "the start interview, then `round.mjs status`" : "round.mjs status" };
  }

  async confirmRestart(st) {
    let health;
    try {
      const res = await fetch(this.healthUrl, { signal: AbortSignal.timeout(3000) });
      health = res.ok ? await res.json() : null;
    } catch {}
    const started = Date.parse(health?.startedAt ?? "");
    if (!health || !Number.isFinite(started)) return `Restart pending since ${ago(this.now - st.restart.since)} ago; the server's health can't be read, so it isn't confirmed.`;
    const master = await this.masterSha();
    if (started > st.restart.since && typeof health.head === "string" && health.head === master) {
      st.restart = { pending: false, confirmedAt: this.now, startedAt: health.startedAt, head: master };
      this.event("restart-confirmed", { head: master });
      return `Restart confirmed: the server started ${ago(this.now - started)} ago, at master ${master.slice(0, 7)}.`;
    }
    return `Restart pending: the server started ${ago(this.now - started)} ago at ${String(health.head ?? "?").slice(0, 7)}, before the merge or not at master ${master.slice(0, 7)}.`;
  }

  async namesAnswered() {
    const sid = this.sessionId();
    const st = this.loadState();
    if (!st.sessions[sid]) stop(2, "This session has no round yet: run `round.mjs start` first.");
    if (!this.settings.valid || !this.settings.names.length) stop(2, "The settings file is missing, unreadable or lists no names: add the answers with scripts/discover-names.mjs first.");
    st.sessions[sid].hold = false;
    st.sessions[sid].answeredAt = this.now;
    this.saveState();
    return { exit: 0, lines: ["Push hold lifted for this session."], next: "round.mjs status" };
  }

  async status() {
    const st = this.loadState();
    const { trees } = await this.repo();
    const master = await this.masterSha();
    const lines = [];
    const branches = [];
    for (const t of trees.slice(1)) {
      if (!t.branch || t.branch === "master") continue;
      const f = await this.branchFacts(t.branch, t.path, master);
      if (f.ahead === 0) continue;
      const conflicts = await this.trialConflicts(master, `refs/heads/${t.branch}`);
      const rec = st.branches[t.branch] ?? {};
      const owned = !!rec.owner;
      const b = { branch: t.branch, path: t.path, ahead: f.ahead, behind: f.behind, dirty: f.dirty.length, temp: !!f.temp, conflicts, lastCommitAgoMs: this.now - f.lastCommitAt, owner: rec.owner ?? null, chip: rec.chip ?? null, idle: rec.idle ?? null, notedAgoMs: rec.notedAt ? this.now - rec.notedAt : null, ask: rec.ask ? { agoMs: this.now - rec.ask.at, answer: rec.answer?.kind ?? null } : null, restartNeeded: f.changed.some(needsRestart), unowned: !owned };
      branches.push(b);
      const parts = [`+${f.ahead}/-${f.behind}`, f.dirty.length ? `${f.dirty.length} uncommitted (${f.dirty[0]}${f.dirty.length > 1 ? ` and ${f.dirty.length - 1} more` : ""})` : "clean"];
      if (f.temp) parts.push(`temporary commit: "${f.temp.slice(0, 60)}"`);
      parts.push(typeof conflicts === "number" ? (conflicts ? `conflicts with master in ${conflicts} file${conflicts === 1 ? "" : "s"}` : "merges cleanly") : conflicts);
      parts.push(`last commit ${ago(b.lastCommitAgoMs)} ago`);
      parts.push(owned ? `owner ${rec.owner} (chip ${rec.chip}, ${rec.idle === "yes" ? "idle" : "busy"}, noted ${ago(b.notedAgoMs)} ago)` : "UNOWNED");
      if (rec.ask) parts.push(`asked ${ago(b.ask.agoMs)} ago${rec.answer ? `, answer ${rec.answer.kind}${rec.answer.head ? ` at ${rec.answer.head.slice(0, 7)}` : ""}` : ", no answer"}`);
      if (rec.check) parts.push(`last check: ${rec.check.ok ? "landable" : "needs work"} at ${rec.check.head.slice(0, 7)}`);
      if (b.restartNeeded) parts.push("landing needs a restart");
      lines.push(`${t.branch}: ${parts.join(" · ")}`);
    }
    if (!branches.length) lines.push("No local branch with a worktree is ahead of master.");
    const m = await this.mainFacts();
    lines.push(`Main checkout: ${m.onMaster ? "on master" : "NOT on master"}, ${m.dirty} uncommitted, ${m.ahead === null ? "no origin/master" : `+${m.ahead}/-${m.behind} vs origin/master`}.`);
    if (st.restart?.pending) lines.push(`Restart pending since ${ago(this.now - st.restart.since)} ago.`);
    st.lastStatus = { at: this.now, unowned: branches.filter((b) => b.unowned).map((b) => b.branch) };
    this.saveState();
    return { exit: m.onMaster && m.dirty === 0 ? 0 : 1, lines, data: { master, branches, main: m }, next: "read each owner's session_detail, then `round.mjs note <branch> owner=<id> chip=… idle=…`" };
  }

  async note() {
    const { branch } = await this.branchArg();
    const kv = Object.fromEntries(this.args.slice(2).map((a) => { const i = a.indexOf("="); return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, ""]; }));
    const unknown = Object.keys(kv).filter((k) => !["owner", "chip", "idle", "source"].includes(k));
    if (unknown.length) stop(2, `unknown field ${unknown[0]}: owner=, chip=, idle=, source= only.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(kv.owner ?? "")) stop(2, "owner=<session id> is required (the id session_detail shows).");
    if (!["ready", "waiting", "none"].includes(kv.chip)) stop(2, "chip=ready|waiting|none is required.");
    if (!["yes", "no"].includes(kv.idle)) stop(2, "idle=yes|no is required.");
    if (kv.source !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/.test(kv.source)) stop(2, "source= takes one lowercase word (session_detail, user, overseer, message).");
    const st = this.loadState();
    const rec = (st.branches[branch] ??= {});
    if (rec.owner && rec.owner !== kv.owner) { delete rec.ask; delete rec.answer; }
    Object.assign(rec, { owner: kv.owner, chip: kv.chip, idle: kv.idle, notedAt: this.now }, kv.source ? { source: kv.source } : {});
    this.saveState();
    const next = kv.chip === "waiting" ? `round.mjs ask ${branch} (waiting means ask, never merge)` : kv.chip === "ready" ? `read the owner's latest messages, then round.mjs ask ${branch} or round.mjs check ${branch}` : `round.mjs ask ${branch} when unsure, if the owner is idle`;
    return { exit: 0, lines: [`Noted ${branch}: owner ${kv.owner}, chip ${kv.chip}, ${kv.idle === "yes" ? "idle" : "busy"}.`], next };
  }

  async ask() {
    const { branch, head } = await this.branchArg();
    const kv = Object.fromEntries(this.args.slice(2).map((a) => { const i = a.indexOf("="); return i > 0 ? [a.slice(0, i), a.slice(i + 1)] : [a, ""]; }));
    const unknown = Object.keys(kv).filter((k) => k !== "topic");
    if (unknown.length) stop(2, `Unknown: ${unknown.join(", ")}.`);
    if (!TOPIC_NAME_RE.test(kv.topic ?? "")) stop(2, "topic=<name> is required: the name queue_open gave this round's topic (queue_open merge).");
    const topic = kv.topic;
    const st = this.loadState();
    const rec = st.branches[branch];
    if (!rec?.owner) stop(1, `No owner recorded for ${branch}: read session_detail and note it first.`, `round.mjs note ${branch} owner=<id> chip=… idle=…`);
    if (rec.idle !== "yes") stop(1, `${rec.owner} was busy when noted: never ask a busy session. Try next round.`, "the next branch");
    if (this.now - rec.notedAt > NOTE_FRESH_MS) stop(1, `The note on ${branch} is ${ago(this.now - rec.notedAt)} old: read session_detail again and note it.`, `round.mjs note ${branch} …`);
    for (const [b, r] of Object.entries(st.branches)) {
      if (r.ask?.owner === rec.owner && this.now - r.ask.at < ASK_GAP_MS) stop(1, `${rec.owner} was asked about ${b} ${ago(this.now - r.ask.at)} ago: wait for its answer on the topic first.`, `pipe the delivered batch into round.mjs reply ${b}`);
    }
    rec.ask = { at: this.now, owner: rec.owner, head, topic };
    delete rec.answer;
    this.event("asked", { branch, owner: rec.owner });
    this.saveState();
    return { exit: 0, lines: [`session_send to ${rec.owner}:`, askText(branch, topic)], data: { owner: rec.owner, topic, text: askText(branch, topic) }, next: `don't poll: the answer arrives as a "${topic}" batch when your turn ends or you are idle; pipe that batch into \`round.mjs reply ${branch}\`` };
  }

  async reply() {
    const { branch, head } = await this.branchArg();
    const st = this.loadState();
    const rec = st.branches[branch];
    if (!rec?.owner) stop(1, `No owner recorded for ${branch}.`, `round.mjs note ${branch} …`);
    if (process.stdin.isTTY) stop(2, "Pipe the delivered topic batch (or the owner's session_read output) into stdin.");
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const r = replyOf(Buffer.concat(chunks).toString("utf8"), {
      branch,
      head,
      owner: rec.owner,
      topic: rec.ask?.topic,
      askedAt: rec.ask?.at,
      since: rec.answer?.noteAt,
      read: rec.readNotes ?? [],
    });
    const a = r.answer;
    if (a.kind === "no-ask") stop(2, `No ask about ${branch} is recorded, so no batch answers one: ask first.`, `round.mjs ask ${branch} topic=<name>`);
    if (a.kind === "wrong-topic") stop(2, `That batch is on "${a.topic}", not this ask's topic "${rec.ask?.topic}".`);
    if (a.kind === "wrong-session") stop(2, `That isn't a topic batch or ${rec.owner}'s session_read output (the header names another session, or none).`);
    // The owner's notes read here never count again (a batch piped twice, a reused topic).
    if (r.read.length) {
      rec.readNotes = [...(rec.readNotes ?? []), ...r.read].slice(-READ_NOTES_KEPT);
      this.saveState();
    }
    if (a.kind === "old") return { exit: 1, lines: [`Nothing new from ${rec.owner} about ${branch}: its notes there were read already, or predate this ask or its recorded answer.`], next: "wait for the next batch on the topic, or ask again on a later round" };
    if (a.kind === "none") return { exit: 1, lines: [`No answer yet from ${rec.owner} about ${branch}.`], next: "wait for the next batch on the topic, or ask again on a later round" };
    if (a.kind === "stale") return { exit: 1, lines: [`Stale: ${rec.owner} answered READY at ${a.sha}, but ${branch} is at ${head.slice(0, 7)}.`], next: `ask again on a later round (round.mjs ask ${branch})` };
    const noteAt = r.noteAt !== undefined ? { noteAt: r.noteAt } : {};
    rec.answer = a.kind === "ready" ? { kind: "ready", head, at: this.now, ...noteAt } : { kind: "not-ready", why: a.why, head, at: this.now, ...noteAt };
    this.event("answer", { branch, owner: rec.owner, answer: a.kind });
    this.saveState();
    if (a.kind === "ready") return { exit: 0, lines: [`${rec.owner}: READY ${branch} at ${head.slice(0, 7)} (its current head).`], next: `round.mjs check ${branch}` };
    return { exit: 1, lines: [`${rec.owner}: NOT READY: ${a.why}`], next: "leave it queued and say why in the report" };
  }

  async check() {
    const { branch, tree } = await this.branchArg();
    if (!tree) stop(1, `${branch} has no worktree: the round works only in a branch's own worktree.`);
    const { main } = await this.repo();
    const st = this.loadState();
    let master = await this.masterSha();
    const f = await this.branchFacts(branch, tree, master);
    if (f.ahead === 0) stop(1, `${branch} has no commit ahead of master.`);
    if (f.dirty.length) stop(1, `${branch} has ${f.dirty.length} uncommitted file${f.dirty.length === 1 ? "" : "s"} (${f.dirty[0]}${f.dirty.length > 1 ? ` and ${f.dirty.length - 1} more` : ""}): hand it back to the owner.`);
    if (f.temp) stop(1, `${branch} has a temporary commit ("${f.temp.slice(0, 60)}"): hand it back to the owner.`);
    if ((await git(tree, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0) stop(1, `A merge is in progress in ${tree}: finish or abort it first.`);
    const lines = [];

    // Merge current master into the branch, in its own worktree.
    if (f.behind > 0) {
      const m = await git(tree, ["merge", "--no-edit", "refs/heads/master"], { timeoutMs: 120_000 });
      if (m.code !== 0) {
        let conflicted = (await gitOut(tree, ["diff", "--name-only", "--diff-filter=U"], "diff")).split("\n").filter(Boolean);
        if (!conflicted.length) stop(2, `git merge master failed in ${tree}: ${firstLine(m)}`);
        if (conflicted.includes(MANIFEST)) {
          const mm = await run(process.execPath, [join(this.specCore, "sova-spec-draft.mjs"), "merge-manifest", "--write", "--root", tree, "--json"], { cwd: tree, timeoutMs: 60_000 });
          const ok = mm.code === 0 && (await run(process.execPath, [join(this.specCore, "sova-spec.mjs"), "check", "--root", tree, "--json"], { cwd: tree, timeoutMs: 60_000 })).code !== 2;
          if (ok) {
            await gitOut(tree, ["add", "--", MANIFEST], "add");
            lines.push("manifest.json conflict merged by the spec tool's merge-manifest --write.");
          } else lines.push(`manifest.json: merge-manifest --write didn't resolve it (${mm.timedOut ? "timed out" : `exit ${mm.code}`}).`);
          conflicted = (await gitOut(tree, ["diff", "--name-only", "--diff-filter=U"], "diff")).split("\n").filter(Boolean);
        }
        if (conflicted.length) {
          return { exit: 1, lines: [...lines, `Merging master into ${branch} conflicts in ${conflicted.length} file${conflicted.length === 1 ? "" : "s"}: ${conflicted.slice(0, 5).join(", ")}${conflicted.length > 5 ? ` and ${conflicted.length - 5} more` : ""}.`, `They're left in ${tree} for you; if one isn't clear-cut, ask the owner.`], next: `resolve, commit in ${tree}, then round.mjs check ${branch}` };
        }
        const c = await git(tree, ["commit", "--no-edit"], { timeoutMs: 60_000 });
        if (c.code !== 0) stop(2, `committing the merge failed in ${tree}: ${firstLine(c)}`);
      }
      lines.push(`Merged master ${master.slice(0, 7)} into ${branch}.`);
    }
    const head = await gitOut(main, ["rev-parse", `refs/heads/${branch}`], "rev-parse");
    master = await this.masterSha();
    const changed = (await gitOut(main, ["diff", "--name-only", `${master}...${head}`], "diff")).split("\n").filter(Boolean);

    // The checks, each in its own process group with a log.
    const logDir = join(this.dir, "logs", `${new Date(this.now).toISOString().replace(/[:.]/g, "-")}-${branch.replace(/[^A-Za-z0-9._-]/g, "_")}`);
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    const needs = [];
    const preexisting = [];
    const step = async (key, floorKey, label, cmd, args, cwd) => {
      const timeoutMs = timeoutFor(this.floor(floorKey), st.timings[key]);
      const r = await run(cmd, args, { cwd, env, timeoutMs, logFile: join(logDir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.log`) });
      if (r.code === 0) st.timings[key] = [...(st.timings[key] ?? []), r.ms].slice(-9);
      const said = r.timedOut ? `TIMED OUT at ${Math.round(timeoutMs / 1000)}s (process group killed)` : r.code === 0 ? "ok" : `FAILED (exit ${r.code})`;
      lines.push(`${label}: ${said}, ${Math.round(r.ms / 1000)}s.`);
      return r;
    };
    const tc = await step("typecheck", "typecheck", "typecheck", this.pnpm, ["run", "typecheck"], tree);
    if (tc.code !== 0) needs.push(tc.timedOut ? "typecheck timed out" : "typecheck fails");
    const t = await step("test", "test", "pnpm test", this.pnpm, ["test"], tree);
    if (t.timedOut) needs.push("pnpm test timed out");
    else if (t.code !== 0) {
      const files = failingTestFiles(`${t.stdout}\n${t.stderr}`, tree);
      if (!files.length) needs.push("pnpm test fails (no failing file named; see the log)");
      else {
        const verdicts = await this.onMaster(files, master, env, st);
        for (const [file, v] of Object.entries(verdicts)) {
          if (v === "pre-existing") preexisting.push(file);
          else needs.push(v === "new" ? `new test failure: ${file}` : `test failure in ${file} (${v})`);
        }
        lines.push(`  failing files: ${files.map((x) => `${x} (${verdicts[x]})`).join(", ")}.`);
      }
    }
    const exts = [...new Set(changed.map((p) => /^pi-config\/extensions\/([^/]+)\//.exec(p)?.[1]).filter(Boolean))].sort();
    if (exts.length) {
      let readme = "";
      try { readme = readFileSync(join(tree, "pi-config", "README.md"), "utf8"); } catch {}
      for (const ext of exts) {
        const suite = suiteOf(readme, ext);
        if (!suite) { lines.push(`pi-config ${ext}: no line in pi-config/README.md's Tests block.`); continue; }
        const cwd = join(tree, "pi-config", suite.dir);
        let failed = null;
        for (const argv of suite.commands) {
          const [cmd, ...rest] = expandArgs(argv, cwd);
          const r = await step(`ext:${ext}`, "ext", `pi-config ${ext}: ${argv.join(" ")}`, cmd === "node" ? process.execPath : cmd, rest, cwd);
          if (r.code !== 0) { failed = r.timedOut ? "timed out" : "fails"; break; }
        }
        if (failed) needs.push(`pi-config ${ext} suite ${failed}`);
      }
    }
    if (tc.code === 0) {
      const b = await step("build", "build", "build", this.pnpm, ["run", "build"], tree);
      if (b.code !== 0) needs.push(b.timedOut ? "build timed out" : "build fails");
    } else lines.push("build: skipped (the typecheck failed).");
    lines.push(...(await this.specChecks(tree, needs)));

    const ok = needs.length === 0;
    (st.branches[branch] ??= {}).check = { head, masterSha: master, ok, needs, preexisting, at: this.now, logs: logDir };
    this.event("check", { branch, head, ok });
    this.saveState();
    if (preexisting.length) lines.push(`Pre-existing on master (not blocking): ${preexisting.join(", ")}.`);
    lines.push(`Logs: ${logDir}`);
    lines.push(ok ? `landable at ${head.slice(0, 7)}` : `needs: ${needs.join("; ")}`);
    return { exit: ok ? 0 : 1, lines, data: { head, master, ok, needs, preexisting, logs: logDir }, next: ok ? `round.mjs land ${branch}` : "hand it back to the owner with what it needs (session_send, only when idle)" };
  }

  /** Each failing file run again on master, in the main checkout at master's sha; cached per (master, file). */
  async onMaster(files, master, env, st) {
    const { main } = await this.repo();
    const out = {};
    const runs = (st.masterRuns[master] ??= {});
    for (const k of Object.keys(st.masterRuns)) if (k !== master) delete st.masterRuns[k];
    const mainHead = (await git(main, ["rev-parse", "HEAD"])).stdout.trim();
    for (const file of files) {
      if (runs[file]) { out[file] = runs[file].fails ? "pre-existing" : "new"; continue; }
      if ((await git(main, ["cat-file", "-e", `${master}:${file}`])).code !== 0) { out[file] = "new"; continue; }
      if (mainHead !== master) { out[file] = "can't tell: the main checkout isn't at master"; continue; }
      if ((await gitOut(main, ["status", "--porcelain", "--", file], "status")) !== "") { out[file] = "can't tell: it's dirty in the main checkout"; continue; }
      const r = await run(this.pnpm, ["exec", "tsx", "--import", "./pi-config/extensions/claude-code/tests/hermetic-env.mjs", "--test", file], { cwd: main, env, timeoutMs: timeoutFor(this.floor("master"), st.timings.master) });
      if (r.timedOut) { out[file] = "can't tell: it timed out on master"; continue; }
      runs[file] = { fails: r.code !== 0, at: this.now };
      out[file] = r.code !== 0 ? "pre-existing" : "new";
    }
    return out;
  }

  async specChecks(tree, needs) {
    if (!existsSync(join(tree, MANIFEST))) return ["spec: none in this project."];
    const tool = (file, args) => run(process.execPath, [join(this.specCore, file), ...args, "--root", tree, "--json"], { cwd: tree, timeoutMs: 120_000 });
    if (!existsSync(join(this.specCore, "sova-spec.mjs"))) { needs.push("spec tools not found"); return ["spec: the spec tools aren't installed, so the spec can't be checked."]; }
    const lines = [];
    const c = await tool("sova-spec.mjs", ["check"]);
    lines.push(`spec check: ${c.code === 0 ? "ok" : c.code === 1 ? "warnings" : "ERRORS"}.`);
    if (c.code !== 0 && c.code !== 1) needs.push("spec check fails");
    const census = await tool("sova-spec.mjs", ["census", "--changed", "--base", "master"]);
    let unclaimed = null;
    try { unclaimed = JSON.parse(census.stdout).census?.unclaimed ?? null; } catch {}
    if (census.code === 2 || !Array.isArray(unclaimed)) { needs.push("spec census couldn't run"); lines.push("spec census: couldn't run."); }
    else if (unclaimed.length) { needs.push(`${unclaimed.length} changed file${unclaimed.length === 1 ? "" : "s"} no claim maps`); lines.push(`spec census: ${unclaimed.length} unclaimed (${unclaimed.slice(0, 3).join(", ")}).`); }
    else lines.push("spec census: clean.");
    let drafts = [];
    try { drafts = readdirSync(join(tree, ".sova", "spec", "drafts"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
    for (const name of drafts.sort()) {
      const s = await tool("sova-spec-draft.mjs", ["status", name]);
      let pending = null;
      try {
        const j = JSON.parse(s.stdout);
        if (Array.isArray(j.ids)) pending = j.ids.filter((x) => x?.current !== "already-current").map((x) => x?.id ?? "?");
      } catch {}
      if (pending === null) { needs.push(`draft ${name}: status unreadable`); lines.push(`draft ${name}: status unreadable.`); }
      else if (pending.length) { needs.push(`draft ${name}: ${pending.length} record${pending.length === 1 ? "" : "s"} not promoted`); lines.push(`draft ${name}: not promoted: ${pending.slice(0, 4).join(", ")}.`); }
      else lines.push(`draft ${name}: promoted.`);
    }
    return lines;
  }

  async land() {
    const { branch, head, tree } = await this.branchArg();
    const st = this.loadState();
    const rec = st.branches[branch];
    const master = await this.masterSha();
    const c = rec?.check;
    if (!c) stop(1, `${branch} has no check: run it first.`, `round.mjs check ${branch}`);
    if (!c.ok) stop(1, `${branch}'s last check needs: ${c.needs.join("; ")}.`, "hand it back to the owner");
    if (c.head !== head) stop(1, `${branch} moved since its check (${c.head.slice(0, 7)} → ${head.slice(0, 7)}): check again.`, `round.mjs check ${branch}`);
    if (c.masterSha !== master) stop(1, `master moved since ${branch}'s check (${c.masterSha.slice(0, 7)} → ${master.slice(0, 7)}): check again.`, `round.mjs check ${branch}`);
    if (!tree) stop(1, `${branch} has no worktree.`);
    const dirty = await this.dirtyIn(tree);
    if (dirty.length) stop(1, `${branch}'s worktree has ${dirty.length} uncommitted file${dirty.length === 1 ? "" : "s"} since its check.`);
    if (this.mask(tree) !== tree) stop(2, "The worktree's path holds a private name: ask the user how to land it.");
    const call = `worktree ${JSON.stringify({ action: "merge", path: tree })}`;
    const owner = rec.answer?.kind === "ready" ? `Owner ${rec.owner} said READY at ${rec.answer.head.slice(0, 7)}.` : rec.owner ? `No READY recorded from ${rec.owner}: land only if the owner has said it's ready at this head.` : "UNOWNED: never land it without the user's OK.";
    return { exit: 0, lines: [`landable at ${head.slice(0, 7)} on master ${master.slice(0, 7)} (checked ${ago(this.now - c.at)} ago).`, owner, `call: ${call}`], data: { call: { action: "merge", path: tree } }, next: `after the merge card, round.mjs landed ${branch}` };
  }

  async landed() {
    const { branch } = await this.branchArg();
    const st = this.loadState();
    const rec = st.branches[branch];
    if (!rec?.check?.ok) stop(1, `${branch} has no green check on record.`);
    const { main } = await this.repo();
    const master = await this.masterSha();
    const anc = await git(main, ["merge-base", "--is-ancestor", rec.check.head, master]);
    if (anc.code === 1) stop(1, `${rec.check.head.slice(0, 7)} isn't in master yet: land it with the worktree tool first.`, `round.mjs land ${branch}`);
    if (anc.code !== 0) stop(2, `git merge-base failed: ${firstLine(anc)}`);
    const m = await this.mainFacts();
    const mainHead = (await git(main, ["rev-parse", "HEAD"])).stdout.trim();
    if (!m.onMaster || mainHead !== master) stop(2, "The main checkout isn't on master at its tip, so it can't be built.");
    const changed = (await gitOut(main, ["diff", "--name-only", `${rec.check.masterSha}..${master}`], "diff")).split("\n").filter(Boolean);
    const restart = changed.some(needsRestart);
    const env = { ...process.env };
    delete env.CLAUDE_CONFIG_DIR;
    mkdirSync(join(this.dir, "logs"), { recursive: true, mode: 0o700 });
    const logFile = join(this.dir, "logs", `${new Date(this.now).toISOString().replace(/[:.]/g, "-")}-main-build.log`);
    const b = await run(this.pnpm, ["run", "build"], { cwd: main, env, timeoutMs: timeoutFor(this.floor("build"), st.timings.build), logFile });
    rec.landed = { sha: master, at: this.now };
    if (restart) st.restart = { pending: true, since: st.restart?.pending ? st.restart.since : this.now, merges: [...(st.restart?.pending ? st.restart.merges ?? [] : []), { branch, sha: master }] };
    this.event("landed", { branch, sha: master, restart, built: b.code === 0 });
    this.saveState();
    const lines = [
      `${branch} is in master at ${master.slice(0, 7)}.`,
      `Main checkout build: ${b.code === 0 ? "ok" : b.timedOut ? "TIMED OUT" : `FAILED (exit ${b.code})`} (log ${logFile}).`,
      restart ? "It changes server-side code: a restart is needed (round.mjs restart-check)." : "No restart needed: only the build.",
    ];
    if (rec.owner) lines.push(`session_send to ${rec.owner}:`, `${branch} is merged into master at ${master.slice(0, 7)}. Don't touch master; start any new work on a fresh branch.`);
    return { exit: b.code === 0 ? 0 : 1, lines, data: { sha: master, restart }, next: "round.mjs push" };
  }

  async push() {
    const sid = this.sessionId();
    const st = this.loadState();
    const sess = st.sessions[sid];
    if (!sess) stop(2, "This session has no round yet: run `round.mjs start` first.");
    if (sess.hold) stop(1, "Push hold: the settings were missing at this session's first round, and the user hasn't answered yet. Merge locally; push nothing.", "wait for the answers, add them, then round.mjs names-answered");
    const { main } = await this.repo();
    const m = await this.mainFacts();
    if (!m.onMaster) stop(1, "The main checkout isn't on master: push nothing, and ask the user.");
    const fetch = await git(main, ["fetch", "--no-tags", "origin", "master"], { timeoutMs: 60_000 });
    if (fetch.code !== 0) stop(2, `git fetch origin master failed: ${firstLine(fetch)}`);
    const master = await this.masterSha();
    const origin = await gitOut(main, ["rev-parse", "--verify", "refs/remotes/origin/master^{commit}"], "rev-parse origin/master");
    if (origin === master) return { exit: 0, lines: ["Nothing to push: origin/master is at master."], next: "round.mjs restart-check, if a restart is pending; else the report" };
    const ff = await git(main, ["merge-base", "--is-ancestor", origin, master]);
    if (ff.code === 1) stop(1, `master isn't a fast-forward of origin/master (${origin.slice(0, 7)}): someone pushed, or master was rewritten. Push nothing; ask the user.`);
    if (ff.code !== 0) stop(2, `git merge-base failed: ${firstLine(ff)}`);
    const scan = await run(process.execPath, [join(HERE, "leak-scan.mjs"), "--repo", main, "--range", `${origin}..${master}`], { cwd: main, timeoutMs: 120_000 });
    const scanned = `${scan.stdout}${scan.stderr}`.split("\n").filter(Boolean);
    if (scan.code !== 0) {
      this.event("push-refused", { why: scan.code === 1 ? "leak-scan hits" : "leak-scan couldn't check" });
      this.saveState();
      return { exit: scan.code === 1 ? 1 : 2, lines: [...scanned, "Push nothing."], next: scan.code === 1 ? "report the commit, file and line; rewriting unpushed commits is the user's call" : "ask the user" };
    }
    const p = await git(main, ["push", "origin", "master"], { timeoutMs: 120_000 });
    if (p.code !== 0) stop(2, `git push origin master failed: ${firstLine(p)}`);
    this.event("pushed", { from: origin, to: master });
    this.saveState();
    return { exit: 0, lines: [...scanned, `Pushed ${origin.slice(0, 7)}..${master.slice(0, 7)} to origin/master.`], next: st.restart?.pending ? "round.mjs restart-check" : "round.mjs report" };
  }

  /** The Sova server this process runs under: the nearest ancestor running server/index.ts, else the unit's main pid. */
  async serverPid(unit) {
    let pid = process.ppid;
    for (let hops = 0; pid > 1 && hops < 64; hops++) {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
        if (args.some((a) => a === "server/index.ts" || a.endsWith("/server/index.ts"))) return { pid, how: "process ancestry" };
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } catch {
        break;
      }
    }
    const r = await run("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit], { timeoutMs: 5000 });
    const main = Number(r.stdout.trim());
    return r.code === 0 && Number.isSafeInteger(main) && main > 1 ? { pid: main, how: `${unit}'s main pid` } : null;
  }

  async restartCheck() {
    const sid = this.sessionId();
    const st = this.loadState();
    const unit = this.settings.restartUnit ?? DEFAULT_UNIT;
    if (!/^[A-Za-z0-9@._-]+\.service$/.test(unit) || this.mask(unit) !== unit) stop(2, "The settings' restartUnit isn't a plain unit name: ask the user to restart.");
    const server = await this.serverPid(unit);
    if (!server) stop(2, "Can't find the Sova server's pid (no server/index.ts ancestor, and the unit has no main pid). Restart nothing; ask the user.");
    const live = join(this.agent, "sessions", "live");
    let names = [];
    try { names = readdirSync(live).filter((n) => n.startsWith(`p${server.pid}-`) && n.endsWith(".json")); } catch {}
    const fresh = [];
    for (const n of names) {
      let r;
      try { r = JSON.parse(readFileSync(join(live, n), "utf8")); } catch { continue; }
      if (r?.session?.pid !== server.pid || typeof r.heartbeat !== "number" || this.now - r.heartbeat > HEARTBEAT_MS) continue;
      fresh.push(r);
    }
    if (!fresh.length) stop(2, `No live record of server pid ${server.pid} (found by ${server.how}) has a heartbeat in the last 30 s: can't tell who is busy. Restart nothing.`);
    const others = fresh.filter((r) => r.session.sessionId !== sid);
    const busy = others.filter(busyOf);
    const pending = !!st.restart?.pending;
    this.event("restart-check", { busy: busy.length, hosted: others.length });
    this.saveState();
    if (busy.length) {
      const lines = [`${busy.length} of ${others.length} other hosted session${others.length === 1 ? "" : "s"} busy (server pid ${server.pid}):`];
      for (const r of busy) {
        const why = [r.presence?.activity?.state === "working" ? "turn in flight" : "", (r.presence?.workerCounts?.working ?? 0) > 0 ? `${r.presence.workerCounts.working} worker(s) working` : ""].filter(Boolean);
        lines.push(`- ${r.session.sessionId ?? r.session.id}${r.session.name ? ` "${r.session.name}"` : ""}: ${why.join(", ")}`);
      }
      return { exit: 1, lines: [...lines, "Restart only with the user's OK; put this list in the report."], data: { busy: busy.map((r) => r.session.sessionId ?? r.session.id) }, next: "the report, with the busy list" };
    }
    const lines = [`Every other hosted session is idle (${others.length}, server pid ${server.pid}).`];
    if (!pending) return { exit: 0, lines: [...lines, "No restart pending."], next: "round.mjs report" };
    lines.push("As your turn's LAST tool call, then end the turn:", `systemd-run --user --on-active=30s systemctl --user restart ${unit}`, "If it fails, ask the user to restart; never another way.");
    return { exit: 0, lines, next: "the report, then that call as your last" };
  }

  async report() {
    const sid = this.sessionId();
    const st = this.loadState();
    const sess = st.sessions[sid];
    if (!sess) stop(2, "This session has no round yet: run `round.mjs start` first.");
    const since = sess.roundStartedAt ?? 0;
    const ev = st.events.filter((e) => e.at >= since);
    const of = (k) => ev.filter((e) => e.kind === k);
    const lines = ["Round report"];
    lines.push(`- Merged: ${of("landed").map((e) => `${e.branch} at ${e.sha.slice(0, 7)}${e.built ? "" : " (main build FAILED)"}`).join(", ") || "none"}`);
    const pushed = of("pushed").at(-1);
    const refused = of("push-refused").at(-1);
    lines.push(`- Push: ${sess.hold ? "held (the user hasn't answered the start interview)" : pushed ? `pushed to ${pushed.to.slice(0, 7)}` : refused ? `refused: ${refused.why}` : "nothing pushed"}`);
    const checks = of("check");
    lines.push(`- Checks: ${checks.map((e) => `${e.branch} ${e.ok ? "landable" : `needs: ${st.branches[e.branch]?.check?.needs?.join("; ") ?? "?"}`}`).join(" · ") || "none run"}`);
    const rc = of("restart-check").at(-1);
    lines.push(`- Restart: ${st.restart?.pending ? `pending (${(st.restart.merges ?? []).map((m) => m.branch).join(", ")})${rc ? `, ${rc.busy} busy at the last check` : ", not checked"}` : st.restart?.confirmedAt >= since ? "done and confirmed" : "none needed"}`);
    lines.push(`- Unowned: ${st.lastStatus?.unowned?.join(", ") || "none"}`);
    lines.push(`- Owners asked: ${of("asked").map((e) => { const a = ev.find((x) => x.kind === "answer" && x.branch === e.branch && x.at >= e.at); return `${e.owner} about ${e.branch}: ${a ? a.answer : "no answer yet"}`; }).join(" · ") || "none"}`);
    lines.push("- Handed back: (fill in: branch, owner, why)");
    if (sess.firstRound) lines.push("- Settings: (fill in the kinds and counts discover-names.mjs printed, and any names it says origin already has, masked as printed)");
    return { exit: 0, lines, next: "end the turn (or the restart call, if restart-check printed it)" };
  }
}

const COMMANDS = { start: "start", "names-answered": "namesAnswered", status: "status", note: "note", ask: "ask", reply: "reply", check: "check", land: "land", landed: "landed", push: "push", "restart-check": "restartCheck", report: "report" };

export async function main(argv = process.argv.slice(2)) {
  let round;
  let result;
  try {
    round = new Round(argv);
    const method = COMMANDS[round.args[0]];
    if (!method) stop(2, `usage: round.mjs <${Object.keys(COMMANDS).join("|")}> [args] [--repo <dir>] [--json]`);
    result = await round[method]();
  } catch (err) {
    result = err instanceof Exit ? { exit: err.code, lines: err.lines, next: err.next } : { exit: 2, lines: [`round.mjs: ${err?.message ?? err}`] };
  }
  const mask = round?.mask ?? ((s) => s);
  const next = result.next ?? (result.exit === 2 ? "fail closed: say it couldn't be checked" : undefined);
  const text = round?.json
    ? JSON.stringify({ command: round.args[0] ?? null, exit: result.exit, lines: result.lines, ...(result.data ?? {}), next: next ?? null })
    : [...result.lines, ...(next ? [`next: ${next}`] : [])].join("\n");
  process.stdout.write(`${mask(text)}\n`);
  return result.exit;
}

const invoked = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main().then((code) => { process.exitCode = code; });
