// Run: pnpm test -- server/commands-fuzz.test.ts
// Bad input against every catalogue entry (shared/commands-catalog.ts), in-process through the
// catalogue's own buildRequest and app.request, in a scratch state root. The rules it holds:
//   - a refusal is a 4xx whose body carries a sentence (`error`, or a verb result's `error.message`);
//   - no answer is a 5xx, except the rows of server/commands-fuzz/known-500.json, a list that only
//     shrinks: a new 5xx fails, and so does a row whose case no longer answers 5xx;
//   - nothing is written outside the scratch root (the throwaway HOME and this checkout are hashed);
//   - every entry has a valid fixture with an effect oracle, or is validate-only with a reason: a
//     `looks` fixture changes nothing on disk, a `changes` fixture changes the state root and its
//     oracle reads the change back. So "everything refuses" cannot pass.
// Entries whose valid call starts a process (a chat, a project verb) are validate-only here: their
// cases always carry an anchor the route refuses before it starts anything, and the tier guard fails
// this file should any of them start one. The judge's own failure modes are pinned at the bottom.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { buildRequest, COMMANDS, wireKey, type CommandEntry } from "../shared/commands-catalog";
import { scratchRoot } from "./test-scratch";

// The run hashes $HOME to prove nothing was written there: only ever the runner's throwaway one.
const testHome = process.env.SOVA_TEST_HOME;
if (!testHome || !homedir().startsWith(`${testHome}/`)) throw new Error("server/commands-fuzz.test.ts runs only through the test runner (pnpm test -- server/commands-fuzz.test.ts), whose throwaway HOME it hashes; a bare `bun test` would read the real one.");
const root = scratchRoot("sova-commands-fuzz-");
const agentDir = join(root, "agent");
const outside = join(root, "outside"); // a sibling of the agent dir: what a `../` aims at
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "sentinel.jsonl"), "{}\n");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-fuzz--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { testApp } = await import("./mesh/app-test-fixtures");
const app = await testApp();
const { addWebSession } = await import("./web-sessions");
const { canonicalPath } = await import("./paths");

after(() => rmSync(root, { recursive: true, force: true }));

const KNOWN_FILE = join(import.meta.dirname, "commands-fuzz", "known-500.json");
interface KnownRow { id: string; case: string; status: number; finding: string }
const KNOWN: KnownRow[] = JSON.parse(readFileSync(KNOWN_FILE, "utf8"));

// ---- disk, hashed ---------------------------------------------------------------------------------

/** Every name, link and file's bytes under `dir`, as one hash (`skip`: subtrees left out). */
function treeHash(dir: string, skip: readonly string[] = []): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    let names: string[];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (skip.some((s) => p === s || p.startsWith(`${s}/`))) continue;
      const st = lstatSync(p);
      h.update(`${p}\0${st.mode}\0`);
      if (st.isSymbolicLink()) h.update(readlinkSync(p));
      else if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}
const repoRoot = join(import.meta.dirname, "..");
/** This checkout's changed and untracked files (git is allowed in the unit tier). */
const gitDirt = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" });
/** What lies outside the scratch root that a stray write could reach: the HOME and this checkout. */
const outsideState = () => `${treeHash(homedir(), [root, join(homedir(), ".cache"), join(homedir(), ".bun")])}\n${gitDirt()}`;

// ---- requests -------------------------------------------------------------------------------------

interface Answer { status: number; body: unknown }
async function sendTo(a: Hono, method: string, url: string, raw?: string): Promise<Answer> {
  const res = await a.request(url, { method, ...(raw === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: raw }) });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON: the judge says so */ }
  return { status: res.status, body };
}

/** One bad input: a name, and how it changes the built request. */
interface Case { name: string; method: string; url: string; raw?: string; wrongType?: boolean }

/** The bad values that are the wrong JSON type for a param: the route must refuse these on their own. */
function wrongTypes(p: CommandEntry["params"][string]): string[] {
  const t = p.type === "path" || p.type === "session" ? "string" : p.type;
  const nul = p.nullable ? [] : ["null"];
  if (t === "string") return ["number", "float-huge", "boolean", "object", "array", "proto-object", ...nul];
  if (t === "list") return ["number", "boolean", "object", "proto-object", ...nul];
  if (t === "boolean") return ["number", "proto-string", "object", "array", ...nul];
  if (t === "integer" || t === "number") return [...(t === "integer" ? ["fraction"] : []), "proto-string", "boolean", "object", "array", ...nul];
  return [];
}

/** The bad values every param gets in turn. `__proto__` keys survive as own keys (JSON.parse). */
const BAD: Record<string, unknown> = {
  number: 42,
  "float-huge": 1e308,
  "negative": -1,
  "fraction": 1.5,
  boolean: true,
  object: { a: 1 },
  array: [1, { b: 2 }],
  null: null,
  "string-1mb": "x".repeat(1 << 20),
  empty: "",
  traversal: "../../outside/sentinel.jsonl",
  "traversal-deep": "../../../../../../../../etc/passwd",
  "encoded-dots": "%2e%2e%2foutside%2fsentinel.jsonl",
  nul: "a\u0000b.jsonl",
  "proto-string": "__proto__",
  "proto-object": JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}}}'),
  "outside-absolute": join(outside, "sentinel.jsonl"),
  "unknown-session": "no-such-session",
};
/** JSON drops NaN to null; sent raw it is no JSON at all. Both are cases. */
const RAW_BODIES: Record<string, string> = {
  "malformed-json": "{not json",
  "nan-literal": '{"x": NaN}',
  "array-body": "[1,2,3]",
  "string-body": '"just a string"',
  "null-body": "null",
  "proto-body": '{"__proto__":{"polluted":1}}',
};

const hasBody = (c: CommandEntry) => c.route.method !== "GET" && c.route.method !== "DELETE";

/** A plain valid value for each required param the anchor doesn't name. */
function fill(entry: CommandEntry): Record<string, unknown> {
  const plain: Record<string, unknown> = { string: "fuzz", path: "fuzz", session: "fuzz", list: ["fuzz"], number: 1, integer: 1, boolean: true, json: {} };
  return Object.fromEntries(Object.entries(entry.params).filter(([, p]) => p.required).map(([n, p]) => [n, p.enum?.[0] ?? plain[p.type]]));
}

/** The request for `values`, then made concrete; a body is sent as raw JSON. */
function built(entry: CommandEntry, values: Record<string, unknown>, name: string): Case {
  const r = buildRequest(entry, values);
  return { name, method: r.method, url: r.url, ...(r.body !== undefined ? { raw: JSON.stringify(r.body) } : {}) };
}

/**
 * The cases for one entry around `anchor` (values the route takes up to the param in question):
 * each param set to each bad value, each required param left out, unknown and `__proto__` keys
 * added, and, for a body, the raw bodies.
 */
