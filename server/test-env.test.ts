// `pnpm test` loads pi-config/extensions/claude-code/tests/hermetic-env.mjs with `--import`: each
// test process gets a throwaway HOME and none of the inherited agent-dir / Claude-directory
// variables, so no test reaches the real `~/.pi/agent` or a real Claude login.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { relative, isAbsolute } from "node:path";
import { test } from "node:test";

test("unit tests run in a throwaway home, whatever they inherited", () => {
  const root = process.env.SOVA_TEST_HOME;
  assert.ok(root, "pnpm test did not --import tests/hermetic-env.mjs");
  const rel = relative(realpathSync(tmpdir()), realpathSync(root));
  assert.ok(!rel.startsWith("..") && !isAbsolute(rel), `${root} is not a temp dir`);
  assert.ok(!relative(root, homedir()).startsWith(".."), "HOME is outside the throwaway home");
  for (const name of ["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "SOVA_DEVICE_ID"]) {
    assert.equal(process.env[name], undefined, `${name} is inherited`);
  }
});
