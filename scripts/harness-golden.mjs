#!/usr/bin/env node
// The golden harness's commands (server/harness/pi/golden/README.md):
//
//   node scripts/harness-golden.mjs compare [--set <a,b>] [--real]   # = the golden test (pnpm test runs it too)
//   node scripts/harness-golden.mjs record [--accept <probe,…>] [--set <a,b>] [--real]
//   node scripts/harness-golden.mjs census [--extra <dir>]…           # counts of entry types, roles, customTypes
//   node scripts/harness-golden.mjs sample [--out <dir>] [--extra <dir>]… [--seed <n>] [--random <n>] [--cap-mb <n>]
//
// record writes the expected files that are missing; one that exists and differs is rewritten only for a probe
// named by --accept, and only once CHANGES.md (beside golden.test.ts) has a line added since HEAD naming that
// probe. Both run golden.test.ts through scripts/run-tests.mjs, so they see exactly the test's environment.
// --real is the local corpus `sample` wrote (default .agent/golden-real, or SOVA_GOLDEN_REAL_DIR).
//
// census and sample read session files (the agent dir's sessions/ without live/, every sessions/ dir under its
// sova/ state root, and each --extra dir) and only ever open them for reading. census prints counts; sample
// copies up to 3 smallest files per feature, plus --random others (seeded), under --cap-mb, into <out>/sessions
// named by their content's sha256[:12], and writes <out>/report.json with hashes, sizes, features and JSON field
// paths: never a source path or any content. It refuses an output dir git does not ignore.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const TEST = "server/harness/pi/golden/golden.test.ts";
const CHANGES = "server/harness/pi/golden/CHANGES.md";
const DEFAULT_REAL = path.join(ROOT, ".agent/golden-real");
const PI_TYPES = new Set(["session", "message", "model_change", "thinking_level_change", "usage", "compaction", "session_info", "label", "branch_summary", "context_edit", "custom", "custom_message"]);

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const opts = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

function die(message, code = 2) {
  console.error(`[harness-golden] ${message}`);
  process.exit(code);
}

// ---- compare / record ---------------------------------------------------------------------------------

function runGolden(mode) {
  const env = { ...process.env, SOVA_GOLDEN_MODE: mode };
  const accept = opt("--accept", "");
  if (accept) {
    if (mode !== "record") die("--accept goes with record");
    if (!flag("--real")) {
      const added = addedChangeLines();
      for (const probe of accept.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!added.some((l) => new RegExp(`(^|[^\\w-])${probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`).test(l)))
          die(`--accept ${probe}: add a line to ${CHANGES} first (probe, fixture, reason, reviewer); none added since HEAD names it`);
      }
    }
    env.SOVA_GOLDEN_ACCEPT = accept;
  }
  const sets = opt("--set", "");
  if (flag("--real")) {
    const dir = process.env.SOVA_GOLDEN_REAL_DIR ?? DEFAULT_REAL;
    if (!fs.existsSync(path.join(dir, "sessions"))) die(`no real corpus at ${path.relative(ROOT, dir) || dir}/sessions: run sample first`);
    env.SOVA_GOLDEN_SETS = "real";
  } else if (sets) env.SOVA_GOLDEN_SETS = sets;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/run-tests.mjs"), TEST], { cwd: ROOT, stdio: "inherit", env });
  process.exit(r.status ?? 1);
}

/** Lines of CHANGES.md added since HEAD (the whole file when HEAD has none). */
function addedChangeLines() {
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "--no-color", "-U0", "HEAD", "--", CHANGES], { cwd: ROOT, encoding: "utf8" });
  } catch {
    return [];
  }
  if (!diff.trim() && fs.existsSync(path.join(ROOT, CHANGES))) {
    try {
      execFileSync("git", ["cat-file", "-e", `HEAD:${CHANGES}`], { cwd: ROOT, stdio: "ignore" });
      return [];
    } catch {
      return fs.readFileSync(path.join(ROOT, CHANGES), "utf8").split("\n");
    }
  }
  return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

