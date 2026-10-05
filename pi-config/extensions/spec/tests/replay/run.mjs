#!/usr/bin/env node
// Replay the fixed scenarios against two tool trees and report the difference.
//
//   node run.mjs --baseline <extensions dir> --candidate <extensions dir> [--out <dir>] [--only a,b,…] [--json]
//
// Each tree is a copy of `pi-config/extensions` (spec/, mode/, claude-code/); make one from a ref with
// `node make-tree.mjs <ref> <dest>`. Writes scorecard-baseline.json, scorecard-candidate.json and
// diff.json to --out (default: a temp dir, printed), and prints a one-screen summary.
// Exit: 0 every guard held in both arms; 1 a guard failed in either arm; 2 usage or a crashed scenario.
import "../../../claude-code/tests/hermetic-env.mjs"; // first: a throwaway HOME, whatever the caller's
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tools, workspace, scrubProcessEnv, stable } from "./lib.mjs";
import { SCENARIOS, moduleLoader } from "./scenarios.mjs";

/** Where a tree came from: `make-tree.mjs` leaves replay-source.json two levels up. */
export function treeSource(tree) {
  const file = join(tree, "../../replay-source.json");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** One arm: every selected scenario against `tree`, in a fresh workspace. Paths in values are normalized. */
export async function runArm(tree, { label, only, pinned } = {}) {
  scrubProcessEnv();
  const abs = realpathSync(resolve(tree));
  for (const need of ["spec/core/sova-spec.mjs", "mode/spec-guard.ts", "claude-code/spec-hooks.ts"])
    if (!existsSync(join(abs, need))) throw new Error(`${tree} is not an extensions tree: no ${need}`);
  const ws = workspace(label ?? "arm");
  const ctx = { tools: new Tools(abs), ws, module: moduleLoader(abs), ...(pinned ? { pinned: realpathSync(resolve(pinned)) } : {}) };
  const rows = [];
  const errors = [];
  try {
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      if (only && !only.includes(key)) continue;
      try { rows.push(...(await scenario(ctx))); }
      catch (e) { errors.push({ scenario: key, error: String(e?.stack ?? e) }); rows.push({ scenario: key, metric: `${key}.crashed`, value: String(e?.message ?? e).split("\n")[0], guards: [{ name: `${key}.ran`, ok: false, detail: "the scenario threw" }] }); }
    }
  } finally { ws.dispose(); }
  const normalize = (s) => s.split(ws.base).join("<tmp>").split(abs).join("<tree>");
  return {
    arm: label ?? null,
    tree: abs,
    source: treeSource(abs),
    rows: JSON.parse(normalize(JSON.stringify(rows))),
    ...(errors.length ? { errors: JSON.parse(normalize(JSON.stringify(errors))) } : {}),
  };
}

/** The harness's own commit, and whether its directory has uncommitted changes. */
export function harnessCommit() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const head = spawnSync("git", ["-C", here, "rev-parse", "HEAD"], { encoding: "utf8" });
  const dirty = spawnSync("git", ["-C", here, "status", "--porcelain", "--", "."], { encoding: "utf8" });
  return head.status === 0 ? { commit: head.stdout.trim(), dirty: Boolean(dirty.stdout.trim()) } : null;
}

/** A guard's result in one arm: true, false, "n/a" (the tree lacks what it checks; never a pass), or null (absent). */
const guardState = (g) => (g === undefined ? null : g.na ? "n/a" : g.ok);

/** A changed value, shortened: for two objects, only the keys that differ. */
function change(a, b) {
  const cell = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 46 ? `${s.slice(0, 45)}…` : s; };
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!obj(a) || !obj(b)) return `${cell(a)} → ${cell(b)}`;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stable(a[k]) !== stable(b[k]));
  return keys.map((k) => `${k} ${cell(a[k])} → ${cell(b[k])}`).join("; ");
}

