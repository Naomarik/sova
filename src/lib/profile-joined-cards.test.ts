// The new chat's cards from the joined list (§chat.profiles/picker, §chat.profiles/joined): no card
// for no profile, library-only rows as cards that set only helpers, the built-in ones last, the
// Default chip, and which card is checked (the profile in effect).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JoinedProfile, ListedProfile, ProfilesListing } from "../../shared/profiles";
import { editedLabel, hasDefaultProfile, inEffectCard, isDefaultCard, isLibraryCard, joinedPickerProfiles, pickerCards, pickerSections, type JoinedCard } from "./profiles";

const listed = (id: string, extra: Partial<ListedProfile> = {}): ListedProfile => ({
  id,
  label: id,
  icon: "wrench",
  description: "",
  remove: [],
  grant: [],
  singleton: false,
  limits: { hops: 3, perMessage: 10, perDay: 40, targetsPerRun: 5, perPair: 6 },
  overseerMayStart: false,
  source: "user",
  key: `user:${id}`,
  ...extra,
});
const row = (key: string, extra: Partial<JoinedProfile>): JoinedProfile => ({ key, id: key.split(":")[1]!, kind: "pair", group: "yours", name: key, footprint: "", providers: [], helperRoles: 0, ...extra });
/** An older server's Off row: never a card now. */
const OFF = row("sova:default", { id: "off", kind: "off", group: "builtin", name: "Off", footprint: "Keeps the chat's own model" });
const OPENAI = row("sova:openai", { kind: "builtin", group: "builtin", name: "OpenAI", libraryId: "openai", session: listed("openai", { source: "sova", key: "sova:openai", label: "OpenAI", model: "openai-codex/gpt-6.2-sol" }) });
const listing = (joined: JoinedProfile[] | undefined, extra: Partial<ProfilesListing> = {}): ProfilesListing => ({
  builtins: [listed("default", { source: "sova", key: "sova:default", label: "My settings" })],
  yours: [listed("claude", { subagents: "claude-lib" })],
  yoursFile: "/x/session-profiles.json",
  project: { state: "ok", name: "sova", root: "/w", profiles: [listed("rel", { source: "project", key: "project:/w#rel" })] },
  problems: [],
  hidden: [],
  running: {},
  ...(joined ? { joined } : {}),
  ...extra,
});
const CLAUDE = row("user:claude", { name: "Claude", session: listed("claude", { label: "Claude", subagents: "claude-lib" }), libraryId: "claude-lib" });
const FAST = row("library:fast", { kind: "library", name: "Fast", libraryId: "fast", footprint: "GPT-6.1 Sol" });
const REL = row("project:/w#rel", { kind: "project", group: "project", name: "Release", session: listed("rel", { source: "project", key: "project:/w#rel" }) });

test("yours, this project's, then built in; no card for no profile, whatever the server sends", () => {
  const g = joinedPickerProfiles(listing([OFF, CLAUDE, FAST, REL, OPENAI]));
  assert.equal(g.mine, null);
  assert.ok(!pickerCards(g).some((p) => p.key === "sova:default" || p.label === "Off"));
  assert.deepEqual(g.yours.map((p) => p.label), ["Claude", "Fast"]);
  assert.deepEqual(g.builtins.map((p) => p.label), ["OpenAI"]);
  assert.deepEqual(pickerSections(g).map((s) => s.id), ["yours", "project", "builtins"]);
  const fast = g.yours[1]!;
  assert.ok(isLibraryCard(fast));
  assert.equal(fast.subagents, "fast", "a library-only card sets only its helpers");
  assert.deepEqual([fast.remove, fast.grant, fast.model], [[], [], undefined], "and no capability or model");
  assert.equal(fast.key, "library:fast");
  assert.ok(!isLibraryCard(g.yours[0]!));
});

