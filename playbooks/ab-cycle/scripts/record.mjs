#!/usr/bin/env node
// The A/B cycle's record: what a subject has learned, kept in the project's repository after the
// campaign folder is gone (references/record.md). One file per subject, <project>/.sova/ab/<name>.jsonl,
// one line per attempt (losing ones too) and one closing line per campaign.
//
//   node record.mjs show  [<name>] [--project <root>] [--campaign <name>]
//                                        the record as markdown, grouped by problem; no name: every record
//   node record.mjs add   <campaign> --round <n> --outcome carried|dropped [--note "..."] [--replace]
//                                        one line per candidate arm of a scored round
//   node record.mjs close <campaign> --verdict land|cycle|park [--confirm <round>] [--note "..."]
//                                        the campaign's closing line
//   node record.mjs check [<name>] [--project <root>] [--campaign <campaign>]
//                                        nothing private in a record; exit 1 naming each line and field
//
// <campaign> is the campaign folder; its project is the worktree it sits in (<project>/.cache/ab/<campaign>/)
// unless --project names it. A line is built from named fields only and checked before it is written:
// no text from a case or a reply, no case id, no home folder, URL, IP address or email.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { args, campaign, die, listDir, readJson } from "./lib.mjs";
import { RECORD_DIR, RECORD_NAME, attemptLine, checkLine, checkRecord, closeLine, corpusOf, parseRecord, projectOf, recordFile, recordSummary, showRecord } from "./record-lib.mjs";

const SUBS = ["show", "add", "close", "check"];
const { pos, opt } = args();
const sub = pos.shift();
if (!SUBS.includes(sub)) die("usage: record.mjs show [<name>] | add <campaign> --round <n> --outcome carried|dropped | close <campaign> --verdict land|cycle|park | check [<name>]", 3);

const today = () => new Date().toISOString().slice(0, 10);
const text = (v) => (typeof v === "string" ? v : undefined);

/** The project to read records from when no campaign names it: --project, else the repository around the current folder. */
function projectHere() {
  if (text(opt.project)) return resolve(opt.project);
  let d = process.cwd();
  for (;;) {
    if (existsSync(join(d, ".git")) || existsSync(join(d, RECORD_DIR))) return d;
    const up = dirname(d);
    if (up === d) return process.cwd();
    d = up;
  }
}

/** A campaign, its project and its record's name. */
function open(dir) {
  if (!dir) die(`usage: record.mjs ${sub} <campaign> ...`, 3);
  const K = campaign(dir);
  const project = text(opt.project) ? resolve(opt.project) : projectOf(K.W);
  if (!project) die(`${K.W} isn't <project>/.cache/ab/<campaign>: say where the record goes with --project <root>`, 3);
  const name = K.c.record;
  if (typeof name !== "string" || !RECORD_NAME.test(name)) die(`campaign.json needs "record": the record's name, in lowercase letters, digits and dashes (references/record.md)`, 3);
  return { K, project, name, file: recordFile(project, name), id: basename(K.W) };
}

const names = (project) =>
  listDir(join(project, RECORD_DIR))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -6))
    .sort();
const linesOf = (file) => (existsSync(file) ? parseRecord(readFileSync(file, "utf8")).lines.map((x) => x.line) : []);

/** Every case and saved reply of a campaign, as the runs of words a line may not repeat. */
function corpus(K) {
  const texts = [];
  for (const k of K.cases()) texts.push(k.prompt, k.expect);
  for (const n of listDir(join(K.W, "rounds")))
    for (const a of listDir(join(K.W, "rounds", n, "results")))
      for (const m of listDir(join(K.W, "rounds", n, "results", a)))
        for (const f of listDir(join(K.W, "rounds", n, "results", a, m))) if (f.endsWith(".json")) texts.push(readJson(join(K.W, "rounds", n, "results", a, m, f)).reply);
  return corpusOf(texts.filter((t) => typeof t === "string"));
}

