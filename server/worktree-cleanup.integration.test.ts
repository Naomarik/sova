// §chat.worktrees/cleanup's process reader against a real child: the Linux /proc scan finds a
// process by the folder it runs in. The rules (what a process inside a tree means) are
// worktree-cleanup.test.ts, with a process as this scan reads one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scanProcesses } from "./worktree-cleanup";
import { until } from "./test-wait";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-cleanup-int-")));
const sleeper = spawn("sleep", ["60"], { cwd: root, stdio: "ignore" });
after(() => {
  sleeper.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

test("the /proc scan names a running process by the folder it runs in", { skip: process.platform !== "linux" && "the /proc scan is Linux's" }, async () => {
  let found: Awaited<ReturnType<typeof scanProcesses>>[number] | undefined;
  await until(async () => (found = (await scanProcesses()).find((p) => p.pid === sleeper.pid && p.command === "sleep")), "the sleeper in the scan");
  assert.ok(found!.paths.includes(root), found!.paths.join(", "));
  assert.equal((await scanProcesses()).some((p) => p.pid === process.pid), false, "the scanning process is left out");
});