function casesFor(entry: CommandEntry, given: Record<string, unknown>, values = BAD, onlyWrongTypes = false): Case[] {
  const out: Case[] = [];
  const anchor = { ...fill(entry), ...given };
  for (const [name, p] of Object.entries(entry.params)) {
    const wrong = new Set(p.in === "body" ? wrongTypes(p) : []);
    for (const [bad, v] of Object.entries(values)) if (!onlyWrongTypes || wrong.has(bad)) out.push({ ...built(entry, { ...anchor, [name]: v }, `${name}=${bad}`), ...(wrong.has(bad) ? { wrongType: true } : {}) });
    if (p.required && !onlyWrongTypes) {
      const r = built(entry, anchor, `${name}=missing`);
      const key = wireKey(name, p);
      if (p.in === "body" && r.raw) {
        const body = JSON.parse(r.raw) as Record<string, unknown>;
        delete body[key];
        r.raw = JSON.stringify(body);
      } else if (p.in === "query") {
        const u = new URL(r.url, "http://x");
        u.searchParams.delete(key);
        r.url = `${u.pathname}${u.search}`;
      }
      if (p.in !== "path") out.push(r);
    }
  }
  if (onlyWrongTypes) return out;
  const base = built(entry, anchor, "unknown-keys");
  const sep = base.url.includes("?") ? "&" : "?";
  if (base.raw !== undefined) {
    const body = JSON.parse(base.raw) as Record<string, unknown>;
    out.push({ ...base, raw: JSON.stringify({ ...body, zzUnknown: 1, nested: { deep: [1] } }).replace(/^\{/, '{"__proto__":{"polluted":1},') });
    for (const [n, raw] of Object.entries(RAW_BODIES)) out.push({ ...base, name: n, raw });
  } else {
    out.push({ ...base, url: `${base.url}${sep}zzUnknown=1&__proto__=1&constructor%5Bprototype%5D=1` });
  }
  return out;
}

// ---- the judge (pure, so its own failure modes are tested) --------------------------------------

interface Result { id: string; case: string; status: number; body: unknown; mustRefuse: boolean; wrongType?: boolean; baseline?: Answer }
/** The sentence a refusal carries, or null. */
function sentenceOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const e = (body as { error?: unknown }).error;
  const s = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : null;
  return s && /\S+\s+\S+/.test(s) ? s : null;
}
/** What is wrong with a run's answers, given the known 5xx rows. Empty when all is well. */
function judge(results: readonly Result[], known: readonly KnownRow[], typeAccepts: Readonly<Record<string, string>> = {}): string[] {
  const problems: string[] = [];
  const key = (id: string, c: string) => `${id} | ${c}`;
  const knownKeys = new Set(known.map((k) => key(k.id, k.case)));
  const seen5xx = new Set<string>();
  for (const r of results) {
    const k = key(r.id, r.case);
    if (r.status >= 500) {
      seen5xx.add(k);
      if (!knownKeys.has(k)) problems.push(`${k}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)} (a new 5xx)`);
      continue;
    }
    if (r.status >= 400 && !sentenceOf(r.body)) problems.push(`${k}: ${r.status} without a sentence: ${JSON.stringify(r.body).slice(0, 200)}`);
    if (r.mustRefuse && (r.status < 400 || r.status >= 500)) problems.push(`${k}: ${r.status}, not a refusal`);
    // A wrong-typed value is refused for itself: a 4xx that is not the anchor's own answer.
    if (r.wrongType) {
      const own = r.status >= 400 && !(r.baseline && r.baseline.status === r.status && JSON.stringify(r.baseline.body) === JSON.stringify(r.body));
      if (!own && !typeAccepts[k]) problems.push(`${k}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}: a wrong-typed value not refused for itself`);
      if (own && typeAccepts[k]) problems.push(`${k}: listed in TYPE_ACCEPTS but now refused for itself; remove the row`);
    }
  }
  const ran = new Set(results.map((r) => key(r.id, r.case)));
  for (const k of knownKeys) if (ran.has(k) && !seen5xx.has(k)) problems.push(`${k}: listed in known-500.json but no longer a 5xx; remove the row`);
  return problems;
}

/** Prototype pollution leaves a mark on every object. */
const polluted = () => ({} as Record<string, unknown>).polluted !== undefined || ([] as unknown as Record<string, unknown>).polluted !== undefined;

// ---- fixtures -------------------------------------------------------------------------------------

