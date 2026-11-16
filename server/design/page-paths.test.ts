// Where a reading chat finds a design's saved page, through the sandbox extension's own policy resolution of the
// chat's branch (its `sandbox` entry), as the server reads it for any file it hands a chat (linkSandboxOf): the saved
// file itself while its sandbox can read the design folder, a read-only copy in its session tmp when the policy hides it.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "design-page-paths-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(agentDir, { recursive: true });
cpSync(join(import.meta.dirname, "..", "..", "pi-config", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });

const { installPageReaderSandbox, pagePathFor } = await import("./page-paths");
const store = await import("./store");
const { linkSandboxOf } = await import("../link-sandbox");

const sid = "pp-1";
const cwd = join(root, "ws");
mkdirSync(cwd, { recursive: true });
store.writePage(sid, "A", 1, "<!doctype html><p>the page</p>");
const entry = (on: boolean) => ({ type: "custom", customType: "sandbox", data: { version: 1, on, level: "workspace-write", backend: "linux-bwrap", enforcement: "full" } });
// Two reading chats, one with its sandbox on and one off, read as the server reads any chat (server/app.ts).
installPageReaderSandbox((id) => linkSandboxOf(id, { cwd: async () => cwd, branch: async (sid) => [entry(sid === "on")], agentDir: () => agentDir }));
after(() => installPageReaderSandbox(null));
const reader = (on: boolean) => ({ sessionId: on ? "on" : "off" });

/** Hide the design folder in the policy, as a user's own policy could. */
function hideDesigns(): void {
  for (const os of ["linux", "darwin"]) {
    const f = join(agentDir, "sandbox-policy", os, "policy.json");
    const p = JSON.parse(readFileSync(f, "utf8"));
    p.hidden.push("$AGENT_DIR/design");
    writeFileSync(f, JSON.stringify(p));
  }
}

test("the saved file itself for a chat with its sandbox off, or on under the shipped policy, which leaves the design folder readable", async () => {
  const file = store.pageFile(sid, "A", 1);
  assert.deepEqual(await pagePathFor(sid, "A", 1, reader(false)), { path: file });
  assert.deepEqual(await pagePathFor(sid, "A", 1, reader(true)), { path: file });
});

test("a policy that hides the design folder gets a read-only copy where that chat's tools read, never the page in the reply", async () => {
  hideDesigns();
  const out = await pagePathFor(sid, "A", 1, reader(true), "linux");
  assert.equal(out.exposed, true);
  assert.equal(out.path, join("/tmp", "lookbook", sid, "A", "v1.html"));
  // Off, the same policy doesn't apply: the file itself.
  assert.deepEqual(await pagePathFor(sid, "A", 1, reader(false)), { path: store.pageFile(sid, "A", 1) });
});