/** Per-row difference of two scorecards, by metric. */
export function diffCards(baseline, candidate) {
  const byMetric = (card) => new Map(card.rows.map((r) => [r.metric, r]));
  const b = byMetric(baseline), c = byMetric(candidate);
  const metrics = [...new Set([...b.keys(), ...c.keys()])];
  const rows = metrics.map((metric) => {
    const x = b.get(metric), y = c.get(metric);
    const guards = [...new Set([...(x?.guards ?? []), ...(y?.guards ?? [])].map((g) => g.name))].map((name) => ({
      name, baseline: guardState(x?.guards.find((g) => g.name === name)), candidate: guardState(y?.guards.find((g) => g.name === name)),
    }));
    const changed = stable(x?.value) !== stable(y?.value) || guards.some((g) => g.baseline !== g.candidate);
    return { metric, scenario: (x ?? y).scenario, baseline: x ? x.value : null, candidate: y ? y.value : null, changed, guards };
  });
  return { changed: rows.filter((r) => r.changed).length, rows };
}

const failedGuards = (card) => card.rows.flatMap((r) => r.guards.filter((g) => !g.ok && !g.na).map((g) => `${g.name}: ${g.detail}`));

/** The one-screen summary. */
export function summary(baseline, candidate, diff) {
  const src = (card) => (card.source ? `${card.source.ref} @ ${card.source.commit.slice(0, 12)}` : "working tree (no replay-source.json)");
  const cell = (v) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 46 ? `${s.slice(0, 45)}…` : s; };
  const lines = [`baseline:  ${src(baseline)}`, `candidate: ${src(candidate)}`, ""];
  const w = Math.max(...diff.rows.map((r) => r.metric.length));
  for (const r of diff.rows) {
    const guards = r.guards.length ? ` [${r.guards.map((g) => (g.candidate === "n/a" ? "–" : g.candidate ? "✓" : "✗")).join("")}]` : "";
    lines.push(`${r.changed ? "*" : " "} ${r.metric.padEnd(w)}  ${r.changed ? change(r.baseline, r.candidate) : cell(r.candidate)}${guards}`);
  }
  const bf = failedGuards(baseline), cf = failedGuards(candidate);
  lines.push("", `${diff.changed} of ${diff.rows.length} rows differ; guards failed: baseline ${bf.length}, candidate ${cf.length}`);
  for (const f of cf) lines.push(`  candidate ✗ ${f}`);
  for (const f of bf) lines.push(`  baseline ✗ ${f}`);
  const targets = diff.rows.filter((r) => /\.target\./.test(r.metric));
  if (targets.length) lines.push("", "Targets (what a milestone moves; never guards), baseline → candidate:");
  for (const r of targets) lines.push(`  ${r.metric}: ${r.changed ? change(r.baseline, r.candidate) : `${cell(r.candidate)} (unchanged)`}`);
  return lines.join("\n");
}

async function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--baseline", "--candidate", "--out", "--only", "--pinned"].includes(a) && i + 1 < argv.length) opt[a.slice(2)] = argv[++i];
    else if (a === "--json") opt.json = true;
    else { console.error(`unknown argument ${a}`); return 2; }
  }
  if (!opt.baseline || !opt.candidate) { console.error("usage: node run.mjs --baseline <extensions dir> --candidate <extensions dir> [--out <dir>] [--only a,b,…,g] [--pinned <dir holding .sova/spec>] [--json]"); return 2; }
  const only = opt.only?.split(",");
  const baseline = await runArm(opt.baseline, { label: "baseline", only, pinned: opt.pinned });
  const candidate = await runArm(opt.candidate, { label: "candidate", only, pinned: opt.pinned });
  const diff = diffCards(baseline, candidate);
  const out = opt.out ? resolve(opt.out) : mkdtempSync(join(tmpdir(), "spec-replay-out-"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "scorecard-baseline.json"), JSON.stringify(baseline, null, 2) + "\n");
  writeFileSync(join(out, "scorecard-candidate.json"), JSON.stringify(candidate, null, 2) + "\n");
  writeFileSync(join(out, "diff.json"), JSON.stringify(diff, null, 2) + "\n");
  writeFileSync(join(out, "summary.txt"), summary(baseline, candidate, diff) + "\n");
  writeFileSync(join(out, "run.json"), JSON.stringify({ baseline: baseline.source ?? baseline.tree, candidate: candidate.source ?? candidate.tree, harness: harnessCommit(), command: ["node", "run.mjs", ...argv].join(" "), date: new Date().toISOString() }, null, 2) + "\n");
  if (opt.json) process.stdout.write(JSON.stringify({ out, diff }) + "\n");
  else console.log(`${summary(baseline, candidate, diff)}\n\nscorecards and diff: ${out}`);
  if (baseline.errors || candidate.errors) return 2;
  return failedGuards(baseline).length || failedGuards(candidate).length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
