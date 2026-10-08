// Run: pnpm test -- server/session-profile-cards.test.ts. Uses a throwaway PI_CODING_AGENT_DIR in
// the OS temp dir; ~/.pi is never read or written.
//
// Profile cards in real runtimes: a pick sets the effort and the subagent pick with the entry, is
// checked before anything is written, pins the device default when switching back from a card that
// set subagents, never writes defaults.json; Save Current As Profile writes yours only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-profile-cards-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
// This repo's mode extension by its real path: the subagent pick is the mode extension's entry.
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ retry: { baseDelayMs: 1 }, extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }),
);
// The policy turns zai off, so a card on a zai model can't be picked.
writeFileSync(join(agentDir, "model-policy.json"), JSON.stringify({ version: 1, disabledProviders: ["zai"], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }));
// Two providers with keys, so a card can name a model other than the one a fresh session opens on.
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test" }, openai: { type: "api_key", key: "test" } }));
const sessionsDir = join(agentDir, "sessions", "--tmp-cards--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const sp = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
// This device's subagent library: two profiles, "house" the default.
sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [sp.legacyProfile(agentDir, "house", "House"), sp.legacyProfile(agentDir, "claude-subs", "Claude subs")] });
sp.writeProfilesDefault(agentDir, { version: 1, default: "house" });

const stateDir = join(agentDir, "sova");
mkdirSync(stateDir, { recursive: true });
const yoursFile = join(stateDir, "session-profiles.json");
const YOURS = {
  version: 1,
  profiles: [
    { id: "subs", label: "Claude subagents", icon: "network", thinking: "high", subagents: "claude-subs" },
    { id: "denied", label: "GLM main", model: "zai/glm-5.3" },
    { id: "dangling", label: "Gone subagents", subagents: "nope" },
    { id: "plain", label: "Plain", description: "Changes nothing." },
    { id: "gpt", label: "GPT high", model: "openai/gpt-5.5", thinking: "high" },
  ],
};
writeFileSync(yoursFile, JSON.stringify(YOURS, null, 2));

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { applyProfile, profilesListing, saveCurrentProfile } = await import("./session-profile-routes");
const { PROFILE_ENTRY } = await import("../shared/profiles");
const { addWebSession } = await import("./web-sessions");
const { markOwned } = await import("./write-guard");

after(async () => {
  await disposeAllChats();
});

