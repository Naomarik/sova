#!/usr/bin/env node
// The A/B cycle's scorer (references/ledger.md). One round at a time:
//
//   node score.mjs check   <campaign> --round <n>     grade every result whose case has a check; an errored run fails
//   node score.mjs blind   <campaign> --round <n>     the replies no check grades, shuffled and unlabelled, for the grader
//   node score.mjs unblind <campaign> --round <n>     the grader's verdicts back onto their arms
//   node score.mjs total   <campaign> --round <n> [--note "..."] [--winner B]
//                                                     scores.json, and the round's row in ledger.jsonl (replaced if there)
//   node score.mjs         <campaign> --round <n>     check, then total
//
// A round's best arm is the one with the highest pass rate over every test model, ties going to the
// cheaper; the baseline arm (master) is never "best". --winner records the main chat's own pick instead.
//
// total also sets each candidate arm's prediction (arms.json: problem, why, expectFix, mayBreak) beside
// what the round did against the arm's base (references/ledger.md, "Predicted beside observed"). It
// counts and never judges: the best arm is still picked by pass rate, then cost. A prediction naming an
// id that isn't a case, or a sealed case, stops it (exit 3).
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { args, campaign, die, listDir, readJson, slug, writeJson } from "./lib.mjs";
import { comparePrediction, findBase, onlySealed, predictionCounts, predictionProblems } from "./record-lib.mjs";

const SUBS = ["check", "blind", "unblind", "total"];
const { pos, opt } = args();
const sub = SUBS.includes(pos[0]) ? pos.shift() : "all";
if (!pos[0] || opt.round === undefined) die("usage: score.mjs [check|blind|unblind|total] <campaign> --round <n>", 3);
const K = campaign(pos[0]);
const n = Number(opt.round);
const arms = K.arms(n);
const cases = new Map(K.cases().map((k) => [k.id, k]));
const models = K.models(opt.models);

/** Every result of the round: [arm, model, case, result]. */
function results() {
  const out = [];
  for (const a of Object.keys(arms))
    for (const m of models)
      for (const f of listDir(join(K.round(n), "results", a, slug(m))))
        if (f.endsWith(".json")) out.push([a, m, f.slice(0, -5), readJson(join(K.round(n), "results", a, slug(m), f))]);
  return out;
}

/** A case's check against one result: {pass, why}. references/ledger.md, "Checks". */
function check(c, r) {
  const text = r.reply ?? "";
  const tools = r.tools ?? [];
  if (c.all) {
    const each = c.all.map((x) => check(x, r));
    const bad = each.find((e) => !e.pass);
    return bad ?? { pass: true, why: each.map((e) => e.why).join("; ") };
  }
  if (c.any) {
    const each = c.any.map((x) => check(x, r));
    return each.find((e) => e.pass) ?? { pass: false, why: `none of: ${each.map((e) => e.why).join("; ")}` };
  }
  if (c.not) {
    const e = check(c.not, r);
    return { pass: !e.pass, why: `not (${e.why})` };
  }
  if (typeof c.contains === "string") {
    const ok = text.toLowerCase().includes(c.contains.toLowerCase());
    return { pass: ok, why: `${ok ? "says" : "doesn't say"} "${c.contains}"` };
  }
  if (typeof c.regex === "string") {
    const ok = new RegExp(c.regex, c.flags ?? "i").test(text);
    return { pass: ok, why: `${ok ? "matches" : "doesn't match"} /${c.regex}/` };
  }
  if (typeof c.tool === "string") {
    const ok = tools.includes(c.tool);
    return { pass: ok, why: `${ok ? "called" : "didn't call"} ${c.tool}` };
  }
  if (typeof c.maxTools === "number") {
    const ok = tools.length <= c.maxTools;
    return { pass: ok, why: `${tools.length} tool calls (at most ${c.maxTools})` };
  }
  if (typeof c.maxWords === "number") {
    const w = text.split(/\s+/).filter(Boolean).length;
    return { pass: w <= c.maxWords, why: `${w} words (at most ${c.maxWords})` };
  }
  die(`unknown check ${JSON.stringify(c)}`, 3);
}

