#!/usr/bin/env node
// The rubric arm: the 15-task rubric (data/rubric.json) re-run fresh in two arms by a headless pi agent, then graded
// BLIND by a reader who never learns which arm wrote which answer. Opt-in and non-deterministic, so it is never part
// of `node --test replay.test.mjs` or of run.mjs's exit code; only its blinding is tested.
//
//   node rubric-arm.mjs run     --tree <extensions dir> --arm baseline|candidate --model <provider/id:thinking> --out <dir>
//                               [--tasks 01,05,…|all] [--pinned <dir holding .sova/spec> [--spec-label <name>]] [--concurrency N]
//                               [--timeout-min M] [--pi <bin>] [--work <dir>] [--extension <dir>]… [--dry-run]
//   node rubric-arm.mjs blind   --a <run dir> --b <run dir> --out <dir> [--seed N] [--accept-tells]
//   node rubric-arm.mjs unblind --blind <dir> --scores <grader scores.json> [--out <file>]
//   node rubric-arm.mjs check   --blind <dir>      the grader folder holds no arm label, tool name or trace (exit 1 if it does)
//
// run: each task gets a work directory like the agent arm's (the pinned spec and the tree's spec/core as `tools/`,
// outside any repository) and the tree's own mode/spec-mode.md as instructions. The prompt is the task's wording and
// seeds, the same words in both arms; the arm is only a label in run.json. Recorded per task: events, the final
// answer, (e) bytes = tool-result bytes the agent received, (g) calls = tool calls.
// blind: per task, only the final answer of each run, scrubbed (tool commands, tool names, arm phrases and revision
// ids removed), shuffled as X and Y with a draw from a random seed (or --seed), recorded only in key.json. A list only
// holds what someone thought of, so blind also runs a differential check: any token in at least 3 tasks of one arm's
// briefs and none of the other's goes to tells.json (beside key.json), and blind refuses until a person scrubs it or
// rules it content (--accept-tells). It also refuses runs with different task sets or prompt bytes. The grader gets <out>/grader/ only: the rubric (a-d), the
// task, answers X and Y, and how to reply. The key (which run is X) and every number that could tell the arms apart
// (bytes, calls) stay in <out>/key.json, outside the grader folder.
// unblind: the grader's scores mapped back to the arms, with (e) bytes and (g) calls beside a-d; the old 63/120
// (data/rubric.json `baseline`) is shown for reference only, its subject model unknown.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED, PROVIDER_CAP, workDir, instructionsFor, agentDir, runPi, readEvents, parseArgs, readSource, specHash, accessesOf } from "./agent-arm.mjs";
import { extractPinned } from "./pinned.mjs";
import { pool } from "./fullness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUBRIC = JSON.parse(readFileSync(join(HERE, "data/rubric.json"), "utf8"));
export const RUBRIC_PROMPT_VERSION = "rubric-1";
const SCORED = ["a", "b", "c", "d"];

/** The task prompt: the rubric's wording and seeds, the same in both arms; no command, no reading strategy, no arm. */
export function rubricPrompt(t) {
  return [
    "You are about to make this change to a product called Sova:",
    "",
    t.task,
    "",
    `It starts at the spec id${t.seeds.length > 1 ? "s" : ""} ${t.seeds.join(", ")}.`,
    "Before any code, find out from the product's spec what you must know to make it. The spec is in .sova/spec.",
    "Read it only through the spec tools, run from this directory as `node tools/sova-spec.mjs <command> … --root .`;",
    "your instructions say which commands to use. Do not open files directly and do not leave this directory.",
    "Stop reading when you have what you need. Then reply with a brief of at most 30 bullet points under four headings:",
    "1. Promises the edit must keep.",
    "2. Exact names, states, shapes and messages.",
    "3. Neighbouring promises it could break.",
    "4. What the edit may ignore.",
    "Give the § id each fact came from. Do not describe how you read the spec.",
  ].join("\n");
}

// ---------------------------------------------------------------- run

