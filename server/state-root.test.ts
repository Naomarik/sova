// Run: npx tsx --test server/state-root.test.ts (or npm test)
// The rebrand state-root primitives: new root, legacy root, and the one lexical rebase every
// "old absolute path in stored data" consumer shares.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-state-root-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its paths

const { stateRoot, legacyStateRoot, unlegacyStatePath } = await import("./state-root");

after(() => rmSync(agentDir, { recursive: true, force: true }));

test("roots hang off the (moved) agent dir", () => {
  assert.equal(stateRoot(), join(agentDir, "sova"));
  assert.equal(legacyStateRoot(), join(agentDir, "pi-web"));
});

test("unlegacyStatePath re-anchors legacy-rooted paths and leaves everything else alone", () => {
  const sid = "01a0c0ff";
  assert.equal(
    unlegacyStatePath(join(agentDir, "pi-web", "attachments", sid, "pi-web-x.png")),
    join(agentDir, "sova", "attachments", sid, "pi-web-x.png"),
    "old attachment path resolves where the move put the bytes",
  );
  assert.equal(
    unlegacyStatePath(join(agentDir, "pi-web", "targets", "box", "srv", "x")),
    join(agentDir, "sova", "targets", "box", "srv", "x"),
    "old placeholder cwd resolves where the move put the directory",
  );
  // Boundaries: the prefix must be the root + separator, not a lookalike.
  assert.equal(unlegacyStatePath(join(agentDir, "pi-web2", "x")), join(agentDir, "pi-web2", "x"));
  assert.equal(unlegacyStatePath(join(agentDir, "sova", "x")), join(agentDir, "sova", "x"));
  assert.equal(unlegacyStatePath("/home/u/project"), "/home/u/project");
  assert.equal(unlegacyStatePath("pi-web/attachments/x"), "pi-web/attachments/x", "relative stays relative");
});