function doCheck() {
  let graded = 0;
  for (const [a, m, id, r] of results()) {
    const k = cases.get(id);
    const g = r.error ? { pass: false, why: `run failed: ${r.error}`, by: "error" } : k?.check ? { ...check(k.check, r), by: "check" } : null;
    if (!g) continue;
    writeJson(K.grade(n, a, m, id), g);
    graded++;
  }
  console.log(`round ${n}: ${graded} graded by checks`);
}

function doBlind() {
  const dir = join(K.round(n), "blind");
  const todo = results().filter(([a, m, id]) => !existsSync(K.grade(n, a, m, id)));
  // Shuffle, so file order says nothing either.
  for (let i = todo.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [todo[i], todo[j]] = [todo[j], todo[i]];
  }
  const key = readJson(join(K.round(n), "blind-key.json"), {});
  for (const [a, m, id, r] of todo) {
    const token = randomBytes(4).toString("hex");
    const k = cases.get(id) ?? {};
    writeJson(join(dir, `${token}.json`), { prompt: k.prompt, expect: k.expect ?? null, reply: r.reply });
    key[token] = { arm: a, model: m, case: id };
  }
  writeJson(join(K.round(n), "blind-key.json"), key);
  writeFileSync(
    join(dir, "README.md"),
    "Each file is one case: its prompt, what a good reply does (expect) and one reply.\n" +
      "For each, write `<same name>.grade.json` beside it: {\"pass\": true|false, \"why\": \"one line\"}.\n" +
      "Judge each reply against its expectation alone.\n",
  );
  console.log(`round ${n}: ${todo.length} replies for the grader in ${dir}`);
}

