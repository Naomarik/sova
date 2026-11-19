#!/usr/bin/env node
// The A/B cycle's runner: every case on every test model in every arm of one round, each result one
// file (references/ledger.md). Resumable: a case with a result is skipped unless --again. Stops a
// model's queue at its first error, since a round on a missing model isn't the same round.
//
//   node runner.mjs <campaign> --round <n> [--arms A,B] [--models zai/glm-5.3@low,...] [--cases fail,pass|ids]
//                  [--parallel 2] [--timeout 300] [--again]
//
// An arm (rounds/<n>/arms.json) is run by its `how`:
//   sova     a fresh chat per case in the arm's test copy of Sova (url, agentDir, cwd; optional mode,
//            minorModes): created, set to the test model, sent the prompt, read back when it is idle
//   command  a shell command per case; {model} {effort} {promptFile} {case} {arm} are filled in, and
//            its stdout is the reply (or JSON {reply, tools, cost})
//   rescore  no run: the results of round `from` (arm `fromArm`, default the same id) are copied in
//
// A round refuses to start (exit 3, naming the arm) when a test chat could read the subject's record:
// an arm whose cwd or worktree still holds .sova/ab/ or still has it in its HEAD commit (git shows an
// uncommitted delete), or that runs inside the campaign's own worktree, where the record is written
// (references/arms.md). A prediction naming an id that isn't a case, or a
// sealed case, stops it the same way.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { args, campaign, die, listDir, modelText, pickCases, pool, sleep, slug, sovaClient, writeJson } from "./lib.mjs";
import { armRefusals, predictionProblems, projectOf } from "./record-lib.mjs";

const { pos, opt } = args();
if (!pos[0] || opt.round === undefined) die("usage: runner.mjs <campaign> --round <n> [--arms A,B] [--models m@effort,...] [--cases ...] [--parallel 2] [--timeout 300] [--again]", 3);
const K = campaign(pos[0]);
const n = Number(opt.round);
const allArms = K.arms(n);
const armIds = opt.arms ? String(opt.arms).split(",") : Object.keys(allArms);
for (const a of armIds) if (!allArms[a]) die(`round ${n} has no arm ${a} (arms.json: ${Object.keys(allArms).join(", ")})`, 3);
const models = K.models(opt.models);
const cases = pickCases(K.cases(), opt.cases);
if (!cases.length) die("no cases picked", 3);
const picked = Object.fromEntries(armIds.map((a) => [a, allArms[a]]));
const refused = [...armRefusals(picked, { project: projectOf(K.W) }), ...predictionProblems(picked, K.cases())];
if (refused.length) die(`round ${n} doesn't start:\n${refused.join("\n")}`, 3);
const parallel = Number(opt.parallel ?? K.c.parallel ?? 2);
const timeoutMs = 1000 * Number(opt.timeout ?? K.c.timeoutSec ?? 300);

const stats = { ran: 0, skipped: 0, errors: 0 };

