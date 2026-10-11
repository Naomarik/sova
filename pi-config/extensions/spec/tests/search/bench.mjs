#!/usr/bin/env node
// Topic-search bench: runs every query of a judgments file through the spec CLI exactly as an agent
// types it (`where summary tree`: the words as separate, unquoted arguments), reads the JSON and
// scores the order of the § ids it lists against the judged targets.
//
//   node bench.mjs [--set dev|<path>] [--cli <sova-spec.mjs>] [--root <project root>]
//                  [--label <name>] [--quoted] [--ranks] [--no-write]
//
// --ranks also prints, for a dev run, one line per query: id, primary rank, any rank, gap, query, top 3.
//
// Ranking: the ids of the answer's `lines`, in order, first appearance only; whatever the line's type.
// --quoted passes the query as one argument instead (`where 'summary tree'`), for a CLI that refuses
// several words. Only what one call prints counts (no --all, no cursor): that is what the agent sees.
// Metrics, over primary targets: R@1, R@3, MRR (1/rank of the first primary; 0 when absent).
// R@3 any also counts acceptable targets. Split by vocabulary gap (no stem of the query in its
// primary target's title or what) and by leak band (under 0.5 / 0.5 and up), so leaky queries
// can't carry the headline. Bytes are the answer's stdout; exit is the CLI's exit code.
//
// The dev set's result file lists every query; any other set's lists aggregates only, so a
// held-out run never writes its queries into the repo.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function rankingOf(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return { ids: [], parsed: false }; }
  const ids = [];
  for (const l of Array.isArray(j?.lines) ? j.lines : []) {
    if (typeof l?.id === "string" && l.id.startsWith("§") && !ids.includes(l.id)) ids.push(l.id);
  }
  return { ids, parsed: true };
}

export function scoreOne(ids, targets) {
  const primary = new Set(targets.primary);
  const any = new Set([...targets.primary, ...(targets.acceptable ?? [])]);
  const rp = ids.findIndex((id) => primary.has(id)) + 1;
  const ra = ids.findIndex((id) => any.has(id)) + 1;
  return {
    rankPrimary: rp || null,
    rankAny: ra || null,
    r1: rp === 1 ? 1 : 0,
    r3: rp >= 1 && rp <= 3 ? 1 : 0,
    r3any: ra >= 1 && ra <= 3 ? 1 : 0,
    rr: rp ? 1 / rp : 0,
  };
}

export function aggregate(rows) {
  const n = rows.length;
  const mean = (k) => (n ? rows.reduce((a, r) => a + r[k], 0) / n : 0);
  const bytes = rows.map((r) => r.bytes).sort((a, b) => a - b);
  const exits = {};
  for (const r of rows) exits[r.exit] = (exits[r.exit] ?? 0) + 1;
  return {
    n,
    r1: mean("r1"), r3: mean("r3"), mrr: mean("rr"), r3any: mean("r3any"),
    meanBytes: Math.round(mean("bytes")),
    medianBytes: n ? bytes[Math.floor((n - 1) / 2)] : 0,
    maxBytes: n ? bytes[n - 1] : 0,
    meanResults: Math.round(mean("results") * 10) / 10,
    exits,
  };
}

function rel(p, root) {
  const r = path.relative(root, p);
  return r.startsWith("..") || path.isAbsolute(r) ? `(outside the repo)/${path.basename(p)}` : r;
}

function git(root, args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; }
}

