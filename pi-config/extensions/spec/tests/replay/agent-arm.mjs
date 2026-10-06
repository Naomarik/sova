#!/usr/bin/env node
// The agent arm: headless pi agents read the pinned spec through one tool tree, and we grade what they read.
// Opt-in and non-deterministic, so it is never part of `node --test replay.test.mjs` or of run.mjs's exit code.
//
//   node agent-arm.mjs run   --tree <extensions dir> --arm packet|pull --model <provider/id:thinking> --out <dir>
//                            [--comparisons C01,C05,…|sample|all] [--concurrency N] [--timeout-min M] [--pi <bin>]
//                            [--work <dir>] [--extension <dir>]… [--pinned <dir holding .sova/spec> [--spec-label <name>]] [--dry-run]
//                            [--instructions <file> | --no-instructions]   default: the tree's mode/spec-mode.md
//   node agent-arm.mjs grade --out <dir>      grade every finished run under <dir> again (no agent is started)
//   node agent-arm.mjs compare --baseline <packet run dir> --candidate <run dir>   M2: against the agent packet arm
//
// Each comparison gets a work directory holding only the arm's spec, `--pinned` or the pinned a95768b7 one (manifest
// and claims, also kept in <out>/<run>/spec and hashed in run.json, so grading always uses the spec the arm read; its vendored
// tools and docs removed) and `tools/` (the tree's spec/core), outside any repository. pi runs there with
// `-p --mode json`, no discovered extensions, context files, skills or prompt templates, and only the extensions
// given with --extension (default: provider-limits and llm-inflight from the pi agent directory, which every run
// must load). Every event goes to <out>/<run>/<Cxx>/events.jsonl and the session to its sessions/ dir. Grading
// reads the tool results the agent saw: a passage counts as read when its exact text came back (a packet or read
// item, joined across fragments, or verbatim output of a file read); a file read by line range counts those
// lines. Needs are scored like scenario g; bytes are the tool-result bytes the agent received; calls are tool
// calls; contents lines are the toc lines it saw. The guard, reported but never an exit code: no need the
// recorded packet baseline answers is lost unless the agent saw its passage in a toc line or a footer.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, extractPinned } from "./pinned.mjs";
import { specIndex, scoreNeed, proseTexts, median, pool } from "./fullness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(HERE, "data/g-baseline.json"), "utf8"));
/** What graded a scorecard: a hash of the grading code and data (compare refuses a mismatch), and the harness commit for the record. */
const GRADER_FILES = ["agent-arm.mjs", "fullness.mjs", "pinned.mjs", "data/comparisons.json", "data/g-baseline.json"];
export function graderId() {
  const h = createHash("sha256");
  for (const f of GRADER_FILES) h.update(`${f}\0`).update(readFileSync(join(HERE, f))).update("\0");
  const git = spawnSync("git", ["-C", HERE, "rev-parse", "HEAD"], { encoding: "utf8" });
  const dirty = spawnSync("git", ["-C", HERE, "status", "--porcelain", "--", ...GRADER_FILES], { encoding: "utf8" });
  return { sha256: h.digest("hex").slice(0, 16), commit: git.status === 0 ? git.stdout.trim() : null, dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null };
}
/** 8 of the 24, one or two per kind, small and large packets alike. */
export const SAMPLE = ["C01", "C05", "C07", "C10", "C14", "C17", "C19", "C22"];
/** The operator's allowed models, and how many runs each provider may have at once. */
export const ALLOWED = [/^zai\/glm-5\.3(-flash|-highspeed)?(:[a-z]+)?$/, /^ollama-cloud\/deepseek-v4\.1-flash(:(low|medium))?$/];
export const PROVIDER_CAP = { zai: 2, "ollama-cloud": 3 };

/** Recorded in run.json and the scorecard; compare refuses two runs told different things. */
export const PROMPT_VERSION = "neutral-1";
/**
 * Not measured by the agent arm, and why; compare reports it so a gate never counts it as held. The agent edits
 * nothing and works outside any repository, where `census --changed` refuses (`not-git`, exit 2): a guard over
 * the claims it lists would hold for an agent that read nothing.
 */
export const NOT_MEASURED = ["every census --changed claim read: the agent arm makes no edits and its work directory is in no repository (census --changed refuses: not-git, exit 2), so the guard would hold vacuously; dropped from M2's report"];

/**
 * The task prompt: the same words in every arm. It names no command and no reading strategy, so how the agent
 * reads comes only from the instructions (the tree's own mode/spec-mode.md); `arm` is a label for the run.
 */
