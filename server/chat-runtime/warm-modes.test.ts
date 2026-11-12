// Run: pnpm test -- server/chat-runtime/warm-modes.test.ts. The chat runtime's warm-up runs Sova's mode engine
// (§chat.mode-menu/sova-runs-modes): the throwaway session it binds to register the Claude Code provider loads the
// same owner a chat does, so no copy of the pi mode extension ever loads in a chat process or the server, whether
// the agent dir links the mode folder or not. On a throwaway agent dir holding the real mode and claude-code
// extensions, linked as install.sh links them, and a probe that reads who owns `/mode` at each session_start.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "..", "..");
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-warm-modes-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths

const extensions = join(agentDir, "extensions");
mkdirSync(extensions);
symlinkSync(join(REPO, "pi-config", "extensions", "mode"), join(extensions, "mode"));
symlinkSync(join(REPO, "pi-config", "extensions", "claude-code"), join(extensions, "claude-code"));
// The probe: where `/mode` and the `align` tool come from in each runtime that binds, in bind order.
writeFileSync(
  join(extensions, "owner-probe.ts"),
  `export default function (pi: any) {
  pi.on("session_start", async () => {
    const from = (all: any[], name: string) => all.filter((c) => c.name === name).map((c) => c.sourceInfo?.path);
    (globalThis as any).__warmModesProbe.push({ mode: from(pi.getCommands(), "mode"), align: from(pi.getAllTools(), "align") });
  });
}
`,
);
const seen: { mode: string[]; align: string[] }[] = [];
(globalThis as unknown as { __warmModesProbe: typeof seen }).__warmModesProbe = seen;

const OLD_EXTENSION = /extensions[/\\]mode[/\\]index\.ts$/;
const SOVA_ENTRY = /server[/\\]harness[/\\]pi[/\\]modes-entry\.ts$/;

const { getModelRuntime, warmClaudeCodeProvider } = await import("../chat-manager");
const { openPiSession } = await import("../harness/pi/open");

/** One warm-up as a chat process's start runs it: who owned the modes in its throwaway session. */
async function warmedOwner() {
  const before = seen.length;
  await warmClaudeCodeProvider(await getModelRuntime(), agentDir);
  assert.equal(seen.length, before + 1, "the warm-up bound one session");
  return seen[before]!;
}

/** The owner a real runtime opened afterwards gets. */
async function openedOwner() {
  const before = seen.length;
  const file = join(agentDir, `opened-${before}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: `opened-${before}`, timestamp: new Date().toISOString(), cwd: agentDir })}\n`);
  const open = await openPiSession(file, agentDir);
  const runtime = await open.start(agentDir, async () => ({ loader: {}, flags: () => ({}), exclude: () => [], opening: () => null, forkCacheRouting: false }));
  await runtime.session.bindExtensions({ mode: "rpc" });
  open.restoreAppends();
  await runtime.dispose();
  assert.equal(seen.length, before + 1, "the open bound one session");
  return seen[before]!;
}

/** The old extension's module in this process's registry, by the real path its link leads to. */
const oldModuleLoaded = () => Object.keys(createRequire(import.meta.url).cache).filter((p) => p === join(REPO, "pi-config", "extensions", "mode", "index.ts"));

const claudeModels = async () => (await getModelRuntime()).getModels().filter((m) => m.provider === "claude-code-cli").length;

/** Exactly one owner of `/mode` and `align`, Sova's engine. */
function assertEngine(owner: { mode: string[]; align: string[] }, where: string) {
  assert.equal(owner.mode.length, 1, `${where}: one owner of /mode: ${owner.mode.join(", ")}`);
  assert.equal(owner.align.length, 1, `${where}: one align tool: ${owner.align.join(", ")}`);
  assert.doesNotMatch(owner.mode[0]!, OLD_EXTENSION);
  assert.match(owner.mode[0]!, SOVA_ENTRY, where);
  assert.match(owner.align[0]!, SOVA_ENTRY, where);
}

// First in this file on purpose: nothing has imported the old extension yet, so the module registry can answer.
test("the warm-up loads Sova's entry in the mode slot and no copy of the old extension, and still registers the provider", async () => {
  const profiles = join(agentDir, "subagent-profiles.json");
  assert.equal(existsSync(profiles), false);
  assertEngine(await warmedOwner(), "warm-up");
  assert.deepEqual(oldModuleLoaded(), [], "the old extension's module never loaded in this process");
  assert.ok((await claudeModels()) > 0, "the warm-up's job: the provider's models are in the shared runtime");
  // What the warm-up's session_start wrote before this change it still writes: the starter subagent library (absent only).
  assert.equal(existsSync(profiles), true, "the owner's session_start seeds the absent subagent library, as the old extension's did");
});

test("a chat opened after the warm-up has Sova's engine too, exactly one owner", async () => {
  await warmedOwner();
  assertEngine(await openedOwner(), "the chat opened next");
  assert.deepEqual(oldModuleLoaded(), [], "still no old extension module");
});

test("with no mode link in the agent dir, the warm-up and a chat still run Sova's engine", async () => {
  unlinkSync(join(extensions, "mode"));
  try {
    assertEngine(await warmedOwner(), "warm-up, no link");
    assertEngine(await openedOwner(), "chat, no link");
    assert.ok((await claudeModels()) > 0);
  } finally {
    symlinkSync(join(REPO, "pi-config", "extensions", "mode"), join(extensions, "mode"));
  }
});

test("the control for the empty answers above: the registry names the old extension's module once it has loaded", async () => {
  await import(join(REPO, "pi-config", "extensions", "mode", "index.ts"));
  assert.equal(oldModuleLoaded().length, 1, "the registry shows the old extension's module now");
});
