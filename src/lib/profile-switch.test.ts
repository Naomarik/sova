import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultLabel, defaultTitle, menuPick, updateOffered, editedName, limitLine, limitOffers, newChatLine, pickDoesSomething, pickerRows, rowDisabledReason, switchedLine, switchRefused, switchWaitingLine, type SwitchRow } from "./profile-switch";

const row = (key: string, providers: string[], extra: Partial<SwitchRow> = {}): SwitchRow => ({ key, id: key, kind: "pair", group: "yours", name: key.toUpperCase(), providers, setsModel: providers.length > 0, ...extra });
const OFF = row("off", [], { kind: "off", group: "builtin", name: "Off" });

test("the waiting line names the chat's model only when the profile sets one", () => {
  assert.equal(switchWaitingLine("OpenAI", 9, true), "Switching to OpenAI when this chat is free. Moves this chat's model, its 9 helpers, and alignment settings. Tools and modes stay.");
  assert.equal(switchWaitingLine("Ollama", 1, false), "Switching to Ollama when this chat is free. Moves its 1 helper and alignment settings. Tools and modes stay.");
  assert.equal(switchWaitingLine("Plain", 0, true), "Switching to Plain when this chat is free. Moves this chat's model and alignment settings. Tools and modes stay.", "never \"its 0 helpers\"");
  assert.equal(switchWaitingLine("Plain", 0, false), "Switching to Plain when this chat is free. Moves its alignment settings. Tools and modes stay.");
});

test("switched, refused, edited and limit wording", () => {
  assert.equal(switchedLine("Claude"), "This chat and its helpers are on Claude.");
  assert.deepEqual(switchRefused("OpenAI", "No credentials here for GPT-6.1 Sol."), { title: "Couldn't switch to OpenAI.", body: "No credentials here for GPT-6.1 Sol. This chat's model and helpers are unchanged." });
  assert.equal(editedName("Claude", true), "Claude (edited)");
  assert.equal(editedName("Claude", false), "Claude");
  assert.equal(limitLine("Opus 5.5"), "Opus 5.5 is at its usage limit.", "never an estimated reset");
  assert.equal(limitLine("Opus 5.5", "42m"), "Opus 5.5 is at its usage limit. It resets in 42m.");
});

test("limit offers: up to two of yours, avoiding the exhausted provider, never Off", () => {
  const rows = [OFF, row("claude", ["claude"]), row("openai", ["openai-codex"]), row("mixed", ["claude", "zai"]), row("ollama", ["ollama-cloud"]), row("zai", ["zai"])];
  assert.deepEqual(limitOffers(rows, "claude", { key: "claude", edited: false }).map((r) => r.key), ["openai", "ollama"]);
  assert.deepEqual(limitOffers(rows, "claude", { key: "claude", edited: false }, 5).map((r) => r.key), ["openai", "ollama", "zai"], "mixed uses the exhausted provider (its chat model counts)");
});

test("limit offers: the current profile only while edited, and not unusable, hidden, project or empty rows", () => {
  const rows = [row("openai", ["openai-codex"]), row("hid", ["zai"], { hidden: true }), row("bad", ["zai"], { unusable: "No credentials here for x." }), row("proj", ["zai"], { group: "project" }), row("lib", [], { kind: "library" })];
  assert.deepEqual(limitOffers(rows, "claude", { key: "openai", edited: false }).map((r) => r.key), []);
  assert.deepEqual(limitOffers(rows, "claude", { key: "openai", edited: true }).map((r) => r.key), ["openai"]);
  const helpersOnly = row("lib-openai", ["openai-codex"], { kind: "library", setsModel: false });
  assert.deepEqual(limitOffers([helpersOnly], "claude", { key: null, edited: false }), [], "a row that sets no chat model leaves the chat on the limited model");
});

test("picker rows: Off first, then yours, then the project's; hidden and built-in left out", () => {
  const rows = [row("p1", ["zai"], { group: "project" }), row("y1", ["claude"]), row("b1", ["claude"], { kind: "builtin", group: "builtin" }), OFF, row("h", ["claude"], { hidden: true })];
  assert.deepEqual(pickerRows(rows).map((r) => r.key), ["off", "y1", "p1"]);
  assert.equal(rowDisabledReason(row("p", [], { approval: "needed" })), "Approve it in Settings first");
  assert.equal(rowDisabledReason(row("p", [], { unusable: "No credentials here for x." })), "No credentials here for x.");
  assert.equal(rowDisabledReason(row("p", [])), null);
});

