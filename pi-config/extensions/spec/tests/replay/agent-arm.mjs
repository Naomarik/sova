#!/usr/bin/env node
// The agent arm: headless pi agents read the pinned spec through one tool tree, and we grade what they read.
// Opt-in and non-deterministic, so it is never part of `node --test replay.test.mjs` or of run.mjs's exit code.
//
//   node agent-arm.mjs run   --tree <extensions dir> --arm packet|pull --model <provider/id:thinking> --out <dir>
//                            [--comparisons C01,C05,…|sample|all] [--concurrency N] [--timeout-min M] [--pi <bin>]
//                            [--work <dir>] [--extension <dir>]… [--pinned <dir holding .sova/spec>] [--dry-run]
//   node agent-arm.mjs grade --out <dir>      grade every finished run under <dir> again (no agent is started)
//   node agent-arm.mjs compare --baseline <packet run dir> --candidate <run dir>   M2: against the agent packet arm
//
// Each comparison gets a work directory holding only the pinned `.sova/spec` (manifest and claims; its vendored
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA, extractPinned } from "./pinned.mjs";
import { specIndex, scoreNeed, proseTexts, median, pool } from "./fullness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(readFileSync(join(HERE, "data/g-baseline.json"), "utf8"));
/** 8 of the 24, one or two per kind, small and large packets alike. */
export const SAMPLE = ["C01", "C05", "C07", "C10", "C14", "C17", "C19", "C22"];
/** The operator's allowed models, and how many runs each provider may have at once. */
const ALLOWED = [/^zai\/glm-5\.3(-flash|-highspeed)?(:[a-z]+)?$/, /^ollama-cloud\/deepseek-v4\.1-flash(:(low|medium))?$/];
const PROVIDER_CAP = { zai: 2, "ollama-cloud": 3 };

const TOOLS_LINE = {
  packet: (seed) => [
    `  node tools/sova-spec.mjs packet '${seed}' --root . --json`,
    "    (the promise and everything it depends on, in pages; follow \"next\" with --cursor <token>, same id)",
  ],
  pull: (seed) => [
    `  node tools/sova-spec.mjs toc '<§id>' --dir out|in|down|up|mentions --root . --json`,
    "    (a contents view: one line per neighbouring promise, saying what it is, why it is linked and its size;",
    "     out = what it depends on, in = what depends on it, down = what is inside it, up = its parent, mentions = prose naming it)",
    `  node tools/sova-spec.mjs read '<§id>' --root . --json     (one promise's exact text; add --whole for a whole H1)`,
    `  Start with toc on ${seed}, then open only what the work needs.`,
  ],
};

/** The prompt: the same words for every arm except the tool lines. */
export function prompt(c, arm) {
  return [
    `You are about to change one part of a product called Sova: "${c.title}", whose spec id is ${c.seed}.`,
    "Before any code, find out from the product's spec what a builder of this part must know: the promises it",
    "must keep, the exact names, states, shapes and messages involved, the neighbouring promises it could break,",
    "and what is not its job or not decided.",
    "",
    "The spec is in .sova/spec. Read it only through these commands, run from this directory:",
    ...TOOLS_LINE[arm](c.seed),
    "",
    "Do not open files directly and do not leave this directory. Stop reading when you have what a builder needs.",
    "Then reply with a brief of at most 25 bullet points: the facts you will rely on, each with the § id it came from.",
  ].join("\n");
}

/** A work directory holding only the pinned spec (manifest and claims) and the tool tree's spec/core. */
function workDir(base, tree, pinnedRoot) {
  mkdirSync(base, { recursive: true });
  cpSync(join(pinnedRoot, ".sova/spec/manifest.json"), join(base, ".sova/spec/manifest.json"));
  cpSync(join(pinnedRoot, ".sova/spec/claims"), join(base, ".sova/spec/claims"), { recursive: true });
  cpSync(join(tree, "spec/core"), join(base, "tools"), { recursive: true });
  return base;
}

const agentDir = () => {
  const d = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
  return d.startsWith("~") ? join(homedir(), d.slice(1)) : d;
};

