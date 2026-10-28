// The helper's memory stays bounded where an earlier probe grew without end (46 GB in 17 minutes,
// stdin fed from /dev/zero: a line that never ended was buffered and rescanned forever): a stdin that
// never ends a line makes it exit, never grow. (A 45 s soak of an idle and an unread helper was dropped:
// this test reproduces the leak's own cause, in seconds.)
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
