#!/usr/bin/env node
// The Spec review playbook's driver (playbooks/spec-review/PLAYBOOK.md). Node builtins only. It runs
// the trusted spec tools and git for the agent, in fixed forms inside a brief the operator approved,
// and keeps the run's own folder under <state root>/playbooks/spec-review/runs/. It never edits the
// project: the one thing it can write there is an assessment receipt, through the spec tools' own
// `prepare --write` / `record --write`, within the brief's byte ceiling.
//
//   node scripts/spec-review.mjs plan   <brief flags> [--write] [--json]
//   node scripts/spec-review.mjs run    <run id> <form…> [--show <chars>]
//   node scripts/spec-review.mjs status <run id> [--json]
//   node scripts/spec-review.mjs report <run id>            (the report on stdin)
//   node scripts/spec-review.mjs expire [--write]
//
// Brief flags, every one required: --question <text> --kind assess|retro --root <dir> --base <rev>,
// a scope (--id <§id>… --path <rel>… --changed, and for retro --session <id>…), and the ceilings
// --minutes --report-chars --cpu-seconds --write-bytes --model-runs --tokens --retain-days.
// Forms of `run`: spec packet|scope|impact <§id> [--part --cursor --budget] · spec check · spec census ·
// spec foreign · draft status [<name>] · git log · git stat · git diff <path> · git status ·
// assess prepare <label> [--id …] [--path …] [--write] · assess status <label> ·
// assess record <label> --by <who> --decisions-json <json> [--self] --write (assess kind only).
//
// Exit 0: all is well. 1: something to act on, a ceiling reached included (read the digest). 2: it
// couldn't check, or refused a form outside the brief.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

// ---- where things are --------------------------------------------------------------------------

/** The agent dir, read per call (tests move PI_CODING_AGENT_DIR), `~` expanded as spec-mode.md's `$core` line does. */
export function agentDir() {
  let d = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  if (d === "~" || d.startsWith("~/")) d = homedir() + d.slice(1);
  return d;
}
/** The trusted spec tools: exactly where spec-mode.md's `$core` line points, never a guessed path. */
export const coreDir = () => join(agentDir(), "extensions", "spec", "core");
export const runsDir = () => join(agentDir(), "sova", "playbooks", "spec-review", "runs");

// ---- the brief ---------------------------------------------------------------------------------

export const KINDS = ["assess", "retro"];
/** Each ceiling: its flag, its range, and what it bounds. Every one is required: no defaults. */
export const LIMITS = {
  minutes: { min: 1, max: 240, what: "wall time of the run, from plan --write" },
  "report-chars": { min: 500, max: 20000, what: "the report's length" },
  "cpu-seconds": { min: 1, max: 3600, what: "CPU of the tools run through this driver" },
  "write-bytes": { min: 0, max: 64 * 1024 * 1024, what: "assessment receipt bytes written into the project (0: previews only)" },
  "model-runs": { min: 0, max: 10, what: "model sessions beyond this one" },
  tokens: { min: 1, max: 50_000_000, what: "model tokens for the whole run (not metered by this driver)" },
  "retain-days": { min: 0, max: 30, what: "days the run folder is kept after its deadline" },
};
export const SCOPE_CAPS = { id: 20, path: 50, changed: 200, session: 10 };
export const RUN_ID = /^sr-\d{14}-[a-f0-9]{4}$/;
const ID = /^§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/[a-z][a-z-]*$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/;
const DRAFT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const printable = (s, max) => typeof s === "string" && !!s.trim() && s.length <= max && !/[\0-\x08\x0b-\x1f\x7f]/.test(s);

/** A safe relative path inside the root, normalized; null for anything else (absolute, `..`, empty). */
export function relPath(raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return null;
  const s = raw.replaceAll("\\", "/");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s) || s.split("/").includes("..")) return null;
  const n = posix.normalize(s).replace(/\/$/, "");
  return n === "." || n.startsWith("../") ? null : n;
}

