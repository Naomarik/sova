import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { getPriority } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_NICE, workerNice } from "../pi-config/extensions/subagents/priority.ts";
import { DEFAULT_WORKER_NICE, installWorkerNice, LOWER_WORKER, lowerToolCommands, readWorkerNice, TOOL_COMMAND_PREFIX } from "./process-priority";

function withAgentDir(settings: unknown, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "sova-process-priority-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    if (settings !== undefined) {
      mkdirSync(join(dir, "sova"), { recursive: true });
      writeFileSync(join(dir, "sova", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    }
    fn();
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the worker niceness: SOVA_WORKER_NICE, else workerNice in Sova's settings, else 10", () => {
  withAgentDir(undefined, () => assert.equal(readWorkerNice({}), DEFAULT_WORKER_NICE));
  withAgentDir("{not json", () => assert.equal(readWorkerNice({}), 10));
  withAgentDir({ version: 1, experimental: { claudeCodeProvider: true }, workerNice: 15 }, () => {
    assert.equal(readWorkerNice({}), 15);
    assert.equal(readWorkerNice({ SOVA_WORKER_NICE: "5" }), 5, "the environment wins");
    assert.equal(readWorkerNice({ SOVA_WORKER_NICE: "0" }), 0, "0 turns it off");
    assert.equal(readWorkerNice({ SOVA_WORKER_NICE: "high" }), 15, "an invalid variable is ignored");
  });
  withAgentDir({ version: 1, workerNice: 0 }, () => assert.equal(readWorkerNice({}), 0));
  for (const bad of [25, -1, 2.5, "ten", null]) withAgentDir({ version: 1, workerNice: bad }, () => assert.equal(readWorkerNice({}), 10, String(bad)));
});

test("installWorkerNice points the extensions' hooks at the setting, read per use", () => {
  const g = globalThis as Record<symbol, unknown>;
  const before = g[WORKER_NICE];
  const beforeLower = g[LOWER_WORKER];
  const beforePrefix = g[TOOL_COMMAND_PREFIX];
  const env = process.env.SOVA_WORKER_NICE;
  try {
    delete process.env.SOVA_WORKER_NICE;
    installWorkerNice();
    withAgentDir({ version: 1, workerNice: 12 }, () => assert.equal(workerNice(), 12));
    withAgentDir({ version: 1, workerNice: 0 }, () => {
      assert.equal(workerNice(), 0);
      assert.equal((g[TOOL_COMMAND_PREFIX] as (p?: string) => string | undefined)("mine"), "mine", "off: the prefix as configured");
    });
    if (process.platform !== "win32" && getPriority() < 10)
      withAgentDir({ version: 1, workerNice: 10 }, () => {
        assert.match((g[TOOL_COMMAND_PREFIX] as (p?: string) => string)("mine"), /^renice -n \d+ -p \$\$ >\/dev\/null 2>&1\nmine$/);
      });
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

test("a hosted session's shell prefix gets the renice line in front of the user's own", { skip: process.platform === "win32" }, () => {
  const g = globalThis as Record<symbol, unknown>;
  const before = g[WORKER_NICE];
  try {
    let prefix: string | undefined = "shopt -s expand_aliases";
    const settings = { getShellCommandPrefix: () => prefix };
    lowerToolCommands(settings);
    g[WORKER_NICE] = () => 10;
    if (getPriority() < 10) assert.match(settings.getShellCommandPrefix()!, /^renice -n \d+ -p \$\$ >\/dev\/null 2>&1\nshopt -s expand_aliases$/);
    prefix = undefined;
    if (getPriority() < 10) assert.match(settings.getShellCommandPrefix()!, /^renice -n \d+ -p \$\$ >\/dev\/null 2>&1$/);
    g[WORKER_NICE] = () => 0;
    prefix = "shopt -s expand_aliases";
    assert.equal(settings.getShellCommandPrefix(), "shopt -s expand_aliases", "off: the user's prefix as it was");
  } finally {
    if (before === undefined) delete g[WORKER_NICE];
    else g[WORKER_NICE] = before;
  }
});