let n = 0;
/** A session file in the scratch sessions dir: [path, id]. */
function session(webOwned = false): [string, string] {
  const id = `fuzz-${++n}`;
  const path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-17T00:00:01.000Z", message: { role: "user", content: "hi" } }),
  ].join("\n")}\n`);
  if (webOwned) addWebSession(id);
  return [canonicalPath(path), id];
}
const missingPath = join(sessionsDir, "missing.jsonl");
const workDir = () => { const d = join(root, "work"); mkdirSync(d, { recursive: true }); return d; };
/** A session file a terminal holds open (this test's parent process stands in for the TUI). */
function liveSession(): [string, string] {
  const s = session();
  writeFileSync(join(agentDir, "sessions", "live", `p-${s[1]}.json`), JSON.stringify({ session: { pid: process.ppid, sessionFile: s[0], mode: "tui" }, presence: { status: "idle" } }));
  return s;
}
const sessionArg = (c: CommandEntry, which: [string, string]) => (c.sessionKey === "id" ? which[1] : which[0]);

/** Cases a refusing anchor may still answer 2xx, by design, with the reason. */
const ACCEPTS: Record<string, string> = {
  "session.mode.get | refused:session=missing": "GET /api/mode without ?path= is the default mode, by design",
  "session.mode.get | live:session=missing": "GET /api/mode without ?path= is the default mode, by design",
};

/**
 * Wrong-typed values a route takes, by design or for want of a check, with the reason. A list that
 * only shrinks: a row whose case is now refused for itself fails. Each row is a finding.
 */
const TYPE_ACCEPTS: Record<string, string> = {
  "session.title.set | real:title=null": "title null is the reset, by design (session.title.reset sends it)",
  // Finding: POST /api/sessions ignores a profile or prompt that is not a string (startOf), and makes a plain session.
  ...Object.fromEntries(["profile", "prompt"].flatMap((p) => ["number", "float-huge", "boolean", "object", "array", "proto-object", "null"].map((b) => [`session.create | real:${p}=${b}`, "finding: a non-string profile or prompt is ignored, not refused"]))),
};

/** Why an entry is validate-only: its valid call starts a process the unit tier may not start. */
const VALIDATE_ONLY: Record<string, string> = {
  "session.send": "starts a chat process for the turn",
  "session.configure": "acquires a chat handle, which starts the chat's process",
  "session.mode.set": "acquires a chat handle, which starts the chat's process",
  "session.mode.get": "answers only for a chat this server holds, which needs a started chat",
  ...Object.fromEntries(COMMANDS.filter((c) => c.id.startsWith("project.verb.")).map((c) => [c.id, "a project verb runs git and the supervisor"])),
  "session.sandbox.set": "acquires a chat handle, which starts the chat's process",
  "worker.resume": "acquires a chat handle, which starts the chat's process, and resumes a worker process",
  "session.group.send": "prompts each member, which starts their chat processes",
  "project.costs": "a valid call asks the usage helper, a process of its own (without it the route answers 503 usage-unavailable)",
  "project.preview.off": "needs a minted preview, and minting connects to the port it shows",
  "project.worktree.merge": "a valid call needs a coding session of the project (its build row and git worktree), which only starting a coding session makes, and that starts its chat process",
  "project.worktree.remove": "a valid call needs a coding session of the project (its build row and git worktree), which only starting a coding session makes, and that starts its chat process",
  "project.settings.propose.withdraw": "a valid call needs a settings card, which only the project overseer's sova_settings propose makes, in its chat",
  "usage.prices.refresh": "fetches the price list over the network; the in-process ledger here has prices off, so a valid call changes nothing",
  "push.test": "sends a real notification to every registered device",
  "chat.stop": "a valid call on an open chat drives its process; on a closed one it writes nothing, so no effect oracle can read it back",
  "chat.compact": "acquires a chat handle, which starts the chat's process",
  "chat.rewind": "acquires a chat handle, which starts the chat's process",
  "chat.regenerate": "acquires a chat handle, which starts the chat's process",
  "chat.queue.remove": "acquires a chat handle, which starts the chat's process",
  "chat.reload-code": "a valid call on an open chat drives its process; on a closed one it writes nothing, so no effect oracle can read it back",
  "chat.mode-command": "acquires a chat handle, which starts the chat's process, and runs a project's program",
  "org.owner.request.chat": "a valid call starts a coding session in the request's project, which starts its chat process",
  "session.offers.choose": "a valid click on a send button sends its text as the user's message, which starts the session's chat process for the turn",
};

/**
 * The anchor each entry's cases start from. `refuse: true` means every case must be refused: the
 * anchor itself is refused before anything runs (a missing session, a missing project), so changing
 * one param can't make a valid call. The spawning entries always have one.
 */
interface Anchor { anchor: Record<string, unknown>; refuse: boolean; kind: "refused" | "real" | "live"; onlyWrongTypes?: boolean }
function anchors(c: CommandEntry): Anchor[] {
  const missing: [string, string] = [missingPath, "no-such-id"];
  // Every path param: a dot segment in any spelling is refused by the request builder, before any request (it would resolve out of the route).
  for (const [name, p] of Object.entries(c.params)) if (p.in === "path") pendingSetup.push(async () => { for (const dots of [".", "..", "%2e", "%2E%2e", ".%2e"]) assert.throws(() => buildRequest(c, { ...fill(c), [name]: dots }), /can't be "\." or "\.\."/, `${c.id} ${name}=${dots}`); });
  if (c.id.startsWith("project.verb.")) return [{ anchor: { project: join(outside, "no-project") }, refuse: true, kind: "refused" }];
  // A real folder too, but only wrong-typed values: a string profile would start a chat.
  if (c.id === "session.create") return [{ anchor: { cwd: join(outside, "no-dir") }, refuse: true, kind: "refused" }, { anchor: { cwd: workDir() }, refuse: false, kind: "real", onlyWrongTypes: true }];
  if (c.id === "project.services.view") return [{ anchor: { pid: "no-such-project" }, refuse: false, kind: "real" }];
  if (c.id === "overseer.todo.remove") return [{ anchor: { id: "no-such-todo" }, refuse: true, kind: "refused" }];
  if (c.id === "overseer.todo.update") return [{ anchor: { id: "no-such-todo" }, refuse: true, kind: "refused" }, { anchor: { id: todoId("Fuzzed in place") }, refuse: false, kind: "real" }];
  if (c.id === "overseer.todo.add") return [{ anchor: { text: "a to-do" }, refuse: false, kind: "real" }];
  // A refused anchor (an unknown project, or an idea that isn't there), and a real one that reaches the body's own checks.
  if (c.id === "overseer.idea.update") return [{ anchor: { id: "§fuzz/none" }, refuse: true, kind: "refused" }, { anchor: (() => { const a: Record<string, unknown> = { id: "§fuzz/anchor" }; pendingSetup.push(async () => void (await import("./overseer-ideas")).addIdea({ id: "§fuzz/anchor", title: "Anchor" })); return a; })(), refuse: false, kind: "real" }];
  if (c.id === "project.overseer.idea.add") return [{ anchor: { pid: "no-such-project", id: "§gap/fuzz" }, refuse: true, kind: "refused" }, { anchor: Object.assign((() => { const a: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `po-${c.id}`); mkdirSync(d, { recursive: true }); a.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: c.id }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(a.pid)); await (await import("./org-engine")).hostOf(String(a.pid)).idle(); }); return a; })(), { id: "§gap/fuzz-add" }), refuse: false, kind: "real" }];
  if (c.id === "project.overseer.idea.update") return [{ anchor: { pid: "no-such-project", id: "§gap/fuzz" }, refuse: true, kind: "refused" }, { anchor: (() => { const a: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `po-${c.id}`); mkdirSync(d, { recursive: true }); a.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: c.id }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(a.pid)); await (await import("./org-engine")).hostOf(String(a.pid)).idle(); a.id = "§gap/fuzz-anchor"; await sendTo(app, "POST", `/api/projects/${a.pid}/overseer/ideas`, JSON.stringify({ id: a.id, title: "Anchor" })); }); return a; })(), refuse: false, kind: "real" }];
  if (c.id === "project.overseer.todo.add") return [{ anchor: { pid: "no-such-project" }, refuse: true, kind: "refused" }, { anchor: Object.assign((() => { const a: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `po-${c.id}`); mkdirSync(d, { recursive: true }); a.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: c.id }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(a.pid)); await (await import("./org-engine")).hostOf(String(a.pid)).idle(); }); return a; })(), { text: "a to-do" }), refuse: false, kind: "real" }];
  if (c.id === "project.overseer.todo.update") return [{ anchor: { pid: "no-such-project", id: "x" }, refuse: true, kind: "refused" }, { anchor: (() => { const a: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `po-${c.id}`); mkdirSync(d, { recursive: true }); a.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: c.id }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(a.pid)); await (await import("./org-engine")).hostOf(String(a.pid)).idle(); a.id = ((await sendTo(app, "POST", `/api/projects/${a.pid}/overseer/todos`, JSON.stringify({ text: "Anchor" }))).body as { todos: { id: string }[] }).todos[0]!.id; }); return a; })(), refuse: false, kind: "real" }];
  if (c.id === "project.overseer.todo.reorder") return [{ anchor: { pid: "no-such-project" }, refuse: true, kind: "refused" }, { anchor: (() => { const a: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `po-${c.id}`); mkdirSync(d, { recursive: true }); a.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: c.id }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(a.pid)); await (await import("./org-engine")).hostOf(String(a.pid)).idle(); a.id = ((await sendTo(app, "POST", `/api/projects/${a.pid}/overseer/todos`, JSON.stringify({ text: "Anchor" }))).body as { todos: { id: string }[] }).todos[0]!.id; }); return a; })(), refuse: false, kind: "real" }];
  // A registered project (made in the set-up, its id written into the anchor) takes each body past the project's lookup to the route's own checks.
  if (c.id === "project.update" || c.id === "project.worktree.merge" || c.id === "project.worktree.remove" || c.id === "project.claude-login.set") {
    const v: Record<string, unknown> = {};
    pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
    return [{ anchor: { pid: "no-such-project" }, refuse: true, kind: "refused" }, { anchor: v, refuse: false, kind: "real" }];
  }
  if (c.id === "project.settings.undo" || c.id === "project.settings.propose.withdraw" || c.id === "project.overseer.settings.set") return [{ anchor: { pid: "no-such-project", card: "sc_1" }, refuse: true, kind: "refused" }, { anchor: withProject({ card: "sc_1" }), refuse: false, kind: "real", onlyWrongTypes: true }];
  // A folder that is no folder is refused whatever else the body says; one already registered (in the set-up) is the
  // route's own 409 after its checks of the body, so each case meets them and none registers a project.
  if (c.id === "project.create") {
    const d = join(root, `project-${++n}`);
    mkdirSync(d, { recursive: true });
    const v: Record<string, unknown> = {};
    pendingSetup.push(async () => { v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
    return [{ anchor: { root: join(outside, "no-dir") }, refuse: true, kind: "refused" }, { anchor: { root: d }, refuse: false, kind: "real" }];
  }
  // The usage routes ask the usage helper, which the unit tier doesn't start: the in-process ledger answers instead (prices off: no network), reset when this file ends. A refused anchor only where one exists: a bad range refuses every costs and performance case; today, session, sessions and prices have one param or none, so varying it replaces any refused value (today's tz isn't checked at all).
  if (c.id.startsWith("usage.")) return pendingSetup.push(async () => { const { setUsageAsker } = await import("./usage-helper/client"); const { BadRequest, createService } = await import("./usage-helper/service"); const svc = createService({ usageRoot: join(agentDir, "usage", "v1"), stateDir: join(agentDir, "sova", "usage-ledger"), pricesPath: join(agentDir, "sova", "model-prices.json"), log: () => {}, prices: { enabled: false } }); setUsageAsker(async (op, params) => { try { return { status: 200, body: Buffer.from(JSON.stringify(await svc.answer({ ...params, op }))) }; } catch (err) { return err instanceof BadRequest ? { status: 400, body: Buffer.from(JSON.stringify({ error: err.message })) } : { status: 500, body: Buffer.from(JSON.stringify({ error: "usage-helper-failed" })) }; } }); after(() => setUsageAsker(null)); }), [...(c.params.range ? [{ anchor: { range: "bogus" }, refuse: true, kind: "refused" as const }] : []), { anchor: {}, refuse: false, kind: "real" }];
  // In-chat actions: a missing session, and a real file a terminal holds, whose 409 comes after the body and wait checks, so each wrong-typed value is refused for itself.
  if (c.id.startsWith("chat.")) return [{ anchor: { session: sessionArg(c, missing) }, refuse: true, kind: "refused" }, { anchor: { session: sessionArg(c, liveSession()) }, refuse: true, kind: "live" }];
  const out: Anchor[] = [];
  // Tags are kept by id, for any id: a missing session is no refusal there (a finding, reported).
  if (c.id === "session.tags.set") return [{ anchor: { session: "no-such-id" }, refuse: false, kind: "real" }, { anchor: { session: session()[1] }, refuse: false, kind: "real" }];
  if (c.params.session) {
    out.push({ anchor: { session: sessionArg(c, missing) }, refuse: true, kind: "refused" });
    if (!VALIDATE_ONLY[c.id]) out.push({ anchor: { session: sessionArg(c, session(c.id.includes("archive"))) }, refuse: false, kind: "real" });
    // A real file a terminal holds: past the session lookup, refused before any chat starts.
    else out.push({ anchor: { session: sessionArg(c, liveSession()) }, refuse: true, kind: "live" });
  } else out.push({ anchor: {}, refuse: false, kind: "real" });
  return out;
}

/** A valid call and what it must do: `looks` changes nothing on disk; `changes` changes it and the oracle reads it back. */
interface Fixture { values: () => Record<string, unknown>; status: number; oracle?: (body: unknown, values: Record<string, unknown>) => Promise<void> }
const read = async (method: string, url: string) => (await sendTo(app, method, url)).body as Record<string, unknown>;
const titleOf = async (id: string) => (await read("GET", `/api/sessions/summary?id=${id}`)).title;
const pathToId = (p: unknown) => /_(fuzz-\d+)\.jsonl$/.exec(String(p))![1]!;
/** An org with a project and one owner request, made in-process; the valid call closes it. */
function ownerRequestFixture(status: "done" | "declined"): Fixture {
  return {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => {
        const orgs = await import("./orgs");
        const store = await import("./project-assistant-store");
        const d = join(root, `org-project-${++n}`);
        mkdirSync(d, { recursive: true });
        const org = await orgs.createOrg({ name: `Fuzz Org ${n}`, dir: join(root, `org-${n}`) });
        const proj = await orgs.addProject(org.id, { name: "Fuzz project", root: d });
        v["org-id"] = org.id;
        v["request-id"] = store.fileRequest(org.id, { projectId: proj.id, kind: "bug", title: "A fuzz request", text: "Filed by the fuzz." }).id;
      });
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.equal((await import("./project-assistant-store")).findRequest(String(v["org-id"]), String(v["request-id"]))?.status, status),
  };
}

const FIXTURES: Record<string, Fixture> = {
  "session.list": { values: () => ({}), status: 200 },
  "session.get": { values: () => ({ session: session()[1] }), status: 200 },
  "session.read": { values: () => ({ session: session()[0] }), status: 200 },
  "project.services.view": { values: () => ({ pid: "no-such-project" }), status: 404 },
  "org.owner.request.done": ownerRequestFixture("done"),
  "org.owner.request.decline": ownerRequestFixture("declined"),
  "overseer.attention": { values: () => ({}), status: 200 },
  "overseer.todo.list": { values: () => ({}), status: 200 },
  "models.list": { values: () => ({}), status: 200 },
  "extensions.list": { values: () => ({}), status: 200 },
  "session.create": {
    values: () => { const d = join(root, "work"); mkdirSync(d, { recursive: true }); return { cwd: d }; },
    status: 201,
    oracle: async (body) => {
      const path = (body as { path?: string }).path;
      assert.ok(path && existsSync(path), `a new session file: ${JSON.stringify(body).slice(0, 200)}`);
    },
  },
  "session.title.set": {
    values: () => ({ session: session()[0], title: "Named by the fuzz" }),
    status: 200,
    oracle: async (_b, v) => assert.equal(await titleOf(pathToId(v.session)), "Named by the fuzz"),
  },
  "session.title.reset": {
    values: () => { const s = session(); writeTitle(s[0]); return { session: s[0] }; },
    status: 200,
    oracle: async (_b, v) => assert.equal(await titleOf(pathToId(v.session)), "hi"),
  },
  "session.tags.set": {
    values: () => ({ session: session()[1], tags: ["fuzzed"] }),
    status: 200,
    oracle: async (_b, v) => assert.ok(JSON.stringify(await read("GET", `/api/sessions/summary?id=${v.session}`)).includes("fuzzed")),
  },
  "session.archive": {
    values: () => ({ session: session(true)[0] }),
    status: 200,
    oracle: async (_b, v) => assert.equal((await read("GET", `/api/sessions/summary?id=${pathToId(v.session)}`)).archived, true),
  },
  "session.unarchive": {
    values: () => { const s = session(true); archived.push(s[0]); return { session: s[0] }; },
    status: 200,
    oracle: async (_b, v) => assert.notEqual((await read("GET", `/api/sessions/summary?id=${pathToId(v.session)}`)).archived, true),
  },
  "overseer.todo.add": {
    values: () => ({ text: "Fuzz to-do" }),
    status: 201,
    oracle: async () => assert.ok(JSON.stringify(await read("GET", "/api/overseer/todos")).includes("Fuzz to-do")),
  },
  "overseer.todo.update": {
    values: () => ({ id: todoId("Update me"), text: "Updated by the fuzz" }),
    status: 200,
    oracle: async () => assert.ok(JSON.stringify(await read("GET", "/api/overseer/todos")).includes("Updated by the fuzz")),
  },
  "overseer.todo.remove": {
    values: () => ({ id: todoId("Remove me") }),
    status: 200,
    oracle: async () => assert.ok(!JSON.stringify(await read("GET", "/api/overseer/todos")).includes("Remove me")),
  },
  "session.draft.get": { values: () => ({ session: session()[0] }), status: 200 },
  "session.tools.get": { values: () => ({ session: session()[0] }), status: 200 },
  "session.context": { values: () => ({ session: session()[0] }), status: 200 },
  // A path the setup doesn't list: refused before any read.
  "session.context.file": { values: () => ({ session: session()[0], file: "/etc/hostname" }), status: 404 },
  "session.align.triage": { values: () => ({ session: session()[0] }), status: 200 },
  "session.workers.checks": { values: () => ({ session: session()[0] }), status: 200 },
  "session.insights": { values: () => ({ session: session()[0] }), status: 200 },
  "session.group.list": { values: () => ({}), status: 200 },
  "session.fork": {
    values: () => {
      // A reply to fork from, and a file last written an hour ago, past the guard on files a process may still be writing.
      const path = session()[0];
      const fs = process.getBuiltinModule("node:fs");
      fs.appendFileSync(path, `${JSON.stringify({ type: "message", id: "a1", parentId: "m1", timestamp: "2026-10-17T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], provider: "fuzz", model: "fuzz", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } })}\n`);
      const then = new Date(Date.now() - 3_600_000);
      fs.utimesSync(path, then, then);
      return { session: path, entry: "a1" };
    },
    status: 201,
    oracle: async (body, v) => {
      const path = (body as { path?: string }).path;
      assert.ok(path && path !== v.session && existsSync(path), `a new session file: ${JSON.stringify(body).slice(0, 200)}`);
    },
  },
  "session.draft.set": {
    values: () => ({ session: session()[0], text: "Drafted by the fuzz" }),
    status: 200,
    oracle: async (_b, v) => assert.equal((await read("GET", `/api/sessions/draft?path=${encodeURIComponent(String(v.session))}`)).text, "Drafted by the fuzz"),
  },
  "session.group.create": {
    values: () => ({ name: "Fuzz group" }),
    status: 201,
    oracle: async () => assert.ok(JSON.stringify(await read("GET", "/api/session-groups")).includes("Fuzz group")),
  },
  "session.group.rename": {
    values: () => {
      // The group is made in the set-up, and its id written into these values before the call.
      const v: Record<string, unknown> = { name: "Renamed by the fuzz" };
      pendingSetup.push(async () => void (v.group = ((await sendTo(app, "POST", "/api/session-groups", JSON.stringify({ name: "Rename me" }))).body as { id: string }).id));
      return v;
    },
    status: 200,
    oracle: async () => {
      const groups = JSON.stringify(await read("GET", "/api/session-groups"));
      assert.ok(groups.includes("Renamed by the fuzz") && !groups.includes("Rename me"), groups.slice(0, 300));
    },
  },
  "session.group.delete": {
    values: () => {
      // The group is made in the set-up, and its id written into these values before the call.
      const v: Record<string, unknown> = { };
      pendingSetup.push(async () => void (v.group = ((await sendTo(app, "POST", "/api/session-groups", JSON.stringify({ name: "Delete me" }))).body as { id: string }).id));
      return v;
    },
    status: 200,
    oracle: async () => assert.ok(!JSON.stringify(await read("GET", "/api/session-groups")).includes("Delete me")),
  },
  "session.group.assign": {
    values: () => {
      // The group is made in the set-up, and its id written into these values before the call.
      const v: Record<string, unknown> = { session: session()[0] };
      pendingSetup.push(async () => void (v.group = ((await sendTo(app, "POST", "/api/session-groups", JSON.stringify({ name: "Assign here" }))).body as { id: string }).id));
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.ok(JSON.stringify(await read("GET", "/api/session-groups")).includes(pathToId(v.session))),
  },
  "overseer.todo.reorder": {
    values: () => { const v: Record<string, unknown> = {}; pendingSetup.push(async () => { for (const text of ["Order A", "Order B"]) await sendTo(app, "POST", "/api/overseer/todos", JSON.stringify({ text })); v.ids = ((await read("GET", "/api/overseer/todos")).todos as { id: string }[]).map((t) => t.id).reverse(); }); return v; },
    status: 200,
    oracle: async (_b, v) => assert.deepEqual(((await read("GET", "/api/overseer/todos")).todos as { id: string }[]).map((t) => t.id), v.ids),
  },
  "overseer.todo.clear-done": {
    values: () => { pendingSetup.push(async () => { const t = ((await sendTo(app, "POST", "/api/overseer/todos", JSON.stringify({ text: "Clear me when done" }))).body as { todos: { id: string; text: string }[] }).todos.find((x) => x.text === "Clear me when done")!; await sendTo(app, "PATCH", `/api/overseer/todo?id=${t.id}`, JSON.stringify({ done: true })); }); return {}; },
    status: 200,
    oracle: async () => assert.ok(!JSON.stringify(await read("GET", "/api/overseer/todos")).includes("Clear me when done")),
  },
  "overseer.idea.list": { values: () => ({}), status: 200 },
  "overseer.idea.get": { values: () => { pendingSetup.push(async () => void (await import("./overseer-ideas")).addIdea({ id: "§fuzz/to-read", title: "To read" })); return { id: "§fuzz/to-read" }; }, status: 200 },
  "overseer.idea.update": {
    values: () => { pendingSetup.push(async () => void (await import("./overseer-ideas")).addIdea({ id: "§fuzz/to-update", title: "Before" })); return { id: "§fuzz/to-update", title: "Updated by the fuzz" }; },
    status: 200,
    oracle: async () => assert.ok(JSON.stringify(await read("GET", `/api/overseer/idea?id=${encodeURIComponent("§fuzz/to-update")}`)).includes("Updated by the fuzz")),
  },
  "overseer.notes.get": { values: () => ({}), status: 200 },
  "overseer.notes.set": {
    values: () => ({ text: "Noted by the fuzz" }),
    status: 200,
    oracle: async () => assert.equal((await read("GET", "/api/overseer/notes")).text, "Noted by the fuzz"),
  },
  "project.overseer.idea.list": { values: () => { const v: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); }); return v; }, status: 200 },
  "project.overseer.idea.get": { values: () => { const v: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); v.id = "§gap/fuzz-fixture"; await sendTo(app, "POST", `/api/projects/${v.pid}/overseer/ideas`, JSON.stringify({ id: v.id, title: "Before" })); }); return v; }, status: 200 },
  "project.overseer.idea.add": { values: () => { const v: Record<string, unknown> = { id: "§gap/fuzz-added", title: "Added by the fuzz" }; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); }); return v; }, status: 201, oracle: async (_b, v) => assert.ok(JSON.stringify(await read("GET", `/api/projects/${v.pid}/overseer/ideas`)).includes("Added by the fuzz")) },
  "project.overseer.idea.update": { values: () => { const v: Record<string, unknown> = { title: "Updated by the fuzz" }; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); v.id = "§gap/fuzz-fixture"; await sendTo(app, "POST", `/api/projects/${v.pid}/overseer/ideas`, JSON.stringify({ id: v.id, title: "Before" })); }); return v; }, status: 200, oracle: async (_b, v) => assert.ok(JSON.stringify(await read("GET", `/api/projects/${v.pid}/overseer/idea?id=${encodeURIComponent(String(v.id))}`)).includes("Updated by the fuzz")) },
  "project.overseer.todo.list": { values: () => { const v: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); }); return v; }, status: 200 },
  "project.overseer.todo.add": { values: () => { const v: Record<string, unknown> = { text: "Added by the fuzz" }; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); }); return v; }, status: 201, oracle: async (_b, v) => assert.ok(JSON.stringify(await read("GET", `/api/projects/${v.pid}/overseer/todos`)).includes("Added by the fuzz")) },
  "project.overseer.todo.update": { values: () => { const v: Record<string, unknown> = { text: "Updated by the fuzz" }; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); for (const text of ["Kept", "Done one"]) await sendTo(app, "POST", `/api/projects/${v.pid}/overseer/todos`, JSON.stringify({ text })); const ids = ((await read("GET", `/api/projects/${v.pid}/overseer/todos`)).todos as { id: string }[]).map((t) => t.id); v.id = ids[1]; v.ids = [...ids].reverse(); }); return v; }, status: 200, oracle: async (_b, v) => assert.ok(JSON.stringify(await read("GET", `/api/projects/${v.pid}/overseer/todos`)).includes("Updated by the fuzz")) },
  "project.overseer.todo.remove": { values: () => { const v: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); for (const text of ["Kept", "Done one"]) await sendTo(app, "POST", `/api/projects/${v.pid}/overseer/todos`, JSON.stringify({ text })); const ids = ((await read("GET", `/api/projects/${v.pid}/overseer/todos`)).todos as { id: string }[]).map((t) => t.id); v.id = ids[1]; v.ids = [...ids].reverse(); }); return v; }, status: 200, oracle: async (_b, v) => assert.ok(!JSON.stringify(await read("GET", `/api/projects/${v.pid}/overseer/todos`)).includes("Done one")) },
  "project.overseer.todo.reorder": { values: () => { const v: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); for (const text of ["Kept", "Done one"]) await sendTo(app, "POST", `/api/projects/${v.pid}/overseer/todos`, JSON.stringify({ text })); const ids = ((await read("GET", `/api/projects/${v.pid}/overseer/todos`)).todos as { id: string }[]).map((t) => t.id); v.id = ids[1]; v.ids = [...ids].reverse(); }); return v; }, status: 200, oracle: async (_b, v) => assert.deepEqual(((await read("GET", `/api/projects/${v.pid}/overseer/todos`)).todos as { id: string; text: string }[]).map((t) => t.id), v.ids) },
  "project.overseer.todo.clear-done": { values: () => { const v: Record<string, unknown> = {}; pendingSetup.push(async () => { const d = join(root, `pf-${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d, name: "Fuzz fixture" }))).body as { project: { id: string } }).project.id; /* its runtime registry's first read, done now: no write lands after the hash */ await (await import("./projects/runtime")).observe(String(v.pid)); await (await import("./org-engine")).hostOf(String(v.pid)).idle(); for (const text of ["Kept", "Done one"]) await sendTo(app, "POST", `/api/projects/${v.pid}/overseer/todos`, JSON.stringify({ text })); const ids = ((await read("GET", `/api/projects/${v.pid}/overseer/todos`)).todos as { id: string }[]).map((t) => t.id); v.id = ids[1]; v.ids = [...ids].reverse(); await sendTo(app, "PATCH", `/api/projects/${v.pid}/overseer/todo?id=${v.id}`, JSON.stringify({ done: true })); }); return v; }, status: 200, oracle: async (_b, v) => assert.ok(!JSON.stringify(await read("GET", `/api/projects/${v.pid}/overseer/todos`)).includes("Done one")) },
  "project.list": { values: () => ({}), status: 200 },
  "project.get": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
  },
  "project.worktree.list": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
  },
  "project.files.list": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
  },
  "project.create": {
    values: () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); return { root: d }; },
    status: 201,
    oracle: async (body, v) => {
      const id = (body as { project?: { id?: string } }).project?.id;
      assert.ok(id, JSON.stringify(body).slice(0, 200));
      assert.ok(JSON.stringify(await read("GET", "/api/projects")).includes(id), `${id} is listed`);
      assert.equal((await read("GET", `/api/projects/${id}`)).root, canonicalPath(String(v.root)));
      // Its software registry's first read lands now (it would land half a second later, inside another fixture's window).
      await sendTo(app, "GET", `/api/projects/${id}/runtime`);
    },
  },
  "project.update": {
    values: () => {
      const v: Record<string, unknown> = { name: "Renamed by the fuzz" };
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.equal((await read("GET", `/api/projects/${v.pid}`)).name, "Renamed by the fuzz"),
  },
  "project.claude-login.get": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
  },
  "project.claude-login.set": {
    values: () => {
      const v: Record<string, unknown> = { login: "default" };
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.equal((await read("GET", `/api/projects/${v.pid}/claude-login`)).setting, "default"),
  },
  "org.claude-login.get": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const org = await (await import("./orgs")).createOrg({ name: `Fuzz Org ${++n}`, dir: join(root, `org-${n}`) }); v["org-id"] = org.id; });
      return v;
    },
    status: 200,
  },
  "org.claude-login.set": {
    values: () => {
      const v: Record<string, unknown> = { login: "default" };
      pendingSetup.push(async () => { const org = await (await import("./orgs")).createOrg({ name: `Fuzz Org ${++n}`, dir: join(root, `org-${n}`) }); v["org-id"] = org.id; });
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.equal((await read("GET", `/api/orgs/${v["org-id"]}/claude-login`)).setting, "default"),
  },
  "project.archive": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.ok((await read("GET", `/api/projects/${v.pid}`)).archived, "archived"),
  },
  "project.unarchive": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); await sendTo(app, "POST", `/api/projects/${v.pid}/archive`, "{}"); });
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.equal((await read("GET", `/api/projects/${v.pid}`)).archived, undefined),
  },
  "targets.list": { values: () => ({}), status: 200 },
  "folders.list": { values: () => ({ path: outside }), status: 200 },
  "audit.list": { values: () => ({ limit: 5 }), status: 200 },
  "cwds.list": { values: () => ({}), status: 200 },
  "files.list": { values: () => ({ cwd: outside }), status: 200 },
  "models.favorite": { values: () => ({ ref: "zai/glm-5.3", favorite: true }), status: 200, oracle: async () => assert.match(readFileSync(join(agentDir, "model-favorites.json"), "utf8"), /glm-5\.3/) },
  "usage.costs": { values: () => (anchors(COMMANDS.find((e) => e.id === "usage.costs")!), {}), status: 200 },
  "usage.performance": { values: () => (anchors(COMMANDS.find((e) => e.id === "usage.performance")!), {}), status: 200 },
  "usage.today": { values: () => (anchors(COMMANDS.find((e) => e.id === "usage.today")!), {}), status: 200 },
  "usage.session": { values: () => (anchors(COMMANDS.find((e) => e.id === "usage.session")!), { sid: "no-such-sid" }), status: 200 },
  "usage.sessions": { values: () => (anchors(COMMANDS.find((e) => e.id === "usage.sessions")!), { sids: ["no-such-sid"] }), status: 200 },
  "usage.prices": { values: () => (anchors(COMMANDS.find((e) => e.id === "usage.prices")!), {}), status: 200 },
  "insights.usage": { values: () => ({}), status: 200 },
  "insights.usage.history": { values: () => ({ series: "fuzz", window: "5h" }), status: 200 },
  "insights.agents": { values: () => ({}), status: 200 },
  "insights.worktrees": { values: () => ({ paths: ["fuzz"] }), status: 200 },
  "insights.session.workers": { values: () => ({ session: session()[0] }), status: 200 },
  "insights.session.inbox": { values: () => ({ session: session()[0], team: "team_01", worker: "ag_01" }), status: 404 },
  "sova.health": { values: () => ({}), status: 200 },
  ...Object.fromEntries(["sova", "models", "provider-limits", "align", "delegate", "spec", "team", "summarizer", "overseer", "memory", "subagents"].map((d) => [`settings.${d}.get`, { values: () => ({}), status: 200 }])),
  "settings.align.set": { values: () => ({ style: "default", visuals: true }), status: 200, oracle: async () => assert.equal(((await read("GET", "/api/settings/align")).settings as { visuals: boolean }).visuals, true) },
  "settings.assistant-default.set": { values: () => ({ assistant: { model: "zai/glm-5.3", thinking: "high" } }), status: 200, oracle: async () => assert.equal(((await read("GET", "/api/baton/settings")).assistant as { model: string }).model, "zai/glm-5.3") },
  "session.offers.get": { values: () => ({ session: session()[0] }), status: 200 },
  "session.offers.show": {
    values: () => ({ session: offersSession(), offer: "hello" }),
    status: 200,
    oracle: async (_b, v) => assert.equal(((await read("GET", `/api/session-offers?path=${encodeURIComponent(String(v.session))}`)).cards as unknown[]).length, 1),
  },
  "session.offers.snooze": {
    values: () => ({ session: session()[0], offer: "hello" }),
    status: 200,
    oracle: async (_b, v) => assert.deepEqual((await read("GET", `/api/session-offers?path=${encodeURIComponent(String(v.session))}`)).notNow, ["hello"]),
  },
  "session.offers.unsnooze": {
    values: () => ({ session: session()[0], offer: "hello" }),
    status: 200,
    oracle: async (_b, v) => assert.deepEqual((await read("GET", `/api/session-offers?path=${encodeURIComponent(String(v.session))}`)).notNow, []),
  },
  "project.settings.get": { values: () => withProject(), status: 200 },
  "project.settings.history": { values: () => withProject(), status: 200 },
  "project.overseer.settings.set": {
    values: () => withProject({ watch: false }),
    status: 200,
    oracle: async (_b, v) => assert.equal(((await read("GET", `/api/projects/${v.pid}/overseer`)).settings as { watch: boolean }).watch, false),
  },
  "project.settings.undo": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => {
        v.pid = await newProject();
        await sendTo(app, "PATCH", `/api/projects/${v.pid}/overseer`, JSON.stringify({ holdMin: 3 }));
        v.id = ((await read("GET", `/api/projects/${v.pid}/settings/history`)) as unknown as { id: string }[])[0]!.id;
      });
      return v;
    },
    status: 200,
    oracle: async (_b, v) => assert.equal(((await read("GET", `/api/projects/${v.pid}/overseer`)).settings as { holdMin: number }).holdMin, 10),
  },
  "project.offers.list": {
    values: () => {
      const v: Record<string, unknown> = {};
      pendingSetup.push(async () => { const d = join(root, `project-${++n}`); mkdirSync(d, { recursive: true }); v.pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id; await sendTo(app, "GET", `/api/projects/${v.pid}/runtime`); });
      return v;
    },
    status: 200,
  },
};
/** A registered project (its overseer's settings read their defaults), made in the set-up. */
async function newProject(): Promise<string> {
  const d = join(root, `project-${++n}`);
  mkdirSync(d, { recursive: true });
  const pid = ((await sendTo(app, "POST", "/api/projects", JSON.stringify({ root: d }))).body as { project: { id: string } }).project.id;
  // No looks of its own while the fuzz runs: its watch loop writes nothing behind a later fixture's hash.
  await sendTo(app, "PATCH", `/api/projects/${pid}/overseer`, JSON.stringify({ watch: false }));
  // Its runtime registry's first read, done now: no write lands after the hash.
  await (await import("./projects/runtime")).observe(pid);
  await (await import("./org-engine")).hostOf(pid).idle();
  return pid;
}
/** Values naming a project made in the set-up (its pid filled in before the hash is taken), plus `extra`. */
function withProject(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const v: Record<string, unknown> = { ...extra };
  pendingSetup.push(async () => void (v.pid = await newProject()));
  return v;
}
/** A session whose folder's project declares one offer, `hello`, with a send button (§chat/offers). */
function offersSession(): string {
  const d = join(root, `offers-project-${++n}`);
  mkdirSync(join(d, ".sova"), { recursive: true });
  writeFileSync(join(d, ".sova", "offers.json"), JSON.stringify({ version: 1, offers: { hello: { when: "Always.", title: "Say hello?", repeat: "once-per-session", buttons: [{ label: "Hello", about: "Sends hello.", send: "hello" }] } } }));
  const id = `fuzz-${++n}`;
  const path = join(sessionsDir, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-17T00:00:00.000Z", cwd: d })}\n`);
  return canonicalPath(path);
}
// Set-up a fixture needs before its hash is taken, done by the fixture's own `values`.
const pendingSetup: (() => Promise<void>)[] = [];
const archived: string[] = [];
function writeTitle(path: string) {
  pendingSetup.push(async () => void (await sendTo(app, "POST", "/api/sessions/title", JSON.stringify({ path, title: "Before reset" }))));
}
const todoIds: Record<string, string> = {};
function todoId(text: string): string {
  pendingSetup.push(async () => {
    const r = (await sendTo(app, "POST", "/api/overseer/todos", JSON.stringify({ text }))).body as { todos: { id: string; text: string }[] };
    todoIds[text] = r.todos.find((t) => t.text === text)!.id;
  });
  return `@todo:${text}`;
}
async function settle(values: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (const s of pendingSetup.splice(0)) await s();
  for (const p of archived.splice(0)) await sendTo(app, "POST", "/api/sessions/archive", JSON.stringify({ path: p, archived: true }));
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === "string" && v.startsWith("@todo:") ? todoIds[v.slice(6)] : v]));
}

