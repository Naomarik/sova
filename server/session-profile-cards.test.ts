// Run: pnpm test -- server/session-profile-cards.test.ts. Uses a throwaway PI_CODING_AGENT_DIR in
// the OS temp dir; ~/.pi is never read or written.
//
// Profile cards in real runtimes: a pick sets the effort and the subagent pick with the entry, is
// checked before anything is written, pins the device default when switching back from a card that
// set subagents, never writes defaults.json; its mode and minor modes are pinned together, and go
// back to mode.json's default when switching back; Save Current As Profile writes yours only.
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

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
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
    { id: "aligned", label: "Aligned delegate", mode: "delegate", minorModes: ["vis", "align", "spec"] },
    { id: "spec-only", label: "Spec only", minorModes: ["spec"] },
    { id: "no-minors", label: "No minors", minorModes: [] },
  ],
};
writeFileSync(yoursFile, JSON.stringify(YOURS, null, 2));
// The default new sessions start from: normal, no minor modes.
const modeFile = join(agentDir, "mode.json");
const MODE_DEFAULT = JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] });
writeFileSync(modeFile, MODE_DEFAULT);

const { restoreActive, MODE_ENTRY_TYPE } = await import("../pi-config/extensions/mode/state.ts");
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { applyProfile, profilesListing } = await import("./session-profile-routes");
const { saveCurrentFor } = await import("./profile-editor-routes");
const { startOnDefault } = await import("./default-start");
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
  test("a pick sets the effort and the subagent pick with the entry; Off afterwards pins the helpers to off", async () => {
    const path = makeSession();
    await acquireChat(path, true);
    assert.deepEqual(await applyProfile(path, { ...yours, id: "subs" }), { ok: true });
    const after = entries(path);
    assert.equal(after.filter((e) => e.customType === PROFILE_ENTRY).length, 1);
    assert.ok(after.some((e) => e.type === "thinking_level_change"), "the card's effort is set");
    assert.equal(pickOf(path), "claude-subs");
    // Back to Off: the agent picks every worker, so the helpers are pinned to off (§chat.subagent-profiles/off).
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.equal(pickOf(path), "off");
    assert.equal(picks(path).length, 2);
    // Off again: nothing more to pin.
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

  test("a session that never had a pick gets none from a pick without subagents; Off pins off", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "plain" }), { ok: true });
    assert.equal(picks(path).length, 0);
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.equal(pickOf(path), "off");
  });

  test("switching back to a profile without subagents pins this computer's default profile's helpers", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "subs" }), { ok: true });
    assert.deepEqual(await applyProfile(path, { ...yours, id: "plain" }), { ok: true });
    assert.equal(pickOf(path), "house", "the saved default helpers, no default chosen yet");
  });

  test("a library profile no session profile links is picked as Off with its helpers", async () => {
    const libFile = join(agentDir, "subagent-profiles.json");
    const before = readFileSync(libFile, "utf8");
    sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [...(JSON.parse(before) as { profiles: unknown[] }).profiles, sp.legacyProfile(agentDir, "solo", "Solo")] });
    try {
      for (const pick of ["library:solo", "solo"]) {
        const path = makeSession();
        assert.deepEqual(await applyProfile(path, pick), { ok: true }, pick);
        assert.deepEqual(entries(path).filter((e) => e.customType === PROFILE_ENTRY).map((e) => (e.data as { profile: unknown }).profile), [null]);
        assert.equal(pickOf(path), "solo");
      }
      const bad = await applyProfile(makeSession(), "library:nope");
      assert.equal(bad.ok, false);
    } finally {
      writeFileSync(libFile, before);
    }
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
    // The cards' subagents count: the footprint's distinct primary models, counted, never parsed by the client.
    assert.equal(l.subagents?.[0]?.models, 0, "off names no models");
    for (const s of l.subagents!.slice(1)) {
      assert.ok(s.models! > 0, `${s.id} names a model`);
      if (!s.footprint.includes("+")) assert.equal(s.models, s.footprint.split(" · ").length, `${s.id}: ${s.footprint}`);
    }
  });
});

/** The mode and minor modes the branch's newest mode entry pins, or null when none does. */
const pinned = (path: string) => {
  const a = restoreActive(entries(path) as never);
  return a ? { mode: a.mode, minorModes: [...a.minorModes] } : null;
};
/** The mode a chat opened fresh on the session holds. */
const reopened = async (path: string) => {
  await disposeHeldChat(path, "test");
  const s = (await acquireChat(path)).modeState;
  return { mode: s.mode, minorModes: [...s.minorModes] };
};

