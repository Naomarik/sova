import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILE_MINOR_MODES, startsFrom, type ChatStarts, type Profile } from "../../shared/profiles";
import { isEditedBuiltin, namesProfile, menuPick, startsOfRow, updateOffered, editedName, limitLine, limitOffers, newChatLine, pickDoesSomething, pickerNewChatLine, pickerRows, rowDisabledReason, switchedLine, switchRefused, switchWaitingLine, type SwitchRow } from "./profile-switch";

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

test("limit offers: up to two, yours before the built-in ones, avoiding the exhausted provider, never Off", () => {
  const builtin = (key: string, providers: string[]) => row(key, providers, { kind: "builtin", group: "builtin" });
  const rows = [OFF, builtin("sova:openai", ["openai-codex"]), row("claude", ["claude"]), row("openai", ["openai-codex"]), row("mixed", ["claude", "zai"]), row("ollama", ["ollama-cloud"]), row("zai", ["zai"])];
  assert.deepEqual(limitOffers(rows, "claude", { key: "claude", edited: false }).map((r) => r.key), ["openai", "ollama"]);
  assert.deepEqual(limitOffers(rows, "claude", { key: "claude", edited: false }, 5).map((r) => r.key), ["openai", "ollama", "zai", "sova:openai"], "mixed uses the exhausted provider (its chat model counts)");
  assert.deepEqual(limitOffers([OFF, builtin("sova:claude", ["claude"]), builtin("sova:openai", ["openai-codex"])], "claude", { key: "sova:claude", edited: false }).map((r) => r.key), ["sova:openai"], "a built-in one is offered: Switch This Chat to OpenAI");
});

test("limit offers: the current profile only while edited, and not unusable, hidden, project or empty rows", () => {
  const rows = [row("openai", ["openai-codex"]), row("hid", ["zai"], { hidden: true }), row("bad", ["zai"], { unusable: "No credentials here for x." }), row("proj", ["zai"], { group: "project" }), row("lib", [], { kind: "library" })];
  assert.deepEqual(limitOffers(rows, "claude", { key: "openai", edited: false }).map((r) => r.key), []);
  assert.deepEqual(limitOffers(rows, "claude", { key: "openai", edited: true }).map((r) => r.key), ["openai"]);
  const helpersOnly = row("lib-openai", ["openai-codex"], { kind: "library", setsModel: false });
  assert.deepEqual(limitOffers([helpersOnly], "claude", { key: null, edited: false }), [], "a row that sets no chat model leaves the chat on the limited model");
});

test("picker rows: yours, then the project's, then built in; hidden ones and an older server's Off left out", () => {
  const rows = [row("p1", ["zai"], { group: "project" }), row("b1", ["claude"], { kind: "builtin", group: "builtin" }), row("y1", ["claude"]), OFF, row("h", ["claude"], { hidden: true }), row("bh", ["claude"], { kind: "builtin", group: "builtin", hidden: true })];
  assert.deepEqual(pickerRows(rows).map((r) => r.key), ["y1", "p1", "b1"]);
  assert.equal(rowDisabledReason(row("p", [], { approval: "needed" })), "Approve it in Settings first");
  assert.equal(rowDisabledReason(row("p", [], { unusable: "No credentials here for x." })), "No credentials here for x.");
  assert.equal(rowDisabledReason(row("p", [])), null);
});

test("an edited built-in one is a picker row under Built in, in its built-in one's place, never among yours", () => {
  const builtin = (key: string) => row(key, [], { kind: "builtin", group: "builtin", id: key.slice("sova:".length) });
  const edited = row("user:openai", [], { id: "openai", replaces: "sova:openai" });
  const rows = [row("y1", []), edited, row("p1", [], { group: "project" }), builtin("sova:deepseek"), builtin("sova:claude")];
  assert.deepEqual(pickerRows(rows).map((r) => r.key), ["y1", "p1", "sova:claude", "user:openai", "sova:deepseek"]);
  assert.equal(isEditedBuiltin(edited), true);
  assert.equal(isEditedBuiltin(row("y1", [])), false);
});

test("picking the chat's own profile does nothing unless it is edited", () => {
  assert.equal(pickDoesSomething({ key: "a" }, { key: "a", edited: false }), false);
  assert.equal(pickDoesSomething({ key: "a" }, { key: "a", edited: true }), true);
  assert.equal(pickDoesSomething({ key: "b" }, { key: "a", edited: false }), true);
});

test("the new chat line", () => {
  assert.equal(newChatLine("sova"), "New chat in sova. The default is already picked.");
  assert.equal(newChatLine(null), "New chat. The default is already picked.");
});

test("the picker's new chat line is hidden when there is no default or it couldn't be applied", () => {
  assert.equal(pickerNewChatLine({ hasDefault: true, project: "sova" }), "New chat in sova. The default is already picked.");
  assert.equal(pickerNewChatLine({ hasDefault: true, project: null, defaultNotApplied: undefined }), "New chat. The default is already picked.");
  assert.equal(pickerNewChatLine({ hasDefault: false, project: "sova" }), null);
  assert.equal(pickerNewChatLine({ hasDefault: true, project: "sova", defaultNotApplied: { profile: "Reviewer", reason: "it is not approved" } }), null);
});

