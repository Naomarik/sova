// scripts/install.sh, through its own suite (scripts/install.test.sh): every case in a temporary
// HOME with stubbed toolchains and service managers, cloning a local seed repository.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("scripts/install.test.sh passes", () => {
  const r = spawnSync("bash", [join(REPO, "scripts", "install.test.sh")], { encoding: "utf8", timeout: 300_000 });
  const failed = r.stdout.split("\n").filter((l) => l.startsWith("  FAIL"));
  assert.equal(r.status, 0, `${failed.join("\n") || r.stdout.slice(-2000)}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stdout, /\d+ passed, 0 failed/);
});