// ---- the runs -------------------------------------------------------------------------------------

describe("every entry, bad input", () => {
  test("covered: every entry has a valid fixture or is validate-only with a reason, never both", () => {
    const neither = COMMANDS.filter((c) => !FIXTURES[c.id] && !VALIDATE_ONLY[c.id]).map((c) => c.id);
    const both = COMMANDS.filter((c) => FIXTURES[c.id] && VALIDATE_ONLY[c.id]).map((c) => c.id);
    assert.deepEqual({ neither, both }, { neither: [], both: [] });
    const stale = [...Object.keys(FIXTURES), ...Object.keys(VALIDATE_ONLY)].filter((id) => !COMMANDS.some((c) => c.id === id));
    assert.deepEqual(stale, []);
  });

  test("a 4xx with a sentence, never an unlisted 5xx, nothing written outside the scratch root", async () => {
    const before = outsideState();
    const results: Result[] = [];
    for (const c of COMMANDS) {
      for (const { anchor: a0, refuse, kind, onlyWrongTypes } of anchors(c)) {
        const anchor = await settle(a0);
        const b = built(c, { ...fill(c), ...anchor }, "anchor");
        const baseline = await sendTo(app, b.method, b.url, b.raw);
        for (const k of casesFor(c, anchor, BAD, onlyWrongTypes)) {
          const a = await sendTo(app, k.method, k.url, k.raw);
          const name = `${kind}:${k.name}`;
          results.push({ id: c.id, case: name, status: a.status, body: a.body, mustRefuse: refuse && !ACCEPTS[`${c.id} | ${name}`], ...(k.wrongType && kind !== "refused" ? { wrongType: true, baseline } : {}) });
        }
      }
    }
    assert.deepEqual(judge(results, KNOWN, TYPE_ACCEPTS), []);
    assert.equal(polluted(), false, "Object.prototype was polluted");
    assert.equal(readFileSync(join(outside, "sentinel.jsonl"), "utf8"), "{}\n");
    assert.deepEqual(readdirSync(outside).sort(), ["sentinel.jsonl"]);
    assert.equal(outsideState(), before, "something outside the scratch root changed");
    assert.ok(results.length > 1000, `${results.length} cases`);
  });
});

