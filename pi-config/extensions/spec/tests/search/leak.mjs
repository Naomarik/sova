#!/usr/bin/env node
// Leak check for a judgments file: for each query, the fraction of its distinct stems found in its
// primary target's title or first sentence (its `what`, as `toc` reports it). A query at 0 is a
// vocabulary-gap query. Prints the distribution and the median; the set is fit to rank against
// only when the median is well under 0.5.
//
//   node leak.mjs [--set dev|<path>] [--root <project root>] [--cli <sova-spec.mjs>] [--json]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overlap, stems } from "./text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The area a claim id sits in: §ns.area/claim → §ns/area; an area id is its own area. */
export function areaOf(id) {
  const m = /^§([a-z0-9-]+)\.([a-z0-9-]+)\/[a-z0-9-]+$/.exec(id);
  return m ? `§${m[1]}/${m[2]}` : id;
}

/** Title and what of every given id, read through `toc <area> --dir down`. */
export function readHeads(ids, { root, cli }) {
  const heads = new Map();
  for (const area of new Set(ids.map(areaOf))) {
    let cursor = null;
    do {
      const args = [cli, "toc", area, "--dir", "down", "--root", root, "--json", ...(cursor ? ["--cursor", cursor] : [])];
      let out;
      try {
        out = execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 << 20 });
      } catch (err) {
        if (err.status !== 1 || !err.stdout) throw err; // exit 1 is "more": another page follows
        out = err.stdout;
      }
      const j = JSON.parse(out);
      if (j.seed) heads.set(j.seed.id, { title: j.seed.title, what: j.seed.what ?? "" });
      for (const l of j.lines ?? []) if (l.id) heads.set(l.id, { title: l.title, what: l.what ?? "" });
      cursor = j.status === "more" ? j.next : null;
    } while (cursor);
  }
  return heads;
}

/** Leak of one query against its first primary target's title and what. */
export function leakOf(query, head) {
  return overlap(query, `${head.title} ${head.what}`);
}

export function summarize(values) {
  const v = [...values].sort((a, b) => a - b);
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const buckets = { "0": 0, "(0,0.25]": 0, "(0.25,0.5)": 0, "[0.5,0.75)": 0, "[0.75,1]": 0 };
  for (const x of v) {
    if (x === 0) buckets["0"]++;
    else if (x <= 0.25) buckets["(0,0.25]"]++;
    else if (x < 0.5) buckets["(0.25,0.5)"]++;
    else if (x < 0.75) buckets["[0.5,0.75)"]++;
    else buckets["[0.75,1]"]++;
  }
  const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  return { n: v.length, median, mean, buckets };
}

function main(argv) {
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const set = arg("--set", "dev");
  const file = set === "dev" ? path.join(HERE, "judgments.dev.json") : path.resolve(set);
  const root = path.resolve(arg("--root", path.join(HERE, "../../../../..")));
  const cli = path.resolve(arg("--cli", path.join(HERE, "../../core/sova-spec.mjs")));
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const heads = readHeads(j.queries.map((q) => q.targets.primary[0]), { root, cli });
  const rows = j.queries.map((q) => {
    const head = heads.get(q.targets.primary[0]);
    if (!head) throw new Error(`${q.id}: ${q.targets.primary[0]} not found in the spec`);
    const leak = leakOf(q.query, head);
    return { id: q.id, query: q.query, stems: stems(q.query), target: q.targets.primary[0], leak };
  });
  const s = summarize(rows.map((r) => r.leak));
  const gap = rows.filter((r) => r.leak === 0).length;
  if (argv.includes("--json")) { console.log(JSON.stringify({ file, ...s, vocabularyGap: gap, rows }, null, 2)); return; }
  console.log(`${path.basename(file)}: ${s.n} queries · leak median ${s.median.toFixed(3)} · mean ${s.mean.toFixed(3)} · vocabulary-gap ${gap}`);
  for (const [k, n] of Object.entries(s.buckets)) console.log(`  ${k.padEnd(11)} ${String(n).padStart(3)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
