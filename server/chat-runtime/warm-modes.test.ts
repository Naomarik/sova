// Run: pnpm test -- server/chat-runtime/warm-modes.test.ts. The chat runtime's warm-up runs Sova's mode engine
// (§chat.mode-menu/sova-runs-modes): the throwaway session it binds to register the Claude Code provider loads the
// same owner a chat does, whether the agent dir links the mode folder (an older install's leftover link) or not.
// On a throwaway agent dir holding the real claude-code extension, linked as install.sh links it (the mode folder
// is no pi extension, so it isn't linked), and a probe that reads who owns `/mode` at each session_start.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "..", "..");
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-warm-modes-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths

const extensions = join(agentDir, "extensions");
mkdirSync(extensions);
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

const claudeModels = async () => (await getModelRuntime()).getModels().filter((m) => m.provider === "claude-code-cli").length;

/** Exactly one owner of `/mode` and `align`, Sova's engine. */
function assertEngine(owner: { mode: string[]; align: string[] }, where: string) {
  assert.equal(owner.mode.length, 1, `${where}: one owner of /mode: ${owner.mode.join(", ")}`);
  assert.equal(owner.align.length, 1, `${where}: one align tool: ${owner.align.join(", ")}`);
  assert.match(owner.mode[0]!, SOVA_ENTRY, where);
  assert.match(owner.align[0]!, SOVA_ENTRY, where);
}

test("the warm-up loads Sova's entry, and still registers the provider", async () => {
  const profiles = join(agentDir, "subagent-profiles.json");
  assert.equal(existsSync(profiles), false);
  assertEngine(await warmedOwner(), "warm-up");
  assert.ok((await claudeModels()) > 0, "the warm-up's job: the provider's models are in the shared runtime");
  // What the warm-up's session_start wrote before this change it still writes: the starter subagent library (absent only).
  assert.equal(existsSync(profiles), true, "the owner's session_start seeds the absent subagent library, as the old extension's did");
});

test("a chat opened after the warm-up has Sova's engine too, exactly one owner", async () => {
  await warmedOwner();
  assertEngine(await openedOwner(), "the chat opened next");
});

test("with an older install's mode link in the agent dir, the warm-up and a chat still run Sova's engine, once", async () => {
  symlinkSync(join(REPO, "pi-config", "extensions", "mode"), join(extensions, "mode"));
  try {
    assertEngine(await warmedOwner(), "warm-up, leftover link");
    assertEngine(await openedOwner(), "chat, leftover link");
    assert.ok((await claudeModels()) > 0);
  } finally {
    unlinkSync(join(extensions, "mode"));
  }
});
