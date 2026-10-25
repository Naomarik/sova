#!/usr/bin/env node
// One tuning attempt: copies the core to a scratch dir (the OS temp dir, never the repo), overrides the
// topic ranker's constants there, runs the dev bench through that copy and appends one row to LOG.md.
//
//   node run.mjs --name <attempt> [--cfg '<json merged into TOPIC; weights merge per field>'] [--note <text>]
//
// Writes nothing under tests/search/results: the row in LOG.md is the record; per-query ranks go to the
// scratch dir beside the copy (<tmp>/spec-topic-variants/<attempt>/rows.json) for comparison.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { run } from "../bench.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(HERE, "../../../core");
const LOG = path.join(HERE, "LOG.md");

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const name = arg("--name");
if (!name || !/^[\w.+-]+$/.test(name)) { console.error("run.mjs --name <attempt> [--cfg JSON] [--note TEXT]"); process.exit(2); }
const cfg = JSON.parse(arg("--cfg") ?? "{}");

const dir = path.join(process.env.TMPDIR ?? os.tmpdir(), "spec-topic-variants", name);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(CORE)) if (f.endsWith(".mjs")) fs.copyFileSync(path.join(CORE, f), path.join(dir, f));
fs.appendFileSync(path.join(dir, "topic.mjs"),
  `\nObject.assign(TOPIC, ${JSON.stringify(cfg)}, { weights: { ...TOPIC.weights, ...(${JSON.stringify(cfg.weights ?? {})}) } });\n`);

// The ranker version the copy holds: a hash of topic.mjs and where.mjs as copied, before the override.
const coreHash = createHash("sha256").update(fs.readFileSync(path.join(CORE, "topic.mjs"))).update(fs.readFileSync(path.join(CORE, "where.mjs"))).digest("hex").slice(0, 8);
const out = run({ set: "dev", cli: path.join(dir, "sova-spec.mjs"), label: name, write: false });
fs.writeFileSync(path.join(dir, "rows.json"), JSON.stringify(out.rows, null, 2));
const pct = (x) => (x * 100).toFixed(1);
const g = out.groups, a = g.all, v = g["vocabulary gap"], w = g["word overlap"];
const row = `| ${name} | \`${JSON.stringify(cfg)}\` | ${pct(a.r1)} | ${pct(a.r3)} | ${a.mrr.toFixed(3)} | ${pct(a.r3any)} | ${pct(v.r3)} / ${v.mrr.toFixed(3)} | ${pct(w.r3)} / ${w.mrr.toFixed(3)} | ${a.meanBytes} | ${out.meta.head} · ${coreHash} | ${arg("--note") ?? ""} |\n`;
fs.appendFileSync(LOG, row);
process.stdout.write(row);