export function prompt(c) {
  return [
    `You are about to change one part of a product called Sova: "${c.title}", whose spec id is ${c.seed}.`,
    "Before any code, find out from the product's spec what a builder of this part must know: the promises it",
    "must keep, the exact names, states, shapes and messages involved, the neighbouring promises it could break,",
    "and what is not its job or not decided.",
    "",
    "The spec is in .sova/spec. Read it only through the spec tools, run from this directory as",
    "`node tools/sova-spec.mjs <command> … --root .`; your instructions say which commands to use.",
    "",
    "Do not open files directly and do not leave this directory. Stop reading when you have what a builder needs.",
    "Then reply with a brief of at most 25 bullet points: the facts you will rely on, each with the § id it came from.",
  ].join("\n");
}

/** A hash of a spec's manifest and claims (what the agent reads), so a run is always graded against the spec it read. */
export function specHash(root) {
  const h = createHash("sha256"), dir = join(root, ".sova/spec");
  h.update(readFileSync(join(dir, "manifest.json")));
  const walk = (d, rel = "") => readdirSync(join(d, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => (e.isDirectory() ? walk(d, join(rel, e.name)) : [join(rel, e.name)]));
  for (const f of walk(join(dir, "claims"))) h.update(`\0${f}\0`).update(readFileSync(join(dir, "claims", f)));
  return h.digest("hex").slice(0, 16);
}

/** The spec a run read, kept in its run directory (manifest and claims), so re-grading never depends on where it came from. */
export function snapshotSpec(root, dest) {
  cpSync(join(root, ".sova/spec/manifest.json"), join(dest, ".sova/spec/manifest.json"));
  cpSync(join(root, ".sova/spec/claims"), join(dest, ".sova/spec/claims"), { recursive: true });
  return dest;
}

/**
 * The spec root to grade a run against: the snapshot in the run directory (checked against the hash run.json
 * recorded), or, for a run made before per-arm specs, the pinned a95768b7 spec extracted into `scratch`.
 */
export function runSpecRoot(out, meta, scratch) {
  if (meta.spec?.snapshot) {
    const root = join(out, meta.spec.snapshot);
    if (specHash(root) !== meta.spec.sha256) throw new Error(`${root}: the spec snapshot no longer matches the hash run.json recorded`);
    return root;
  }
  return extractPinned(scratch);
}

/** A work directory holding only the pinned spec (manifest and claims) and the tool tree's spec/core. */
export function workDir(base, tree, pinnedRoot) {
  mkdirSync(base, { recursive: true });
  cpSync(join(pinnedRoot, ".sova/spec/manifest.json"), join(base, ".sova/spec/manifest.json"));
  cpSync(join(pinnedRoot, ".sova/spec/claims"), join(base, ".sova/spec/claims"), { recursive: true });
  cpSync(join(tree, "spec/core"), join(base, "tools"), { recursive: true });
  // The docs the instructions point at as `$core/../X.md` (tools/../X.md), so every path they name exists here.
  for (const doc of ["PROMOTE.md", "README.md", "DRAFTS.md"]) if (existsSync(join(tree, "spec", doc))) cpSync(join(tree, "spec", doc), join(base, doc));
  return base;
}

/**
 * The instructions the agent gets: the tree under test's spec-mode text (`<tree>/mode/spec-mode.md`), or `--instructions
 * <file>` to experiment, or none with `--no-instructions`. Adapted only mechanically, the same in every arm: the
 * trusted-core line resolves to the work directory's `tools/`. → { source, sha256, adaptedSha256, text } | null
 */
export function instructionsFor(tree, o = {}) {
  if (o.noInstructions) return null;
  const source = o.instructions ? resolve(o.instructions) : join(tree, "mode/spec-mode.md");
  if (!existsSync(source)) { if (o.instructions) throw new Error(`instructions ${source} not found`); return null; }
  const raw = readFileSync(source, "utf8");
  const text = raw.replace(/^core=.*\/extensions\/spec\/core"\s*$/m, 'core="$PWD/tools"');
  if (text === raw && /^core=/m.test(raw)) throw new Error("the instructions' core= line has an unexpected form; adapt the harness, not the text");
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  return { source: o.instructions ? source : "<tree>/mode/spec-mode.md", sha256: sha(raw), adaptedSha256: sha(text), text };
}

/** Everything an agent is told for comparison `c` on `tree`: the task prompt and the instructions. */
export function agentInput(c, tree, o = {}) {
  return { prompt: prompt(c), instructions: instructionsFor(tree, o)?.text ?? null };
}

export const agentDir = () => {
  const d = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
  return d.startsWith("~") ? join(homedir(), d.slice(1)) : d;
};

/** One pi run; resolves when it exits or times out. */
export function runPi({ pi, model, work, sessions, extensions, text, instructions, events, stderr, timeoutMs }) {
  const args = ["-p", "--mode", "json", "--no-extensions", ...extensions.flatMap((e) => ["-e", e]), "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-approve", ...(instructions ? ["--append-system-prompt", instructions] : []), "--model", model, "--tools", "bash,read", "--session-dir", sessions, text];
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(pi, args, { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      writeFileSync(events, Buffer.concat(out));
      writeFileSync(stderr, Buffer.concat(err));
      done({ code, signal, ms: Date.now() - started, args: args.slice(0, -1) });
    });
  });
}