describe("a card's mode and minor modes", () => {
  test("a pick pins exactly its set with its mode, and a later mode.json edit never moves them", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "aligned" }), { ok: true });
    const want = { mode: "delegate", minorModes: ["align", "spec", "vis"] };
    assert.deepEqual(pinned(path), want, "the branch's mode entry has them");
    assert.deepEqual(await reopened(path), want, "a reopened chat holds them");
    writeFileSync(modeFile, JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: ["vis"] }));
    try {
      assert.deepEqual(await reopened(path), want, "mode.json moved; the session didn't");
    } finally {
      writeFileSync(modeFile, MODE_DEFAULT);
    }
  });

  test("minorModes without mode keeps the session's mode; [] pins none over a default that has some", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "spec-only" }), { ok: true });
    assert.deepEqual(pinned(path), { mode: "normal", minorModes: ["spec"] });
    writeFileSync(modeFile, JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: ["align"] }));
    try {
      const none = makeSession();
      assert.deepEqual(await applyProfile(none, { ...yours, id: "no-minors" }), { ok: true });
      assert.deepEqual(pinned(none), { mode: "normal", minorModes: [] });
      assert.deepEqual(await reopened(none), { mode: "normal", minorModes: [] });
    } finally {
      writeFileSync(modeFile, MODE_DEFAULT);
    }
  });

  test("switching back: Default or a card without them puts mode.json's mode and minor modes back, pinned, and never writes mode.json", async () => {
    const def = { mode: "normal", minorModes: [] };
    for (const back of [null, { ...yours, id: "plain" }]) {
      const path = makeSession();
      assert.deepEqual(await applyProfile(path, { ...yours, id: "aligned" }), { ok: true });
      assert.deepEqual(await applyProfile(path, back), { ok: true });
      assert.deepEqual(pinned(path), def, `after ${back ? "Plain" : "Default"}`);
      assert.deepEqual(await reopened(path), def);
    }
    assert.equal(readFileSync(modeFile, "utf8"), MODE_DEFAULT, "mode.json is never written");
  });

  test("a card that sets neither, with none before it, writes no mode entry", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "plain" }), { ok: true });
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.equal(entries(path).filter((e) => e.customType === MODE_ENTRY_TYPE).length, 0);
  });
});

/** The `mine` of each profile entry on the file, in order (null for an entry without one). */
const mines = (path: string) => entries(path).filter((e) => e.customType === PROFILE_ENTRY).map((e) => (e.data as { mine?: unknown }).mine ?? null);

