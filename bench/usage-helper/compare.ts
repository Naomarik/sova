// Do the Bun and Rust helpers give the same answers on the same files? Generates a small history,
// copies it for each helper, asks both the same queries and diffs the JSON (numbers to 1e-6).
//
//   bun bench/usage-helper/compare.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runtimeCommand, startUsageHelper } from "../../server/usage-helper/client";

const ROOT = path.join(import.meta.dirname, "..", "..");
const work = path.join(ROOT, "tmp", "bench", `compare-${process.pid}`);
const src = path.join(work, "src");
fs.mkdirSync(path.join(src, "sova"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "shared", "model-prices", "seed.json"), path.join(src, "sova", "model-prices.json"));
const gen = (args: string[]) => {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "gen.ts"), "--agent-dir", src, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
gen(["--backfill-days", "3", "--per-day", "3000", "--tag", "h"]);
gen(["--rate", "200", "--seconds", "3", "--tag", "l"]);

const queries: Record<string, unknown>[] = [
  { op: "costs", range: "7d", tz: "Europe/Berlin" },
  { op: "costs", range: "30d", tz: "Asia/Kolkata" },
  { op: "costs", range: "all", tz: "America/New_York", provider: ["zai", "claude"] },
  { op: "costs", range: "all", tz: "UTC", model: ["openai-codex/gpt-6-astra"] },
  { op: "today", tz: "Pacific/Auckland" },
  { op: "session", sid: "0199main-0000-7000-8000-000000000000" },
  { op: "session", sid: "0199work-0000-7000-8000-000000000001" },
  { op: "sessions", sids: ["0199main-0000-7000-8000-000000000003", "0199main-0000-7000-8000-000000000004", "nobody"] },
];

async function answers(which: "bun" | "rust"): Promise<unknown[]> {
  const dir = path.join(work, which);
  fs.cpSync(src, dir, { recursive: true });
  const command = which === "rust" ? { exe: path.join(import.meta.dirname, "rust", "target", "release", "usage-helper-rs"), args: [] } : runtimeCommand(path.join(ROOT, "server", "usage-helper", "main.ts"));
  const h = startUsageHelper({ env: { ...process.env, PI_CODING_AGENT_DIR: dir, SOVA_PRICES_FETCH: "off", SOVA_USAGE_ALIASES: path.join(ROOT, "shared", "model-prices", "aliases.json") }, command, log: () => {} });
  for (let i = 0; i < 500 && (await h.request("stats")).status !== 200; i++) await new Promise((r) => setTimeout(r, 20));
  const out = [];
  for (const { op, ...q } of queries) {
    const a = await h.request(op as string, q);
    out.push(JSON.parse(a.body.toString()));
  }
  await h.stop();
  return out;
}

/** Fields that legitimately differ: clocks, and the price standing (the Rust twin never downloads). */
const SKIP = new Set(["asOf", "prices", "fetching", "enabled"]);
function diff(a: unknown, b: unknown, at: string, out: string[]): void {
  if (out.length > 30) return;
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(a))) out.push(`${at}: ${a} != ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${at}: length ${a.length} != ${b.length}`);
    // Rows tied on usd may come in either order: compare as sorted by their JSON.
    const canon = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).filter((k) => !SKIP.has(k)).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v;
    const key = (x: unknown) => JSON.stringify(canon(x));
    const sa = [...a].sort((x, y) => key(x).localeCompare(key(y)));
    const sb = [...b].sort((x, y) => key(x).localeCompare(key(y)));
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) diff(sa[i], sb[i], `${at}[${i}]`, out);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!SKIP.has(k)) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`, out);
    return;
  }
  if (a !== b) out.push(`${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

const [bun, rust] = [await answers("bun"), await answers("rust")];
const problems: string[] = [];
queries.forEach((q, i) => diff(bun[i], rust[i], `${q.op}${q.range ? `:${q.range}` : ""}#${i}`, problems));
fs.rmSync(work, { recursive: true, force: true });
console.log(problems.length ? `DIFFER:\n${problems.join("\n")}` : `same answers on ${queries.length} queries`);
process.exit(problems.length ? 1 : 0);
