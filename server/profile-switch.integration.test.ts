// Run: pnpm test:int -- server/profile-switch.integration.test.ts. A chat's mid-chat switch of its whole
// Models part (§chat.profiles/switch, /edited, §chat.subagent-profiles/limit-row), in real pi runtimes in
// this process with the scripted model: checked first and all or nothing; while a reply runs it waits for
// the reply's end and then moves the model and the helper pick together; Cancel Switch leaves both; a
// composer pick afterwards reads "(edited)" and a failed turn names the model it actually ran.
// A throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import type { ChatProfileState } from "../shared/profile-switch";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { piSession } from "./harness/pi/testing/handle";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-profile-switch-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
// The mode extension by its real path: the helper pick is its entry, and a chat without a mode owner can't switch.
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false }, extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }),
);
// Settings → Models turns zai off: a profile on a zai model is refused before anything is written.
writeFileSync(join(agentDir, "model-policy.json"), JSON.stringify({ version: 1, disabledProviders: ["zai"], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }));
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test" }, openai: { type: "api_key", key: "test" } }));
const sessionsDir = join(agentDir, "sessions", "--tmp-switch--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

await import("./testing/in-process-chats"); // chats open in this process
const sp = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [sp.legacyProfile(agentDir, "house", "House"), sp.legacyProfile(agentDir, "gpt-subs", "GPT helpers")] });
sp.writeProfilesDefault(agentDir, { version: 1, default: "house" });
const stateDir = join(agentDir, "sova");
mkdirSync(stateDir, { recursive: true });
// Yours: a pair on OpenAI (its own model and effort, helpers "gpt-subs"), and one on a model the policy turns off.
writeFileSync(
  join(stateDir, "session-profiles.json"),
  JSON.stringify({
    version: 1,
    profiles: [
      { id: "fast", label: "Fast", model: "openai/gpt-5.5", thinking: "high", subagents: "gpt-subs" },
      { id: "glm", label: "GLM", model: "zai/glm-5.3", subagents: "gpt-subs" },
      { id: "solo", label: "Solo", model: "openai/gpt-5.5" },
    ],
  }),
);

const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");
const { addWebSession } = await import("./web-sessions");
const { switchChatProfile, switchTargetOf, cancelChatProfileSwitch, switchRefusalOf } = await import("./profile-switch");
const { CHAT_PROFILE_ENTRY } = await import("../shared/profile-switch");

