// The new chat's cards from the joined list (§chat.profiles/picker, §chat.profiles/joined): Off in
// place of My settings, library-only rows as cards that set only helpers, the Default chip.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JoinedProfile, ListedProfile, ProfilesListing } from "../../shared/profiles";
import { isDefaultCard, isLibraryCard, joinedPickerProfiles, OFF_LABEL, pickerSections, type JoinedCard } from "./profiles";

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
const OFF = row("sova:default", { id: "off", kind: "off", group: "builtin", name: "Off", footprint: "Keeps the chat's own model" });
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

test("Off replaces My settings, first under no label; then yours, this project's and built in", () => {
  const l = listing([
    OFF,
    row("user:claude", { name: "Claude", session: listed("claude", { label: "Claude", subagents: "claude-lib" }), libraryId: "claude-lib" }),
    row("library:fast", { kind: "library", name: "Fast", libraryId: "fast", footprint: "GPT-6.1 Sol" }),
    row("project:/w#rel", { kind: "project", group: "project", name: "Release", session: listed("rel", { source: "project", key: "project:/w#rel" }) }),
  ]);
  const g = joinedPickerProfiles(l);
  assert.equal(g.mine?.label, OFF_LABEL);
  assert.equal(g.mine?.key, "sova:default", "Off is still the session with no profile");
  assert.deepEqual(g.yours.map((p) => p.label), ["Claude", "Fast"]);
  assert.deepEqual(pickerSections(g).map((s) => s.id), ["mine", "yours", "project"]);
  const fast = g.yours[1]!;
  assert.ok(isLibraryCard(fast));
  assert.equal(fast.subagents, "fast", "a library-only card sets only its helpers");
  assert.deepEqual([fast.remove, fast.grant, fast.model], [[], [], undefined], "and no capability or model");
  assert.equal(fast.key, "library:fast");
  assert.ok(!isLibraryCard(g.yours[0]!));
});

test("hidden rows are left out, never Off; an older server's listing keeps the old groups", () => {
  const g = joinedPickerProfiles(listing([{ ...OFF, hidden: true }, row("user:claude", { hidden: true, session: listed("claude") })]));
  assert.equal(g.mine?.label, OFF_LABEL);
  assert.deepEqual(g.yours, []);
  const old = joinedPickerProfiles(listing(undefined));
  assert.equal(old.mine?.label, "My settings");
  assert.deepEqual(old.yours.map((p) => p.id), ["claude"]);
});

test("the Default chip follows the listing's default, Off included", () => {
  const l = listing([OFF, row("user:claude", { session: listed("claude") })], { defaultProfile: { key: "user:claude", id: "claude", name: "Claude", chosen: true } });
  const g = joinedPickerProfiles(l);
  assert.equal(isDefaultCard(l, g.yours[0]!), true);
  assert.equal(isDefaultCard(l, g.mine as JoinedCard), false);
  const offDefault = { ...l, defaultProfile: { key: "sova:default", id: "off", name: "Off", chosen: true } };
  assert.equal(isDefaultCard(offDefault, joinedPickerProfiles(offDefault).mine!), true);
  assert.equal(isDefaultCard(listing([OFF]), g.mine!), false, "no default read: no chip");
});
