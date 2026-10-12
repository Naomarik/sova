// The subagent profile library's per-profile merge, as pure functions (§mesh.sync/profile-library).
import { test } from "node:test";
import assert from "node:assert/strict";
import { delegateDefaults } from "../../pi-config/extensions/mode/delegate.ts";
import { parseSubagentProfiles, type SubagentProfile } from "../../pi-config/extensions/subagents/subagent-profiles.ts";
import { itemsAhead, libraryText, mergeLibraries, observeItems, profileHash, remoteItems, seedOnly, type Items, type Side } from "./profile-merge";

const profile = (id: string, name: string, model?: string): SubagentProfile => ({
  id,
  name,
  delegate: delegateDefaults().profiles,
  teams: null,
  members: model ? { backend: "pi", model, effort: "low" } : null,
  specWriter: null,
});
const side = (profiles: SubagentProfile[] | null, at: Record<string, number>, origin = "a", deleted: Record<string, number> = {}): Side => {
  const items: Items = {};
  for (const p of profiles ?? []) items[p.id] = { hash: profileHash(p), modifiedAt: at[p.id] ?? 1, origin };
  for (const [id, t] of Object.entries(deleted)) items[id] = { hash: null, modifiedAt: t, origin };
  return { profiles, items };
};
const ids = (ps: SubagentProfile[]) => ps.map((p) => p.id);

test("a profile only one side has is kept on both sides of the merge, whichever side merges", () => {
  const a = side([profile("x", "X"), profile("y", "Y")], { x: 5, y: 5 }, "a");
  const b = side([profile("x", "X"), profile("z", "Z")], { x: 5, z: 9 }, "b");
  assert.deepEqual(ids(mergeLibraries(a, b, "a", 100).profiles), ["x", "y", "z"]);
  assert.deepEqual(ids(mergeLibraries(b, a, "b", 100).profiles), ["x", "z", "y"]);
  const m = mergeLibraries(a, b, "a", 100);
  assert.deepEqual(m.changes, { added: ["Z"], changed: [], removed: [] });
  assert.equal(m.cause?.origin, "b");
});

test("two edits to one profile: the newer wins for that profile only", () => {
  const a = side([profile("x", "X", "zai/one"), profile("y", "Y", "zai/a-edit")], { x: 10, y: 30 }, "a");
  const b = side([profile("x", "X", "zai/two"), profile("y", "Y")], { x: 20, y: 5 }, "b");
  for (const [l, r] of [[a, b], [b, a]] as const) {
    const m = mergeLibraries(l, r, "h", 100);
    assert.equal(m.profiles.find((p) => p.id === "x")!.members?.model, "zai/two", "b's later edit of X");
    assert.equal(m.profiles.find((p) => p.id === "y")!.members?.model, "zai/a-edit", "a's later edit of Y");
  }
});

test("a deletion newer than the other side's edit removes the profile; an edit after the deletion keeps it", () => {
  const a = side([profile("x", "X")], { x: 5 }, "a", { y: 20 });
  const b = side([profile("x", "X"), profile("y", "Y")], { x: 5, y: 10 }, "b");
  const m = mergeLibraries(b, a, "b", 100);
  assert.deepEqual(ids(m.profiles), ["x"]);
  assert.deepEqual(m.changes.removed, ["Y"]);
  assert.equal(m.items.y?.hash, null, "the deletion is kept, so Y can't come back from a third host");
  const later = side([profile("x", "X"), profile("y", "Y", "zai/edited")], { x: 5, y: 30 }, "b");
  assert.deepEqual(ids(mergeLibraries(later, a, "b", 100).profiles), ["x", "y"]);
});

test("observing: a profile that left an existing library becomes a deletion; a file that appeared or vanished deletes nothing", () => {
  const before = side([profile("x", "X"), profile("y", "Y")], { x: 5, y: 5 }).items;
  const edited = observeItems(before, [profile("x", "X")], { modifiedAt: 50, origin: "a" }, true);
  assert.deepEqual(edited.y, { hash: null, modifiedAt: 50, origin: "a" });
  assert.equal(edited.x, before.x, "an unchanged profile keeps its stamp");
  const appeared = observeItems(before, [profile("x", "X")], { modifiedAt: 0, origin: "a" }, false);
  assert.equal(appeared.y, undefined);
  assert.deepEqual(observeItems(edited, null, { modifiedAt: 60, origin: "a" }, true), { y: edited.y }, "absent: only the deletions stay");
  const changed = observeItems(before, [profile("x", "X", "zai/new"), profile("y", "Y")], { modifiedAt: 70, origin: "a" }, true);
  assert.equal(changed.x?.modifiedAt, 70);
  assert.equal(changed.y, before.y);
});

