import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/** Ordinary chats load the kill guard: the default extension list holds the shell guard's factory. */

const agentDir = mkdtempSync(join(tmpdir(), "sova-chat-defaults-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { DEFAULT_EXTENSION_FACTORIES } = await import("./chat-manager");
const { SHELL_GUARD_FACTORY } = await import("./shell-guard-extension");

test("an ordinary chat's default extensions include the shell guard, exactly once", () => {
  assert.equal(DEFAULT_EXTENSION_FACTORIES.filter((f) => f === SHELL_GUARD_FACTORY).length, 1);
  assert.equal(DEFAULT_EXTENSION_FACTORIES.filter((f) => f.name === "sova-shell-guard").length, 1);
});
