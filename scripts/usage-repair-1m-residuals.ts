#!/usr/bin/env bun
// A one-off repair of the usage ledger's files: removes the Claude Code residual records keyed by a
// `[1m]` model (`ccr:<session>:<total>:claude-opus-5-5[1m]`) from the 4–7 Oct 2026 days, each of
// which counted its whole turn a second time (server/usage-helper/records.ts isDoubledResidual).
//
//   bun scripts/usage-repair-1m-residuals.ts [--agent-dir <dir>] [--write [--assume-stopped]] [--json]
//
// Default agent dir: $PI_CODING_AGENT_DIR, else ~/.pi/agent. Without --write it changes nothing: it
// shows, per day and file, what it would remove, and the expected drop in dollars, by model.
// With --write, run while Sova's server is stopped (it refuses while a server or usage helper on
// this agent dir runs, and when it can't see this machine's processes, as in a sandbox, unless
// --assume-stopped says you stopped it yourself):
//   1. copies the four day folders, and the usage helper's saved snapshots of those days, to
//      `<agent dir>/usage/v1-backup-<yyyymmdd-hhmmss>/` (beside `v1`, which nothing reads);
//   2. rewrites each file without those lines (a sealed `.jsonl.gz` gzipped again as the helper
//      seals it), each through a temporary file and a rename;
//   3. deletes those days' snapshots (`<agent dir>/sova/usage-ledger/days/<day>.snap`), so the
//      helper folds the days again from the files when the server next starts: no saved offset
//      or row of a rewritten file is reused.
// Undo: stop the server, put the backup's day folders back under usage/v1 and its snapshots back
// under sova/usage-ledger/days, and start the server again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { defaultAgentDir, parseUsageLine, usageRoot, type UsageRecord } from "../pi-config/extensions/llm-inflight/usage-record";
import { type Aliases, parseTable, type PriceTable, priceUsage } from "../shared/model-prices/prices";
import { ALIASES_FILE, SEED_FILE } from "../server/usage-helper/price-book";
import { isDoubledResidual, usageOf } from "../server/usage-helper/records";

/** The days the doubled residuals were written: before the fix of 7 Oct 2026. */
export const REPAIR_DAYS = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"] as const;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jsonl(\.gz)?$/;

export interface FilePlan {
  day: string;
  file: string;
  /** Lines in the file now, and how many go. */
  lines: number;
  remove: number;
}

