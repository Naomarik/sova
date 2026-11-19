#!/usr/bin/env node
// The A/B cycle's chart: a round's pass rates as Sova `vis` blocks and a table, master's Round 0 always
// the first series. Prints markdown to paste into the report, and saves it as rounds/<n>/chart.md.
//
//   node chart.mjs <campaign> --round <n>     this round against master and the best so far, then the trend
//   node chart.mjs <campaign> --sample        the shape of the charts with made-up numbers, for the first stop
//
// Higher is better everywhere: every number is the share of cases that passed, so 100% is the goal.
// Under the table, Predicted vs observed: one row per candidate arm, what its fix was expected to fix
// and to risk beside what it did (score.mjs total counts it). An arm that stated no prediction says so.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { args, campaign, die, modelText, readJson, slug } from "./lib.mjs";
import { predictionTable, samplePredictionTable } from "./record-lib.mjs";

const { pos, opt } = args();
if (!pos[0] || (opt.round === undefined && !opt.sample)) die("usage: chart.mjs <campaign> --round <n> | --sample", 3);
const K = campaign(pos[0]);
const models = K.models(opt.models);
const q = (s) => `"${String(s).replace(/"/g, "'")}"`;
const short = (m) => modelText(m).replace(/^[^/]+\//, "").replace(/^claude-/, "");
const pct = (v) => (v === null || v === undefined ? "-" : `${v}%`);
/** A model's folder name as the chart calls it. */
const label = (s) => {
  const m = models.find((x) => slug(x) === s);
  return m ? short(m) : s;
};

/** One grouped bar chart: rows are the test models and All, series the columns given. */
function bars(title, caption, columns) {
  const lines = ["```vis chart", `title: ${title}`, `caption: ${caption}`, "type: bar", "unit: %", `series: ${columns.map((c) => c.name.replace(/,/g, "")).join(", ")}`];
  for (const m of models) lines.push(`${q(short(m))} ${columns.map((c) => c.perModel[slug(m)] ?? "-").join(" ")}`);
  lines.push(`"All" ${columns.map((c) => c.all ?? "-").join(" ")}`);
  lines.push("```");
  return lines.join("\n");
}

if (opt.sample) {
  const fake = (base) => Object.fromEntries(models.map((m, i) => [slug(m), Math.min(100, base + 10 * i)]));
  const out = [
    bars("Sample: what each round's chart looks like", "Made-up numbers. Each bar: the share of cases that passed. Master is Round 0, measured once.", [
      { name: "Master (Round 0)", perModel: fake(40), all: 50 },
      { name: "This round: B", perModel: fake(70), all: 80 },
    ]),
    "",
    "| Arm | Model | Passed | Rate | Cost | Avg time |",
    "|---|---|---|---|---|---|",
    ...models.map((m) => `| B | ${modelText(m)} | 8/10 | 80% | $0.01 | 20 s |`),
    "",
    samplePredictionTable(models.map(slug), label),
  ].join("\n");
  console.log(out);
  process.exit(0);
}

const n = Number(opt.round);
const scores = readJson(join(K.round(n), "scores.json"));
const ledger = K.ledger();
const r0 = ledger.find((r) => r.round === 0);
const master = r0 && Object.values(r0.arms).find((a) => a.baseline);
const columns = [];
if (master) columns.push({ name: "Master (Round 0)", perModel: master.perModel, all: master.rate });
// The best arm of any earlier round: what this round has to beat besides master.
const earlier = ledger.filter((r) => r.round > 0 && r.round < n && r.best && r.arms[r.best]);
earlier.sort((x, y) => y.arms[y.best].rate - x.arms[x.best].rate);
if (earlier[0]) columns.push({ name: `Best so far: Round ${earlier[0].round} ${earlier[0].best}`, perModel: earlier[0].arms[earlier[0].best].perModel, all: earlier[0].arms[earlier[0].best].rate });
for (const [a, v] of Object.entries(scores.arms)) {
  if (v.baseline && n !== 0) continue;
  columns.push({ name: n === 0 ? `Master (Round 0)` : `Round ${n} ${a}`, perModel: Object.fromEntries(Object.entries(v.models).map(([s, x]) => [s, x.rate])), all: v.all.rate });
}
const cols = n === 0 ? columns.slice(-1) : columns.slice(0, 6);

const parts = [bars(`Round ${n}: share of cases passed`, "Higher is better; 100% means every case passed. Master is Round 0, measured once.", cols)];

// The trend: each round's best arm (master for Round 0), one line per test model.
const rounds = ledger.filter((r) => r.round === 0 || (r.best && r.arms[r.best]));
if (rounds.length > 1) {
  const pick = (r) => (r.round === 0 ? master : r.arms[r.best]);
  const lines = ["```vis chart", "title: Each round's best, against master", "caption: Round 0 is master. Higher is better.", "type: line", "unit: %", `series: ${models.slice(0, 6).map((m) => short(m).replace(/,/g, "")).join(", ")}`];
  for (const r of rounds) lines.push(`${q(r.round === 0 ? "Round 0 master" : `Round ${r.round} ${r.best}`)} ${models.slice(0, 6).map((m) => pick(r)?.perModel?.[slug(m)] ?? "-").join(" ")}`);
  lines.push("```");
  parts.push(lines.join("\n"));
}

const table = ["| Arm | What changed | Model | Passed | Rate | Cost | Avg time |", "|---|---|---|---|---|---|---|"];
for (const [a, v] of Object.entries(scores.arms))
  for (const x of Object.values(v.models)) table.push(`| ${a}${v.baseline ? " (master)" : ""} | ${(v.change ?? "").replace(/\|/g, "/").slice(0, 80)} | ${modelText(x)} | ${x.pass}/${x.total} | ${pct(x.rate)} | ${x.cost === null ? "-" : `$${x.cost.toFixed(4)}`} | ${x.ms === null ? "-" : `${Math.round(x.ms / 1000)} s`} |`);
parts.push(table.join("\n"));
const predicted = Object.entries(scores.arms)
  .filter(([, v]) => v.prediction)
  .map(([a, v]) => ({ arm: a, prediction: v.prediction }));
if (predicted.length) parts.push(predictionTable(predicted, label));
if (scores.best) parts.push(`Best this round: **${scores.best}** (${scores.arms[scores.best]?.all.rate}% over every test model).`);

const md = parts.join("\n\n");
writeFileSync(join(K.round(n), "chart.md"), `${md}\n`);
console.log(md);
