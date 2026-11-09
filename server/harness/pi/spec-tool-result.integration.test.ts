// The `spec` tool's answer as the model reads it: a real AgentSession (faux model) calls the real tool, on
// the real spec tools, through the extension a chat loads. A root that doesn't exist is an error result that
// says so; a real folder with no spec keeps its plain "no spec here". The tool result's `isError` and text
// are what the model is handed, so this is the seam where a missing folder read as "this project has no spec".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { servedToolsExtension } from "../../served-tools";
import { NO_SPEC_HERE, specCodingTool } from "../../spec-coding-tool";

/** What the model is handed for one `spec` call in a session whose folder is `cwd`. */
async function resultOf(cwd: string, agentDir: string, params: Record<string, string>): Promise<{ isError: boolean; text: string }> {
  const faux = fauxProvider();
  const ext = servedToolsExtension("sova-spec", [specCodingTool()]);
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [ext.factory] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory() });
  try {
    await session.bindExtensions({ mode: "rpc" });
    session.modelRuntime.registerNativeProvider(faux.provider);
    await session.setModel(faux.getModel());
    faux.setResponses([fauxAssistantMessage(fauxToolCall("spec", params), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await session.prompt("go");
    await session.waitForIdle?.();
    const result = session.messages.find((m) => m.role === "toolResult") as { isError: boolean; content: { type: string; text?: string }[] } | undefined;
    assert.ok(result, "the tool ran and answered");
    return { isError: result.isError, text: result.content.map((c) => c.text ?? "").join("") };
  } finally {
    session.dispose();
  }
}

test("a root that doesn't exist yet is an error saying so; the existing folder with no spec beside it keeps its plain answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spec-tool-result-"));
  try {
    const cwd = join(dir, "work");
    const agentDir = join(dir, "agent");
    mkdirSync(join(cwd, "bare"), { recursive: true });
    mkdirSync(agentDir);

    const bare = await resultOf(cwd, agentDir, { op: "map", root: "bare" });
    assert.deepEqual(bare, { isError: false, text: NO_SPEC_HERE }, "a real folder with no spec");

    // The live case: the root a bash call in the same batch is still creating.
    const missing = await resultOf(cwd, agentDir, { op: "map", root: ".cache/master" });
    assert.equal(missing.isError, true, `an error result, got: ${missing.text}`);
    assert.ok(!missing.text.includes(NO_SPEC_HERE), `it must not read as no spec: ${missing.text}`);
    assert.match(missing.text, /does not exist/);
    assert.ok(missing.text.includes(join(cwd, ".cache/master")), `it names the folder: ${missing.text}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