test("picking the chat's own profile does nothing unless it is edited", () => {
  assert.equal(pickDoesSomething({ key: "a" }, { key: "a", edited: false }), false);
  assert.equal(pickDoesSomething({ key: "a" }, { key: "a", edited: true }), true);
  assert.equal(pickDoesSomething({ key: "b" }, { key: "a", edited: false }), true);
});

test("the default button and the new chat line", () => {
  assert.equal(defaultLabel("idle", "Claude"), "Make Claude the Default");
  assert.equal(defaultLabel("done", "Claude"), "Already the default");
  assert.equal(defaultLabel("saving", "Claude"), "Saving…");
  assert.equal(defaultTitle("Claude", false), "New chats will start on Claude.");
  assert.equal(defaultTitle("Claude", true), "New chats already start on Claude.");
  assert.equal(defaultTitle(null, false), "Make this chat's profile the default for new chats.");
  assert.equal(newChatLine("sova"), "New chat in sova. The default is already picked.");
  assert.equal(newChatLine(null), "New chat. The default is already picked.");
});

test("Update {name}: only yours, only while something it saves differs", () => {
  const yours = row("claude", ["claude"]);
  const same = { model: "claude-code-cli/claude-opus-5-5", thinking: "high", mode: "delegate", minorModes: ["align", "spec"] };
  assert.equal(updateOffered(yours, { profile: same, chat: same }), false);
  assert.equal(updateOffered(yours, { profile: same, chat: { ...same, minorModes: ["spec", "align"] } }), false, "the same add-ons in another order");
  assert.equal(updateOffered(yours, { profile: same, chat: { ...same, thinking: "low" } }), true);
  assert.equal(updateOffered(yours, { profile: same, chat: { ...same, mode: "normal" } }), true);
  assert.equal(updateOffered(yours, { profile: same, chat: { ...same, minorModes: ["align"] } }), true);
  assert.equal(updateOffered(yours, { profile: same, chat: { model: null, thinking: null, mode: null, minorModes: null } }), false, "unknown is never a difference");
  assert.equal(updateOffered(row("p", ["zai"], { group: "project" }), { profile: same, chat: { ...same, mode: "normal" } }), false, "a project's file");
  assert.equal(updateOffered(OFF, { profile: undefined, chat: same }), false, "never Off");
  assert.equal(updateOffered(yours, { profile: { model: same.model, thinking: same.thinking }, chat: { ...same, mode: "normal", minorModes: [] } }), false, "a mode the profile leaves unset is no difference");
  assert.equal(updateOffered(yours, { profile: { minorModes: [] }, chat: { ...same, minorModes: ["align"] } }), true, "[] is set: no add-ons");
  assert.equal(updateOffered(row("lib", ["zai"], { kind: "library" }), { profile: undefined, chat: same }), false, "a library-only row sets none of them");
});

test("a mode-menu pick before the first message is a card pick, both parts; after it, the switch", async () => {
  const calls: string[] = [];
  const io = { pick: async (ref: unknown) => void calls.push(`pick ${JSON.stringify(ref)}`), switchTo: async (id: string) => (calls.push(`switch ${id}`), { applies: "now" }) };
  const pair = { kind: "pair", id: "claude", session: { source: "user" as const, id: "claude" } };
  assert.deepEqual(await menuPick(pair, true, io), { kind: "card" });
  assert.deepEqual(calls, ['pick {"source":"user","id":"claude"}'], "never the Models-only switch before the first message");
  calls.length = 0;
  assert.deepEqual(await menuPick(pair, false, io), { kind: "switch", result: { applies: "now" } });
  assert.deepEqual(calls, ["switch claude"]);
  calls.length = 0;
  await menuPick({ kind: "off", id: "off" }, true, io);
  await menuPick({ kind: "library", id: "fast", libraryId: "fast" }, true, io);
  await menuPick({ kind: "project", id: "rel", session: { source: "project", id: "rel" } }, true, io);
  assert.deepEqual(calls, ["pick null", 'pick {"source":"library","id":"fast"}', 'pick {"source":"project","id":"rel"}'], "Off, a library-only row and a project's, as their cards send them");
});