test("a starter-only library yields to one with any edited profile; two starters, or a starter alone, stay", () => {
  const starter = side([profile("my-setup", "My setup", "zai/seed")], { "my-setup": 0 }, "zen");
  assert.equal(seedOnly(starter.items), true);
  const real = side([profile("fast", "Fast"), profile("deep", "Deep")], { fast: 100, deep: 200 }, "flow");
  const taken = mergeLibraries(starter, real, "zen", 1000);
  assert.deepEqual(ids(taken.profiles), ["fast", "deep"], "the fresh device takes the real library, its starter dropped");
  assert.equal(taken.items["my-setup"], undefined, "dropped, not recorded as deleted");
  const kept = mergeLibraries(real, starter, "flow", 1000);
  assert.deepEqual(ids(kept.profiles), ["fast", "deep"], "the real library ignores a starter");
  assert.deepEqual(kept.changes, { added: [], changed: [], removed: [] });
  const other = side([profile("my-setup", "My setup", "zai/other")], { "my-setup": 0 }, "air");
  assert.deepEqual(ids(mergeLibraries(starter, other, "zen", 1000).profiles), ["my-setup"], "two starters keep one");
  // Same id on both sides: the real (dated) edit wins over the starter's.
  const realSetup = side([profile("my-setup", "My setup", "zai/real")], { "my-setup": 300 }, "flow");
  assert.equal(mergeLibraries(starter, realSetup, "zen", 1000).profiles[0]!.members?.model, "zai/real");
});

test("names left colliding are made unique: the newer edit keeps the name, the other is renamed as a new edit", () => {
  const a = side([profile("fast", "Fast")], { fast: 10 }, "a");
  const b = side([profile("fast-2", "fast")], { "fast-2": 20 }, "b");
  const m = mergeLibraries(a, b, "a", 100);
  const names = Object.fromEntries(m.profiles.map((p) => [p.id, p.name]));
  assert.deepEqual(names, { fast: "Fast (2)", "fast-2": "fast" });
  assert.equal(m.items.fast?.modifiedAt, 100);
  assert.equal(m.items.fast?.origin, "a");
  assert.equal(parseSubagentProfiles(libraryText(m.profiles)).ok, true, "the merged file passes the library's own parse");
});

test("an older peer's whole file: each profile takes the file's date; stamps that contradict the file are refused", () => {
  const ps = [profile("x", "X"), profile("y", "Y")];
  const derived = remoteItems({ modifiedAt: 42, origin: "old" }, ps)!;
  assert.deepEqual(Object.values(derived).map((m) => [m.modifiedAt, m.origin]), [[42, "old"], [42, "old"]]);
  assert.equal(remoteItems({ modifiedAt: 1, origin: "b", items: { x: derived.x } }, ps), null, "a profile with no stamp");
  assert.equal(remoteItems({ modifiedAt: 1, origin: "b", items: { ...derived, z: { hash: "a".repeat(64), modifiedAt: 1, origin: "b" } } }, ps), null, "a stamp with no profile");
  assert.equal(remoteItems({ modifiedAt: 1, origin: "b", items: { ...derived, OFF: derived.x } }, ps), null, "a key that is no profile id");
  // The union never deletes what the older peer lacks.
  const mine = side([profile("x", "X"), profile("z", "Z")], { x: 10, z: 10 }, "me");
  const m = mergeLibraries(mine, { profiles: ps, items: derived }, "me", 100);
  assert.deepEqual(ids(m.profiles), ["x", "z", "y"]);
});

test("itemsAhead: a newer stamp or an unseen profile is ahead; a deletion of something never seen is not", () => {
  const a = side([profile("x", "X")], { x: 5 }, "a").items;
  assert.equal(itemsAhead(a, {}), true);
  assert.equal(itemsAhead(a, a), false);
  assert.equal(itemsAhead({ gone: { hash: null, modifiedAt: 9, origin: "a" } }, {}), false);
  assert.equal(itemsAhead({ x: { hash: null, modifiedAt: 9, origin: "a" } }, a), true);
});

test("a profile hashes the same whatever order its keys were written in", () => {
  const p = profile("x", "X", "zai/glm-5.3");
  const shuffled = JSON.parse(JSON.stringify({ specWriter: p.specWriter, members: p.members, teams: p.teams, delegate: p.delegate, name: p.name, id: p.id })) as SubagentProfile;
  assert.equal(profileHash(shuffled), profileHash(p));
});