/** What the agent saw, from its event stream. */
export function readEvents(text) {
  const calls = [], results = new Map();
  let usage = null, final = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "tool_execution_start") calls.push({ id: e.toolCallId, tool: e.toolName, args: e.args });
    if (e.type === "tool_execution_end") results.set(e.toolCallId, { isError: e.isError, text: (e.result?.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n") });
    if (e.type === "message_end" && e.message?.role === "assistant") {
      if (e.message.usage) usage = addUsage(usage, e.message.usage);
      const t = (e.message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
      if (t.trim()) final = t;
    }
  }
  return { calls: calls.map((c) => ({ ...c, result: results.get(c.id) ?? null })), usage, final };
}
function addUsage(a, u) {
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(u)) if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Every JSON object in a tool result (the whole text, or one per line). */
function jsonsIn(text) {
  try { return [JSON.parse(text)]; } catch { /* not one document */ }
  return text.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/**
 * What one call reached besides the tools (GRADING.md, "Reaching around the tools"): `directSpec` opens spec files
 * without the tools; `scratch` is the agent's own temp files (where it saved tool output); `outside` is any other path
 * out of the work directory. Paths are words with at least two segments starting at `/`, `~/` or `../`.
 */
export function accessesOf(call, cmd, workRoot) {
  const out = [];
  const what = cmd.replace(/\s+/g, " ").slice(0, 160);
  if (/\.sova\/spec\//.test(cmd) && !(call.tool === "bash" && /^\s*node tools\/sova-spec\.mjs\b/.test(cmd) && !/[|;&]/.test(cmd))) out.push({ kind: "directSpec", what });
  // `where` and `map` take a path or a name to look up, not a file to open: their arguments (up to a shell
  // separator, a redirect or the end of the line) are dropped before looking for paths. `--root` and `--spec` name
  // a directory the tool reads, so their values are still scanned.
  const scan = cmd.replace(/(sova-spec\.mjs["']?[ \t]+["']?(?:where|map)\b["']?)(?:[ \t]+(?!--(?:root|spec)\b)(?:'[^'\n]*'|"[^"\n]*"|[^\s;&|<>'"]+))*/g, "$1");
  const paths = call.tool === "read" ? [cmd] : [...scan.matchAll(/(?:^|[\s'"=(<>])((?:~|\.\.)?\/[\w.-]+(?:\/[\w.-]+)+)/g)].map((m) => m[1]);
  for (const p of paths) {
    const abs = p.startsWith("~") ? p : resolve(workRoot ?? "/work", p);
    if (workRoot && (abs === workRoot || abs.startsWith(`${workRoot}/`))) continue;
    if (!workRoot && !p.startsWith("/") && !p.startsWith("~") && !p.startsWith("..")) continue;
    if (/^\/dev\//.test(abs)) continue; // /dev/null and the like are no read
    if (/^\/tmp\/|^\/var\/tmp\//.test(abs) || (process.env.TMPDIR && abs.startsWith(process.env.TMPDIR))) out.push({ kind: "scratch", what });
    else out.push({ kind: "outside", what });
    break;
  }
  return out;
}

/**
 * The recorded passage `id` (an id of the record's spec, `recordIndex`) on another spec (`index`): the same id if it is
 * there; else the passage whose body lines (heading left out) match at least half of the recorded passage's, so a renamed
 * or moved passage is followed by its text; else null.
 */
export function relocate(recordIndex, index, id) {
  if (!id || index.passages.has(id)) return id ?? null;
  const p = recordIndex?.passages.get(id);
  if (!p) return null;
  const bodyOf = (t) => t.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  const body = new Set(bodyOf(p.text));
  if (!body.size) return null;
  let best = null, score = 0;
  for (const q of index.passages.values()) {
    const lines = bodyOf(q.text), k = lines.filter((l) => body.has(l)).length, sc = k / Math.max(body.size, lines.length);
    if (sc > score) { score = sc; best = q.id; }
  }
  return score >= 0.5 ? best : null;
}

/** Grade one finished run against its spec's index (`recordIndex`: the record's spec, to follow renamed passages). */
export function grade(index, c, events, workRoot, recordIndex = index) {
  const { calls, usage, final } = readEvents(events);
  const fragments = [], spans = [], seenLines = new Set(), mapLines = new Set(), footerNamed = new Set(), access = { outside: [], directSpec: [], scratch: [] };
  let bytes = 0;
  const claimsRel = (p) => {
    const abs = resolve(workRoot ?? "/", p);
    const m = /\.sova\/spec\/claims\/(.+\.md)$/.exec(abs);
    return m ? m[1] : null;
  };
  for (const call of calls) {
    const text = call.result?.text ?? "";
    bytes += Buffer.byteLength(text);
    const cmd = call.tool === "bash" ? String(call.args?.command ?? "") : String(call.args?.path ?? "");
    for (const a of accessesOf(call, cmd, workRoot)) access[a.kind].push(a.what);
    const jsons = jsonsIn(text).filter((j) => j && typeof j === "object");
    for (const j of jsons) {
      // read's first page carries the frame (core records) beside its items; both arrive as passages.
      for (const it of [...(j.items ?? []), ...(j.frame?.items ?? [])]) if (typeof it?.text === "string" && typeof it.id === "string") fragments.push({ id: it.id, start: it.fragment?.start ?? 0, text: it.text });
      // map (and where) list every area on one page: a line there is not a sighting of the passage (reported apart).
      for (const l of j.lines ?? []) if (typeof l?.id === "string") (j.command === "map" || j.command === "where" ? mapLines : seenLines).add(l.id);
      for (const id of [...(j.footer?.named ?? []), ...(j.footer?.about ?? [])]) if (typeof id === "string") footerNamed.add(id);
    }
    // The readable (text) forms of toc and read: contents lines and the footer's named ids. Passage text in
    // text mode is verbatim, so the raw-text check below finds it.
    if (!jsons.length && call.tool === "bash" && /sova-spec\.mjs["']?\s+["']?(?:toc|read)\b/.test(cmd)) {
      for (const m of text.matchAll(/^ {2}(§[^\s,]+) — /gm)) seenLines.add(m[1]);
      for (const m of text.matchAll(/^(?:named here|notes about it), not delivered by this (?:call|read): (.+)$/gm)) for (const id of m[1].match(/§[^\s,]+/g) ?? []) footerNamed.add(id);
    }
    // A claims file read by the read tool: the lines it returned.
    if (call.tool === "read" && claimsRel(cmd)) {
      const from = Number(call.args?.offset ?? 1), n = text.replace(/\n\n\[(Showing lines|\d+ more lines)[^\]]*\]$/, "").split("\n").length;
      spans.push({ rel: claimsRel(cmd), from, to: from + n - 1 });
    }
  }
  // Packet and read items, fragments joined in order; a passage counts only when its exact text arrived.
  const joined = new Map();
  for (const f of [...fragments].sort((a, b) => (a.id === b.id ? a.start - b.start : 0))) {
    const parts = joined.get(f.id) ?? new Map();
    parts.set(f.start, f.text);
    joined.set(f.id, parts);
  }
  const delivered = new Set();
  for (const [id, parts] of joined) {
    const text = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t).join("");
    if (index.passages.get(id)?.text === text) delivered.add(id);
  }
  // Verbatim passage text in any other output (cat, sed, the read tool).
  const raw = calls.map((x) => x.result?.text ?? "").join("\n");
  for (const p of index.passages.values()) if (!delivered.has(p.id) && p.bytes > 40 && raw.includes(p.text.trimEnd())) delivered.add(p.id);
  const named = new Set([...seenLines, ...footerNamed].filter((id) => !delivered.has(id)));
  const needs = c.needs.map((n) => scoreNeed(index, n, delivered, named, spans));
  const scored = needs.filter((x) => x.status !== "n/a");
  const base = BASELINE.comparisons[c.id];
  // Where the recorded packet arm answered each need, followed onto this run's spec (the same id, or the passage holding
  // its text when the id is gone); only when neither exists, where the need's probe or anchor lands in this spec.
  const where = (i) => relocate(recordIndex, index, base?.passageOf[i]) ?? needs[i].passage ?? null;
  // A verdict whose quoted line this spec lacks (unanchored) is listed apart for a re-verdict, never counted lost (as in g).
  const lost = (base?.values ?? []).map((v, i) => (v > 0 && needs[i].status !== "unanchored" && needs[i].value < v && !(where(i) && (seenLines.has(where(i)) || footerNamed.has(where(i))))) ? `${i} ${c.needs[i].need}` : null).filter(Boolean);
  const textOf = (p) => (p && index.passages.has(p) ? createHash("sha256").update(index.passages.get(p).text).digest("hex").slice(0, 12) : null);
  return {
    answered: scored.reduce((s, x) => s + x.value, 0), of: scored.length, named: scored.filter((x) => x.named).length,
    needs: needs.map((x) => (x.status === "missed" && x.named ? "named" : x.status)).join(" "), values: needs.map((x) => x.value), passageOf: needs.map((x) => x.passage ?? null), whereOf: needs.map((_, i) => where(i)), textOf: needs.map((x) => textOf(x.passage)), unanchored: needs.map((x, i) => (x.status === "unanchored" ? i : null)).filter((i) => i !== null), shown: [...new Set([...seenLines, ...footerNamed])].sort(), mapShown: [...mapLines].filter((id) => !seenLines.has(id) && !footerNamed.has(id)).sort(),
    bytes, calls: calls.length, toolErrors: calls.filter((x) => x.result?.isError).length, passagesRead: delivered.size, contentsLines: seenLines.size,
    outside: access.outside, directSpec: access.directSpec, scratch: access.scratch, usage, lostVsPacket: lost, final,
  };
}

export function parseArgs(argv) {
  const o = { extension: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--no-instructions") o.noInstructions = true;
    else if (a === "--extension") o.extension.push(argv[++i]);
    else if (a.startsWith("--") && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else (o._ ??= []).push(a);
  }
  return o;
}

async function cmdRun(o) {
  for (const k of ["tree", "arm", "model", "out"]) if (!o[k]) throw new Error(`run needs --${k}`);
  if (!["packet", "pull"].includes(o.arm)) throw new Error("--arm is packet or pull");
  if (!ALLOWED.some((re) => re.test(o.model))) throw new Error(`model ${o.model} is not on the allowed list (zai/glm-5.3[-flash|-highspeed][:level], ollama-cloud/deepseek-v4.1-flash[:low|medium])`);
  const provider = o.model.split("/")[0];
  const cap = PROVIDER_CAP[provider];
  const concurrency = Math.min(Number(o.concurrency ?? cap), cap);
  const tree = realpathSync(resolve(o.tree));
  if (!existsSync(join(tree, "spec/core/sova-spec.mjs"))) throw new Error(`${o.tree} is not an extensions tree`);
  const extensions = o.extension.length ? o.extension.map((e) => resolve(e)) : ["provider-limits", "llm-inflight"].map((n) => join(agentDir(), "extensions", n));
  if (!extensions.some((e) => /provider-limits/.test(e))) throw new Error("every run loads provider-limits (--extension <dir>)");
  for (const e of extensions) if (!existsSync(e)) throw new Error(`extension ${e} not found`);
  const ids = !o.comparisons || o.comparisons === "sample" ? SAMPLE : o.comparisons === "all" ? DATA.comparisons.map((c) => c.id) : o.comparisons.split(",");
  const comps = ids.map((id) => DATA.comparisons.find((c) => c.id === id) ?? (() => { throw new Error(`no comparison ${id}`); })());
  const runId = `${o.arm}-${o.model.replace(/[/:]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const out = resolve(o.out, runId);
  const workBase = resolve(o.work ?? join(tmpdir(), `spec-agent-arm-${runId}`));
  mkdirSync(out, { recursive: true });
  const pinnedDir = join(workBase, "pinned");
  mkdirSync(pinnedDir, { recursive: true });
  const pinnedRoot = o.pinned ? resolve(o.pinned) : extractPinned(pinnedDir);
  const index = specIndex(pinnedRoot);
  const instr = instructionsFor(tree, o);
  if (instr) writeFileSync(join(out, "instructions.md"), instr.text);
  const meta = { runId, arm: o.arm, model: o.model, prompt: PROMPT_VERSION, instructions: instr ? { source: instr.source, sha256: instr.sha256, adaptedSha256: instr.adaptedSha256 } : null, tree, treeSource: readSource(tree), pinned: o.pinned ? null : DATA.pinned, spec: { label: o["spec-label"] ?? (o.pinned ? resolve(o.pinned) : `pinned ${DATA.pinned.rev.slice(0, 8)}`), sha256: specHash(pinnedRoot), snapshot: "spec" }, comparisons: ids, concurrency, timeoutMin: Number(o["timeout-min"] ?? 20), extensions, pi: o.pi ?? "pi", started: new Date().toISOString(), dryRun: Boolean(o.dryRun) };
  snapshotSpec(pinnedRoot, join(out, "spec"));
  writeFileSync(join(out, "run.json"), JSON.stringify(meta, null, 2) + "\n");
  await pool(comps, concurrency, async (c) => {
    const dir = join(out, c.id);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const work = workDir(join(workBase, c.id), tree, pinnedRoot);
    const text = agentInput(c, tree, o).prompt;
    writeFileSync(join(dir, "prompt.txt"), text + "\n");
    if (o.dryRun) { writeFileSync(join(dir, "dry-run.json"), JSON.stringify({ work, cwdFiles: readdirSync(work).sort() }, null, 2) + "\n"); return; }
    const r = await runPi({ pi: meta.pi, model: o.model, work, sessions: join(dir, "sessions"), extensions, text, instructions: instr ? join(out, "instructions.md") : null, events: join(dir, "events.jsonl"), stderr: join(dir, "stderr.txt"), timeoutMs: meta.timeoutMin * 60_000 });
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ ...r, work }, null, 2) + "\n");
    console.error(`${c.id}: exit ${r.code}${r.signal ? ` (${r.signal})` : ""} in ${Math.round(r.ms / 1000)} s`);
  });
  if (!o.dryRun) gradeDir(out, index);
  console.log(out);
}

export const readSource = (tree) => { try { return JSON.parse(readFileSync(join(tree, "../../replay-source.json"), "utf8")); } catch { return null; } };

/** Grade every comparison of one run directory; writes agent-scorecard.json and summary.txt. */
export function gradeDir(out, index, recordIndex = index) {
  const meta = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
  if (!index) {
    const scratch = join(tmpdir(), `spec-agent-grade-${process.pid}-${Date.now()}`);
    mkdirSync(scratch, { recursive: true });
    try {
      mkdirSync(join(scratch, "own"), { recursive: true });
      const own = specIndex(runSpecRoot(out, meta, join(scratch, "own")));
      if (!meta.spec?.snapshot) return gradeDir(out, own, own);
      mkdirSync(join(scratch, "record"), { recursive: true });
      return gradeDir(out, own, specIndex(extractPinned(join(scratch, "record"))));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const rows = [];
  for (const id of meta.comparisons) {
    const c = DATA.comparisons.find((x) => x.id === id);
    const file = join(out, id, "events.jsonl");
    if (!existsSync(file)) { rows.push({ id, missing: true }); continue; }
    const exit = existsSync(join(out, id, "exit.json")) ? JSON.parse(readFileSync(join(out, id, "exit.json"), "utf8")) : {};
    rows.push({ id, exit: exit.code ?? null, signal: exit.signal ?? null, seconds: exit.ms ? Math.round(exit.ms / 1000) : null, ...grade(index, c, readFileSync(file, "utf8"), exit.work, recordIndex) });
  }
  const done = rows.filter((r) => !r.missing);
  const packet = Object.fromEntries(DATA.comparisons.map((c) => [c.id, BASELINE.comparisons[c.id].values.reduce((s, v) => s + v, 0)]));
  const total = {
    answered: done.reduce((s, r) => s + r.answered, 0), of: done.reduce((s, r) => s + r.of, 0), packetAnswered: done.reduce((s, r) => s + packet[r.id], 0),
    bytesMedian: median(done.map((r) => r.bytes)), callsMedian: median(done.map((r) => r.calls)), callsMax: Math.max(0, ...done.map((r) => r.calls)),
    lostVsPacket: done.reduce((s, r) => s + r.lostVsPacket.length, 0), unanchored: done.reduce((s, r) => s + (r.unanchored?.length ?? 0), 0), outside: done.reduce((s, r) => s + r.outside.length, 0),
    directSpec: done.reduce((s, r) => s + (r.directSpec?.length ?? 0), 0), scratch: done.reduce((s, r) => s + (r.scratch?.length ?? 0), 0),
  };
  const card = { arm: meta.arm, model: meta.model, grader: graderId(), prompt: meta.prompt ?? "arm-specific (before neutral-1)", instructions: meta.instructions ?? null, tree: meta.treeSource ?? meta.tree, pinned: meta.pinned, spec: meta.spec ? { label: meta.spec.label, sha256: meta.spec.sha256 } : { label: `pinned ${DATA.pinned.rev.slice(0, 8)} (run made before per-arm specs)` }, runId: meta.runId, total, rows };
  writeFileSync(join(out, "agent-scorecard.json"), JSON.stringify(card, null, 2) + "\n");
  const lines = [`agent arm: ${meta.arm} · model ${meta.model} · spec ${card.spec.label} · tree ${meta.treeSource ? `${meta.treeSource.ref} @ ${meta.treeSource.commit.slice(0, 12)}` : meta.tree}`, ""];
  for (const r of rows) lines.push(r.missing ? `  ${r.id}  (no events)` : `  ${r.id}  answered ${r.answered}/${r.of} (packet ${packet[r.id]})  bytes ${r.bytes}  calls ${r.calls}  read ${r.passagesRead}  lines ${r.contentsLines}  lost-vs-packet ${r.lostVsPacket.length}  outside ${r.outside.length}  direct-spec ${r.directSpec.length}  scratch ${r.scratch.length}  exit ${r.exit}${r.signal ? ` ${r.signal}` : ""}`);
  lines.push("", `total answered ${total.answered}/${total.of} (packet ${total.packetAnswered}); median bytes ${total.bytesMedian}; median calls ${total.callsMedian} (max ${total.callsMax}); lost vs packet, unshown: ${total.lostVsPacket}; unanchored on this spec (re-verdict, not scored as lost): ${total.unanchored}; outside: ${total.outside}; direct spec reads: ${total.directSpec}; scratch files: ${total.scratch}`);
  writeFileSync(join(out, "summary.txt"), lines.join("\n") + "\n");
  return card;
}

/**
 * M2's comparison: a candidate run against the AGENT packet arm on the same comparisons, model and level. A need
 * the agent packet arm answered is lost when the candidate scores lower and never saw its passage in a toc line or a
 * footer (a `map` line is no sighting: such losses are also listed apart, lostSeenOnlyInMap). Both packet numbers (agent
 * and computed) are reported.
 */
export function compareRuns(baseDir, candDir) {
  const base = JSON.parse(readFileSync(join(baseDir, "agent-scorecard.json"), "utf8"));
  const cand = JSON.parse(readFileSync(join(candDir, "agent-scorecard.json"), "utf8"));
  if (base.model !== cand.model) throw new Error(`models differ: ${base.model} vs ${cand.model}; compare only at one model and level`);
  if (Boolean(base.instructions) !== Boolean(cand.instructions)) throw new Error("one run had instructions and the other not; both arms get their own tree's spec-mode text, or neither");
  if (base.prompt !== cand.prompt) throw new Error(`task prompts differ (${base.prompt} vs ${cand.prompt}); re-run both arms at one harness`);
  if (!base.grader?.sha256 || !cand.grader?.sha256 || base.grader.sha256 !== cand.grader.sha256) throw new Error(`graded by different grading code (${base.grader?.sha256 ?? "unrecorded"} vs ${cand.grader?.sha256 ?? "unrecorded"}); re-grade both with \`grade --out\``);
  const rows = [], lost = [], mapOnly = [], moved = [], unconfirmed = [], textChanged = [], unanchored = { baseline: [], candidate: [] };
  for (const r of cand.rows.filter((x) => !x.missing)) {
    const b = base.rows.find((x) => x.id === r.id && !x.missing);
    if (!b) { rows.push({ id: r.id, missing: "baseline" }); continue; }
    const c = DATA.comparisons.find((x) => x.id === r.id);
    // Each arm is scored on its own spec: the candidate's passage for a need is where it lives in the candidate's spec.
    const passageOf = BASELINE.comparisons[r.id].passageOf;
    const candAt = (i) => r.whereOf?.[i] ?? passageOf[i];
    // A need unanchored on either arm's spec (its verdict's quoted line is gone there) is left out of both arms: listed
    // for a re-verdict, never lost and never in either answered total.
    const out = new Set([...(b.unanchored ?? []), ...(r.unanchored ?? [])]);
    for (const i of b.unanchored ?? []) unanchored.baseline.push(`${r.id}:${i} ${c.needs[i].need}`);
    for (const i of r.unanchored ?? []) unanchored.candidate.push(`${r.id}:${i} ${c.needs[i].need}`);
    (b.values ?? []).forEach((v, i) => {
      if (out.has(i)) return;
      // Answered in both arms: in another passage (a moved answer, kept only if an anchored verdict confirms it there),
      // or in the same passage whose text differs between the two specs (a hand check for probe-only needs).
      if (v > 0 && (r.values?.[i] ?? 0) > 0 && b.passageOf?.[i] && r.passageOf?.[i]) {
        const need = c.needs[i], anchors = need.verdict?.anchors ?? (need.verdict?.anchor ? [need.verdict.anchor] : []);
        if (b.passageOf[i] !== r.passageOf[i]) {
          moved.push(`${r.id}:${i} ${b.passageOf[i]} → ${r.passageOf[i]}`);
          if (!anchors.some((a) => a.passage === r.passageOf[i])) unconfirmed.push(`${r.id}:${i} ${b.passageOf[i]} → ${r.passageOf[i]}`);
        } else if (b.textOf?.[i] && r.textOf?.[i] && b.textOf[i] !== r.textOf[i]) textChanged.push(`${r.id}:${i} ${r.passageOf[i]}${anchors.length ? " (anchored)" : " (probe only)"}`);
      }
      if (!(v > 0 && (r.values?.[i] ?? 0) < v) || (r.shown ?? []).includes(candAt(i))) return;
      lost.push(`${r.id}:${i} ${c.needs[i].need}`);
      if ((r.mapShown ?? []).includes(candAt(i))) mapOnly.push(`${r.id}:${i}`);
    });
    const less = (vals) => [...out].reduce((t, i) => t + (vals?.[i] ?? 0), 0);
    rows.push({ id: r.id, answered: r.answered - less(r.values), agentPacket: b.answered - less(b.values), excluded: [...out].sort((x, y) => x - y), computedPacket: BASELINE.comparisons[r.id].values.reduce((s, v) => s + v, 0), bytes: r.bytes, packetBytes: b.bytes, calls: r.calls, packetCalls: b.calls });
  }
  const sum = (k) => rows.reduce((s, x) => s + (x[k] ?? 0), 0);
  return { baseline: base.runId, candidate: cand.runId, model: cand.model, grader: cand.grader, specs: { baseline: base.spec ?? null, candidate: cand.spec ?? null }, unanchored, moved, movedUnconfirmed: unconfirmed, answerTextChanged: textChanged, total: { answered: sum("answered"), agentPacket: sum("agentPacket"), computedPacket: sum("computedPacket"), lostUnseen: lost.length, bytesMedian: median(rows.map((x) => x.bytes)), packetBytesMedian: median(rows.map((x) => x.packetBytes)), callsMax: Math.max(0, ...rows.map((x) => x.calls ?? 0)), lostSeenOnlyInMap: mapOnly.length, movedUnconfirmed: unconfirmed.length, unanchoredLeftOut: unanchored.baseline.length + unanchored.candidate.length }, notMeasured: NOT_MEASURED, lost, lostSeenOnlyInMap: mapOnly, rows };
}

async function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._?.[0];
  if (cmd === "run") return cmdRun(o);
  if (cmd === "compare") {
    if (!o.baseline || !o.candidate) throw new Error("compare needs --baseline <packet-arm run dir> --candidate <run dir>");
    const card = compareRuns(resolve(o.baseline), resolve(o.candidate));
    writeFileSync(join(resolve(o.candidate), "compare.json"), JSON.stringify(card, null, 2) + "\n");
    console.log(JSON.stringify(card.total));
    return;
  }
  if (cmd === "grade") {
    if (!o.out) throw new Error("grade needs --out <run dir>");
    const scratch = join(tmpdir(), `spec-agent-grade-${process.pid}`);
    mkdirSync(scratch, { recursive: true });
    try {
      // The run's own spec (its snapshot) unless --pinned overrides it on purpose.
      const index = o.pinned ? specIndex(resolve(o.pinned)) : undefined;
      console.log(JSON.stringify(gradeDir(resolve(o.out), index).total));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    return;
  }
  throw new Error("usage: node agent-arm.mjs run --tree <dir> --arm packet|pull --model <m> --out <dir> [...] | grade --out <run dir>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(2); });
}