// Inherited GIT_* (a GIT_DIR, say) never redirects a read, as in the spec tools' own gitEnv.
const GIT_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
const GIT_C = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
function git(root, args, opts = {}) {
  const r = spawnSync("git", ["-C", root, ...GIT_C, ...args], { encoding: "utf8", env: GIT_ENV, maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim(), r };
}

/** Flags: repeated ones collect, booleans take no value. Positionals are returned in order. */
export function parseArgs(argv, { repeated = [], booleans = [] } = {}) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const k = a.slice(2);
    if (booleans.includes(k)) { flags[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Usage(`--${k} needs a value`);
    if (repeated.includes(k)) (flags[k] ??= []).push(v);
    else if (k in flags) throw new Usage(`--${k} given twice`);
    else flags[k] = v;
  }
  return { flags, pos };
}
class Usage extends Error {}

const BRIEF_FLAGS = ["question", "kind", "root", "base", ...Object.keys(LIMITS)];
const BRIEF_REPEATED = ["id", "path", "session"];

/**
 * Checks a brief and resolves it against the root: every problem is listed (exit 1), and a root that
 * can't be read as a git checkout is "couldn't check" (exit 2). Writes nothing.
 */
export function checkBrief(flags) {
  const problems = [];
  for (const k of Object.keys(flags)) if (![...BRIEF_FLAGS, ...BRIEF_REPEATED, "changed", "write", "json"].includes(k)) problems.push(`--${k}: not a brief flag`);
  for (const k of BRIEF_FLAGS) if (flags[k] === undefined) problems.push(`--${k}: missing${LIMITS[k] ? ` (${LIMITS[k].what})` : ""}`);
  if (flags.question !== undefined && !printable(flags.question, 500)) problems.push("--question: one line of up to 500 printable characters");
  if (flags.kind !== undefined && !KINDS.includes(flags.kind)) problems.push("--kind: assess or retro");
  const limits = {};
  for (const [k, { min, max }] of Object.entries(LIMITS)) {
    if (flags[k] === undefined) continue;
    const n = /^\d+$/.test(flags[k]) ? Number(flags[k]) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) problems.push(`--${k}: a whole number from ${min} to ${max}`);
    else limits[k] = n;
  }
  const ids = flags.id ?? [], paths = (flags.path ?? []).map((p) => [p, relPath(p)]), sessions = flags.session ?? [];
  for (const id of ids) if (!ID.test(id)) problems.push(`--id ${id}: not a § id`);
  for (const [raw, p] of paths) if (!p) problems.push(`--path ${raw}: not a relative path inside the root`);
  for (const s of sessions) if (!SESSION.test(s)) problems.push(`--session ${s}: not a session id`);
  if (sessions.length && flags.kind === "assess") problems.push("--session: only a retro reads sessions; an assessment compares code and docs");
  if (ids.length > SCOPE_CAPS.id) problems.push(`--id: at most ${SCOPE_CAPS.id}`);
  if (paths.length > SCOPE_CAPS.path) problems.push(`--path: at most ${SCOPE_CAPS.path}`);
  if (sessions.length > SCOPE_CAPS.session) problems.push(`--session: at most ${SCOPE_CAPS.session}`);
  if (!ids.length && !paths.length && !flags.changed && !sessions.length) problems.push("scope: missing (--id, --path, --changed or, for a retro, --session)");

  let root = null, base = null, head = null, changed = null, fatal = null;
  if (flags.root !== undefined) {
    if (!isAbsolute(flags.root)) problems.push("--root: an absolute path");
    else {
      let real = null;
      try { real = realpathSync(flags.root); } catch { fatal = `--root ${flags.root}: can't be read`; }
      if (real && real !== flags.root.replace(/\/$/, "")) problems.push(`--root: a real path without symlinks (it resolves to ${real})`);
      else if (real) {
        const top = git(real, ["rev-parse", "--show-toplevel"]);
        if (!top.ok) fatal = `--root ${real}: not a git checkout (${top.err || "git failed"})`;
        else if (top.out.trim() !== real) problems.push(`--root: the checkout's top level (${top.out.trim()})`);
        else root = real;
      }
    }
  }
  if (root && flags.base !== undefined) {
    const h = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const b = git(root, ["rev-parse", "--verify", "--end-of-options", `${flags.base}^{commit}`]);
    if (!h.ok) fatal = "HEAD: no commit to compare against";
    else if (!b.ok) problems.push(`--base ${flags.base}: not a commit here`);
    else {
      head = h.out.trim();
      base = b.out.trim();
      if (!git(root, ["merge-base", "--is-ancestor", base, head]).ok) problems.push(`--base ${flags.base}: not an ancestor of HEAD; name the revision the work started from, or git merge-base master HEAD`);
    }
  }
  if (root && base && flags.changed) {
    const tracked = git(root, ["diff", "--name-only", "-z", "--no-renames", base]);
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (!tracked.ok || !untracked.ok) fatal = "--changed: git couldn't list the changes since base";
    else {
      changed = [...new Set([...tracked.out.split("\0"), ...untracked.out.split("\0")].filter(Boolean))].sort();
      if (changed.length > SCOPE_CAPS.changed) problems.push(`--changed: ${changed.length} files changed since base, over ${SCOPE_CAPS.changed}; narrow the scope with --path`);
    }
  }
  const brief = {
    question: flags.question,
    kind: flags.kind,
    root,
    base,
    baseRev: flags.base,
    head,
    scope: { ids: [...new Set(ids)].sort(), paths: [...new Set(paths.map(([, p]) => p).filter(Boolean))].sort(), changed, sessions: [...new Set(sessions)] },
    limits,
  };
  return { problems, fatal, brief };
}