// ---- census / sample: reading session files -------------------------------------------------------------

const agentDir = () => {
  const d = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d;
};

/** Every *.jsonl under `dir` (depth-limited), skipping `skip` dirs. */
function jsonlUnder(dir, depth, skip = new Set()) {
  const out = [];
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth > 0 && !skip.has(p)) out.push(...jsonlUnder(p, depth - 1, skip));
    else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** The session files census and sample read: sessions/ (not live/), sova/**\/sessions/*.jsonl, --extra dirs. */
function sessionFiles() {
  const agent = agentDir();
  const sessions = path.join(agent, "sessions");
  const files = new Set(jsonlUnder(sessions, 3, new Set([path.join(sessions, "live")])));
  const findSessionDirs = (dir, depth) => {
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      if (!d.isDirectory()) continue;
      const p = path.join(dir, d.name);
      if (d.name === "sessions") for (const f of jsonlUnder(p, 0)) files.add(f);
      else if (depth > 0) findSessionDirs(p, depth - 1);
    }
  };
  findSessionDirs(path.join(agent, "sova"), 4);
  for (const extra of opts("--extra")) for (const f of jsonlUnder(path.resolve(extra), 1)) files.add(f);
  return [...files].sort();
}

/** A JSON value's key paths (arrays as `[]`), up to `depth`: the structure, never a value. */
function keyPaths(v, prefix, depth, out) {
  if (depth < 0 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 50)) keyPaths(x, `${prefix}[]`, depth - 1, out);
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    const p = prefix ? `${prefix}.${/^[A-Za-z_$][\w$]*$/.test(k) ? k : "<key>"}` : k;
    out.add(p);
    keyPaths(x, p, depth - 1, out);
  }
}

/** One file's facts: counts by type/role/customType, the sample's features, its field paths. Read-only. */
function factsOf(file) {
  const text = fs.readFileSync(file, "utf8");
  const counts = new Map();
  const features = new Set();
  const paths = new Set();
  const children = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      features.add("malformed-line");
      continue;
    }
    if (!e || typeof e !== "object") {
      features.add("malformed-line");
      continue;
    }
    keyPaths(e, "", 5, paths);
    const type = typeof e.type === "string" ? e.type : "(none)";
    bump(`type:${type}`);
    features.add(`type:${PI_TYPES.has(type) ? type : "(unknown)"}`);
    if (type !== "session" && typeof e.id !== "string") features.add("id-less");
    if (typeof e.parentId === "string") children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
    if (typeof e.customType === "string") {
      bump(`customType:${e.customType}`);
      features.add(`customType:${e.customType}`);
    }
    const m = e.message;
    if (type === "message" && m && typeof m === "object") {
      const role = typeof m.role === "string" ? m.role : "(none)";
      bump(`role:${role}`);
      features.add(`role:${role}`);
      if (role === "assistant") {
        if (m.stopReason === "error" || m.stopReason === "aborted") features.add(`stop:${m.stopReason}`);
        for (const b of Array.isArray(m.content) ? m.content : []) if (b && typeof b.type === "string" && !["text", "thinking", "toolCall"].includes(b.type)) features.add("block:(unknown)");
      }
      if (role === "toolResult" && m.isError === true) features.add("tool-error");
      if (role === "toolResult" && m.toolName === "align") features.add("tool:align");
      if (role === "user" && Array.isArray(m.content) && m.content.some((b) => b?.type === "text" && typeof b.text === "string" && b.text.includes("[Image: original "))) features.add("image-notes");
      if (typeof m.customType === "string") features.add(`customType:${m.customType}`);
    }
  }
  if ([...children.values()].some((n) => n >= 2)) features.add("branched");
  return { counts, features, paths, bytes: Buffer.byteLength(text) };
}