after(async () => {
  await disposeAllChats();
});

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let n = 0;
async function openChat() {
  const id = `0199cccc-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-11-08T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-08T00:00:00.000Z", cwd }) + "\n");
  markOwned(path);
  addWebSession(id);
  const chat = await acquireChat(path, true);
  const model = new ScriptedModel().attach(piSession(chat));
  const heard: ChatServerMessage[] = [];
  chat.attach({ send: (m: ChatServerMessage) => heard.push(m) } as never);
  const profileMessages = () => heard.filter((m): m is Extract<ChatServerMessage, { type: "chat_profile" }> => m.type === "chat_profile").map((m) => m.state as ChatProfileState);
  return { path, chat, model, heard, profileMessages };
}
const fileOf = (path: string) => readFileSync(path, "utf8");
const lines = (path: string) => fileOf(path).trim().split("\n").map((l) => JSON.parse(l)) as { type: string; customType?: string; data?: unknown }[];
const switchEntries = (path: string) => lines(path).filter((e) => e.customType === CHAT_PROFILE_ENTRY);
/** What a switch writes, counted: model and effort changes, helper picks, the profile entry. */
const written = (path: string) => {
  const all = lines(path);
  return { model: all.filter((e) => e.type === "model_change").length, thinking: all.filter((e) => e.type === "thinking_level_change").length, pick: all.filter((e) => e.customType === sp.PICK_ENTRY_TYPE).length, profile: all.filter((e) => e.customType === CHAT_PROFILE_ENTRY).length };
};

describe("a profile switch, all at once (§chat.profiles/switch)", () => {
  test("resolves a joined profile into the chat's model, effort and helpers", async () => {
    const t = await switchTargetOf("fast", cwd);
    assert.ok(!("error" in t), JSON.stringify(t));
    assert.equal(t.model, "openai/gpt-5.5");
    assert.equal(t.thinking, "high");
    assert.equal(t.subagents, "gpt-subs");
    assert.ok(t.helpers > 0);
    assert.deepEqual(await switchTargetOf("off", cwd), { id: "off", key: "sova:default", name: "Off", subagents: "off", helpers: 0 });
    const unknown = await switchTargetOf("nope", cwd);
    assert.ok("error" in unknown && unknown.status === 404);
  });

  test("idle: model, effort and helper pick move together, and the chat remembers the profile", async () => {
    const { path, chat, profileMessages } = await openChat();
    assert.equal(chat.harness.model()?.ref, "scripted/scripted");
    const was = written(path);
    const r = await switchChatProfile(path, "fast");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.applies, "now");
    assert.equal(chat.harness.model()?.ref, "openai/gpt-5.5");
    assert.equal(chat.harness.thinking(), "high");
    assert.equal(chat.subagentPick, "gpt-subs");
    assert.equal(r.state.current.id, "fast");
    assert.equal(r.state.current.edited, false);
    assert.equal(r.state.applied?.name, "Fast");
    // The open's own deferred model and effort entries go out first, then the switch's.
    const now = written(path);
    assert.ok(now.model > was.model && now.thinking > was.thinking, JSON.stringify({ was, now }));
    assert.deepEqual({ pick: now.pick, profile: now.profile }, { pick: 1, profile: 1 });
    const last = (type: string) => [...lines(path)].reverse().find((e) => e.type === type) as Record<string, unknown> | undefined;
    assert.equal(last("model_change")?.modelId, "gpt-5.5");
    assert.equal(last("thinking_level_change")?.thinkingLevel, "high");
    assert.ok(profileMessages().some((s) => s.current.id === "fast" && s.applied?.name === "Fast"));
  });

  test("a switch during a reply waits for its end, then the model and the helper pick both name the new profile", async () => {
    const { path, chat, model, profileMessages } = await openChat();
    const release = model.hold();
    const run = chat.prompt("hi").catch(() => undefined); // resolves once the held reply ends
    await until(() => chat.harness.isRunning() && model.calls.length === 1, "the reply to start");
    const r = await switchChatProfile(path, "fast");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.applies, "after-turn");
    assert.deepEqual(r.state.pending, { id: "fast", key: r.state.pending?.key, name: "Fast", helpers: r.state.pending!.helpers, setsModel: true });
    // Nothing moved yet: the running reply keeps the old model and helpers.
    assert.equal(chat.harness.model()?.ref, "scripted/scripted");
    assert.equal(chat.subagentPick, undefined);
    const held = written(path);
    assert.deepEqual({ pick: held.pick, profile: held.profile }, { pick: 0, profile: 0 });
    release();
    await run;
    await until(() => chat.harness.model()?.ref === "openai/gpt-5.5", "the held switch to apply");
    assert.deepEqual(written(path), { model: held.model + 1, thinking: held.thinking + 1, pick: 1, profile: 1 });
    assert.equal(chat.subagentPick, "gpt-subs");
    assert.equal(chat.harness.thinking(), "high");
    const state = chat.chatProfileState();
    assert.equal(state.pending, undefined);
    assert.equal(state.current.id, "fast");
    assert.equal(state.applied?.name, "Fast");
    assert.ok(profileMessages().some((s) => s.applied?.name === "Fast" && !s.pending));
  });

  test("a denied model leaves the model and the helpers as they are and writes nothing", async () => {
    const { path, chat } = await openChat();
    const before = fileOf(path);
    const counts = written(path);
    const r = await switchChatProfile(path, "glm");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.status === 400 && r.name === "GLM", JSON.stringify(r));
    assert.equal(chat.harness.model()?.ref, "scripted/scripted");
    assert.equal(chat.subagentPick, undefined);
    assert.equal(fileOf(path), before, "the session file is untouched");
    assert.deepEqual(written(path), counts);
  });

  test("a model this computer can't find is refused the same way, idle or at the reply's end", async () => {
    const { path, chat, model } = await openChat();
    const before = fileOf(path);
    const r = await chat.switchProfile({ id: "x", name: "X", model: "nowhere/none", subagents: "gpt-subs", helpers: 1 });
    assert.deepEqual(r, { ok: false, status: 400, error: "No credentials here for none." });
    assert.equal(fileOf(path), before);
    // Held, then its turn-end check fails: nothing switches and the chat says why.
    const release = model.hold();
    const run = chat.prompt("hi").catch(() => undefined);
    await until(() => chat.harness.isRunning(), "the reply to start");
    const ok = await chat.switchProfile({ id: "fast", name: "Fast", model: "openai/gpt-5.5", subagents: "gpt-subs", helpers: 1 });
    assert.ok(ok.ok && ok.applies === "after-turn");
    writeFileSync(join(agentDir, "model-policy.json"), JSON.stringify({ version: 1, disabledProviders: ["zai", "openai"], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }));
    try {
      release();
      await run;
      await until(() => chat.chatProfileState().failed !== undefined, "the re-check to fail");
      assert.equal(chat.chatProfileState().failed?.name, "Fast");
      assert.equal(chat.harness.model()?.ref, "scripted/scripted");
      assert.equal(chat.subagentPick, undefined);
      assert.equal(switchEntries(path).length, 0);
    } finally {
      writeFileSync(join(agentDir, "model-policy.json"), JSON.stringify({ version: 1, disabledProviders: ["zai"], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }));
    }
  });

  test("Cancel Switch drops the waiting switch: the model and the helpers stay", async () => {
    const { path, chat, model } = await openChat();
    const release = model.hold();
    const run = chat.prompt("hi").catch(() => undefined);
    await until(() => chat.harness.isRunning(), "the reply to start");
    const r = await switchChatProfile(path, "fast");
    assert.ok(r.ok && r.applies === "after-turn");
    const c = await cancelChatProfileSwitch(path);
    assert.equal(c?.cancelled, true);
    assert.equal(c?.state.pending, undefined);
    release();
    await run;
    // A second reply ends too: any held switch would have applied at the first one's end.
    await chat.prompt("again");
    await until(() => model.calls.length === 2 && !chat.harness.isRunning(), "a second reply");
    assert.equal(chat.harness.model()?.ref, "scripted/scripted");
    assert.equal(chat.subagentPick, undefined);
    assert.deepEqual({ pick: written(path).pick, profile: written(path).profile }, { pick: 0, profile: 0 });
  });

  test("a composer pick after a switch reads (edited); the profile's model again clears it; a failed turn names the model it ran", async () => {
    const { path, chat, model } = await openChat();
    assert.ok((await switchChatProfile(path, "fast")).ok);
    await chat.setModelRef("anthropic/claude-opus-4-6", { save: true });
    let s = chat.chatProfileState();
    assert.equal(s.current.id, "fast");
    assert.equal(s.current.edited, true);
    assert.equal(s.current.model, "anthropic/claude-opus-4-6");
    assert.equal(chat.subagentPick, "gpt-subs", "a composer pick changes no helper");
    // The limit row judges what runs: the failed turn's model, never the profile's.
    model.reply({ error: "429 rate_limit_error: usage limit reached" });
    await chat.prompt("hi").catch(() => undefined);
    await until(() => !chat.harness.isRunning() && model.calls.length >= 1, "the failed reply");
    const branch = chat.harness.branch();
    const failed = [...branch].reverse().find((e) => e.kind === "assistant") as { model?: string; provider?: string; stop?: string } | undefined;
    assert.equal(failed?.stop, "error");
    assert.equal(`${failed?.provider}`, "anthropic");
    // The row the limit row reads (§chat.subagent-profiles/limit-row) carries that model, not the profile's.
    assert.equal(failed?.model, "claude-opus-4-6");
    // Picking the profile's model again clears it.
    await chat.setModelRef("openai/gpt-5.5");
    s = chat.chatProfileState();
    assert.equal(s.current.edited, false);
    // So does picking the profile again, after another hand pick: it puts back its model and effort.
    await chat.setModelRef("anthropic/claude-opus-4-6");
    chat.setThinking("low");
    const again = await switchChatProfile(path, "fast");
    assert.ok(again.ok && again.applies === "now");
    assert.equal(chat.harness.model()?.ref, "openai/gpt-5.5");
    assert.equal(chat.harness.thinking(), "high");
    assert.equal(chat.chatProfileState().current.edited, false);
  });

  test("Off moves only the helpers: the chat keeps its own model", async () => {
    const { path, chat } = await openChat();
    assert.ok((await switchChatProfile(path, "fast")).ok);
    const r = await switchChatProfile(path, "off");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(chat.harness.model()?.ref, "openai/gpt-5.5");
    assert.equal(chat.subagentPick, "off");
    assert.equal(r.state.current.id, "off");
    assert.equal(r.state.current.edited, false);
  });
  test("the same profile again, unedited, changes nothing and says nothing", async () => {
    const { path, chat } = await openChat();
    assert.ok((await switchChatProfile(path, "fast")).ok);
    const counts = written(path);
    const said = chat.chatProfileState().applied;
    const again = await switchChatProfile(path, "fast");
    assert.ok(again.ok && again.applies === "now");
    assert.deepEqual(written(path), counts);
    assert.equal(chat.chatProfileState().applied, said, "no new line");
  });

  test("a profile without helpers pins this computer's default profile's helpers", async () => {
    const free = await openChat();
    const r = await switchChatProfile(free.path, "solo");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(free.chat.harness.model()?.ref, "openai/gpt-5.5");
    // No default-profile.json yet: the default is the saved default subagent profile's row ("house", library-only).
    assert.equal(free.chat.subagentPick, "house");
    assert.equal(free.chat.chatProfileState().current.id, "solo");
  });

  test("all or nothing: when a write after the model fails, the model and effort are put back", async () => {
    const { path, chat } = await openChat();
    const real = chat.harness.state;
    const failing = Object.create(real, {
      append: { value: (kind: { type: string }, data: unknown) => {
        if (kind.type === CHAT_PROFILE_ENTRY) throw new Error("disk full");
        return (real.append as (k: unknown, d: unknown) => string).call(real, kind, data);
      } },
    });
    Object.defineProperty(chat.harness, "state", { value: failing, configurable: true });
    try {
      const r = await switchChatProfile(path, "fast");
      assert.ok(!r.ok && /disk full/.test(r.error), JSON.stringify(r));
      assert.equal(chat.harness.model()?.ref, "scripted/scripted");
      assert.notEqual(chat.harness.thinking(), "high");
    } finally {
      delete (chat.harness as unknown as { state?: unknown }).state;
    }
  });

  test("the Overseer's subagent_profile alias moves only the helpers: the chat stays on its profile", async () => {
    const { path, chat } = await openChat();
    assert.equal(chat.chatProfileState().current.id, "off");
    await chat.switchSubagentProfile("gpt-subs");
    assert.equal(chat.subagentPick, "gpt-subs");
    assert.equal(chat.chatProfileState().current.id, "off", "still Off, not the library profile");
    assert.ok((await switchChatProfile(path, "fast")).ok);
    await chat.switchSubagentProfile("house");
    assert.equal(chat.chatProfileState().current.id, "fast");
    assert.equal(chat.harness.model()?.ref, "openai/gpt-5.5");
  });

  test("refused for the Overseer's own chat, a TUI-live session and an unknown id, writing nothing", async () => {
    const { path, chat } = await openChat();
    const counts = written(path);
    // A TUI holds it: a live record for another process that is alive (this one's parent).
    const live = join(agentDir, "sessions", "live", `${process.ppid}.json`);
    writeFileSync(live, JSON.stringify({ session: { pid: process.ppid, sessionFile: path, cwd } }));
    try {
      const r = await chat.switchProfile({ id: "fast", name: "Fast", model: "openai/gpt-5.5", subagents: "gpt-subs", helpers: 1 });
      assert.ok(!r.ok && r.status === 409, JSON.stringify(r));
    } finally {
      rmSync(live, { force: true });
    }
    const unknown = await switchChatProfile(path, "nope");
    assert.ok(!unknown.ok && unknown.status === 404);
    Object.defineProperty(chat, "overseer", { get: () => true, configurable: true });
    try {
      const r = await chat.switchProfile({ id: "fast", name: "Fast", model: "openai/gpt-5.5", subagents: "gpt-subs", helpers: 1 });
      assert.ok(!r.ok && r.status === 409, JSON.stringify(r));
    } finally {
      delete (chat as unknown as { overseer?: unknown }).overseer;
    }
    assert.deepEqual(written(path), counts);
    assert.equal(chat.harness.model()?.ref, "scripted/scripted");
  });
  test("of an organization's sessions only a project's coding session takes a switch; Sova's special sessions never", () => {
    const org = (kind: "gathering" | "offer" | "overseer" | "coding" | "other") => ({ org: { kind } as never });
    assert.equal(switchRefusalOf(org("coding")), null);
    for (const kind of ["gathering", "offer", "overseer", "other"] as const) assert.equal(switchRefusalOf(org(kind)), "This chat can't switch profiles.", kind);
    for (const s of [{ overseer: true }, { projectOverseer: true }, { baton: true }, { workerSession: true }] as never[]) assert.ok(switchRefusalOf(s));
    assert.ok(switchRefusalOf({ queueChat: true } as never));
    assert.equal(switchRefusalOf({}), null);
  });
  test("a switch held only by a compaction (Sova's /compact, idle) applies when the compaction ends, with no reply", async () => {
    const { path, chat, model } = await openChat();
    const session = piSession(chat) as unknown as { compact: (i?: string) => Promise<unknown> };
    let release!: () => void;
    let compacting = false;
    session.compact = async () => {
      compacting = true;
      await new Promise<void>((r) => (release = r));
      return { tokensBefore: 300 };
    };
    const client = { send: () => {} };
    chat.handle(client as never, { type: "compact", id: "c1" });
    await until(() => compacting && chat.isCompacting(), "the compaction to start");
    const r = await switchChatProfile(path, "fast");
    assert.ok(r.ok && r.applies === "after-turn", JSON.stringify(r));
    assert.equal(chat.harness.model()?.ref, "scripted/scripted");
    release();
    await until(() => !chat.chatProfileState().pending, "the held switch to apply at the compaction's end");
    assert.equal(chat.harness.model()?.ref, "openai/gpt-5.5");
    assert.equal(chat.subagentPick, "gpt-subs");
    assert.equal(model.calls.length, 0, "no prompt was sent");
  });

  test("a switch held by pi's automatic compaction after a turn applies at compaction_end, not at the turn's settle", async () => {
    const { path, chat, model } = await openChat();
    const session = piSession(chat) as unknown as { _emit: (e: unknown) => void };
    // pi compacts on its own after a turn: isCompacting stays true through the turn's settle.
    Object.defineProperty(session, "isCompacting", { get: () => true, configurable: true });
    const r = await switchChatProfile(path, "fast");
    assert.ok(r.ok && r.applies === "after-turn", JSON.stringify(r));
    session._emit({ type: "agent_settled" });
    await new Promise((res) => setImmediate(res));
    assert.ok(chat.chatProfileState().pending, "the settle came while compacting: it still waits");
    session._emit({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
    delete (session as { isCompacting?: unknown }).isCompacting; // pi's finally, right after the emit returns
    await until(() => !chat.chatProfileState().pending, "the held switch to apply at compaction_end");
    assert.equal(chat.harness.model()?.ref, "openai/gpt-5.5");
    assert.equal(model.calls.length, 0, "no prompt was sent");
  });
  test("the chat's own unedited profile while it is busy: no waiting switch, no line, and a waiting one is dropped", async () => {
    const { path, chat, model } = await openChat();
    assert.ok((await switchChatProfile(path, "fast")).ok);
    const counts = written(path);
    const release = model.hold();
    const run = chat.prompt("hi").catch(() => undefined);
    await until(() => chat.harness.isRunning() && model.calls.length === 1, "the reply to start");
    const same = await switchChatProfile(path, "fast");
    assert.ok(same.ok && same.applies === "now", JSON.stringify(same));
    assert.equal(same.state.pending, undefined, "no waiting line");
    // Another switch waits; picking the current profile again drops it.
    const other = await switchChatProfile(path, "solo");
    assert.ok(other.ok && other.applies === "after-turn");
    const back = await switchChatProfile(path, "fast");
    assert.ok(back.ok && back.applies === "now" && !back.state.pending, JSON.stringify(back));
    release();
    await run;
    assert.equal(chat.chatProfileState().current.id, "fast");
    assert.deepEqual(written(path), counts, "nothing written at the reply's end");
  });
});
