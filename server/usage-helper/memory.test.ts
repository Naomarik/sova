// The helper's memory stays bounded where an earlier probe grew without end (46 GB in 17 minutes,
// stdin fed from /dev/zero: a line that never ended was buffered and rescanned forever):
// - idle on an empty agent dir, its RSS stays flat;
// - when nobody reads its answers, it stops reading requests instead of queueing answers;
// - a stdin that never ends a line makes it exit, never grow.
// Every child runs under a hard RSS and wall-time cap enforced here.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runtimeCommand } from "./client";

const ROOT = join(import.meta.dirname, "..", "..");
const ENTRY = join(import.meta.dirname, "main.ts");
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

/** Least-squares slope in MB per minute. */
function slope(ys: number[]): number {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return (num / den) * 60;
}

test("idle on an empty agent dir and with its answers unread: memory stays flat", { skip: process.platform !== "linux" }, async () => {
  const idle = start(agentDir());
  const stalled = start(agentDir());
  // Nobody reads stalled's stdout; we keep asking it questions.
  stalled.stdout!.pause();
  const req = `${JSON.stringify({ id: 1, op: "costs", range: "all", tz: "UTC" })}\n`;
  stalled.stdin!.on("error", () => {});
  const ask = () => {
    try {
      for (let i = 0; i < 500; i++) if (!stalled.stdin!.write(req)) break;
    } catch {
      // its stdin is full or gone: the point is that it stays bounded
    }
  };
  idle.stdout!.resume();
  const [a, b] = await Promise.all([watch(idle, 30), watch(stalled, 30, ask)]);
  const settled = (xs: number[]) => xs.slice(5);
  assert.ok(Math.max(...a) < 150, `idle RSS ${Math.max(...a)} MB`);
  assert.ok(slope(settled(a)) < 3, `idle RSS grows ${slope(settled(a)).toFixed(1)} MB/min: ${a.map(Math.round).join(" ")}`);
  assert.ok(Math.max(...b) < 200, `unread RSS ${Math.max(...b)} MB`);
  assert.ok(slope(settled(b)) < 3, `unread RSS grows ${slope(settled(b)).toFixed(1)} MB/min: ${b.map(Math.round).join(" ")}`);
  idle.stdin!.end();
  stalled.kill("SIGKILL");
});

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