/** One pi run; resolves when it exits or times out. */
function runPi({ pi, model, work, sessions, extensions, text, events, stderr, timeoutMs }) {
  const args = ["-p", "--mode", "json", "--no-extensions", ...extensions.flatMap((e) => ["-e", e]), "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-approve", "--model", model, "--tools", "bash,read", "--session-dir", sessions, text];
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
  const paths = call.tool === "read" ? [cmd] : [...cmd.matchAll(/(?:^|[\s'"=(<>])((?:~|\.\.)?\/[\w.-]+(?:\/[\w.-]+)+)/g)].map((m) => m[1]);
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

/** Grade one finished run against the pinned index. */
export function grade(index, c, events, workRoot) {
  const { calls, usage, final } = readEvents(events);
  const fragments = [], spans = [], seenLines = new Set(), footerNamed = new Set(), access = { outside: [], directSpec: [], scratch: [] };
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
    for (const j of jsonsIn(text)) {
      if (!j || typeof j !== "object") continue;
      for (const it of j.items ?? []) if (typeof it?.text === "string" && typeof it.id === "string") fragments.push({ id: it.id, start: it.fragment?.start ?? 0, text: it.text });
      for (const l of j.lines ?? []) if (typeof l?.id === "string") seenLines.add(l.id);
      for (const id of j.footer?.named ?? []) footerNamed.add(id);
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
  const lost = (base?.values ?? []).map((v, i) => (v > 0 && needs[i].value < v && !(base.passageOf[i] && (seenLines.has(base.passageOf[i]) || footerNamed.has(base.passageOf[i])))) ? `${i} ${c.needs[i].need}` : null).filter(Boolean);
  return {
    answered: scored.reduce((s, x) => s + x.value, 0), of: scored.length, named: scored.filter((x) => x.named).length,
    needs: needs.map((x) => (x.status === "missed" && x.named ? "named" : x.status)).join(" "), values: needs.map((x) => x.value), shown: [...new Set([...seenLines, ...footerNamed])].sort(),
    bytes, calls: calls.length, toolErrors: calls.filter((x) => x.result?.isError).length, passagesRead: delivered.size, contentsLines: seenLines.size,
    outside: access.outside, directSpec: access.directSpec, scratch: access.scratch, usage, lostVsPacket: lost, final,
  };
}

function parseArgs(argv) {
  const o = { extension: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
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
  const meta = { runId, arm: o.arm, model: o.model, tree, treeSource: readSource(tree), pinned: DATA.pinned, comparisons: ids, concurrency, timeoutMin: Number(o["timeout-min"] ?? 20), extensions, pi: o.pi ?? "pi", started: new Date().toISOString(), dryRun: Boolean(o.dryRun) };
  writeFileSync(join(out, "run.json"), JSON.stringify(meta, null, 2) + "\n");
  await pool(comps, concurrency, async (c) => {
    const dir = join(out, c.id);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const work = workDir(join(workBase, c.id), tree, pinnedRoot);
    const text = prompt(c, o.arm);
    writeFileSync(join(dir, "prompt.txt"), text + "\n");
    if (o.dryRun) { writeFileSync(join(dir, "dry-run.json"), JSON.stringify({ work, cwdFiles: readdirSync(work).sort() }, null, 2) + "\n"); return; }
    const r = await runPi({ pi: meta.pi, model: o.model, work, sessions: join(dir, "sessions"), extensions, text, events: join(dir, "events.jsonl"), stderr: join(dir, "stderr.txt"), timeoutMs: meta.timeoutMin * 60_000 });
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ ...r, work }, null, 2) + "\n");
    console.error(`${c.id}: exit ${r.code}${r.signal ? ` (${r.signal})` : ""} in ${Math.round(r.ms / 1000)} s`);
  });
  if (!o.dryRun) gradeDir(out, index);
  console.log(out);
}

const readSource = (tree) => { try { return JSON.parse(readFileSync(join(tree, "../../replay-source.json"), "utf8")); } catch { return null; } };

/** Grade every comparison of one run directory; writes agent-scorecard.json and summary.txt. */
export function gradeDir(out, index) {
  const meta = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
  const rows = [];
  for (const id of meta.comparisons) {
    const c = DATA.comparisons.find((x) => x.id === id);
    const file = join(out, id, "events.jsonl");
    if (!existsSync(file)) { rows.push({ id, missing: true }); continue; }
    const exit = existsSync(join(out, id, "exit.json")) ? JSON.parse(readFileSync(join(out, id, "exit.json"), "utf8")) : {};
    rows.push({ id, exit: exit.code ?? null, signal: exit.signal ?? null, seconds: exit.ms ? Math.round(exit.ms / 1000) : null, ...grade(index, c, readFileSync(file, "utf8"), exit.work) });
  }
  const done = rows.filter((r) => !r.missing);
  const packet = Object.fromEntries(DATA.comparisons.map((c) => [c.id, BASELINE.comparisons[c.id].values.reduce((s, v) => s + v, 0)]));
  const total = {
    answered: done.reduce((s, r) => s + r.answered, 0), of: done.reduce((s, r) => s + r.of, 0), packetAnswered: done.reduce((s, r) => s + packet[r.id], 0),
    bytesMedian: median(done.map((r) => r.bytes)), callsMedian: median(done.map((r) => r.calls)), callsMax: Math.max(0, ...done.map((r) => r.calls)),
    lostVsPacket: done.reduce((s, r) => s + r.lostVsPacket.length, 0), outside: done.reduce((s, r) => s + r.outside.length, 0),
    directSpec: done.reduce((s, r) => s + (r.directSpec?.length ?? 0), 0), scratch: done.reduce((s, r) => s + (r.scratch?.length ?? 0), 0),
  };
  const card = { arm: meta.arm, model: meta.model, tree: meta.treeSource ?? meta.tree, pinned: meta.pinned, runId: meta.runId, total, rows };
  writeFileSync(join(out, "agent-scorecard.json"), JSON.stringify(card, null, 2) + "\n");
  const lines = [`agent arm: ${meta.arm} · model ${meta.model} · tree ${meta.treeSource ? `${meta.treeSource.ref} @ ${meta.treeSource.commit.slice(0, 12)}` : meta.tree}`, ""];
  for (const r of rows) lines.push(r.missing ? `  ${r.id}  (no events)` : `  ${r.id}  answered ${r.answered}/${r.of} (packet ${packet[r.id]})  bytes ${r.bytes}  calls ${r.calls}  read ${r.passagesRead}  lines ${r.contentsLines}  lost-vs-packet ${r.lostVsPacket.length}  outside ${r.outside.length}  direct-spec ${r.directSpec.length}  scratch ${r.scratch.length}  exit ${r.exit}${r.signal ? ` ${r.signal}` : ""}`);
  lines.push("", `total answered ${total.answered}/${total.of} (packet ${total.packetAnswered}); median bytes ${total.bytesMedian}; median calls ${total.callsMedian} (max ${total.callsMax}); lost vs packet, unshown: ${total.lostVsPacket}; outside: ${total.outside}; direct spec reads: ${total.directSpec}; scratch files: ${total.scratch}`);
  writeFileSync(join(out, "summary.txt"), lines.join("\n") + "\n");
  return card;
}

/**
 * M2's comparison: a candidate run against the AGENT packet arm on the same comparisons, model and level. A need
 * the agent packet arm answered is lost when the candidate scores lower and never saw its passage in a toc line or a
 * footer. Both packet numbers (agent and computed) are reported.
 */
export function compareRuns(baseDir, candDir) {
  const base = JSON.parse(readFileSync(join(baseDir, "agent-scorecard.json"), "utf8"));
  const cand = JSON.parse(readFileSync(join(candDir, "agent-scorecard.json"), "utf8"));
  if (base.model !== cand.model) throw new Error(`models differ: ${base.model} vs ${cand.model}; compare only at one model and level`);
  const rows = [], lost = [];
  for (const r of cand.rows.filter((x) => !x.missing)) {
    const b = base.rows.find((x) => x.id === r.id && !x.missing);
    if (!b) { rows.push({ id: r.id, missing: "baseline" }); continue; }
    const c = DATA.comparisons.find((x) => x.id === r.id);
    const passageOf = BASELINE.comparisons[r.id].passageOf;
    (b.values ?? []).forEach((v, i) => { if (v > 0 && (r.values?.[i] ?? 0) < v && !(r.shown ?? []).includes(passageOf[i])) lost.push(`${r.id}:${i} ${c.needs[i].need}`); });
    rows.push({ id: r.id, answered: r.answered, agentPacket: b.answered, computedPacket: BASELINE.comparisons[r.id].values.reduce((s, v) => s + v, 0), bytes: r.bytes, packetBytes: b.bytes, calls: r.calls, packetCalls: b.calls });
  }
  const sum = (k) => rows.reduce((s, x) => s + (x[k] ?? 0), 0);
  return { baseline: base.runId, candidate: cand.runId, model: cand.model, total: { answered: sum("answered"), agentPacket: sum("agentPacket"), computedPacket: sum("computedPacket"), lostUnseen: lost.length, bytesMedian: median(rows.map((x) => x.bytes)), packetBytesMedian: median(rows.map((x) => x.packetBytes)), callsMax: Math.max(0, ...rows.map((x) => x.calls ?? 0)) }, lost, rows };
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
      const index = specIndex(o.pinned ? resolve(o.pinned) : extractPinned(scratch));
      console.log(JSON.stringify(gradeDir(resolve(o.out), index).total));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    return;
  }
  throw new Error("usage: node agent-arm.mjs run --tree <dir> --arm packet|pull --model <m> --out <dir> [...] | grade --out <run dir>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(2); });
}