describe("My settings comes back as you left it (§chat.profiles/applying)", () => {
  test("what was set by hand before the first pick is remembered, carried across picks, and put back by My settings", async () => {
    const path = makeSession();
    const chat = await acquireChat(path, true);
    const model = chat.harness.model()?.ref;
    assert.ok(model && model !== "openai/gpt-5.5");
    // By hand, before any profile: delegate with spec, low effort, subagents off (the device default is house).
    await chat.switchMode({ mode: "delegate", minorModes: ["spec"] });
    chat.setThinking("low");
    await chat.switchSubagentProfile("off");
    const byHand = { mode: "delegate", minorModes: ["spec"], model, thinking: chat.harness.thinking(), subagents: "off" };
    // Three profiles, each moving something: the model and effort, the mode, the effort and subagents.
    for (const id of ["gpt", "aligned", "subs"]) assert.deepEqual(await applyProfile(path, { ...yours, id }), { ok: true }, id);
    const held = await acquireChat(path, true);
    assert.equal(held.profileMessage().mine?.mode, "delegate", "the picker hears what My settings puts back");
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    const back = await acquireChat(path, true);
    assert.deepEqual(
      { mode: back.modeState.mode, minorModes: [...back.modeState.minorModes], model: back.harness.model()?.ref, thinking: back.harness.thinking(), subagents: pickOf(path) },
      byHand,
    );
    assert.deepEqual(pinned(path), { mode: "delegate", minorModes: ["spec"] }, "the mode is pinned with its minor modes");
    // Remembered at the first pick, the same on every later one, and gone once back on My settings.
    const m = mines(path);
    assert.deepEqual(m.slice(0, 3), [byHand, byHand, byHand]);
    assert.equal(m[3], null);
    assert.equal(back.profileMessage().mine, undefined);
    assert.equal(readFileSync(modeFile, "utf8"), MODE_DEFAULT, "mode.json is never written");
    assert.equal(existsSync(defaultsFile), false, "defaults.json is never written");
  });

  test("the next first pick remembers afresh", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "aligned" }), { ok: true });
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    const chat = await acquireChat(path, true);
    await chat.switchMode({ mode: "normal", minorModes: ["vis"] });
    assert.deepEqual(await applyProfile(path, { ...yours, id: "aligned" }), { ok: true });
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.deepEqual(await reopened(path), { mode: "normal", minorModes: ["vis"] });
  });

  test("a remembered model that can't be used now falls to the one a new session opens on", async () => {
    const fresh = (await acquireChat(makeSession(), true)).harness.model()?.ref;
    const path = makeSession();
    const chat = await acquireChat(path, true);
    await chat.setModelRef("openai/gpt-5.5");
    writeFileSync(yoursFile, JSON.stringify({ ...YOURS, profiles: [...YOURS.profiles, { id: "fresh-model", label: "Fresh model", model: fresh }] }));
    const policy = readFileSync(join(agentDir, "model-policy.json"), "utf8");
    try {
      assert.deepEqual(await applyProfile(path, { ...yours, id: "fresh-model" }), { ok: true });
      writeFileSync(join(agentDir, "model-policy.json"), JSON.stringify({ ...JSON.parse(policy), disabledProviders: ["zai", "openai"] }));
      assert.deepEqual(await applyProfile(path, null), { ok: true });
      assert.equal((await acquireChat(path, true)).harness.model()?.ref, fresh);
    } finally {
      writeFileSync(join(agentDir, "model-policy.json"), policy);
      writeFileSync(yoursFile, JSON.stringify(YOURS, null, 2));
    }
  });

  test("an entry an older build wrote, with no `mine`: My settings puts mode.json's mode back, as before", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "aligned" }), { ok: true });
    await disposeHeldChat(path, "test");
    const lines = entries(path).map((e) => (e.customType === PROFILE_ENTRY ? { ...e, data: { ...(e.data as object), mine: undefined } } : e));
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    markOwned(path);
    assert.deepEqual(mines(path), [null]);
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.deepEqual(pinned(path), { mode: "normal", minorModes: [] });
  });
});

