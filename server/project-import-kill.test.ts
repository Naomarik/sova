// Run: pnpm exec tsx --test server/project-import-kill.test.ts. An import (§app.projects/import) SIGKILLed after
// the mark, mid-copy, after the adopt and before the place (the org-host/kill9-child.ts pattern: a child process,
// project-import-child.ts), then a start as the server does it: the import finishes, never rolls back, and a
// second start changes nothing. A throwaway agent dir per step in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./project-import-child.ts", import.meta.url));
const HERMETIC = resolve(import.meta.dirname, "..", "pi-config", "extensions", "claude-code", "tests", "hermetic-env.mjs");

function child(root: string, ...args: string[]): Promise<{ out: string; signal: NodeJS.Signals | null }> {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, ["--import", "tsx", "--import", HERMETIC, CHILD, root, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") } });
    let out = "";
    let err = "";
    p.stdout.on("data", (b: Buffer) => (out += b.toString()));
    p.stderr.on("data", (b: Buffer) => (err += b.toString()));
    p.on("exit", (code, signal) => (signal === "SIGKILL" || code === 0 ? done({ out, signal }) : fail(new Error(`child ${args.join(" ")} exited ${code}: ${err}`))));
  });
}

const lastJson = (out: string) => JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, any>;

for (const step of ["mark", "copy", "adopt", "place"]) {
  test(`killed ${step === "copy" ? "mid-copy" : step === "place" ? "before the place" : `after the ${step}`}: the next start finishes the import`, { timeout: 180_000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `sova-import-kill-${step}-`)));
    try {
      const killed = await child(root, "import", step);
      assert.equal(killed.signal, "SIGKILL", `cut off at ${step}`);
      assert.ok(!killed.out.includes("finished"));
      const s = lastJson((await child(root, "boot")).out);
      assert.deepEqual(s.registry, [], "the entry is gone");
      assert.ok(s.engine, "the project opened somewhere");
      assert.equal(s.engine, s.otherEngine, "in the org's engine, beside its other project");
      assert.equal(s.placement?.placedVia ?? s.placement?.via, "import", "placed as imported");
      assert.equal(s.projectData?.name, "Solo One", "its data came along");
      assert.ok(s.watch, "its watch came along");
      assert.ok(s.soloRows > 0, "its Activity rows are read in the org");
      assert.equal(s.dupRows, 0, "no row twice");
      assert.equal(s.costs, true);
      assert.equal(s.sessions.length, 1, "its overseer conversation is in the workspace");
      assert.equal(s.aside.length, 1, "the standalone dir is set aside");
      assert.equal(s.commits[0], "Imported project Solo One");
      assert.deepEqual(s.problems, []);
      const again = lastJson((await child(root, "boot")).out);
      // (an open writes its own resume rows: the rows only grow, never twice)
      const stable = (x: Record<string, any>) => ({ registry: x.registry, engine: x.engine, placedAt: x.placement?.placedAt, name: x.projectData?.name, sessions: x.sessions, costs: x.costs, aside: x.aside, commits: x.commits, dupRows: x.dupRows });
      assert.deepEqual(stable(again), stable(s), "a second start changes nothing");
      assert.ok(again.soloRows >= s.soloRows);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