async function runSova(arm, m, k) {
  const sova = await sovaClient(arm);
  const t0 = Date.now();
  const s = await sova.post("/api/sessions", { cwd: arm.cwd });
  const session = { id: s.id, path: s.path, url: `${sova.base}/#/s/${encodeURIComponent(s.path)}` };
  await sova.post("/api/sessions/configure", { path: s.path, model: m.model, ...(m.effort ? { thinking: m.effort } : {}), ...(arm.mode ? { mode: arm.mode } : {}), ...(arm.minorModes ? { minorModes: arm.minorModes } : {}) });
  await sova.post("/api/sessions/prompt", { path: s.path, text: k.prompt });
  // Idle twice in a row, after at least one reply row, is done.
  let idle = 0;
  let items = [];
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    const sum = await sova.get(`/api/sessions/summary?id=${encodeURIComponent(s.id)}`);
    if (sum.busy) {
      idle = 0;
      continue;
    }
    items = (await sova.get(`/api/transcript?path=${encodeURIComponent(s.path)}`)).items ?? [];
    const replied = items.some((it) => it.kind === "assistant-text" || it.kind === "error");
    idle = replied ? idle + 1 : 0;
    if (idle >= 2) break;
  }
  const ms = Date.now() - t0;
  if (idle < 2) throw Object.assign(new Error(`no reply within ${timeoutMs / 1000}s`), { session });
  const replyRows = items.filter((it) => it.kind === "assistant-text");
  const errors = items.filter((it) => it.kind === "error").map((it) => it.text);
  let usage = null;
  try {
    usage = await sova.get(`/api/usage/session?sid=${encodeURIComponent(s.id)}`);
  } catch {
    usage = null;
  }
  const answered = replyRows.map((it) => it.model).filter(Boolean);
  return {
    reply: replyRows.map((it) => it.text ?? "").join("\n\n"),
    tools: items.filter((it) => it.kind === "tool-call").map((it) => it.text),
    ...(errors.length ? { error: errors.join(" | ") } : {}),
    answeredBy: [...new Set(answered)],
    usage,
    cost: typeof usage?.cost === "number" ? usage.cost : typeof usage?.total?.cost === "number" ? usage.total.cost : null,
    ms,
    session,
  };
}

function runCommand(arm, m, k) {
  const dir = join(tmpdir(), `ab-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, `${k.id}.txt`);
  writeFileSync(promptFile, k.prompt);
  const fill = (s) => s.replaceAll("{model}", m.model).replaceAll("{effort}", m.effort ?? "").replaceAll("{promptFile}", promptFile).replaceAll("{case}", k.id).replaceAll("{arm}", arm.id);
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const p = spawn("/bin/sh", ["-c", fill(arm.command)], { cwd: arm.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (code !== 0) return rej(new Error(`exit ${code}: ${err.trim().slice(-300)}`));
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed.reply === "string") res({ tools: [], cost: null, ...parsed, ms });
      else res({ reply: out.trim(), tools: [], cost: null, ms });
    });
  });
}

async function one(armId, m, k) {
  const arm = { id: armId, ...allArms[armId] };
  const file = K.result(n, armId, m, k.id);
  if (existsSync(file) && !opt.again) return void stats.skipped++;
  if (arm.how === "rescore") {
    const from = K.result(Number(arm.from), arm.fromArm ?? armId, m, k.id);
    if (!existsSync(from)) throw new Error(`rescore: no result at ${from}`);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(from, file);
    return void stats.ran++;
  }
  const base = { case: k.id, group: k.group, arm: armId, model: m.model, effort: m.effort ?? null, at: new Date().toISOString() };
  try {
    const r = arm.how === "sova" ? await runSova(arm, m, k) : arm.how === "command" ? await runCommand(arm, m, k) : die(`arm ${armId}: how is sova, command or rescore`, 3);
    writeJson(file, { ...base, ...r });
    stats.ran++;
    if (r.error) throw new Error(r.error);
  } catch (e) {
    if (!existsSync(file)) writeJson(file, { ...base, reply: "", tools: [], error: String(e.message ?? e), ...(e.session ? { session: e.session } : {}) });
    throw e;
  }
}

for (const m of models) {
  const jobs = armIds.flatMap((a) => cases.map((k) => [a, k]));
  let failed = null;
  await pool(jobs, parallel, async ([a, k]) => {
    if (failed) return;
    try {
      await one(a, m, k);
    } catch (e) {
      stats.errors++;
      failed = `${modelText(m)} · arm ${a} · case ${k.id}: ${e.message ?? e}`;
    }
  });
  if (failed) {
    console.error(`stopped ${modelText(m)} at its first error: ${failed}`);
  }
}

const done = armIds.flatMap((a) => models.map((m) => listDir(join(K.round(n), "results", a, slug(m))).length));
console.log(`round ${n}: ran ${stats.ran}, already there ${stats.skipped}, errors ${stats.errors}; results per arm×model: ${done.join(", ")}`);
process.exit(stats.errors ? 1 : 0);
