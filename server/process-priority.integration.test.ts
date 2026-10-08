import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { getPriority } from "node:os";
import { WORKER_NICE } from "../pi-config/extensions/subagents/priority.ts";
import { installWorkerNice, LOWER_WORKER, TOOL_COMMAND_PREFIX } from "./process-priority";

const inapplicable = process.platform === "win32"
  ? "Windows does not lower worker priority"
  : getPriority() >= 10
    ? "the starting priority is already at least niceness 10"
    : false;

test("the installed claude-code hook lowers a real launched worker to niceness 10", { skip: inapplicable }, async () => {
  const g = globalThis as Record<symbol, unknown>;
  const before = g[WORKER_NICE];
  const beforeLower = g[LOWER_WORKER];
  const beforePrefix = g[TOOL_COMMAND_PREFIX];
  const env = process.env.SOVA_WORKER_NICE;
  try {
    process.env.SOVA_WORKER_NICE = "10";
    installWorkerNice();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await once(child, "spawn");
      assert.ok(child.pid, "the worker started with a pid");
      assert.ok(getPriority(child.pid) < 10, "the launched worker needs lowering before the hook runs");
      (g[LOWER_WORKER] as (pid: number) => void)(child.pid);
      assert.equal(getPriority(child.pid), 10, "the claude-code hook lowers the launched worker");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  } finally {
    if (beforeLower === undefined) delete g[LOWER_WORKER];
    else g[LOWER_WORKER] = beforeLower;
    if (beforePrefix === undefined) delete g[TOOL_COMMAND_PREFIX];
    else g[TOOL_COMMAND_PREFIX] = beforePrefix;
    if (env === undefined) delete process.env.SOVA_WORKER_NICE;
    else process.env.SOVA_WORKER_NICE = env;
    if (before === undefined) delete g[WORKER_NICE];
    else g[WORKER_NICE] = before;
  }
});
