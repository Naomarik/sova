// The server's view of the project mode approval store: the same file the chats' mode extension reads.
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const base = mkdtempSync(join(tmpdir(), "sova-approvals-"));
const agentDir = join(base, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.SOVA_CHAT_STATE_ROOT;
after(() => rmSync(base, { recursive: true, force: true }));

const { approvalsFile, approvalsOf, isApproved, recordApproval } = await import("./project-mode-approvals");
const store = await import("../pi-config/extensions/mode/project-tools-approval.ts");

test("the server and the mode extension resolve one file, in the state root", () => {
  assert.equal(approvalsFile(), join(agentDir, "sova", "project-mode-approvals.json"));
  assert.equal(store.approvalsFile(), approvalsFile());
});

test("an approval the server records is what the extension's check sees", () => {
  const root = join(base, "repo");
  mkdirSync(root);
  const hash = "c".repeat(64);
  assert.equal(isApproved(root, "release-check", hash), false);
  assert.equal(store.isApproved(root, "release-check", hash), false);
  recordApproval(root, "release-check", hash, "overseer");
  assert.equal(isApproved(root, "release-check", hash), true);
  assert.equal(store.isApproved(root, "release-check", hash), true, "the chat process reads the same approval");
  assert.deepEqual(approvalsOf(root, "release-check").map((r) => r.by), ["overseer"]);
  assert.equal(isApproved(root, "release-check", "d".repeat(64)), false);
  assert.equal(isApproved(root, "no-tools", ""), true);
});
