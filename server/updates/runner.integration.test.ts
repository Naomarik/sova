import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { installRunner } from "./runner";

/** The upgrade job runs installRunner's copy of runner.ts from the job's own directory, with nothing of
    Sova's beside it: that copy must load there (v0.9.0 and v0.10.0 shipped one that didn't). */

const dir = mkdtempSync(join(tmpdir(), "sova-runner-alone-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the job's copy of runner.ts loads alone in an empty job directory", () => {
  const copy = installRunner(dir);
  assert.deepEqual(readdirSync(dir), ["runner.ts"]);
  const r = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(copy)}); console.log("loaded")`], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /loaded/);
});