function census() {
  const files = sessionFiles();
  const total = new Map();
  let unreadable = 0;
  for (const f of files) {
    try {
      for (const [k, n] of factsOf(f).counts) total.set(k, (total.get(k) ?? 0) + n);
    } catch {
      unreadable++;
    }
  }
  const sorted = Object.fromEntries([...total.entries()].sort(([a], [b]) => a.localeCompare(b)));
  console.log(JSON.stringify({ files: files.length, unreadable, counts: sorted }, null, 2));
}

/** mulberry32: the seeded draw for the random picks, so a sample can be taken again. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True when git ignores `p` (exit 0 of `git check-ignore -q`); anything else (not ignored, not a repo) is false. */
function gitIgnored(p) {
  const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: ROOT, stdio: "ignore" });
  return r.status === 0;
}

function sample() {
  const out = path.resolve(opt("--out", process.env.SOVA_GOLDEN_REAL_DIR ?? DEFAULT_REAL));
  // Both the dir and a file inside it: a negated rule could un-ignore its contents.
  if (!gitIgnored(out) || !gitIgnored(path.join(out, "sessions", "x.jsonl")))
    die(`refusing ${out}: git does not ignore it (git check-ignore -q). The real corpus must never be committable.`);
  const perFeature = 3;
  const randomCount = Number(opt("--random", "10"));
  const cap = Number(opt("--cap-mb", "300")) * 1024 * 1024;
  const rand = prng(Number(opt("--seed", "1")));

  const files = sessionFiles();
  const facts = new Map();
  for (const f of files) {
    try {
      facts.set(f, factsOf(f));
    } catch {
      // unreadable: not sampled
    }
  }
  const byFeature = new Map();
  for (const [f, x] of facts) for (const feat of x.features) (byFeature.get(feat) ?? byFeature.set(feat, []).get(feat)).push(f);
  const picked = new Map(); // file -> reasons
  let bytes = 0;
  const take = (f, why) => {
    const had = picked.get(f);
    if (had) return void had.add(why);
    const size = facts.get(f).bytes;
    if (bytes + size > cap) return;
    bytes += size;
    picked.set(f, new Set([why]));
  };
  for (const [feat, list] of [...byFeature.entries()].sort(([a], [b]) => a.localeCompare(b)))
    for (const f of list.sort((a, b) => facts.get(a).bytes - facts.get(b).bytes).slice(0, perFeature)) take(f, feat);
  const rest = [...facts.keys()].filter((f) => !picked.has(f));
  for (let i = 0; i < randomCount && rest.length; i++) take(rest.splice(Math.floor(rand() * rest.length), 1)[0], "random");

  // A new sample needs its own expected files, recorded at the branch point: the old ones go.
  fs.rmSync(path.join(out, "sessions"), { recursive: true, force: true });
  fs.rmSync(path.join(out, "expected"), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "sessions"), { recursive: true });
  const entries = [];
  for (const [f, why] of picked) {
    const buf = fs.readFileSync(f);
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
    fs.writeFileSync(path.join(out, "sessions", `${hash}.jsonl`), buf);
    const x = facts.get(f);
    entries.push({ hash, bytes: x.bytes, picked: [...why].sort(), features: [...x.features].sort(), paths: [...x.paths].sort() });
  }
  entries.sort((a, b) => a.hash.localeCompare(b.hash));
  const coverage = Object.fromEntries([...byFeature.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.length]));
  const report = { scanned: files.length, sampled: entries.length, bytes, seed: Number(opt("--seed", "1")), features: coverage, files: entries };
  fs.writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[harness-golden] sampled ${entries.length} of ${files.length} files (${(bytes / 1048576).toFixed(1)} MB) into ${path.relative(ROOT, out) || out}; next: node scripts/harness-golden.mjs record --real`);
}

switch (cmd) {
  case "compare":
    runGolden("compare");
    break;
  case "record":
    runGolden("record");
    break;
  case "census":
    census();
    break;
  case "sample":
    sample();
    break;
  default:
    die("usage: node scripts/harness-golden.mjs compare|record|census|sample (see the header)");
}
