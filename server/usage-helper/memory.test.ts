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
  // A helper warms up for its first seconds (a 3-minute probe: idle 33 -> 34 MB by 15 s then flat;
  // unread 29 -> 46 MB by 5 s then flat or falling), so the plateau is judged on the tail only:
  // after 20 s of warm-up, 25 s of samples must neither trend up nor step up.
  const [a, b] = await Promise.all([watch(idle, 45), watch(stalled, 45, ask)]);
  const WARM = 20;
  const plateau = (name: string, xs: number[], cap: number) => {
    const series = xs.map(Math.round).join(" ");
    assert.ok(xs.length >= 40, `${name}: only ${xs.length} samples: ${series}`);
    assert.ok(Math.max(...xs) < cap, `${name} RSS ${Math.max(...xs)} MB: ${series}`);
    const tail = xs.slice(WARM);
    assert.ok(slope(tail) < 6, `${name} RSS grows ${slope(tail).toFixed(1)} MB/min after warm-up: ${series}`);
    assert.ok(Math.max(...tail) - tail[0]! < 8, `${name} RSS climbs ${(Math.max(...tail) - tail[0]!).toFixed(1)} MB after warm-up: ${series}`);
  };
  plateau("idle", a, 150);
  plateau("unread", b, 200);
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