export function run({ set = "dev", cli, root, label, quoted = false, ranks = false, write = true } = {}) {
  root = path.resolve(root ?? path.join(HERE, "../../../../.."));
  cli = path.resolve(cli ?? path.join(HERE, "../../core/sova-spec.mjs"));
  const file = set === "dev" ? path.join(HERE, "judgments.dev.json") : path.resolve(set);
  const judgments = JSON.parse(fs.readFileSync(file, "utf8"));
  const setName = judgments.set ?? path.basename(file, ".json");
  const rows = [];
  for (const q of judgments.queries) {
    const words = quoted ? [q.query.trim()] : q.query.trim().split(/\s+/);
    const argv = [cli, "where", ...words, "--root", root, "--json"];
    const t0 = process.hrtime.bigint();
    const p = spawnSync(process.execPath, argv, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const stdout = p.stdout ?? "";
    const { ids, parsed } = rankingOf(stdout);
    rows.push({
      id: q.id, query: q.query, vocabularyGap: !!q.vocabularyGap, leak: q.leak ?? null, targets: q.targets,
      exit: p.status ?? `signal ${p.signal}`, parsed, bytes: Buffer.byteLength(stdout), ms: Math.round(ms),
      results: ids.length, top: ids.slice(0, 3), ...scoreOne(ids, q.targets),
    });
  }
  const groups = {
    all: aggregate(rows),
    "vocabulary gap": aggregate(rows.filter((r) => r.vocabularyGap)),
    "word overlap": aggregate(rows.filter((r) => !r.vocabularyGap)),
    "leak under 0.5": aggregate(rows.filter((r) => r.leak !== null && r.leak < 0.5)),
    "leak 0.5 and up": aggregate(rows.filter((r) => r.leak !== null && r.leak >= 0.5)),
  };
  const head = git(root, ["rev-parse", "--short=8", "HEAD"]);
  const coreRel = path.relative(root, path.dirname(cli));
  const coreDirty = coreRel.startsWith("..") ? null : git(root, ["status", "--porcelain", "--", coreRel]) !== "";
  const meta = {
    date: new Date().toISOString(),
    label: label ?? (coreDirty ? `worktree@${head}+dirty` : `worktree@${head}`),
    set: setName, file: rel(file, root), cli: rel(cli, root), head, coreDirty, args: quoted ? "one quoted argument" : "unquoted words",
    judgmentsSpecCommit: judgments.spec?.commit?.slice(0, 8) ?? null,
  };
  const out = { meta, groups, rows: setName === "dev" ? rows : undefined };
  const md = render(meta, groups, setName === "dev" ? rows : null);
  process.stdout.write(table(meta, groups));
  if (ranks && setName === "dev") for (const r of rows) process.stdout.write(`${r.id}\t${r.rankPrimary ?? "-"}\t${r.rankAny ?? "-"}\t${r.vocabularyGap ? "gap" : ""}\t${r.query}\t${r.top.join(" ")}\n`);
  if (write) {
    const dir = path.join(HERE, "results");
    fs.mkdirSync(dir, { recursive: true });
    const slug = meta.label.replace(/[^A-Za-z0-9._+-]+/g, "-");
    const base = `${setName === "dev" ? "dev" : "heldout"}-${meta.date.slice(0, 10)}-${slug}`;
    let name = base, i = 2;
    while (fs.existsSync(path.join(dir, `${name}.md`))) name = `${base}-${i++}`; // a result is never overwritten
    fs.writeFileSync(path.join(dir, `${name}.md`), md);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(out, null, 2) + "\n");
    process.stdout.write(`\nwrote ${rel(path.join(dir, `${name}.md`), root)} (+ .json)\n`);
  }
  return out;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function tableRows(groups) {
  const lines = ["| group | n | R@1 | R@3 | MRR | R@3 any | results (mean) | bytes mean / median / max | exit codes |",
    "|---|---|---|---|---|---|---|---|---|"];
  for (const [g, a] of Object.entries(groups)) {
    const exits = Object.entries(a.exits).map(([k, v]) => `${k}×${v}`).join(" ");
    lines.push(`| ${g} | ${a.n} | ${pct(a.r1)} | ${pct(a.r3)} | ${a.mrr.toFixed(3)} | ${pct(a.r3any)} | ${a.meanResults} | ${a.meanBytes} / ${a.medianBytes} / ${a.maxBytes} | ${exits} |`);
  }
  return lines.join("\n");
}

function table(meta, groups) {
  return `${meta.label} · set ${meta.set} (${meta.file}) · cli ${meta.cli} · ${meta.args}\n${tableRows(groups)}\n`;
}

function render(meta, groups, rows) {
  let md = `# Topic search bench: ${meta.label} on ${meta.set}\n\n`;
  md += `- date: ${meta.date}\n- set: ${meta.set} (\`${meta.file}\`, targets judged at spec ${meta.judgmentsSpecCommit})\n`;
  md += `- cli: \`${meta.cli}\` · repo HEAD ${meta.head}${meta.coreDirty ? " (core has uncommitted changes)" : ""} · query passed as ${meta.args}\n`;
  md += `- command: \`node pi-config/extensions/spec/tests/search/bench.mjs --set ${meta.set === "dev" ? "dev" : "<path>"}${meta.args === "one quoted argument" ? " --quoted" : ""}\`\n\n`;
  md += `${tableRows(groups)}\n`;
  if (rows) {
    md += `\n## Queries\n\nrank = rank of the first primary target (— absent); top = the first three ids listed.\n\n`;
    md += "| id | query | gap | exit | rank | rank any | results | bytes | top |\n|---|---|---|---|---|---|---|---|---|\n";
    for (const r of rows) {
      md += `| ${r.id} | ${r.query} | ${r.vocabularyGap ? "yes" : ""} | ${r.exit} | ${r.rankPrimary ?? "—"} | ${r.rankAny ?? "—"} | ${r.results} | ${r.bytes} | ${r.top.join(" ")} |\n`;
    }
  }
  return md;
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  run({ set: arg("--set") ?? "dev", cli: arg("--cli"), root: arg("--root"), label: arg("--label"), quoted: argv.includes("--quoted"), ranks: argv.includes("--ranks"), write: !argv.includes("--no-write") });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