const newRunId = (now = new Date()) => `sr-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;

function briefLines(b) {
  const s = b.scope, L = b.limits;
  return [
    `question: ${b.question}`,
    `kind: ${b.kind} · root: ${b.root} · base: ${b.base?.slice(0, 12)} (${b.baseRev}) · head: ${b.head?.slice(0, 12)}`,
    `scope: ${s.ids.length} ids${s.ids.length ? ` (${s.ids.join(", ")})` : ""} · ${s.paths.length} paths${s.paths.length ? ` (${s.paths.join(", ")})` : ""} · changed since base: ${s.changed ? s.changed.length : "not in scope"}${s.sessions.length ? ` · ${s.sessions.length} sessions` : ""}`,
    `ceilings: ${L.minutes} min · report ${L["report-chars"]} chars · ${L["cpu-seconds"]} CPU s · writes ${L["write-bytes"]} B${L["write-bytes"] === 0 ? " (previews only)" : ""} · ${L["model-runs"]} model runs · ${L.tokens} tokens · kept ${L["retain-days"]} days`,
  ];
}

function cmdPlan(argv) {
  const { flags } = parseArgs(argv, { repeated: BRIEF_REPEATED, booleans: ["changed", "write", "json"] });
  const { problems, fatal, brief } = checkBrief(flags);
  const exit = fatal ? 2 : problems.length ? 1 : 0;
  let runId = null, dir = null, frozen = null;
  if (!exit && flags.write) {
    const now = new Date();
    runId = newRunId(now);
    dir = join(runsDir(), runId);
    mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    const deadline = new Date(now.getTime() + brief.limits.minutes * 60_000);
    frozen = { tool: "spec-review", v: 1, runId, createdAt: now.toISOString(), deadline: deadline.toISOString(), expiresAt: new Date(deadline.getTime() + brief.limits["retain-days"] * 86_400_000).toISOString(), ...brief };
    writeFileSync(join(dir, "brief.json"), JSON.stringify(frozen, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify({ exit, problems, fatal, brief, written: !!runId, runId, dir }, null, 2) + "\n");
    return exit;
  }
  const out = [];
  if (fatal) out.push(`couldn't check: ${fatal}`);
  for (const p of problems) out.push(`problem: ${p}`);
  if (!fatal && brief.root) out.push(...briefLines(brief));
  if (exit) out.push("next: settle each problem with the operator, then plan again. Nothing was collected or written.");
  else if (runId) out.push(`frozen: run ${runId} · deadline ${frozen.deadline} · ${dir}`, `next: node scripts/spec-review.mjs run ${runId} git stat`);
  else out.push("preview: nothing written. Once the operator approves this brief, run the same command with --write.");
  console.log(out.join("\n"));
  return exit;
}

// ---- a run's state -----------------------------------------------------------------------------

function readRegular(path, max = 4 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error(`${path}: not a small regular file`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (!n) break; off += n; }
    return buf.subarray(0, off).toString("utf8");
  } finally { closeSync(fd); }
}

/** The run's frozen brief and its ledger, or throws Usage. */
export function loadRun(runId) {
  if (!RUN_ID.test(runId ?? "")) throw new Usage(`${runId ?? "(none)"}: not a run id (plan --write prints one)`);
  const dir = join(runsDir(), runId);
  let st;
  try { st = lstatSync(dir); } catch { throw new Usage(`run ${runId}: no such run folder`); }
  if (!st.isDirectory()) throw new Usage(`run ${runId}: its folder isn't a plain directory`);
  const brief = JSON.parse(readRegular(join(dir, "brief.json")));
  if (brief.tool !== "spec-review" || brief.runId !== runId) throw new Usage(`run ${runId}: brief.json doesn't belong to this run`);
  let ledger = [];
  try { ledger = readRegular(join(dir, "ledger.jsonl"), 16 * 1024 * 1024).split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return { dir, brief, ledger };
}

/** What a run has spent, from its ledger, against its brief. */
export function spent(run, now = Date.now()) {
  const { brief, ledger } = run;
  const L = brief.limits;
  const cpuMs = ledger.reduce((s, e) => s + (e.cpuMs ?? 0), 0);
  const cpuUnknown = ledger.some((e) => e.ran && e.cpuMs === null);
  const wrote = ledger.reduce((s, e) => s + (e.wroteBytes ?? 0), 0);
  const deadline = Date.parse(brief.deadline);
  const reached = [];
  if (now >= deadline) reached.push("time");
  if (cpuMs >= L["cpu-seconds"] * 1000) reached.push("cpu");
  return { cpuMs, cpuUnknown, wrote, writeLeft: Math.max(0, L["write-bytes"] - wrote), msLeft: Math.max(0, deadline - now), reached };
}

/** Every § id the run may read: the brief's, their children, and what this run's census, foreign and preparations surfaced. */
export function allowedIds(run) {
  const set = new Set(run.brief.scope.ids);
  for (const e of run.ledger) for (const id of e.surfaced ?? []) set.add(id);
  return set;
}
const idAllowed = (allowed, id) => allowed.has(id) || [...allowed].some((a) => { const m = /^§([a-z][a-z-]*)\/([a-z][a-z-]*)$/.exec(a); return !!m && id.startsWith(`§${m[1]}.${m[2]}/`); });

/** A path is in scope when the brief names it or a folder above it, or it changed since base (frozen at plan). */
export function pathInScope(brief, p) {
  const s = brief.scope;
  return (s.changed ?? []).includes(p) || s.paths.some((q) => p === q || p.startsWith(`${q}/`));
}
const scopePathspecs = (brief) => [...new Set([...brief.scope.paths, ...(brief.scope.changed ?? [])])].map((p) => `:(literal)${p}`);

// ---- child CPU (Linux: this process's reaped children; elsewhere unknown) ------------------------

let tick = null;
function childCpuMs() {
  try {
    if (tick === null) { const r = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }); tick = Number(r.stdout) || 100; } // before the read: its own CPU isn't a tool's
    const stat = readFileSync("/proc/self/stat", "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return ((Number(f[13]) + Number(f[14])) * 1000) / tick; // cutime, cstime
  } catch { return null; }
}

