#!/usr/bin/env node
// Regenerate shared/model-prices/seed.json from models.dev and print what changed
// (§app.project-costs/pricing). Run with `pnpm run prices:update` (tsx: it imports the shared
// TypeScript rule). Servers refresh their own host-local copy every 3 days; this updates the
// checked-in seed that a fresh host (or one with fetching off) starts from.
//
//   --from <file>  read a saved api.json instead of fetching
//   --check        write nothing; exit 1 if the seed's prices would change
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mergeFetched, normalizeModelsDev, parseTable, resolvePriceRef, EMPTY_TABLE } from "../shared/model-prices/prices.ts";

const ROOT = join(import.meta.dirname, "..");
const DIR = join(ROOT, "shared", "model-prices");
const SEED = join(DIR, "seed.json");
const URL = "https://models.dev/api.json";

const args = process.argv.slice(2);
const check = args.includes("--check");
const fromIdx = args.indexOf("--from");
const from = fromIdx >= 0 ? args[fromIdx + 1] : null;

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const aliases = readJson(join(DIR, "aliases.json"));
let base = EMPTY_TABLE;
try {
  base = parseTable(readJson(SEED)) ?? EMPTY_TABLE;
} catch {}

let api;
if (from) api = readJson(from);
else {
  const res = await fetch(URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${URL}: HTTP ${res.status}`);
  api = await res.json();
}

const at = new Date().toISOString();
const fetched = normalizeModelsDev(api, aliases);
const { table, report } = mergeFetched(base, fetched, at);

const fmt = (r) => Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ");
const lines = [];
for (const k of report.added) lines.push(`+ ${k}: ${fmt(fetched[k].rates)}`);
for (const k of report.changed) {
  const ps = table.models[k].periods;
  lines.push(`~ ${k}: ${fmt(ps[ps.length - 2].rates)}  ->  ${fmt(ps[ps.length - 1].rates)}${ps[ps.length - 1].tiers ? " (tiers updated)" : ""}`);
}
for (const k of Object.keys(base.models)) if (!fetched[k]) lines.push(`- ${k}: no longer on models.dev (history kept)`);
console.log(lines.length ? lines.join("\n") : "No price changes.");

// Every model Sova can run today, and what it resolves to now.
const known = new Set(["claude-code-cli/opus", "claude-code-cli/opus[1m]", "claude-code-cli/sonnet", "claude-code-cli/haiku", "claude-code-cli/claude-fable-5-1[1m]"]);
try {
  const models = readJson(join(ROOT, "pi-config", "models.json"));
  for (const [p, cfg] of Object.entries(models.providers ?? {})) for (const m of cfg.models ?? []) known.add(`${p}/${m.id}`);
} catch {}
try {
  const pkg = realpathSync(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent"));
  const { MODELS } = await import(join(dirname(pkg), "pi-ai", "dist", "models.generated.js"));
  for (const p of ["anthropic", "openai-codex", "zai", "deepseek"]) for (const id of Object.keys(MODELS[p] ?? {})) known.add(`${p}/${id}`);
} catch (err) {
  console.warn(`(pi-ai registry not read: ${err.message})`);
}
const unpriced = [];
for (const ref of [...known].sort()) {
  const i = ref.indexOf("/");
  const r = resolvePriceRef(table, aliases, { provider: ref.slice(0, i), model: ref.slice(i + 1) }, at);
  if ("unpriced" in r) unpriced.push(`  ${ref}: ${r.unpriced}`);
}
console.log(`\n${known.size} known models; ${unpriced.length} unpriced${unpriced.length ? ":\n" + unpriced.join("\n") : "."}`);

const changed = report.added.length + report.changed.length > 0;
if (check) process.exit(changed ? 1 : 0);
if (changed || !base.fetchedAt) {
  const tmp = `${SEED}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(table, null, 1)}\n`);
  renameSync(tmp, SEED);
  console.log(`\nWrote ${SEED.slice(ROOT.length + 1)}.`);
} else console.log("\nSeed unchanged.");