/** The arm's change as a diff from its base to its ref, or null when either isn't a commit this repository has. */
function diffOf(project, arm) {
  const commit = /^[0-9a-f]{7,40}$/;
  if (!commit.test(arm.base ?? "") || !commit.test(arm.ref ?? "")) return null;
  try {
    return execFileSync("git", ["-C", project, "diff", "--no-color", "--no-ext-diff", "-U0", arm.base, arm.ref, "--"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function refuse(what, bad) {
  die(`${what} isn't written:\n${bad.map((b) => `  ${b.field} ${b.what}`).join("\n")}\nA record holds general words and counts only (references/record.md).`, 1);
}

function write(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function doShow() {
  const project = projectHere();
  const name = pos[0];
  if (!name) {
    const all = names(project);
    if (!all.length) return console.log(`This project has no records yet (${RECORD_DIR}/ is empty or missing). A campaign's first round starts one.`);
    console.log(["Records in this project:", "", ...all.map((n) => `- ${recordSummary(n, linesOf(recordFile(project, n)))}`)].join("\n"));
    return;
  }
  if (!RECORD_NAME.test(name)) die(`a record's name is lowercase letters, digits and dashes: ${name}`, 3);
  const file = recordFile(project, name);
  if (!existsSync(file)) {
    const all = names(project);
    return console.log(`No record named ${name} yet: this campaign starts it.${all.length ? ` The project's records: ${all.join(", ")}.` : ""}`);
  }
  console.log(showRecord(name, linesOf(file), { campaign: text(opt.campaign) }));
}

function doAdd() {
  const { K, project, name, file, id } = open(pos[0]);
  if (opt.round === undefined) die("usage: record.mjs add <campaign> --round <n> --outcome carried|dropped", 3);
  const n = Number(opt.round);
  if (opt.outcome !== "carried" && opt.outcome !== "dropped") die("--outcome is carried (the round's best arm became the next base) or dropped (none did)", 3);
  const arms = K.arms(n);
  const scores = readJson(join(K.round(n), "scores.json"), null) ?? die(`round ${n} has no scores yet: run score.mjs total first`, 3);
  const candidates = Object.keys(arms).filter((a) => !arms[a].baseline);
  if (!candidates.length) die(`round ${n} has no candidate arm: master alone adds nothing to the record`, 3);
  if (opt.outcome === "carried" && !candidates.includes(scores.best)) die(`round ${n} has no best arm to carry: use --outcome dropped, or score.mjs total --winner <arm>`, 3);
  const had = linesOf(file);
  const mine = (l) => l.kind === "attempt" && l.campaign === id && l.round === n;
  if (had.some(mine) && !opt.replace) die(`round ${n} of ${id} is already in the record (${had.filter(mine).length} lines): --replace rewrites them`, 3);

  const words = corpus(K);
  const lines = [];
  for (const a of candidates) {
    const p = scores.arms?.[a]?.prediction;
    if (!p) die(`round ${n}, arm ${a}: its scores hold no comparison with its base (a round on the sealed cases adds nothing; otherwise run score.mjs total again)`, 3);
    for (const field of ["problem", "change", "why"]) if (typeof arms[a][field] !== "string" || !arms[a][field].trim()) die(`round ${n}, arm ${a}: arms.json needs "${field}": the record keeps the reason for every attempt (references/record.md)`, 3);
    const { line, textLeftOut } = attemptLine({ campaign: id, round: n, armId: a, arm: arms[a], prediction: { ...p, problem: arms[a].problem.trim(), why: arms[a].why.trim() }, models: scores.arms[a].models, outcome: opt.outcome === "carried" && a === scores.best ? "carried" : "dropped", note: text(opt.note), date: today(), diff: diffOf(project, arms[a]) }, words);
    const bad = checkLine(line, words);
    if (bad.length) refuse(`round ${n}, arm ${a}`, bad);
    if (textLeftOut) console.error(`arm ${a}: the changed text is left out (${textLeftOut}); the line keeps the files and line counts`);
    lines.push(line);
  }
  write(file, [...had.filter((l) => !mine(l)), ...lines]);
  console.log(`${join(RECORD_DIR, `${name}.jsonl`)}: ${lines.map((l) => `${l.arm} ${l.outcome}`).join(", ")} (round ${n} of ${id})`);
  console.log(`${recordSummary(name, linesOf(file))}.`);
}

function doClose() {
  const { K, name, file, id } = open(pos[0]);
  if (!["land", "cycle", "park"].includes(opt.verdict)) die("--verdict is land, cycle or park", 3);
  const had = linesOf(file);
  const master = Object.values(K.arms(0)).find((a) => a.baseline)?.ref;
  let confirm;
  if (opt.confirm !== undefined) {
    const c = Number(opt.confirm);
    const arms = K.arms(c);
    const scores = readJson(join(K.round(c), "scores.json"), null) ?? die(`round ${c} has no scores yet: run score.mjs total first`, 3);
    const base = Object.keys(arms).find((a) => arms[a].baseline) ?? die(`round ${c} has no master arm: a confirm round holds master and the winner`, 3);
    const winner = Object.keys(arms).find((a) => !arms[a].baseline) ?? die(`round ${c} has no winner arm: a confirm round holds master and the winner`, 3);
    confirm = Object.entries(scores.arms?.[winner]?.models ?? {}).map(([slug, w]) => ({ model: w.model, effort: w.effort ?? null, cases: w.total, master: scores.arms?.[base]?.models?.[slug]?.rate ?? null, winner: w.rate }));
  }
  const line = closeLine({ campaign: id, date: today(), verdict: opt.verdict, master: typeof master === "string" && /^[0-9a-f]{7,40}$/.test(master) ? master : null, rounds: new Set(had.filter((l) => l.kind === "attempt" && l.campaign === id).map((l) => l.round)).size, confirm, note: text(opt.note) });
  const bad = checkLine(line, corpus(K));
  if (bad.length) refuse(`the closing line of ${id}`, bad);
  write(file, [...had, line]);
  console.log(`${join(RECORD_DIR, `${name}.jsonl`)}: ${id} closed (${opt.verdict})`);
  console.log(`Keep it: commit ${join(RECORD_DIR, `${name}.jsonl`)} alone, by that path, on the campaign's own branch (never git add -A).`);
}

function doCheck() {
  const K = text(opt.campaign) ? campaign(opt.campaign) : null;
  const project = text(opt.project) ? resolve(opt.project) : (K && projectOf(K.W)) || projectHere();
  const which = pos[0] ? [pos[0]] : names(project);
  const words = K ? corpus(K) : undefined;
  let bad = 0;
  for (const name of which) {
    const file = recordFile(project, name);
    if (!existsSync(file)) die(`no record at ${file}`, 3);
    for (const b of checkRecord(readFileSync(file, "utf8"), words)) {
      console.error(`${join(RECORD_DIR, `${name}.jsonl`)}:${b.at}: ${b.field} ${b.what}`);
      bad++;
    }
  }
  if (bad) die(`${bad} to fix: a record holds general words and counts only (references/record.md)`, 1);
  console.log(which.length ? `${which.length === 1 ? `${which[0]}: nothing` : `${which.length} records: nothing`} private found${K ? ", against the campaign's cases and replies too" : ""}` : "no records to check");
}

if (sub === "show") doShow();
if (sub === "add") doAdd();
if (sub === "close") doClose();
if (sub === "check") doCheck();