export interface ModelTotal {
  /** `provider/model`, the model without its `[1m]`. */
  model: string;
  calls: number;
  usd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface RepairPlan {
  agentDir: string;
  days: string[];
  files: FilePlan[];
  /** Distinct records that go (a key counts once a day, as the ledger counts it). */
  records: number;
  /** Lines that go (a record written twice is two lines). */
  lines: number;
  /** The four days as the ledger counted them before, and as it will after, by model; and the drop. */
  before: ModelTotal[];
  after: ModelTotal[];
  dropUsd: number;
  /** Day folders that hold a half-done write of the helper (`.sealing`, `.tmp`): no --write then. */
  unsettled: string[];
  /** Snapshot files of those days that a --write deletes. */
  snapshots: string[];
}

const readText = (file: string): string => {
  const buf = fs.readFileSync(file);
  return file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
};

/** The lines of a file as the ledger reads them: whole lines only (an unterminated tail stays as it is). */
const splitLines = (text: string): { lines: string[]; tail: string } => {
  const last = text.lastIndexOf("\n");
  const body = last >= 0 ? text.slice(0, last) : "";
  return { lines: body ? body.split("\n") : last >= 0 ? [""] : [], tail: text.slice(last + 1) };
};

export function loadPrices(agentDir: string): { table: PriceTable; aliases: Aliases } {
  const file = [path.join(agentDir, "sova", "model-prices.json"), SEED_FILE].find((f) => fs.existsSync(f))!;
  const table = parseTable(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!table) throw new Error(`${file} is not a price table`);
  return { table, aliases: JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8")) as Aliases };
}

const modelOf = (r: UsageRecord) => `${r.provider}/${r.model.replace(/\[1m\]$/i, "")}`;

function addTotal(by: Map<string, ModelTotal>, r: UsageRecord, usd: number): void {
  const k = modelOf(r);
  const t = by.get(k) ?? { model: k, calls: 0, usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  t.calls++;
  t.usd += usd;
  t.tokens.input += r.input;
  t.tokens.output += r.output;
  t.tokens.cacheRead += r.cacheRead;
  t.tokens.cacheWrite += r.cacheWrite;
  by.set(k, t);
}

const sorted = (by: Map<string, ModelTotal>) => [...by.values()].sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));

/** What a repair would do, reading only. */
export function planRepair(agentDir: string, prices: { table: PriceTable; aliases: Aliases }, days: readonly string[] = REPAIR_DAYS): RepairPlan {
  const root = usageRoot(agentDir);
  const files: FilePlan[] = [];
  const before = new Map<string, ModelTotal>();
  const after = new Map<string, ModelTotal>();
  const unsettled: string[] = [];
  const snapshots: string[] = [];
  let records = 0;
  let lines = 0;
  const present: string[] = [];
  for (const day of days) {
    const dir = path.join(root, day);
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    present.push(day);
    const snap = path.join(agentDir, "sova", "usage-ledger", "days", `${day}.snap`);
    if (fs.existsSync(snap)) snapshots.push(snap);
    for (const n of names) if (n.endsWith(".sealing") || n.endsWith(".tmp")) unsettled.push(path.join(day, n));
    // The ledger keeps the first record of a key in a day and drops the rest.
    const seen = new Set<string>();
    for (const file of names.filter((n) => FILE_RE.test(n))) {
      const { lines: all } = splitLines(readText(path.join(dir, file)));
      let remove = 0;
      for (const line of all) {
        const r = line ? parseUsageLine(line) : null;
        if (!r) continue;
        const doubled = isDoubledResidual(r);
        if (doubled) remove++;
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        const priced = priceUsage(prices.table, prices.aliases, { provider: r.provider, model: r.model, ...(r.responseModel ? { responseModel: r.responseModel } : {}) }, usageOf(r), r.ts);
        const usd = priced.status === "priced" ? priced.usd.total : 0;
        addTotal(before, r, usd);
        if (doubled) records++;
        else addTotal(after, r, usd);
      }
      lines += remove;
      files.push({ day, file, lines: all.length, remove });
    }
  }
  const sum = (by: Map<string, ModelTotal>) => [...by.values()].reduce((s, t) => s + t.usd, 0);
  return { agentDir, days: present, files, records, lines, before: sorted(before), after: sorted(after), dropUsd: sum(before) - sum(after), unsettled, snapshots };
}

/**
 * Processes that read or write this agent dir's ledger: a Sova server or a usage helper whose agent
 * dir is this one. Linux reads /proc; elsewhere it can't tell, and says so (null).
 */
export function runningOn(agentDir: string, procRoot = "/proc"): { pid: number; cmd: string }[] | null {
  if (!fs.existsSync(path.join(procRoot, "self"))) return null;
  // In a pid namespace of its own (a sandbox, a container) /proc shows only that namespace: a
  // server outside it is invisible, so the check can't tell.
  try {
    const init = fs.readFileSync(path.join(procRoot, "1", "cmdline"), "utf8");
    if (/bwrap|firejail|nsjail/.test(init) || fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)).length < 20) return null;
  } catch {
    return null;
  }
  const want = realpathOr(agentDir);
  const out: { pid: number; cmd: string }[] = [];
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let cmd: string;
    try {
      cmd = fs.readFileSync(path.join(procRoot, name, "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
    } catch {
      continue;
    }
    if (!/usage-helper\/main\.ts|server\/index\.ts|scripts\/start-server\.sh/.test(cmd)) continue;
    let env: Record<string, string> | null = null;
    try {
      env = Object.fromEntries(
        fs
          .readFileSync(path.join(procRoot, name, "environ"), "utf8")
          .split("\0")
          .filter(Boolean)
          .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
      );
    } catch {
      // Its environment isn't ours to read: it may be on this agent dir, so it counts.
    }
    const dir = env ? (env.PI_CODING_AGENT_DIR ? defaultAgentDir(env) : path.join(env.HOME ?? os.homedir(), ".pi", "agent")) : null;
    if (dir === null || realpathOr(dir) === want) out.push({ pid: Number(name), cmd });
  }
  return out;
}

const realpathOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** Back up, rewrite, discard the snapshots. Returns the backup folder. */
export function applyRepair(plan: RepairPlan, now = new Date()): string {
  if (plan.unsettled.length) throw new Error(`a usage helper left a half-done write (${plan.unsettled.join(", ")}): start and stop the server once, then run this again`);
  const root = usageRoot(plan.agentDir);
  const backup = path.join(path.dirname(root), `v1-backup-${stamp(now)}`);
  if (fs.existsSync(backup)) throw new Error(`${backup} already exists`);
  // 1. The backup, checked byte for byte before anything changes.
  for (const day of plan.days) {
    fs.cpSync(path.join(root, day), path.join(backup, day), { recursive: true, preserveTimestamps: true, errorOnExist: true });
    for (const f of fs.readdirSync(path.join(root, day))) {
      const a = fs.readFileSync(path.join(root, day, f));
      const b = fs.readFileSync(path.join(backup, day, f));
      if (!a.equals(b)) throw new Error(`backup of ${day}/${f} differs from the original; nothing was changed`);
    }
  }
  if (plan.snapshots.length) {
    fs.mkdirSync(path.join(backup, "usage-ledger-days"), { recursive: true });
    for (const s of plan.snapshots) fs.copyFileSync(s, path.join(backup, "usage-ledger-days", path.basename(s)));
  }
  // 2. Each file without the doubled residuals.
  for (const f of plan.files) {
    if (!f.remove) continue;
    const file = path.join(root, f.day, f.file);
    const text = readText(file);
    const { lines, tail } = splitLines(text);
    const kept = lines.filter((line) => {
      const r = line ? parseUsageLine(line) : null;
      return !(r && isDoubledResidual(r));
    });
    const body = Buffer.from(kept.length ? `${kept.join("\n")}\n${tail}` : tail, "utf8");
    const tmp = `${file}.repair-tmp`;
    fs.writeFileSync(tmp, file.endsWith(".gz") ? zlib.gzipSync(body) : body);
    fs.renameSync(tmp, file);
  }
  // 3. The days' snapshots go, so the helper folds them again from the files.
  for (const s of plan.snapshots) fs.rmSync(s, { force: true });
  return backup;
}

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const big = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function formatPlan(plan: RepairPlan): string {
  const out: string[] = [];
  out.push(`Agent dir: ${plan.agentDir}`);
  out.push(`Days: ${plan.days.join(", ") || "none of 2026-10-04..07 here"}`);
  for (const day of plan.days) {
    const fs_ = plan.files.filter((f) => f.day === day);
    const rm = fs_.reduce((s, f) => s + f.remove, 0);
    out.push(`  ${day}: ${rm} of ${fs_.reduce((s, f) => s + f.lines, 0)} lines go, in ${fs_.filter((f) => f.remove).length} of ${fs_.length} files`);
    for (const f of fs_.filter((x) => x.remove)) out.push(`    ${f.file}: ${f.remove} of ${f.lines}`);
  }
  out.push(`Records removed: ${plan.records} (${plan.lines} lines)`);
  out.push(`Expected drop: ${money(plan.dropUsd)}`);
  out.push("By model, these days, before → after:");
  const after = new Map(plan.after.map((t) => [t.model, t]));
  for (const b of plan.before) {
    const a = after.get(b.model);
    const moved = !a || Math.abs(a.usd - b.usd) > 1e-9 || a.calls !== b.calls;
    out.push(
      `  ${b.model}: ${money(b.usd)} → ${money(a?.usd ?? 0)}${moved ? `  (−${money(b.usd - (a?.usd ?? 0))}, −${b.calls - (a?.calls ?? 0)} calls; cache read −${big(b.tokens.cacheRead - (a?.tokens.cacheRead ?? 0))}, output −${big(b.tokens.output - (a?.tokens.output ?? 0))}, cache write −${big(b.tokens.cacheWrite - (a?.tokens.cacheWrite ?? 0))})` : "  (unchanged)"}`,
    );
  }
  out.push(`Snapshots a write deletes: ${plan.snapshots.length ? plan.snapshots.map((s) => path.basename(s)).join(", ") : "none"}`);
  if (plan.unsettled.length) out.push(`Half-done helper writes (a write refuses): ${plan.unsettled.join(", ")}`);
  return out.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf("--agent-dir");
  if (at >= 0 && !argv[at + 1]) {
    console.error("usage: bun scripts/usage-repair-1m-residuals.ts [--agent-dir <dir>] [--write [--assume-stopped]] [--json]");
    return 2;
  }
  const agentDir = path.resolve(at >= 0 ? argv[at + 1]! : defaultAgentDir());
  const write = argv.includes("--write");
  const plan = planRepair(agentDir, loadPrices(agentDir));
  if (argv.includes("--json")) console.log(JSON.stringify(plan, null, 2));
  else console.log(formatPlan(plan));
  if (!write) {
    console.log(plan.records ? "\nDry run: nothing changed. Stop Sova's server, then run again with --write." : "\nNothing to remove.");
    return 0;
  }
  if (!plan.records) return 0;
  const running = runningOn(agentDir);
  if (running === null && !argv.includes("--assume-stopped")) {
    console.error("\nCan't see this machine's processes (no /proc, or a sandbox's own), so can't tell whether Sova's server runs on this agent dir. Nothing was changed. Run it in a plain terminal, or add --assume-stopped once you've stopped the server yourself.");
    return 1;
  }
  if (running === null) console.error("\nCan't see this machine's processes; --assume-stopped: going ahead.");
  if (running?.length) {
    console.error(`\nSova's server or its usage helper runs on this agent dir; stop it first. Nothing was changed.\n${running.map((p) => `  pid ${p.pid}: ${p.cmd}`).join("\n")}`);
    return 1;
  }
  const backup = applyRepair(plan);
  console.log(`\nRemoved ${plan.records} records (${plan.lines} lines). Backup: ${backup}`);
  console.log("The usage helper counts these days again from their files when the server next starts.");
  return 0;
}

if ((import.meta as { main?: boolean }).main) process.exit(await main(process.argv.slice(2)));