// Update {name} is offered exactly when pressing it would change what a new chat on the chat's profile starts with
// (§chat.subagent-profiles/menu): the save writes the chat's mode, its profile-holdable add-ons, model and effort into
// the profile's session half, and a new chat starts on that half over this computer's starting modes (mode.json),
// field by field. Checked over every combination of half, base and chat below.
type Half = Pick<Profile, "mode" | "minorModes" | "model" | "thinking"> | undefined;
type Chat = { model: string | null; thinking: string | null; mode: string | null; minorModes: string[] | null };
const same = (a: ChatStarts, b: ChatStarts) => JSON.stringify(a) === JSON.stringify(b);
/** What pressing it saves, and so what a new chat on the profile then starts with. */
const afterSave = (half: Half, base: ChatStarts, c: Chat): ChatStarts =>
  startsFrom({ ...half, ...(c.mode ? { mode: c.mode } : {}), ...(c.minorModes ? { minorModes: PROFILE_MINOR_MODES.filter((m) => c.minorModes!.includes(m)) } : {}), ...(c.model ? { model: c.model } : {}), ...(c.thinking ? { thinking: c.thinking as Profile["thinking"] } : {}) }, base);
const halves: Half[] = [undefined, {}, { mode: "delegate" }, { minorModes: ["align"] }, { minorModes: [] }, { mode: "normal", minorModes: ["align", "spec"] }, { model: "m/a", thinking: "high" }];
const bases: ChatStarts[] = [{ mode: "normal", minorModes: [] }, { mode: "delegate", minorModes: ["align", "spec"], model: "m/a", thinking: "high" }];
const chats: Chat[] = [];
for (const mode of [null, "normal", "delegate"])
  for (const minorModes of [null, [], ["align"], ["spec", "align"], ["align", "spec", "memory"], ["memory"]])
    for (const [model, thinking] of [[null, null], ["m/a", "high"], ["m/b", "low"]] as const) chats.push({ mode, minorModes, model, thinking });
/** Unknown on either side is never a difference: a model or effort a new chat would open on unnamed (neither the
    profile nor defaults.json sets it) is left out of both. */
const knownDiff = (half: Half, base: ChatStarts, c: Chat) => {
  const now = startsFrom(half, base);
  const after = afterSave(half, base, c);
  if (!now.model) delete after.model;
  if (!now.thinking) delete after.thinking;
  return !same(now, after);
};

test("Update {name}: offered exactly when saving would change what a new chat on the profile starts with", () => {
  for (const group of ["yours", "builtin"] as const)
    for (const half of halves)
      for (const base of bases)
        for (const c of chats) {
          const r = row("p", [], { group, kind: group === "builtin" ? "builtin" : "pair" });
          assert.equal(updateOffered(r, { starts: startsOfRow({ session: half as Profile | undefined }, base), chat: c }), knownDiff(half, base, c), JSON.stringify({ group, half, base, c }));
        }
  // The rule catches the old one, which compared only what the profile itself sets (so a profile with no saved modes
  // never offered a save): with the base unknown, that is exactly what startsOfRow answers.
  const old = (half: Half, c: Chat) => updateOffered(row("p", []), { starts: startsOfRow({ session: half as Profile | undefined }, null), chat: c });
  assert.ok(chats.some((c) => old(undefined, c) !== knownDiff(undefined, bases[0]!, c)));
});

test("Update {name}: the cases the fix is for, by hand", () => {
  const base: ChatStarts = { mode: "normal", minorModes: [] };
  const chat = { model: null, thinking: null, mode: "delegate", minorModes: ["align", "spec"] };
  const on = (r: SwitchRow, half: Half, b: ChatStarts | null = base, c: Chat = chat) => updateOffered(r, { starts: startsOfRow({ session: half as Profile | undefined }, b), chat: c });
  assert.equal(on(row("mine", []), { model: "m/a" }), true, "a profile with no saved modes, the chat on delegate · align · spec");
  assert.equal(on(row("sova:claude", ["claude"], { kind: "builtin", group: "builtin" }), { model: "m/a" }), true, "a built-in profile");
  // A profile that sets only its main mode: the add-ons are compared against mode.json's.
  assert.equal(on(row("mine", []), { mode: "delegate" }, { mode: "normal", minorModes: ["align", "spec"] }), false);
  assert.equal(on(row("mine", []), { mode: "delegate" }, { mode: "normal", minorModes: ["align"] }), true);
  assert.equal(on(row("mine", []), {}, { mode: "delegate", minorModes: ["align", "spec"] }, { ...chat, minorModes: ["align", "spec", "memory"] }), false, "memory on is no difference");
  assert.equal(on(row("p", [], { group: "project", kind: "project" }), {}), false, "never a project's file");
  assert.equal(on(OFF, {}), false, "never Off");
  assert.equal(on(row("bad", [], { unusable: "No credentials here for x." }), {}), false);
  assert.equal(updateOffered(row("mine", []), { starts: null, chat }), false, "the listing not read yet");
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
  await menuPick({ kind: "library", id: "fast", libraryId: "fast" }, true, io);
  await menuPick({ kind: "project", id: "rel", session: { source: "project", id: "rel" } }, true, io);
  await menuPick({ kind: "builtin", id: "openai", session: { source: "sova", id: "openai" } }, true, io);
  assert.deepEqual(calls, ['pick {"source":"library","id":"fast"}', 'pick {"source":"project","id":"rel"}', 'pick {"source":"sova","id":"openai"}'], "a library-only row, a project's and a built-in one, as their cards send them");
});

test("a chat names a profile unless it has none (no account, none of yours) or an older server's Off", () => {
  assert.equal(namesProfile({ id: "claude", key: "sova:claude", name: "Claude" }), true);
  assert.equal(namesProfile({ id: "fast", key: "library:fast", name: "Fast" }), true);
  assert.equal(namesProfile({ id: "off", key: "sova:default", name: "Off" }), false);
  assert.equal(namesProfile({ id: "x", name: "" }), false);
  assert.equal(namesProfile(null), false);
});