let n = 0;
function makeSession(): string {
  const id = `0199bbbb-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-10-08T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-08T00:00:00.000Z", cwd }) + "\n");
  markOwned(path);
  addWebSession(id);
  return path;
}
const entries = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; customType?: string; data?: unknown; thinkingLevel?: string });
const pickOf = (path: string) => sp.restorePick(entries(path) as never);
const picks = (path: string) => entries(path).filter((e) => e.customType === sp.PICK_ENTRY_TYPE);
const defaultsFile = join(stateDir, "defaults.json");
const yours = { source: "user" as const };

describe("a card's effort and subagents", () => {
  test("a pick sets the effort and the subagent pick with the entry; Default afterwards pins the device default", async () => {
    const path = makeSession();
    await acquireChat(path, true);
    assert.deepEqual(await applyProfile(path, { ...yours, id: "subs" }), { ok: true });
    const after = entries(path);
    assert.equal(after.filter((e) => e.customType === PROFILE_ENTRY).length, 1);
    assert.ok(after.some((e) => e.type === "thinking_level_change"), "the card's effort is set");
    assert.equal(pickOf(path), "claude-subs");
    // Back to Default: picks are newest-wins and can't be cleared, so the device default is pinned.
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.equal(pickOf(path), "house");
    assert.equal(picks(path).length, 2);
    // Default again: nothing more to pin.
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.equal(picks(path).length, 2);
  });

  test("a card without subagents after one that set them pins Off when the device default is Off", async () => {
    sp.writeProfilesDefault(agentDir, { version: 1, default: "off" });
    try {
      const path = makeSession();
      assert.deepEqual(await applyProfile(path, { ...yours, id: "subs" }), { ok: true });
      assert.deepEqual(await applyProfile(path, { ...yours, id: "plain" }), { ok: true });
      assert.equal(pickOf(path), "off");
    } finally {
      sp.writeProfilesDefault(agentDir, { version: 1, default: "house" });
    }
  });

  test("a session that never had a pick gets none from a pick without subagents", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "plain" }), { ok: true });
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.equal(picks(path).length, 0);
  });

  test("Default after a card that set the model and effort, with no new-session defaults: what a fresh session opens on", async () => {
    assert.equal(existsSync(defaultsFile), false);
    const fresh = await acquireChat(makeSession(), true);
    const want = { model: fresh.harness.model()?.ref, thinking: fresh.harness.thinking() };
    assert.notEqual(want.model, "openai/gpt-5.5");
    assert.notEqual(want.thinking, "high");
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "gpt" }), { ok: true });
    const card = await acquireChat(path, true);
    assert.deepEqual({ model: card.harness.model()?.ref, thinking: card.harness.thinking() }, { model: "openai/gpt-5.5", thinking: "high" });
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    const back = await acquireChat(path, true);
    assert.deepEqual({ model: back.harness.model()?.ref, thinking: back.harness.thinking() }, want);
    assert.equal(existsSync(defaultsFile), false, "defaults.json is never written");
  });

  test("refused before anything is written: a model the policy turns off, a subagent profile this device lacks", async () => {
    const path = makeSession();
    await acquireChat(path, true);
    const before = readFileSync(path, "utf8");
    const denied = await applyProfile(path, { ...yours, id: "denied" });
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.status, 400);
    assert.match(!denied.ok ? denied.error : "", /^GLM main can't be picked here: Provider zai is turned off in Settings → Models/);
    assert.equal(readFileSync(path, "utf8"), before, "nothing written");
    const dangling = await applyProfile(path, { ...yours, id: "dangling" });
    assert.deepEqual(dangling.ok ? null : [dangling.status, dangling.error], [400, `Gone subagents can't be picked here: Its subagent profile "nope" isn't in this device's library.`]);
    assert.equal(readFileSync(path, "utf8"), before, "nothing written");
  });

  test("no card pick ever writes the new-session defaults", () => {
    assert.equal(existsSync(defaultsFile), false);
  });

  test("the listing says which cards can't be used here, and why", async () => {
    const l = await profilesListing(cwd);
    assert.deepEqual(Object.keys(l.unusable ?? {}).sort(), ["user:dangling", "user:denied"]);
    assert.match(l.unusable!["user:denied"]!, /^Provider zai is turned off in Settings → Models/);
    assert.deepEqual(l.subagents?.map((s) => s.id), ["off", "house", "claude-subs"]);
  });
});

describe("Save Current As Profile", () => {
  test("adds the session's effort and own subagent pick to yours, keeping the others exactly as written", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "subs" }), { ok: true });
    const before = JSON.parse(readFileSync(yoursFile, "utf8")) as typeof YOURS;
    const r = await saveCurrentProfile(path, "My Claude");
    assert.ok(r.ok, !r.ok ? r.error : "");
    const file = JSON.parse(readFileSync(yoursFile, "utf8")) as { version: number; profiles: Record<string, unknown>[] };
    assert.deepEqual(file.profiles.slice(0, -1), before.profiles, "the others untouched");
    const added = file.profiles.at(-1)!;
    assert.deepEqual({ id: added.id, label: added.label, icon: added.icon, subagents: added.subagents }, { id: "my-claude", label: "My Claude", icon: "wrench", subagents: "claude-subs" });
    assert.ok(typeof added.thinking === "string");
    assert.ok(r.ok && r.listing.yours.some((p) => p.id === "my-claude"));
    // A name already yours is refused, and nothing is written.
    const text = readFileSync(yoursFile, "utf8");
    const dup = await saveCurrentProfile(path, "my claude");
    assert.deepEqual(dup.ok ? null : dup.error, `You already have a profile named "my claude". Pick another name.`);
    assert.equal(readFileSync(yoursFile, "utf8"), text);
  });

  test("a session with no pick of its own saves no subagents; a malformed file is refused and never overwritten", async () => {
    const path = makeSession();
    const r = await saveCurrentProfile(path, "Follows default");
    assert.ok(r.ok, !r.ok ? r.error : "");
    const added = (JSON.parse(readFileSync(yoursFile, "utf8")) as { profiles: Record<string, unknown>[] }).profiles.at(-1)!;
    assert.equal(added.label, "Follows default");
    assert.equal("subagents" in added, false);
    const good = readFileSync(yoursFile, "utf8");
    writeFileSync(yoursFile, "{ not json");
    try {
      const bad = await saveCurrentProfile(path, "Another");
      assert.equal(bad.ok, false);
      assert.match(!bad.ok ? bad.error : "", /can't be read .* so nothing was saved/);
      assert.equal(readFileSync(yoursFile, "utf8"), "{ not json");
    } finally {
      writeFileSync(yoursFile, good);
    }
  });
});