describe("valid fixtures, with effect oracles", () => {
  for (const [id, f] of Object.entries(FIXTURES)) {
    test(id, async () => {
      const c = COMMANDS.find((e) => e.id === id)!;
      const values = await settle(f.values());
      const before = treeHash(root);
      const r = built(c, values, "valid");
      const a = await sendTo(app, r.method, r.url, r.raw);
      assert.equal(a.status, f.status, JSON.stringify(a.body).slice(0, 300));
      const changed = treeHash(root) !== before;
      if (c.effect === "looks") assert.equal(changed, false, `${id} is a looks entry, yet its valid call changed the state root`);
      else {
        assert.equal(changed, true, `${id} changes, yet its valid call changed nothing on disk`);
        assert.ok(f.oracle, `${id} changes, so it needs an oracle`);
        await f.oracle(a.body, values);
      }
    });
  }
});

// ---- the judge can fail ---------------------------------------------------------------------------

describe("the judge's own failure modes", () => {
  const planted = new Hono();
  planted.onError((_e, c) => c.text("Internal Server Error", 500));
  planted.post("/planted", async (c) => {
    if ((await c.req.text()).includes('"__proto__"')) throw new Error("planted");
    return c.json({ error: "Nothing here, by design." }, 400);
  });
  const entry: CommandEntry = { id: "planted.x", label: "Planted", summary: "s", effect: "changes", params: { v: { type: "string", description: "d", in: "body" } }, route: { method: "POST", path: "/planted" }, sessionKey: null, sessionFile: "never", meshNeed: "admin" };
  const run = async () => {
    const out: Result[] = [];
    for (const k of casesFor(entry, {}, { "proto-object": BAD["proto-object"] })) {
      const a = await sendTo(planted, k.method, k.url, k.raw);
      out.push({ id: entry.id, case: k.name, status: a.status, body: a.body, mustRefuse: true });
    }
    return out;
  };

  test("a route that throws on __proto__ fails the run", async () => {
    const problems = judge(await run(), []);
    assert.ok(problems.some((p) => p.includes("a new 5xx") && p.includes("v=proto-object")), problems.join("\n"));
  });
  test("a listed 5xx passes; removing its row fails", async () => {
    const results = await run();
    const rows = results.filter((r) => r.status >= 500).map((r) => ({ id: r.id, case: r.case, status: r.status, finding: "planted" }));
    assert.deepEqual(judge(results, rows), []);
    assert.notDeepEqual(judge(results, rows.slice(1)), []);
  });
  test("a row whose case no longer 5xxs fails (the list only shrinks)", () => {
    const ok: Result[] = [{ id: "a", case: "c", status: 400, body: { error: "No such thing here." }, mustRefuse: true }];
    assert.match(judge(ok, [{ id: "a", case: "c", status: 500, finding: "x" }]).join(), /no longer a 5xx/);
  });
  test("a wrong-typed value answered 200, or with the anchor's own refusal, fails", () => {
    const base = { status: 404, body: { error: "Session file not found" } };
    assert.match(judge([{ id: "a", case: "c", status: 404, body: base.body, mustRefuse: true, wrongType: true, baseline: base }], []).join(), /not refused for itself/);
    assert.match(judge([{ id: "a", case: "c", status: 200, body: {}, mustRefuse: false, wrongType: true, baseline: { status: 200, body: {} } }], []).join(), /not refused for itself/);
    assert.deepEqual(judge([{ id: "a", case: "c", status: 400, body: { error: "text must be a string" }, mustRefuse: true, wrongType: true, baseline: base }], []), []);
  });
  test("a refusal without a sentence, or an answer that should refuse and doesn't, fails", () => {
    assert.equal(judge([{ id: "a", case: "c", status: 400, body: { error: "" }, mustRefuse: true }], []).length, 1);
    assert.equal(judge([{ id: "a", case: "c", status: 200, body: {}, mustRefuse: true }], []).length, 1);
  });
});