describe("Save Current As Profile", () => {
  // No model list here: every worker is "not verified", a warning, never a refusal.
  const sources = { piModels: async () => { throw new Error("offline"); }, claudeModels: async () => { throw new Error("offline"); }, policy: () => ({ version: 1 as const, disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }) };
  const library = () => (JSON.parse(readFileSync(join(agentDir, "subagent-profiles.json"), "utf8")) as { profiles: { id: string; name: string }[] }).profiles;

  test("adds the session's effort and a copy of its helpers to yours, both halves linked, keeping the others exactly as written", async () => {
    const path = makeSession();
    assert.deepEqual(await applyProfile(path, { ...yours, id: "subs" }), { ok: true });
    const before = JSON.parse(readFileSync(yoursFile, "utf8")) as typeof YOURS;
    const libBefore = library();
    const r = await saveCurrentFor(path, "My Claude", sources);
    assert.ok(r.ok, !r.ok ? r.error : "");
    const file = JSON.parse(readFileSync(yoursFile, "utf8")) as { version: number; profiles: Record<string, unknown>[] };
    assert.deepEqual(file.profiles.slice(0, -1), before.profiles, "the others untouched");
    const added = file.profiles.at(-1)!;
    assert.deepEqual({ id: added.id, label: added.label, icon: added.icon, subagents: added.subagents }, { id: "my-claude", label: "My Claude", icon: "wrench", subagents: "my-claude" });
    assert.ok(typeof added.thinking === "string");
    // The helpers are a copy of the chat's ("claude-subs"), under the profile's name; the library's others are kept.
    const lib = library();
    assert.deepEqual(lib.slice(0, -1), libBefore);
    const copy = lib.at(-1)!;
    assert.deepEqual({ id: copy.id, name: copy.name }, { id: "my-claude", name: "My Claude" });
    const source = libBefore.find((l) => l.id === "claude-subs")!;
    assert.deepEqual({ ...copy, id: source.id, name: source.name }, source);
    // A name already yours is refused, and nothing is written.
    const text = readFileSync(yoursFile, "utf8");
    const dup = await saveCurrentFor(path, "my claude", sources);
    assert.deepEqual(dup.ok ? null : dup.error, `You already have a profile named "my claude". Pick another name.`);
    assert.equal(readFileSync(yoursFile, "utf8"), text);
  });

  test("a session on the device default copies the default's helpers; a malformed file is refused and never overwritten", async () => {
    const path = makeSession();
    const r = await saveCurrentFor(path, "Follows default", sources);
    assert.ok(r.ok, !r.ok ? r.error : "");
    const added = (JSON.parse(readFileSync(yoursFile, "utf8")) as { profiles: Record<string, unknown>[] }).profiles.at(-1)!;
    assert.equal(added.label, "Follows default");
    assert.equal(added.subagents, "follows-default");
    assert.equal(library().at(-1)!.name, "Follows default");
    const good = readFileSync(yoursFile, "utf8");
    const libText = readFileSync(join(agentDir, "subagent-profiles.json"), "utf8");
    writeFileSync(yoursFile, "{ not json");
    try {
      const bad = await saveCurrentFor(path, "Another", sources);
      assert.equal(bad.ok, false);
      assert.match(!bad.ok ? bad.error : "", /can't be read .* so nothing was saved/);
      assert.equal(readFileSync(yoursFile, "utf8"), "{ not json");
      assert.equal(readFileSync(join(agentDir, "subagent-profiles.json"), "utf8"), libText, "the library half isn't written either");
    } finally {
      writeFileSync(yoursFile, good);
    }
  });
});

describe("a new chat with no profile named starts on this computer's default", () => {
  // A default that grants a session power and sets minor modes and helpers.
  const reader = { id: "reader", label: "Reader", grant: ["sessions.read"], minorModes: ["spec"], subagents: "claude-subs" };
  const withReader = async (extra: Record<string, unknown>, run: () => Promise<void>) => {
    const before = readFileSync(yoursFile, "utf8");
    const defFile = join(stateDir, "default-profile.json");
    writeFileSync(yoursFile, JSON.stringify({ ...YOURS, profiles: [...YOURS.profiles, { ...reader, ...extra }] }, null, 2));
    writeFileSync(defFile, JSON.stringify({ version: 1, profile: "reader" }));
    try {
      await run();
    } finally {
      writeFileSync(yoursFile, before);
      rmSync(defFile, { force: true });
    }
  };
  const profileEntries = (path: string) => entries(path).filter((e) => e.customType === PROFILE_ENTRY).map((e) => (e.data as { profile: { id: string; grant: string[] } | null }).profile);

  test("from your own new chat, the whole default: its entry, its powers and its helpers", async () => {
    await withReader({}, async () => {
      const path = makeSession();
      const r = await startOnDefault(path, cwd, false);
      assert.deepEqual(r, { ok: true, applied: "whole" });
      const p = profileEntries(path);
      assert.deepEqual(p.map((x) => [x?.id, x?.grant]), [["reader", ["sessions.read"]]]);
      assert.equal(pickOf(path), "claude-subs");
    });
  });

  test("an Overseer's start never gets the powers of a default not marked for it: modes and helpers only, no profile entry", async () => {
    await withReader({}, async () => {
      const path = makeSession();
      const r = await startOnDefault(path, cwd, true);
      assert.deepEqual(r, { ok: true, applied: "models" });
      assert.deepEqual(profileEntries(path), [], "no entry, so no grants");
      assert.deepEqual(pinned(path)?.minorModes, ["spec"]);
      assert.equal(pickOf(path), "claude-subs");
    });
  });

  test("an Overseer's start takes the whole default when the profile says the Overseer may start it", async () => {
    await withReader({ overseerMayStart: true }, async () => {
      const path = makeSession();
      assert.deepEqual(await startOnDefault(path, cwd, true), { ok: true, applied: "whole" });
      assert.deepEqual(profileEntries(path).map((x) => x?.grant), [["sessions.read"]]);
    });
  });

  test("Off as the default writes nothing to the new chat", async () => {
    writeFileSync(join(stateDir, "default-profile.json"), JSON.stringify({ version: 1, profile: "off" }));
    try {
      const path = makeSession();
      const before = readFileSync(path, "utf8");
      assert.deepEqual(await startOnDefault(path, cwd, false), { ok: true, applied: "none" });
      assert.equal(readFileSync(path, "utf8"), before);
    } finally {
      rmSync(join(stateDir, "default-profile.json"), { force: true });
    }
  });
});
