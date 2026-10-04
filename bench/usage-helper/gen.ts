// Load generator for the usage helper benchmark: ~50 simulated agents appending usage records
// (pi-config/extensions/llm-inflight/usage-record.ts lines) to their own producer files, as the
// real producers do (one appendFileSync of one line per call, one writer per file).
//
//   bun bench/usage-helper/gen.ts --agent-dir <dir> --rate <records/s> --seconds <n> [--burst <n>]
//   bun bench/usage-helper/gen.ts --agent-dir <dir> --backfill-days <n> --per-day <n>
//
// Live mode writes at `rate` records/s spread over the agents (Poisson-ish), with an optional burst
// of `burst` records at once every 10 s; `--clock <iso>` starts the records' clock elsewhere (a day
// rollover: start it a minute before midnight). Backfill mode writes whole days at once (the
// cold catch-up). Prints one JSON line of what it wrote.
import fs from "node:fs";
import path from "node:path";
import { formatUsageRecord, type UsageRecord } from "../../pi-config/extensions/llm-inflight/usage-record";

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const agentDir = opt("agent-dir")!;
const rate = Number(opt("rate", "17"));
const seconds = Number(opt("seconds", "30"));
const burst = Number(opt("burst", "0"));
const backfillDays = Number(opt("backfill-days", "0"));
const perDay = Number(opt("per-day", "40000"));
const clockStart = opt("clock") ? Date.parse(opt("clock")!) : Date.now();
const seed = Number(opt("seed", "1"));
const tag = opt("tag", "g");

let s = seed >>> 0 || 1;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo));

interface Agent {
  producer: string;
  weight: number;
  make(ts: number): Omit<UsageRecord, "v" | "ts" | "device" | "producer">;
}

const MAINS = Array.from({ length: 10 }, (_, i) => `0199main-0000-7000-8000-${String(i).padStart(12, "0")}`);
const CWDS = ["/home/u/webapps/sova", "/home/u/webapps/jev", "/home/u/webapps/site", "/home/u/notes"];
const PI_MODELS = [
  { provider: "zai", model: "glm-5.3" },
  { provider: "openai-codex", model: "gpt-6-astra" },
  { provider: "claude-code-cli", model: "opus[1m]", responseModel: "claude-opus-5-5" },
  { provider: "ollama-cloud", model: "deepseek-v4-pro:0813" },
  { provider: "deepseek", model: "deepseek-v4-pro" },
] as const;
let seq = 0;
const tokens = (big = false) => ({
  input: int(200, big ? 60_000 : 8_000),
  output: int(50, 4_000),
  cacheRead: int(0, big ? 400_000 : 120_000),
  cacheWrite: int(0, 20_000),
});

