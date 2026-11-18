// The helper's memory stays bounded where an earlier probe grew without end (46 GB in 17 minutes,
// stdin fed from /dev/zero: a line that never ended was buffered and rescanned forever): a stdin that
// never ends a line makes it exit, never grow. (A 45 s soak of an idle and an unread helper was dropped:
// this test reproduces the leak's own cause, in seconds.)
// Every child runs under a hard RSS and wall-time cap enforced here.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runtimeCommand } from "./client";

const ROOT = join(import.meta.dirname, "..", "..");
// USAGE_HELPER_MAIN points the test at another entry (to check it still fails on an old main.ts).
const ENTRY = process.env.USAGE_HELPER_MAIN ?? join(import.meta.dirname, "main.ts");
const CAP_MB = 400;
const dirs: string[] = [];
const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) k.kill("SIGKILL");
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function agentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "usage-mem-"));
  dirs.push(d);
  mkdirSync(join(d, "sova"), { recursive: true });
  copyFileSync(join(ROOT, "shared", "model-prices", "seed.json"), join(d, "sova", "model-prices.json"));
  return d;
}

function start(agent: string): ChildProcess {
  const cmd = runtimeCommand(ENTRY);
  const c = spawn(cmd.exe, cmd.args, { env: { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_PRICES_FETCH: "off" }, stdio: ["pipe", "pipe", "ignore"] });
  kids.push(c);
  return c;
}

const rssMb = (pid: number): number => {
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024;
  } catch {
    return 0;
  }
};

/** RSS every second for `seconds`; kills the child past the cap. */
async function watch(c: ChildProcess, seconds: number, tick?: (i: number) => void): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (c.exitCode !== null) break;
    const mb = rssMb(c.pid!);
    out.push(mb);
    if (mb > CAP_MB) {
      c.kill("SIGKILL");
      assert.fail(`RSS ${mb} MB over the ${CAP_MB} MB cap`);
    }
    tick?.(i);
  }
  return out;
}

test("a stdin that never ends a line (as /dev/zero) makes it exit, bounded", { skip: process.platform !== "linux" }, async () => {
  const c = start(agentDir());
  c.stdout!.resume();
  const zeros = Buffer.alloc(64 * 1024);
  let stop = false;
  c.stdin!.on("error", () => (stop = true));
  const feed = () => {
    try {
      while (!stop && c.exitCode === null && c.stdin!.write(zeros));
      if (!stop && c.exitCode === null) c.stdin!.once("drain", feed);
    } catch {
      stop = true; // EPIPE: it exited, as it should
    }
  };
  feed();
  const series = await watch(c, 15);
  stop = true;
  assert.notEqual(c.exitCode, null, `still running after 15 s: ${series.map(Math.round).join(" ")}`);
  assert.ok(Math.max(0, ...series) < 150, `RSS ${Math.max(...series)} MB`);
});

test("the Time Spent tab's records in memory (21k runs of your time, 50k replies, 20k tool runs) stay bounded and answer", { skip: process.platform !== "linux" }, async () => {
  const agent = agentDir();
  const now = Date.now();
  const att = join(agent, "sova", "attention");
  mkdirSync(att, { recursive: true });
  // 700 sessions × 30 runs: about a year of one person's record.
  for (let s = 0; s < 700; s++) {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      const e = Math.floor((now - (s * 30 + i) * 900_000) / 1000);
      lines.push(JSON.stringify({ s: e - 300, e, r: i % 2 ? "typing" : "reading-transcript" }));
    }
    writeFileSync(join(att, `s${s}.jsonl`), `${lines.join("\n")}\n`);
  }
  const byDay = new Map<string, string[]>();
  const put = (root: string, ts: number, line: string) => {
    const k = `${root}/${new Date(ts).toISOString().slice(0, 10)}`;
    let l = byDay.get(k);
    if (!l) byDay.set(k, (l = []));
    l.push(line);
  };
  for (let i = 0; i < 50_000; i++) {
    const ts = now - i * 600_000;
    put(join(agent, "usage", "perf", "v1"), ts, JSON.stringify({ v: 1, key: `s${i % 700}:e${i}`, ts, device: null, producer: "p1", sid: `s${i % 700}`, entryId: `e${i}`, kind: "main", provider: "zai", model: "glm-5.3", stop: "stop", sentAt: ts - 20_000, ttftMs: 500, thinkingMs: 5000, replyMs: 10_000, thinking: { ms: 5000, n: 1 }, text: { ms: 10_000, n: 1 }, tool: { ms: 0, n: 0 }, endMs: 20_000, output: 300 }));
  }
  for (let i = 0; i < 20_000; i++) {
    const end = now - i * 900_000;
    put(join(agent, "usage", "tools", "v1"), end, JSON.stringify({ v: 1, key: `s${i % 700}:c${i}`, sid: `s${i % 700}`, start: end - 5000, end, kind: i % 10 ? "tool" : "worker-wait", producer: "p1", device: null }));
  }
  for (const [k, lines] of byDay) {
    mkdirSync(k, { recursive: true });
    writeFileSync(join(k, "p1.jsonl"), `${lines.join("\n")}\n`);
  }
  const c = start(agent);
  let got = "";
  c.stdout!.setEncoding("utf8");
  c.stdout!.on("data", (d: string) => (got += d));
  c.stdin!.write(`${JSON.stringify({ id: 1, op: "time", range: "all", tz: "UTC" })}\n`);
  let asked = false;
  const series = await watch(c, 60, () => {
    if (!asked && /^1 \d+ \d+\n/.test(got)) {
      asked = true;
      c.stdin!.write(`${JSON.stringify({ id: 2, op: "time", range: "30d", tz: "Asia/Kolkata" })}\n`);
    } else if (/}2 \d+ \d+\n/.test(got)) c.stdin!.end(); // both answered: it exits, and the watch ends
  });
  assert.match(got, /^1 200 \d+\n/, "the whole history answered");
  assert.match(got, /}2 200 \d+\n/, "and a second zone");
  assert.ok(Math.max(0, ...series) < CAP_MB, `RSS ${Math.max(...series)} MB`);
});