test("an edited built-in one's card is under Built in, in its built-in one's place (§chat.subagent-profiles/edited-builtin)", () => {
  const edited = { ...CLAUDE, replaces: "sova:claude" };
  const g = joinedPickerProfiles(listing([edited, FAST, REL, OPENAI]));
  assert.deepEqual([g.yours.map((p) => p.label), g.builtins.map((p) => p.label)], [["Fast"], ["Claude", "OpenAI"]]);
  assert.equal((g.builtins[0] as JoinedCard).joined?.replaces, "sova:claude", "its Yours chip reads this");
});

test("hidden rows are left out; an older server's listing keeps its groups, less its no-profile card", () => {
  const g = joinedPickerProfiles(listing([OFF, { ...CLAUDE, hidden: true }]));
  assert.deepEqual(pickerCards(g), []);
  const old = joinedPickerProfiles(listing(undefined));
  assert.equal(old.mine, null);
  assert.deepEqual(old.yours.map((p) => p.id), ["claude"]);
});

test("the Default chip follows the listing's default, a built-in one included", () => {
  const l = listing([CLAUDE, OPENAI], { defaultProfile: { key: "user:claude", id: "claude", name: "Claude", chosen: true } });
  const g = joinedPickerProfiles(l);
  assert.equal(isDefaultCard(l, g.yours[0]!), true);
  assert.equal(isDefaultCard(l, g.builtins[0]!), false);
  const derived = { ...l, defaultProfile: { key: "sova:openai", id: "openai", name: "OpenAI", chosen: false } };
  assert.equal(isDefaultCard(derived, g.builtins[0]!), true, "a default worked out from the accounts carries the chip too");
  assert.equal(isDefaultCard(listing([CLAUDE]), g.yours[0]!), false, "no default read: no chip");
});

test("the checked card is the profile in effect: the pick, else what the chat follows", () => {
  const g = joinedPickerProfiles(listing([CLAUDE, FAST, REL, OPENAI]));
  // A session pick names its card by key.
  assert.equal(inEffectCard(g, { id: "openai", source: "sova" }, null)?.key, "sova:openai");
  assert.equal(inEffectCard(g, { id: "claude", source: "user" }, { id: "fast", key: "library:fast" })?.key, "user:claude", "the pick outranks chat_profile");
  // No session pick: a library-only pick, or the default the chat follows, by key then by id.
  assert.equal(inEffectCard(g, null, { id: "fast", key: "library:fast" })?.key, "library:fast");
  assert.equal(inEffectCard(g, null, { id: "fast" })?.key, "library:fast");
  assert.equal(inEffectCard(g, null, { id: "openai", key: "sova:openai" })?.key, "sova:openai");
  assert.equal(inEffectCard(g, null, { id: "x", key: "library:gone", libraryId: "fast" })?.key, "library:fast", "else the helpers in effect, a library-only card first");
  assert.equal(inEffectCard(g, null, { id: "x", key: "library:gone", libraryId: "claude-lib" })?.key, "user:claude", "then the card that links them");
  // A built-in key a profile of yours now replaces: that copy's card.
  const copied = joinedPickerProfiles(listing([{ ...CLAUDE, replaces: "sova:claude" }]));
  assert.equal(inEffectCard(copied, null, { id: "claude", key: "sova:claude" })?.key, "user:claude");
  // Nothing names a card: none checked, never a card for no profile.
  assert.equal(inEffectCard(g, null, { id: "off", key: "sova:default" }), null);
  assert.equal(inEffectCard(g, null, null), null);
  assert.equal(inEffectCard(g, { id: "custom", source: "user", custom: true }, { id: "claude", key: "user:claude" }), null, "a board edit is no card");
  assert.equal(inEffectCard(g, null, { id: "gone", key: "user:gone" }), null);
});

test("the board's head names the profile it started from", () => {
  assert.equal(editedLabel("Claude"), "Claude, edited");
});

test("no default profile at all (no account, none of yours) reads as none, never as Off", () => {
  assert.equal(hasDefaultProfile(listing([], { defaultProfile: { key: "sova:default", id: "off", name: "", chosen: false } })), false);
  assert.equal(hasDefaultProfile(listing([CLAUDE], { defaultProfile: { key: "user:claude", id: "claude", name: "Claude", chosen: true } })), true);
  assert.equal(hasDefaultProfile(listing([])), false);
});