const agents: Agent[] = [];
// 10 main sessions (pi, every provider), now and then a compaction or a cache warm.
for (let i = 0; i < 10; i++) {
  const m = PI_MODELS[i % PI_MODELS.length]!;
  const owner = MAINS[i]!;
  const cwd = CWDS[i % CWDS.length]!;
  agents.push({
    producer: `${tag}-main-${i}`,
    weight: 1,
    make: () => ({ key: `pi:${owner}:${++seq}:${m.provider}/${m.model}`, src: "pi", ...m, ...tokens(true), owner, parent: null, kind: i === 0 ? "overseer" : "main", cwd, ...(rnd() < 0.03 ? { purpose: pick(["compaction", "cache-warm"]) } : {}), stop: "stop" }),
  });
}
// 25 pi workers under the main sessions (5 of them a worker's worker).
for (let i = 0; i < 25; i++) {
  const m = PI_MODELS[(i * 3) % PI_MODELS.length]!;
  const parent = i >= 20 ? `0199work-0000-7000-8000-${String(i - 20).padStart(12, "0")}` : MAINS[i % 10]!;
  const owner = `0199work-0000-7000-8000-${String(i).padStart(12, "0")}`;
  agents.push({
    producer: `${tag}-worker-${i}`,
    weight: 1.5,
    make: () => ({ key: `pi:${owner}:${++seq}:${m.provider}/${m.model}`, src: "pi", ...m, ...tokens(), owner, parent, worker: `ag_${String(i).padStart(2, "0")}`, kind: "worker", cwd: CWDS[i % CWDS.length]! }),
  });
}
// 10 Claude Code workers: per-message records, 5% replayed by a second observer (another producer).
for (let i = 0; i < 10; i++) {
  const owner = `cc${String(i).padStart(6, "0")}-6d0e-4a4e-9f55-3f0b6b1e2a11`;
  agents.push({
    producer: `${tag}-cc-${i}`,
    weight: 1.5,
    make: () => {
      const t = tokens(true);
      return { key: `cc:msg_${tag}_${i}_${++seq}`, src: "claude", provider: "claude", model: pick(["claude-opus-5-5", "claude-haiku-4-5"]), ...t, cacheWrite1h: Math.floor(t.cacheWrite * 0.6), owner, parent: MAINS[i]!, worker: `ag_${30 + i}`, kind: "worker", cwd: CWDS[i % CWDS.length]! };
    },
  });
}
// 5 one-shot producers: titles, decisions (Jev), outlines, vision.
for (let i = 0; i < 5; i++) {
  agents.push({
    producer: `${tag}-oneshot-${i}`,
    weight: 0.3,
    make: () => {
      const purpose = pick(["title", "decide", "outline", "vision"] as const);
      const jev = purpose === "decide";
      return { key: `${tag}-oneshot-${i}:${++seq}`, src: jev ? "jev" : "pi", provider: jev ? "jev" : "zai", model: jev ? "jev-1.13.0" : "glm-5.3", ...tokens(), owner: jev ? null : pick(MAINS), parent: null, kind: "oneshot", purpose };
    },
  });
}
const total = agents.reduce((n, a) => n + a.weight, 0);
const choose = () => {
  let x = rnd() * total;
  for (const a of agents) if ((x -= a.weight) <= 0) return a;
  return agents[agents.length - 1]!;
};

const dirs = new Set<string>();
const root = path.join(agentDir, "usage", "v1");
let written = 0;
let bytes = 0;
let dupes = 0;
function write(a: Agent, ts: number): void {
  const body = a.make(ts);
  const rec = { v: 1, ts, device: null, producer: a.producer, ...body } as UsageRecord;
  const line = formatUsageRecord(rec);
  if (!line) throw new Error(`bad record ${JSON.stringify(rec)}`);
  const dir = path.join(root, new Date(ts).toISOString().slice(0, 10));
  if (!dirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    dirs.add(dir);
  }
  fs.appendFileSync(path.join(dir, `${a.producer}.jsonl`), line);
  written++;
  bytes += line.length;
  if (body.src === "claude" && rnd() < 0.05) {
    fs.appendFileSync(path.join(dir, `${a.producer}-replay.jsonl`), formatUsageRecord({ ...rec, producer: `${a.producer}-replay` })!);
    dupes++;
  }
}

if (backfillDays > 0) {
  const t0 = performance.now();
  const end = clockStart - (clockStart % 86_400_000);
  for (let d = backfillDays; d >= 1; d--) {
    const start = end - d * 86_400_000;
    for (let i = 0; i < perDay; i++) write(choose(), start + Math.floor((i / perDay) * 86_400_000));
  }
  process.stdout.write(`${JSON.stringify({ mode: "backfill", days: backfillDays, written, dupes, bytes, ms: Math.round(performance.now() - t0) })}\n`);
} else {
  const t0 = Date.now();
  const until = t0 + seconds * 1000;
  let nextBurst = t0 + 10_000;
  const tick = 20;
  let owed = 0;
  while (Date.now() < until) {
    const now = Date.now();
    owed += (rate * tick) / 1000;
    const clock = clockStart + (now - t0);
    while (owed >= 1) {
      write(choose(), clock);
      owed--;
    }
    if (burst && now >= nextBurst) {
      for (let i = 0; i < burst; i++) write(choose(), clock);
      nextBurst += 10_000;
    }
    const wait = tick - (Date.now() - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  process.stdout.write(`${JSON.stringify({ mode: "live", rate, seconds, burst, written, dupes, bytes })}\n`);
}