// ---- run: the forms ------------------------------------------------------------------------------

class Refused extends Error { constructor(msg, exit = 2) { super(msg); this.exit = exit; } }

/** The argv for one form, after every scope check; throws Refused for anything outside the brief. */
export function formArgv(run, form) {
  const { brief } = run;
  const [tool, cmd, ...rest] = form;
  const core = coreDir();
  const root = brief.root;
  if (tool === "spec") {
    const spec = join(core, "sova-spec.mjs");
    if (["packet", "scope", "impact"].includes(cmd)) {
      const { flags, pos } = parseArgs(rest);
      const id = pos[0];
      if (pos.length !== 1 || !ID.test(id ?? "")) throw new Refused(`spec ${cmd} takes one § id`);
      if (!idAllowed(allowedIds(run), id)) throw new Refused(`${id} is outside this run's scope: not in the brief, under a brief id, or surfaced by this run's census, foreign or preparations. A wider scope is a new brief the operator approves.`);
      const extra = [];
      for (const [k, v] of Object.entries(flags)) {
        if (cmd !== "packet" || !["part", "cursor", "budget"].includes(k)) throw new Refused(`spec ${cmd}: --${k} isn't allowed`);
        if (k === "part" && !["prose", "inventory", "frontier", "code", "findings"].includes(v)) throw new Refused("--part: prose, inventory, frontier, code or findings");
        if (k === "budget" && !/^\d{1,7}$/.test(v)) throw new Refused("--budget: a whole number");
        if (k === "cursor" && !printable(v, 2048)) throw new Refused("--cursor: the token a packet printed");
        extra.push(`--${k}`, v);
      }
      return { bin: process.execPath, args: [spec, cmd, id, ...extra, "--root", root, "--json"], surfaces: false };
    }
    if (rest.length) throw new Refused(`spec ${cmd} takes no arguments here: root, base and scope come from the brief`);
    if (cmd === "check") return { bin: process.execPath, args: [spec, "check", "--root", root, "--json"] };
    if (cmd === "census") return { bin: process.execPath, args: [spec, "census", "--changed", "--base", brief.base, "--root", root, "--json"], surfaces: "census" };
    if (cmd === "foreign") return { bin: process.execPath, args: [spec, "foreign", "--base", brief.base, "--root", root, "--json"], surfaces: "foreign" };
    throw new Refused(`spec ${cmd ?? ""}: not a form (packet, scope, impact, check, census, foreign)`);
  }
  if (tool === "draft") {
    if (cmd !== "status" || rest.length > 1 || (rest[0] !== undefined && !DRAFT.test(rest[0]))) throw new Refused("draft status [<name>] is the only draft form");
    return { bin: process.execPath, args: [join(core, "sova-spec-draft.mjs"), "status", ...rest, "--root", root, "--json"] };
  }
  if (tool === "git") {
    const specs = brief.scope.paths.length || brief.scope.changed ? scopePathspecs(brief) : [];
    const g = ["-C", root, ...GIT_C];
    if (cmd === "log" && !rest.length) return { bin: "git", args: [...g, "log", "--no-color", "--format=%h%x09%ad%x09%s", "--date=short", `${brief.base}..HEAD`, "--", ...specs] };
    if (cmd === "stat" && !rest.length) return { bin: "git", args: [...g, "diff", "--no-color", "--no-ext-diff", "--stat=200", brief.base, "--", ...specs] };
    if (cmd === "status" && !rest.length) return { bin: "git", args: [...g, "status", "--porcelain=v1", "--untracked-files=all", "--", ...specs] };
    if (cmd === "diff" && rest.length === 1) {
      const p = relPath(rest[0]);
      if (!p || !pathInScope(brief, p)) throw new Refused(`${rest[0]} is outside this run's scope`);
      return { bin: "git", args: [...g, "diff", "--no-color", "--no-ext-diff", "--no-textconv", brief.base, "--", `:(literal)${p}`] };
    }
    throw new Refused("git forms: log, stat, status, diff <path>");
  }
  if (tool === "assess") {
    if (brief.kind !== "assess") throw new Refused("assessment forms belong to an assess run; a retro reads history, not receipts");
    const assess = join(core, "sova-spec-assess.mjs");
    const { flags, pos } = parseArgs(rest, { repeated: ["id", "path"], booleans: ["write", "self"] });
    const label = pos[0];
    if (pos.length !== 1 || !LABEL.test(label ?? "")) throw new Refused(`assess ${cmd ?? ""}: one label, lowercase letters, digits and hyphens, up to 31`);
    const name = `${brief.runId}-${label}`;
    const writtenNames = new Set(run.ledger.filter((e) => e.written).map((e) => e.written.name));
    if (cmd === "prepare") {
      for (const k of Object.keys(flags)) if (!["id", "path", "write"].includes(k)) throw new Refused(`assess prepare: --${k} isn't allowed (root and base come from the brief; no declared snapshot, no attribution)`);
      const ids = [...new Set(flags.id ?? [])].sort(), paths = [...new Set((flags.path ?? []).map((p) => { const r = relPath(p); if (!r || !pathInScope(brief, r)) throw new Refused(`--path ${p} is outside this run's scope`); return r; }))].sort();
      const allowed = allowedIds(run);
      for (const id of ids) if (!ID.test(id) || !idAllowed(allowed, id)) throw new Refused(`--id ${id} is outside this run's scope`);
      if (!ids.length && !paths.length && !brief.scope.changed) throw new Refused("assess prepare with no --id or --path reads every change since base; this brief's scope doesn't include --changed");
      const queryKey = JSON.stringify({ ids, paths });
      const args = [assess, "prepare", name, "--root", brief.root, "--base", brief.base, ...ids.flatMap((i) => ["--id", i]), ...paths.flatMap((p) => ["--path", p]), "--json"];
      if (!flags.write) return { bin: process.execPath, args, surfaces: "prepare", preview: { queryKey } };
      if (writtenNames.has(name)) throw new Refused(`${label}: this run already wrote that receipt; receipts are immutable`);
      const previews = run.ledger.filter((e) => e.preview?.queryKey === queryKey && e.exit === 0 && e.preview.fingerprint);
      const last = previews.at(-1);
      if (!last) throw new Refused("assess prepare --write: preview the same query first (the same --id and --path, without --write)");
      if (run.ledger.some((e) => e.written?.fingerprint === last.preview.fingerprint)) throw new Refused("this run already wrote a receipt with that fingerprint; nothing changed since, so a second one would only repeat it");
      const left = spent(run).writeLeft;
      if (last.preview.bytes > left) throw new Refused(`the preview was ${last.preview.bytes} bytes and ${left} of the write ceiling are left; narrow the query (fewer --path or --id) or report the assessment as not written`, 1);
      return { bin: process.execPath, args: [...args.slice(0, -1), "--write", "--json"], write: { name, kind: "packet", queryKey, previewFingerprint: last.preview.fingerprint } };
    }
    if (cmd === "status") {
      if (Object.keys(flags).length) throw new Refused("assess status takes only a label");
      if (!writtenNames.has(name)) throw new Refused(`${label}: not a receipt this run wrote`);
      return { bin: process.execPath, args: [assess, "status", name, "--root", brief.root, "--json"] };
    }
    if (cmd === "record") {
      for (const k of Object.keys(flags)) if (!["by", "decisions-json", "self", "write"].includes(k)) throw new Refused(`assess record: --${k} isn't allowed`);
      if (!flags.write || !flags.by || !flags["decisions-json"]) throw new Refused("assess record <label> --by <who> --decisions-json <json> --write");
      if (!writtenNames.has(name)) throw new Refused(`${label}: not a receipt this run wrote`);
      if (run.ledger.some((e) => e.written?.name === name && e.written.kind === "record")) throw new Refused(`${label}: already recorded; records are immutable`);
      const estimate = Buffer.byteLength(flags["decisions-json"]) + 2048;
      const left = spent(run).writeLeft;
      if (estimate > left) throw new Refused(`a record of about ${estimate} bytes doesn't fit the ${left} bytes left of the write ceiling`, 1);
      return { bin: process.execPath, args: [assess, "record", name, "--root", brief.root, "--by", flags.by, "--decisions-json", flags["decisions-json"], ...(flags.self ? ["--self"] : []), "--write", "--json"], write: { name, kind: "record" } };
    }
    throw new Refused("assess forms: prepare, status, record");
  }
  throw new Refused(`${tool ?? "(nothing)"}: not a form (spec, draft, git, assess)`);
}