/** Is `dir` inside a git work tree? A rubric agent must not be (the source and the live spec would be in reach). */
export function insideRepo(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

async function cmdRun(o) {
  for (const k of ["tree", "arm", "model", "out"]) if (!o[k]) throw new Error(`run needs --${k}`);
  if (!["baseline", "candidate"].includes(o.arm)) throw new Error("--arm is baseline or candidate");
  if (!ALLOWED.some((re) => re.test(o.model))) throw new Error(`model ${o.model} is not on the allowed list`);
  const cap = PROVIDER_CAP[o.model.split("/")[0]];
  const concurrency = Math.min(Number(o.concurrency ?? cap), cap);
  const tree = realpathSync(resolve(o.tree));
  if (!existsSync(join(tree, "spec/core/sova-spec.mjs"))) throw new Error(`${o.tree} is not an extensions tree`);
  const extensions = o.extension.length ? o.extension.map((e) => resolve(e)) : ["provider-limits", "llm-inflight"].map((n) => join(agentDir(), "extensions", n));
  if (!extensions.some((e) => /provider-limits/.test(e))) throw new Error("every run loads provider-limits (--extension <dir>)");
  for (const e of extensions) if (!existsSync(e)) throw new Error(`extension ${e} not found`);
  const ns = !o.tasks || o.tasks === "all" ? RUBRIC.tasks.map((t) => t.n) : o.tasks.split(",");
  const tasks = ns.map((n) => RUBRIC.tasks.find((t) => t.n === n) ?? (() => { throw new Error(`no task ${n}`); })());
  const runId = `rubric-${o.arm}-${o.model.replace(/[/:]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const out = resolve(o.out, runId);
  // The agent sees its own working directory: its path names no arm, run or model.
  const workBase = resolve(o.work ?? join(tmpdir(), `spec-rubric-${randomUUID().slice(0, 8)}`));
  mkdirSync(join(workBase, "pinned"), { recursive: true });
  // The agent must not sit inside a checkout that holds the source and the live spec (a TMPDIR inside a worktree would).
  if (insideRepo(workBase)) throw new Error(`${workBase} is inside a git work tree; give --work <dir> outside any repository (or a TMPDIR outside one)`);
  mkdirSync(out, { recursive: true });
  const pinnedRoot = o.pinned ? resolve(o.pinned) : extractPinned(join(workBase, "pinned"));
  const instr = instructionsFor(tree, o);
  if (instr) writeFileSync(join(out, "instructions.md"), instr.text);
  const meta = { runId, arm: o.arm, model: o.model, prompt: RUBRIC_PROMPT_VERSION, instructions: instr ? { source: instr.source, sha256: instr.sha256, adaptedSha256: instr.adaptedSha256 } : null, tree, treeSource: readSource(tree), spec: { label: o["spec-label"] ?? (o.pinned ? pinnedRoot : "pinned a95768b7"), sha256: specHash(pinnedRoot) }, tasks: ns, concurrency, timeoutMin: Number(o["timeout-min"] ?? 20), extensions, pi: o.pi ?? "pi", started: new Date().toISOString(), dryRun: Boolean(o.dryRun) };
  writeFileSync(join(out, "run.json"), JSON.stringify(meta, null, 2) + "\n");
  await pool(tasks, concurrency, async (t) => {
    const dir = join(out, `T${t.n}`);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const work = workDir(join(workBase, `T${t.n}`), tree, pinnedRoot);
    const text = rubricPrompt(t);
    writeFileSync(join(dir, "prompt.txt"), text + "\n");
    if (o.dryRun) { writeFileSync(join(dir, "dry-run.json"), JSON.stringify({ work, cwdFiles: readdirSync(work).sort() }, null, 2) + "\n"); return; }
    const r = await runPi({ pi: meta.pi, model: o.model, work, sessions: join(dir, "sessions"), extensions, text, instructions: instr ? join(out, "instructions.md") : null, events: join(dir, "events.jsonl"), stderr: join(dir, "stderr.txt"), timeoutMs: meta.timeoutMin * 60_000 });
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ ...r, work }, null, 2) + "\n");
    console.error(`T${t.n}: exit ${r.code}${r.signal ? ` (${r.signal})` : ""} in ${Math.round(r.ms / 1000)} s`);
  });
  if (!o.dryRun) summarize(out);
  console.log(out);
}

/** Per task of one run: the final answer, (e) bytes, (g) calls and the routes it took, from its events. Writes rubric-run.json. */
export function summarize(out) {
  const meta = JSON.parse(readFileSync(join(out, "run.json"), "utf8"));
  const tasks = {};
  for (const n of meta.tasks) {
    const file = join(out, `T${n}`, "events.jsonl");
    if (!existsSync(file)) { tasks[n] = { missing: true, final: "", bytes: 0, calls: 0, routes: { outside: [], directSpec: [], scratch: [] } }; continue; }
    const { calls, final } = readEvents(readFileSync(file, "utf8"));
    const exit = existsSync(join(out, `T${n}`, "exit.json")) ? JSON.parse(readFileSync(join(out, `T${n}`, "exit.json"), "utf8")) : {};
    // Reaching around the tools, classed as in the agent arm (GRADING.md): an arm must not win by reading more than allowed.
    const routes = { outside: [], directSpec: [], scratch: [] };
    for (const c of calls) for (const a of accessesOf(c, c.tool === "bash" ? String(c.args?.command ?? "") : String(c.args?.path ?? ""), exit.work)) routes[a.kind].push(a.what);
    tasks[n] = { final, bytes: calls.reduce((s, c) => s + Buffer.byteLength(c.result?.text ?? ""), 0), calls: calls.length, routes };
  }
  const card = { runId: meta.runId, arm: meta.arm, spec: meta.spec ?? null, model: meta.model, prompt: meta.prompt, instructions: meta.instructions, tree: meta.treeSource ?? meta.tree, tasks };
  writeFileSync(join(out, "rubric-run.json"), JSON.stringify(card, null, 2) + "\n");
  return card;
}

// ---------------------------------------------------------------- blind

/** Words that name a reading tool or its output: a grader who saw them could guess the arm. A list can only hold what
 *  someone thought of, so the differential check (`tellsOf`) is what stands behind it. */
const TOOL_WORDS = ["sova-spec\\.mjs", "sova-spec", "toc", "packets?", "frontier", "inventory", "census", "contents lines?", "spec tools?"];
/** Arm phrases. The agent is never told its arm, so a bare "baseline", "candidate" or "pull" is a product word (the
 *  spec uses them) and stays; only a phrase naming an arm goes. */
const ARM_WORDS = ["(?:packet|pull|baseline|candidate) arms?"];
const FLAG = /--(?:root|part|dir|cursor|budget|frame|whole|json|near|all|spec)\b/;
/** A revision id: 7-40 hex characters with at least one digit and one letter a-f, so a date (20251001) or a word
 *  ("defaced") is not one. */
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const REDACT = "[…]";
const all = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

/** An answer as the grader sees it: no command, no tool name, no arm phrase, no revision id. → { text, redactions } */
export function scrubCounted(text) {
  const toolRe = new RegExp(`\\b(?:${TOOL_WORDS.join("|")})\\b`, "gi"), armRe = new RegExp(`\\b(?:${ARM_WORDS.join("|")})\\b`, "gi");
  const commandish = (s) => /sova-spec|node\s+tools\/|\$core|tools\/sova/.test(s) || FLAG.test(s) || new RegExp(`\\b(?:${TOOL_WORDS.join("|")})\\b`, "i").test(s);
  let n = 0;
  const cut = () => { n++; return REDACT; };
  let t = String(text ?? "");
  // Fenced blocks and inline code that hold a command or a tool word go whole.
  t = t.replace(/```[\s\S]*?```/g, (b) => (commandish(b) ? cut() : b));
  t = t.replace(/`[^`\n]*`/g, (s) => (commandish(s) ? cut() : s));
  // A line that still runs or names a command goes whole.
  t = t.split("\n").filter((l) => (/sova-spec|node\s+tools\/|\$core|--root\b/.test(l) ? (n++, false) : true)).join("\n");
  t = t.replace(toolRe, cut).replace(armRe, cut).replace(all(SHA), cut).replace(all(FLAG), cut);
  return { text: t, redactions: n };
}
export const scrub = (text) => scrubCounted(text).text;

/** The tokens of one brief for the differential check: lowercased words and word pairs, and a size marker for any
 *  "N B / N KB" figure, leaving out § ids and the words of the task's own wording and seeds. */
export function tokensOf(text, exclude = new Set()) {
  const t = String(text ?? "").toLowerCase().replace(/§\S+/g, " ");
  const out = new Set();
  if (/\b\d[\d,.]*\s?(?:b|kb|mb|bytes)\b/.test(t)) out.add("<size: N B or N KB>");
  const words = t.match(/[a-z][a-z'-]*[a-z]|[a-z]/g) ?? [];
  words.forEach((w, i) => {
    if (!exclude.has(w)) out.add(w);
    const next = words[i + 1];
    if (next && !(exclude.has(w) && exclude.has(next))) out.add(`${w} ${next}`);
  });
  return out;
}

/** The task's own words, never tells: both arms are handed them. */
const taskWords = (t) => new Set(`${t.task} ${t.seeds.join(" ")}`.toLowerCase().match(/[a-z][a-z'-]*[a-z]|[a-z]/g) ?? []);

/**
 * The differential check: tokens found in at least `min` tasks of one arm's scrubbed briefs and in none of the other's.
 * It needs no word list, so a tell nobody thought of still shows. → { A: [{token, tasks}], B: [...] }
 */
export function tellsOf(briefs, min = 3) {
  const count = { A: new Map(), B: new Map() };
  for (const [n, sides] of Object.entries(briefs)) {
    const t = RUBRIC.tasks.find((x) => x.n === n), ex = t ? taskWords(t) : new Set();
    for (const side of ["A", "B"]) for (const tok of tokensOf(sides[side], ex)) count[side].set(tok, (count[side].get(tok) ?? 0) + 1);
  }
  const one = (me, other) => [...count[me]].filter(([tok, k]) => k >= min && !count[other].has(tok)).map(([token, tasks]) => ({ token, tasks })).sort((a, b) => b.tasks - a.tasks || (a.token < b.token ? -1 : 1));
  return { A: one("A", "B"), B: one("B", "A") };
}

/** A small seeded generator (mulberry32), so a blind draw can be repeated from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const GRADER_README = (n) => `# Blind grading: ${n} tasks

Each file in tasks/ is one change a builder is about to make to a product called Sova, and two briefs, X and Y,
that two builders wrote from the product's spec before starting. Score each brief on its own against the rubric
below, 0, 1 or 2 per criterion (0 absent, 1 partly, 2 fully), reading only the brief. Do not guess how either
brief was produced; the briefs are shuffled per task, so X in one task has nothing to do with X in another.

## Rubric

${SCORED.map((k) => `- (${k}) ${RUBRIC.rubric[k]}`).join("\n")}

## Reply

One JSON file: {"tasks": {"<task no>": {"X": {"a": 0-2, "b": 0-2, "c": 0-2, "d": 0-2, "note": "…"}, "Y": {…}}, …}}
with every task present.
`;

/**
 * Blind two runs: grader/ (README and one file per task), key.json and tells.json beside it. Refuses when the runs
 * differ in model, task set or any task's prompt bytes, and while the differential check lists a tell, unless
 * `acceptTells` (a person read tells.json and ruled each one content, not a leak). The seed is random unless given,
 * and recorded only in key.json. → { grader, key, tells }
 */
export function blind(aDir, bDir, out, { seed, acceptTells = false } = {}) {
  const runs = [aDir, bDir].map((d) => (existsSync(join(d, "rubric-run.json")) ? JSON.parse(readFileSync(join(d, "rubric-run.json"), "utf8")) : summarize(d)));
  const [A, B] = runs;
  if (A.model !== B.model) throw new Error(`models differ: ${A.model} vs ${B.model}`);
  const na = Object.keys(A.tasks).sort(), nb = Object.keys(B.tasks).sort();
  if (na.join() !== nb.join()) throw new Error(`the runs hold different tasks: ${na.join(",")} vs ${nb.join(",")}`);
  const ns = na;
  if (!ns.length) throw new Error("no task in the runs");
  // Same words to both arms: each task's prompt.txt, byte for byte (a label could match while the text did not).
  for (const n of ns) {
    const [pa, pb] = [aDir, bDir].map((d) => join(d, `T${n}`, "prompt.txt"));
    if (existsSync(pa) || existsSync(pb)) if (!existsSync(pa) || !existsSync(pb) || !readFileSync(pa).equals(readFileSync(pb))) throw new Error(`task ${n}: the two runs were not given the same prompt`);
  }
  seed = seed ?? randomInt(1, 2 ** 31 - 1);
  const briefs = {}, redactions = {};
  for (const n of ns) {
    const a = scrubCounted(A.tasks[n].final), b = scrubCounted(B.tasks[n].final);
    briefs[n] = { A: a.text, B: b.text };
    redactions[n] = { A: a.redactions, B: b.redactions };
  }
  const tells = tellsOf(briefs);
  mkdirSync(out, { recursive: true });
  const named = (side) => ({ arm: side === "A" ? A.arm : B.arm, tells: tells[side] });
  writeFileSync(join(out, "tells.json"), JSON.stringify({ about: "Tokens in at least 3 tasks of one arm's scrubbed briefs and none of the other's. Each is a possible arm tell: add it to the scrub, or rule it content and pass --accept-tells.", A: named("A"), B: named("B") }, null, 2) + "\n");
  const nTells = tells.A.length + tells.B.length;
  if (nTells && !acceptTells) throw new Error(`blinding refused: ${nTells} differential tell(s) in ${join(out, "tells.json")}; scrub them, or rule them content and pass --accept-tells`);
  const draw = rng(seed);
  const grader = join(out, "grader");
  mkdirSync(join(grader, "tasks"), { recursive: true });
  const key = { seed, runs: { A: { dir: resolve(aDir), runId: A.runId, arm: A.arm, spec: A.spec ?? null }, B: { dir: resolve(bDir), runId: B.runId, arm: B.arm, spec: B.spec ?? null } }, model: A.model, acceptedTells: [...tells.A, ...tells.B].map((x) => x.token), tasks: {} };
  for (const n of ns) {
    const t = RUBRIC.tasks.find((x) => x.n === n);
    const xIsA = draw() < 0.5;
    const [X, Y] = xIsA ? ["A", "B"] : ["B", "A"];
    const routes = (side) => { const r = (side === "A" ? A : B).tasks[n].routes; return r ? { outside: r.outside.length, directSpec: r.directSpec.length, scratch: r.scratch.length } : null; };
    key.tasks[n] = { X, Y, bytes: { A: A.tasks[n].bytes, B: B.tasks[n].bytes }, calls: { A: A.tasks[n].calls, B: B.tasks[n].calls }, routes: { A: routes("A"), B: routes("B") }, redactions: redactions[n] };
    const body = [`# Task ${n}`, "", t.task, "", `Where it starts in the spec: ${t.seeds.join(", ")}`, "",
      "## Brief X", "", briefs[n][X] || "(no brief)", "", "## Brief Y", "", briefs[n][Y] || "(no brief)", ""].join("\n");
    writeFileSync(join(grader, "tasks", `${n}.md`), body);
  }
  writeFileSync(join(grader, "README.md"), GRADER_README(ns.length));
  writeFileSync(join(out, "key.json"), JSON.stringify(key, null, 2) + "\n");
  return { grader, key, tells };
}

/** The briefs as the grader has them, back under the arms (the key says which is X), for the differential check. */
function gradedBriefs(graderDir, key) {
  const out = {};
  for (const n of Object.keys(key.tasks)) {
    const f = join(graderDir, "tasks", `${n}.md`);
    if (!existsSync(f)) continue;
    const text = readFileSync(f, "utf8");
    const x = text.split("\n## Brief X\n")[1]?.split("\n## Brief Y\n") ?? ["", ""];
    out[n] = { [key.tasks[n].X]: x[0] ?? "", [key.tasks[n].Y]: x[1] ?? "" };
  }
  return out;
}

/**
 * What must never reach the grader. Two checks: the listed patterns (tool names, commands, arm phrases, revision ids,
 * event traces, the runs' ids, dirs, spec labels and model), and the differential check over the briefs as handed out,
 * where every tell must be one a person accepted. → { found: [...], patterns: N, accepted: M }
 */
export function leaks(graderDir, key) {
  const found = [];
  const texts = [join(graderDir, "README.md"), ...readdirSync(join(graderDir, "tasks")).map((f) => join(graderDir, "tasks", f))].map((f) => [f, readFileSync(f, "utf8")]);
  const banned = [
    ...TOOL_WORDS.map((w) => new RegExp(`\\b${w}\\b`, "i")), ...ARM_WORDS.map((w) => new RegExp(`\\b${w}\\b`, "i")),
    /node\s+tools\//, /\$core/, FLAG, /tool_execution|toolCallId|"type":\s*"(?:message|tool)/, SHA,
    ...(key ? [key.runs.A.runId, key.runs.B.runId, key.runs.A.dir, key.runs.B.dir, key.runs.A.spec?.label, key.runs.B.spec?.label, key.model].filter(Boolean).map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) : []),
  ];
  for (const [f, t] of texts) for (const re of banned) { const m = re.exec(t); if (m) found.push(`${f.slice(graderDir.length + 1)}: ${m[0]}`); }
  if (readdirSync(graderDir).some((f) => /key|tells/i.test(f))) found.push("a key or tells file in the grader folder");
  if (key) {
    const tells = tellsOf(gradedBriefs(graderDir, key)), accepted = new Set(key.acceptedTells ?? []);
    for (const side of ["A", "B"]) for (const x of tells[side]) if (!accepted.has(x.token)) found.push(`differential tell, not accepted: "${x.token}" in ${x.tasks} tasks of one arm and none of the other`);
  }
  return Object.assign(found, { patterns: banned.length, accepted: key?.acceptedTells?.length ?? 0 });
}

// ---------------------------------------------------------------- unblind

/** The grader's scores mapped back to the arms, with (e) bytes and (g) calls beside a-d. */
export function unblind(blindDir, scores) {
  const key = JSON.parse(readFileSync(join(blindDir, "key.json"), "utf8"));
  const out = { model: key.model, seed: key.seed, acceptedTells: key.acceptedTells ?? [], arms: {}, reference: { ...RUBRIC.baseline, note: "the 2026-10-05 study's packet arm, scored by hand; its subject model is unknown, so it is shown for reference only" } };
  for (const side of ["A", "B"]) out.arms[side] = { arm: key.runs[side].arm, spec: key.runs[side].spec, runId: key.runs[side].runId, tasks: {}, total: { a: 0, b: 0, c: 0, d: 0, sum: 0, of: 0, bytes: 0, calls: 0, outside: 0, directSpec: 0, scratch: 0, redactions: 0 } };
  for (const [n, k] of Object.entries(key.tasks)) {
    const s = scores.tasks?.[n];
    if (!s) throw new Error(`no scores for task ${n}`);
    for (const letter of ["X", "Y"]) {
      const side = k[letter], g = s[letter];
      for (const c of SCORED) if (![0, 1, 2].includes(g?.[c])) throw new Error(`task ${n} ${letter}.${c}: ${g?.[c]} is not 0, 1 or 2`);
      const row = { ...Object.fromEntries(SCORED.map((c) => [c, g[c]])), sum: SCORED.reduce((t, c) => t + g[c], 0), e: k.bytes[side], g: k.calls[side], routes: k.routes?.[side] ?? null, redactions: k.redactions?.[side] ?? null, note: g.note ?? "" };
      out.arms[side].tasks[n] = row;
      const T = out.arms[side].total;
      for (const c of SCORED) T[c] += g[c];
      T.sum += row.sum; T.of += 8; T.bytes += row.e; T.calls += row.g;
      for (const r of ["outside", "directSpec", "scratch"]) T[r] += row.routes?.[r] ?? 0;
      T.redactions += row.redactions ?? 0;
    }
  }
  return out;
}

async function main(argv) {
  const acceptTells = argv.includes("--accept-tells");
  const o = parseArgs(argv.filter((a) => a !== "--accept-tells"));
  const cmd = o._?.[0];
  if (cmd === "run") return cmdRun(o);
  if (cmd === "blind") {
    if (!o.a || !o.b || !o.out) throw new Error("blind needs --a <run dir> --b <run dir> --out <dir>");
    const { grader, key } = blind(resolve(o.a), resolve(o.b), resolve(o.out), { seed: o.seed === undefined ? undefined : Number(o.seed), acceptTells });
    const bad = leaks(grader, key);
    if (bad.length) throw new Error(`blinding failed, nothing handed out: ${bad.join("; ")}`);
    console.log(`grader input: ${grader} (hand over this folder only); key: ${join(resolve(o.out), "key.json")}`);
    return;
  }
  if (cmd === "check") {
    if (!o.blind) throw new Error("check needs --blind <dir>");
    const key = JSON.parse(readFileSync(join(resolve(o.blind), "key.json"), "utf8"));
    const bad = leaks(join(resolve(o.blind), "grader"), key);
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
    console.log(`none of the ${bad.patterns} listed patterns in the grader folder; no differential tell beyond the ${bad.accepted} a person accepted`);
    return;
  }
  if (cmd === "unblind") {
    if (!o.blind || !o.scores) throw new Error("unblind needs --blind <dir> --scores <file>");
    const card = unblind(resolve(o.blind), JSON.parse(readFileSync(resolve(o.scores), "utf8")));
    const text = JSON.stringify(card, null, 2) + "\n";
    if (o.out) writeFileSync(resolve(o.out), text);
    for (const s of ["A", "B"]) { const T = card.arms[s].total; console.log(`${card.arms[s].arm} (spec ${card.arms[s].spec?.label ?? "?"}): ${T.sum}/${T.of} (a ${T.a} b ${T.b} c ${T.c} d ${T.d}); e ${T.bytes} B; g ${T.calls} calls; routes outside ${T.outside}, direct spec ${T.directSpec}, scratch ${T.scratch}; redactions ${T.redactions}`); }
    console.log(`reference: ${card.reference.total}/${card.reference.of} (${card.reference.note})`);
    return;
  }
  throw new Error("usage: node rubric-arm.mjs run|blind|unblind|check … (see the header)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(2); });
}
