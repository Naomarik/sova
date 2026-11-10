// A change to the remembered Claude list reaches this running process with no restart
// (§app.claude-code-provider/model-table): the shared runtime's models, every list built from them, and
// what the web app is told. The file is written as the server writes it, by rename.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-claude-sync-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const stateDir = join(agentDir, "sova");
mkdirSync(stateDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

await import("./testing/in-process-chats");
const { disposeAllChats, getModelRuntime, warmChatRuntime } = await import("./chat-manager");
const { listModels } = await import("./models");
const { checkChoice, delegateOptions } = await import("./delegate");
const { claudeCatalogInfo, onClaudeModelsChanged } = await import("./claude-models-sync");
const { claudeContextWindow, claudeName, claudeOffer, resolveClaude, unverifiedClaudeNote } = await import("../pi-config/extensions/claude-code/catalog.ts");

const NEW = "claude-nova-1-2";
const DROPPED = "claude-sonnet-4-6";
const sources = {
  piModels: async () => [],
  policy: () => ({ disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }),
};

let written = 0;
/** Writes the store and waits for this process to have taken it. */
async function store(file: Record<string, unknown>): Promise<void> {
  const heard = new Promise<void>((done) => {
    const stop = onClaudeModelsChanged(() => {
      stop();
      done();
    });
  });
  const tmp = join(stateDir, `claude-models.json.${++written}.tmp`);
  writeFileSync(tmp, JSON.stringify({ v: 1, ...file }));
  renameSync(tmp, join(stateDir, "claude-models.json"));
  await heard;
}

before(async () => {
  await warmChatRuntime();
  await store({ models: [{ id: NEW, window: 1_000_000, maxOutput: 128_000, efforts: ["low", "high"] }], dropped: [DROPPED] });
});
after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

test("a discovered model is in every list with its name, window and efforts, and no 'not verified'", async () => {
  const listed = (await listModels()).find((m) => m.ref === `claude-code-cli/${NEW}`);
  assert.ok(listed, "the chat picker's list, with no restart");
  assert.equal(listed.contextWindow, 1_000_000);
  assert.ok(listed.thinkingLevels.includes("high"));
  assert.ok(!listed.thinkingLevels.includes("max"));

  const claude = (await delegateOptions(sources)).backends.find((b) => b.id === "claude-code")!;
  assert.deepEqual(claude.models!.find((m) => m.id === NEW), { id: NEW, name: "Nova 1.2", efforts: ["low", "high"] }, "Settings rows");

  assert.ok(claudeOffer().some((m) => m.id === NEW), "agent_models reads the offer");
  assert.equal(claudeContextWindow(NEW), 1_000_000, "worker gauges");
  assert.equal(resolveClaude(`claude-code-cli/${NEW}`)?.id, NEW, "Usage rows group by it");
  assert.equal(claudeName(NEW), "Nova 1.2");
  assert.equal(unverifiedClaudeNote(NEW), undefined);
  assert.deepEqual(checkChoice({ backend: "claude-code", model: NEW, effort: "high" }, await delegateOptions(sources)), {});
});

test("a dropped model leaves the lists, and a saved choice or old chat still has it, with no note", async () => {
  assert.ok(!(await listModels()).some((m) => m.ref === `claude-code-cli/${DROPPED}`), "gone from the picker");
  const options = await delegateOptions(sources);
  assert.ok(!options.backends.find((b) => b.id === "claude-code")!.models!.some((m) => m.id === DROPPED), "gone from Settings' rows");

  assert.ok((await getModelRuntime()).getModel("claude-code-cli", DROPPED), "an old chat still opens on it");
  assert.equal(claudeName(DROPPED), "Sonnet 4.6");
  assert.equal(unverifiedClaudeNote(DROPPED), undefined);
  assert.deepEqual(checkChoice({ backend: "claude-code", model: DROPPED, effort: "high" }, options), {}, "a saved choice: no warning, no error");
});

test("a table model Sova doesn't offer, typed by hand, is unknown", async () => {
  const typed = "claude-mythos-5-2";
  assert.equal(claudeContextWindow(typed), 200_000);
  assert.match(unverifiedClaudeNote(typed)!, /^Not verified/);
  assert.match(checkChoice({ backend: "claude-code", model: typed, effort: "high" }, await delegateOptions(sources)).warning!, /^not verified/);
});

test("the page is told the list, and whether it's the last known one", async () => {
  const fresh = claudeCatalogInfo(stateDir);
  assert.deepEqual([fresh.data.models.map((m) => m.id), fresh.data.dropped, fresh.lastKnown], [[NEW], [DROPPED], false]);

  // The test environment switches the table read off; these say what happens with it on.
  const off = { PI_OFFLINE: process.env.PI_OFFLINE, SOVA_MODELS_FETCH: process.env.SOVA_MODELS_FETCH, SOVA_CLAUDE_TABLE: process.env.SOVA_CLAUDE_TABLE };
  for (const k of Object.keys(off)) delete process.env[k];
  try {
    await store({ models: [{ id: NEW }], unreadable: { reason: "no rows", at: 1 } });
    assert.equal(claudeCatalogInfo(stateDir).lastKnown, true, "a claude whose table can't be read");
    process.env.SOVA_MODELS_FETCH = "off";
    assert.equal(claudeCatalogInfo(stateDir).lastKnown, false, "the read switched off: nothing to say");
    delete process.env.SOVA_MODELS_FETCH;

    await store({ models: [{ id: NEW }], noProgram: true });
    assert.equal(claudeCatalogInfo(stateDir).lastKnown, false, "no claude program: nothing to say");
  } finally {
    for (const [k, v] of Object.entries(off)) if (v !== undefined) process.env[k] = v;
  }
});