function doUnblind() {
  const dir = join(K.round(n), "blind");
  const key = readJson(join(K.round(n), "blind-key.json"), {});
  let back = 0;
  const missing = [];
  for (const [token, { arm, model, case: id }] of Object.entries(key)) {
    const g = join(dir, `${token}.grade.json`);
    if (!existsSync(g)) {
      missing.push(token);
      continue;
    }
    const v = readJson(g);
    writeJson(K.grade(n, arm, model, id), { pass: !!v.pass, why: String(v.why ?? ""), by: "grader" });
    back++;
  }
  console.log(`round ${n}: ${back} grades back${missing.length ? `, ${missing.length} not graded yet (${missing.slice(0, 5).join(", ")}…)` : ""}`);
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const rate = (p, t) => (t ? Math.round((1000 * p) / t) / 10 : 0);

/** One arm's grades in one round: {model folder: {case: pass}}. */
function gradesOf(round, arm) {
  const out = {};
  for (const m of models) {
    const dir = join(K.round(round), "grades", arm, slug(m));
    for (const f of listDir(dir)) if (f.endsWith(".json")) (out[slug(m)] ??= {})[f.slice(0, -5)] = !!readJson(join(dir, f)).pass;
  }
  return out;
}

/** Each candidate arm's prediction beside what it did against its base. A round on the sealed cases compares none. */
function predictions(scores) {
  const mine = Object.fromEntries(Object.keys(arms).map((a) => [a, gradesOf(n, a)]));
  const graded = Object.values(mine).flatMap((g) => Object.values(g).flatMap((x) => Object.keys(x)));
  if (onlySealed(graded, [...cases.values()])) return;
  const armsOf = (r) => (r === n ? arms : readJson(join(K.round(r), "arms.json"), {}));
  for (const [a, arm] of Object.entries(arms)) {
    if (arm.baseline || !scores.arms[a]) continue;
    const base = findBase(armsOf, n, arm);
    scores.arms[a].prediction = comparePrediction({ arm, grades: mine[a], baseGrades: base ? gradesOf(base.round, base.arm) : {}, base, models: models.map(slug) });
  }
}

function doTotal() {
  const wrong = predictionProblems(arms, [...cases.values()]);
  if (wrong.length) die(`round ${n}: ${wrong.join("\n")}`, 3);
  const scores = { round: n, at: new Date().toISOString(), arms: {} };
  const ungraded = [];
  for (const [a, arm] of Object.entries(arms)) {
    const per = {};
    for (const m of models) {
      const rs = listDir(join(K.round(n), "results", a, slug(m))).filter((f) => f.endsWith(".json"));
      if (!rs.length) continue;
      let pass = 0;
      let total = 0;
      let errors = 0;
      const costs = [];
      const times = [];
      for (const f of rs) {
        const id = f.slice(0, -5);
        const r = readJson(join(K.round(n), "results", a, slug(m), f));
        if (r.error) errors++;
        if (typeof r.cost === "number") costs.push(r.cost);
        if (typeof r.ms === "number") times.push(r.ms);
        const gf = K.grade(n, a, m, id);
        if (!existsSync(gf)) {
          ungraded.push(`${a}/${slug(m)}/${id}`);
          continue;
        }
        total++;
        if (readJson(gf).pass) pass++;
      }
      per[slug(m)] = { model: m.model, effort: m.effort ?? null, pass, total, rate: rate(pass, total), errors, cost: costs.length ? sum(costs) : null, ms: times.length ? Math.round(sum(times) / times.length) : null };
    }
    const vs = Object.values(per);
    const pass = sum(vs.map((v) => v.pass));
    const total = sum(vs.map((v) => v.total));
    const cs = vs.map((v) => v.cost).filter((c) => c !== null);
    scores.arms[a] = { label: arm.label ?? a, baseline: !!arm.baseline, change: arm.change ?? null, ref: arm.ref ?? null, models: per, all: { pass, total, rate: rate(pass, total), cost: cs.length ? sum(cs) : null } };
  }
  if (ungraded.length) console.error(`${ungraded.length} results have no grade yet (run check, or blind and unblind): ${ungraded.slice(0, 5).join(", ")}…`);
  const rivals = Object.entries(scores.arms).filter(([, v]) => !v.baseline && v.all.total);
  rivals.sort(([, x], [, y]) => y.all.rate - x.all.rate || (x.all.cost ?? 0) - (y.all.cost ?? 0));
  scores.best = typeof opt.winner === "string" ? opt.winner : rivals[0]?.[0] ?? null;
  predictions(scores);
  writeJson(join(K.round(n), "scores.json"), scores);

  const row = {
    round: n,
    at: scores.at,
    base: arms[Object.keys(arms).find((a) => !arms[a].baseline) ?? ""]?.base ?? null,
    arms: Object.fromEntries(Object.entries(scores.arms).map(([a, v]) => [a, { label: v.label, baseline: v.baseline, change: v.change, ref: v.ref, rate: v.all.rate, pass: v.all.pass, total: v.all.total, cost: v.all.cost, perModel: Object.fromEntries(Object.entries(v.models).map(([s, x]) => [s, x.rate])), ...(v.prediction ? { prediction: predictionCounts(v.prediction) } : {}) }])),
    best: scores.best,
    ...(typeof opt.note === "string" ? { note: opt.note } : {}),
  };
  const rows = K.ledger().filter((r) => r.round !== n);
  rows.push(row);
  rows.sort((x, y) => x.round - y.round);
  writeFileSync(K.ledgerFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const [a, v] of Object.entries(scores.arms)) console.log(`${a} ${v.label}${v.baseline ? " (baseline)" : ""}: ${v.all.pass}/${v.all.total} = ${v.all.rate}%${v.all.cost !== null ? `, $${v.all.cost.toFixed(4)}` : ""}`);
  for (const [a, v] of Object.entries(scores.arms)) {
    const p = v.prediction;
    if (!p) continue;
    console.log(
      p.stated
        ? `${a} predicted vs observed: expected to fix ${p.expectFix.length}: ${p.fixedExpected.n} fixed, ${p.notFixed.n} not; ${p.fixedUnexpected.n} fixed without being expected; at risk ${p.mayBreak.length}: ${p.brokeExpected.n} broken; ${p.brokeUnexpected.n} broken without being expected`
        : `${a} stated no prediction: ${p.fixedUnexpected.n} fixed, ${p.brokeUnexpected.n} broken`,
    );
  }
  console.log(`best: ${scores.best ?? "none"}`);
}

if (sub === "check" || sub === "all") doCheck();
if (sub === "blind") doBlind();
if (sub === "unblind") doUnblind();
if (sub === "total" || sub === "all") doTotal();