/** The § ids a form's JSON output brings into scope: claims of in-scope changed files, changed claims, candidates. */
export function surfacedIds(brief, kind, stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return []; }
  const out = new Set();
  if (kind === "census") for (const list of [j.census?.claimed, j.census?.mappedOutside]) for (const e of Array.isArray(list) ? list : []) {
    if (typeof e?.path === "string" && pathInScope(brief, e.path)) for (const id of e.claims ?? []) if (ID.test(id)) out.add(id);
  }
  if (kind === "foreign" && brief.scope.changed) for (const id of j.foreign ?? []) if (ID.test(id)) out.add(id);
  if (kind === "prepare") for (const c of j.candidates ?? []) if (ID.test(c?.id ?? "")) out.add(c.id);
  return [...out].sort();
}

function receiptBytes(root, name, file) {
  try { const st = lstatSync(join(root, ".sova", "spec", "assessments", name, file)); return st.isFile() ? st.size : 0; } catch { return 0; }
}

function cmdRun(argv) {
  const at = argv.indexOf("--show");
  let show = 4000;
  if (at >= 0) {
    show = Number(argv[at + 1]);
    if (!Number.isInteger(show) || show < 500 || show > 12000) throw new Usage("--show: 500 to 12000 characters");
    argv = [...argv.slice(0, at), ...argv.slice(at + 2)];
  }
  const [runId, ...form] = argv;
  const run = loadRun(runId);
  const n = run.ledger.length + 1;
  const log = (entry) => appendFileSync(join(run.dir, "ledger.jsonl"), JSON.stringify({ n, at: new Date().toISOString(), form: form.join(" ").slice(0, 300), ...entry }) + "\n", { mode: 0o600 });
  const before = spent(run);
  if (before.reached.length) {
    log({ refused: `ceiling ${before.reached.join(", ")}`, ceiling: before.reached });
    console.log(`stop: ceiling ${before.reached.join(" and ")} reached. Collect nothing more: report what is known, what stays unknown, and that this ceiling ended the run. Never raise it yourself.`);
    return 1;
  }
  let spec;
  try { spec = formArgv(run, form); } catch (e) {
    if (!(e instanceof Refused)) throw e;
    log({ refused: e.message });
    console.log(`refused: ${e.message}`);
    return e.exit;
  }
  const cpu0 = childCpuMs(), t0 = Date.now();
  const r = spawnSync(spec.bin, spec.args, { encoding: "utf8", env: GIT_ENV, cwd: run.brief.root, timeout: before.msLeft, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
  const wallMs = Date.now() - t0, cpu1 = childCpuMs();
  const cpuMs = cpu0 === null || cpu1 === null ? null : Math.round(cpu1 - cpu0);
  const stdout = r.stdout ?? "";
  const timedOut = r.error?.code === "ETIMEDOUT" || (r.signal === "SIGKILL" && Date.now() >= Date.parse(run.brief.deadline));
  const exit = r.error && !timedOut ? 2 : timedOut ? 1 : r.status ?? 2;
  // The whole output is the run's own; at most 2 MiB of it is kept.
  const saveCap = 2 * 1024 * 1024;
  const outDir = join(run.dir, "out");
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const outFile = join(outDir, `${String(n).padStart(3, "0")}.txt`);
  const outBytes = Buffer.byteLength(stdout);
  writeFileSync(outFile, outBytes > saveCap ? Buffer.from(stdout).subarray(0, saveCap) : stdout, { flag: "wx", mode: 0o600 });
  const entry = { ran: true, exit, wallMs, cpuMs, outBytes, savedTruncated: outBytes > saveCap, shownTruncated: stdout.length > show, timedOut };
  if (spec.surfaces && exit !== 2) entry.surfaced = surfacedIds(run.brief, spec.surfaces, stdout);
  if (spec.preview) {
    let fp = null;
    try { fp = JSON.parse(stdout).fingerprint ?? null; } catch {}
    entry.preview = { queryKey: spec.preview.queryKey, fingerprint: fp, bytes: outBytes };
  }
  if (spec.write) {
    let j = null;
    try { j = JSON.parse(stdout); } catch {}
    if (exit === 0 && j?.written) {
      const bytes = receiptBytes(run.brief.root, spec.write.name, spec.write.kind === "packet" ? "packet.json" : "record.json");
      entry.written = { name: spec.write.name, kind: spec.write.kind, fingerprint: j.fingerprint ?? null, bytes };
      entry.wroteBytes = bytes;
      if (spec.write.previewFingerprint && j.fingerprint !== spec.write.previewFingerprint) entry.note = "inputs changed between the preview and the write";
    }
  }
  if (r.stderr && exit === 2) entry.stderr = r.stderr.slice(0, 500);
  log(entry);
  const after = spent({ ...run, ledger: [...run.ledger, entry] });
  const L = run.brief.limits;
  const lines = [stdout.length > show ? `${stdout.slice(0, show)}\n… ${stdout.length - show} more characters in the saved output` : stdout.replace(/\n$/, "")];
  if (timedOut) lines.push("stop: ceiling time reached while this ran; it was stopped and its output is partial.");
  if (entry.note) lines.push(`note: ${entry.note}`);
  if (entry.written) lines.push(`wrote: ${entry.written.name} ${entry.written.kind} · ${entry.written.bytes} bytes (receipts are immutable and stay after the run)`);
  if (entry.stderr) lines.push(`stderr: ${entry.stderr}`);
  lines.push(`ledger #${n} · exit ${exit} · ${(wallMs / 1000).toFixed(1)} s · CPU ${cpuMs === null ? "unknown" : `${(cpuMs / 1000).toFixed(1)} s`} · ${outBytes} bytes · saved ${outFile}`);
  lines.push(`left: ${Math.floor(after.msLeft / 60_000)} min · CPU ${Math.max(0, L["cpu-seconds"] - after.cpuMs / 1000).toFixed(1)} s · writes ${after.writeLeft} B${after.reached.length ? ` · reached: ${after.reached.join(", ")}` : ""}`);
  console.log(lines.join("\n"));
  return after.reached.length && exit === 0 ? 1 : exit;
}

// ---- status, report, expire ----------------------------------------------------------------------

export function summary(run, now = Date.now()) {
  const s = spent(run, now), L = run.brief.limits;
  const ran = run.ledger.filter((e) => e.ran);
  const byExit = [0, 1, 2].map((x) => ran.filter((e) => e.exit === x).length);
  return {
    runId: run.brief.runId,
    reached: s.reached,
    minutesUsed: Math.round((now - Date.parse(run.brief.createdAt)) / 60_000),
    cpuSeconds: s.cpuUnknown ? null : Math.round(s.cpuMs / 100) / 10,
    wroteBytes: s.wrote,
    calls: ran.length,
    exits: { 0: byExit[0], 1: byExit[1], 2: byExit[2] },
    refused: run.ledger.filter((e) => e.refused).length,
    truncated: ran.filter((e) => e.shownTruncated || e.savedTruncated).length,
    timedOut: ran.filter((e) => e.timedOut).length,
    receipts: run.ledger.filter((e) => e.written).map((e) => ({ name: e.written.name, kind: e.written.kind, bytes: e.written.bytes })),
    limits: L,
    deadline: run.brief.deadline,
    expiresAt: run.brief.expiresAt,
  };
}

function cmdStatus(argv) {
  const { flags, pos } = parseArgs(argv, { booleans: ["json"] });
  const run = loadRun(pos[0]);
  const s = summary(run);
  const exit = s.reached.length ? 1 : 0;
  if (flags.json) { process.stdout.write(JSON.stringify({ exit, ...s }, null, 2) + "\n"); return exit; }
  const L = s.limits;
  console.log([
    ...briefLines(run.brief),
    `time: ${s.minutesUsed} of ${L.minutes} min${s.reached.includes("time") ? " · reached" : ""}`,
    `CPU: ${s.cpuSeconds === null ? "unknown on this host" : `${s.cpuSeconds} of ${L["cpu-seconds"]} s`}${s.reached.includes("cpu") ? " · reached" : ""}`,
    `writes: ${s.wroteBytes} of ${L["write-bytes"]} bytes · receipts: ${s.receipts.length ? s.receipts.map((r) => `${r.name} ${r.kind} ${r.bytes} B`).join(", ") : "none"}`,
    `model runs ≤ ${L["model-runs"]} · tokens ≤ ${L.tokens}: not metered by this driver; report what the session shows, else unknown`,
    `calls: ${s.calls} (exit 0: ${s.exits[0]}, 1: ${s.exits[1]}, 2: ${s.exits[2]}) · refused ${s.refused} · truncated ${s.truncated} · stopped at the deadline ${s.timedOut}`,
    `run folder kept until ${s.expiresAt}`,
  ].join("\n"));
  return exit;
}

export const REPORT_SECTIONS = ["Question", "Findings", "Unknown", "Coverage", "Cost", "Method proposals", "Stopped because"];
const TAGS = ["Observed:", "Inferred:", "Proposed:"];

/** Problems with a report: its length, its fixed sections in order, and each finding's tag. */
export function checkReport(text, maxChars) {
  const problems = [];
  if (text.length > maxChars) problems.push(`${text.length} characters, over the brief's ${maxChars}: cut, and say what was cut under Coverage`);
  const heads = [...text.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  const missing = REPORT_SECTIONS.filter((s) => !heads.includes(s));
  if (missing.length) problems.push(`missing sections: ${missing.map((s) => `## ${s}`).join(", ")}`);
  else if (REPORT_SECTIONS.map((s) => heads.indexOf(s)).some((v, i, a) => i && v < a[i - 1])) problems.push(`sections out of order: ${REPORT_SECTIONS.join(", ")}`);
  const body = /^## Findings\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const bullets = body.split("\n").filter((l) => /^- /.test(l));
  if (!bullets.length && !/^\s*None\.?\s*$/m.test(body)) problems.push("Findings: one bullet per finding, or the line None.");
  for (const b of bullets) if (!TAGS.some((t) => b.slice(2).startsWith(t))) problems.push(`Findings: "${b.slice(0, 60)}" starts with none of ${TAGS.join(" ")}`);
  return problems;
}

function cmdReport(argv) {
  const run = loadRun(argv[0]);
  const text = readFileSync(0, "utf8");
  const problems = checkReport(text, run.brief.limits["report-chars"]);
  if (problems.length) { console.log(problems.map((p) => `problem: ${p}`).join("\n")); return 1; }
  writeFileSync(join(run.dir, "report.md"), text, { mode: 0o600 });
  console.log(`ok: ${text.length} of ${run.brief.limits["report-chars"]} characters · saved ${join(run.dir, "report.md")}`);
  return 0;
}

const OWN_FILES = new Set(["brief.json", "ledger.jsonl", "report.md"]);
const OUT_FILE = /^\d{3,6}\.txt$/;

/** Each run folder: expired or not, and what removing it would remove; anything not the driver's own is skipped. */
export function expiry(now = Date.now()) {
  let names = [];
  try { names = readdirSync(runsDir()); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const rows = [];
  for (const name of names.sort()) {
    const dir = join(runsDir(), name);
    const row = { name, dir, files: [], bytes: 0, state: "kept" };
    rows.push(row);
    const skip = (why) => { row.state = "skipped"; row.why = why; };
    if (!RUN_ID.test(name)) { skip("not a run folder name"); continue; }
    let st;
    try { st = lstatSync(dir); } catch { skip("unreadable"); continue; }
    if (!st.isDirectory()) { skip("not a plain directory"); continue; }
    let brief;
    try { brief = JSON.parse(readRegular(join(dir, "brief.json"))); } catch { skip("no readable brief.json"); continue; }
    if (brief.tool !== "spec-review" || brief.runId !== name || Number.isNaN(Date.parse(brief.expiresAt))) { skip("brief.json doesn't belong to this folder"); continue; }
    row.expiresAt = brief.expiresAt;
    let bad = null;
    for (const child of readdirSync(dir)) {
      const p = join(dir, child), cst = lstatSync(p);
      if (child === "out" && cst.isDirectory()) {
        for (const f of readdirSync(p)) {
          const fst = lstatSync(join(p, f));
          if (!OUT_FILE.test(f) || !fst.isFile()) { bad = `out/${f}`; break; }
          row.files.push(join(p, f)); row.bytes += fst.size;
        }
        row.outDir = p;
      } else if (OWN_FILES.has(child) && cst.isFile()) { row.files.push(p); row.bytes += cst.size; }
      else bad = child;
      if (bad) break;
    }
    if (bad) { skip(`${bad} isn't the driver's own`); row.files = []; continue; }
    if (Date.parse(brief.expiresAt) <= now) row.state = "expired";
  }
  return rows;
}

function cmdExpire(argv) {
  const { flags } = parseArgs(argv, { booleans: ["write"] });
  const rows = expiry();
  const lines = [];
  for (const r of rows) {
    if (r.state === "expired" && flags.write) {
      for (const f of r.files) unlinkSync(f);
      if (r.outDir) rmdirSync(r.outDir);
      rmdirSync(r.dir);
      lines.push(`removed: ${r.name} · ${r.files.length} files · ${r.bytes} bytes`);
    } else if (r.state === "expired") lines.push(`would remove: ${r.name} · ${r.files.length} files · ${r.bytes} bytes · expired ${r.expiresAt}`);
    else if (r.state === "skipped") lines.push(`skipped: ${r.name} · ${r.why}`);
  }
  const kept = rows.filter((r) => r.state === "kept").length;
  lines.push(`${rows.filter((r) => r.state === "expired").length} expired · ${kept} kept · ${rows.filter((r) => r.state === "skipped").length} skipped${flags.write ? "" : " · preview: nothing removed (--write removes the expired ones)"}. Only run folders under ${runsDir()}; receipts in projects are never touched.`);
  console.log(lines.join("\n"));
  return rows.some((r) => r.state === "skipped") ? 1 : 0;
}

// ---- main ----------------------------------------------------------------------------------------

export function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "plan") return cmdPlan(rest);
    if (cmd === "run") return cmdRun(rest);
    if (cmd === "status") return cmdStatus(rest);
    if (cmd === "report") return cmdReport(rest);
    if (cmd === "expire") return cmdExpire(rest);
    throw new Usage("commands: plan, run, status, report, expire");
  } catch (e) {
    console.log(`couldn't check: ${e instanceof Usage ? e.message : e?.message ?? String(e)}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
