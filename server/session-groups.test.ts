// Run: npx tsx --test server/session-groups.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-groups-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its paths

const {
  assignSession,
  cleanGroupLabel,
  cleanGroupName,
  createGroup,
  deleteGroup,
  dropGroupAssignments,
  GROUP_LABEL_MAX,
  GROUP_NAME_MAX,
  readAssignments,
  readGroups,
  renameGroup,
  updateGroup,
} = await import("./session-groups");

const file = join(agentDir, "pi-web", "session-groups.json");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const onDisk = () =>
  JSON.parse(readFileSync(file, "utf8")) as {
    version: number;
    groups: { id: string; name: string; createdAt: string; members?: { id: string; label?: string }[] }[];
    assignments: Record<string, string>;
  };
const created = (name: string) => {
  const r = createGroup(name);
  assert.ok(r.ok);
  return r.group;
};

test("cleanGroupName trims, and rejects empty, whitespace and over-long names", () => {
  assert.equal(cleanGroupName("  Work  "), "Work");
  assert.equal(cleanGroupName(""), null);
  assert.equal(cleanGroupName("   "), null);
  assert.equal(cleanGroupName("x".repeat(GROUP_NAME_MAX)), "x".repeat(GROUP_NAME_MAX));
  assert.equal(cleanGroupName("x".repeat(GROUP_NAME_MAX + 1)), null);
  assert.equal(cleanGroupName(7), null);
  assert.equal(cleanGroupName(undefined), null);
});

test("createGroup stores trimmed names in creation order, one file version", () => {
  const work = created("  Work  ");
  const personal = created("Personal");
  assert.equal(work.name, "Work");
  assert.notEqual(work.id, personal.id);
  assert.deepEqual(readGroups().map((g) => g.name), ["Work", "Personal"]);
  const raw = onDisk();
  assert.equal(raw.version, 1);
  assert.deepEqual(Object.keys(raw.assignments), []);
  assert.match(work.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("createGroup rejects a nameless group without touching the file", () => {
  const before = readFileSync(file, "utf8");
  const r = createGroup("   ");
  assert.ok(!r.ok && r.status === 400);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a write keeps another server instance's groups (fresh read, merge)", () => {
  const raw = onDisk();
  raw.groups.push({ id: "other-id", name: "From another server", createdAt: "2026-01-01T00:00:00.000Z" });
  writeFileSync(file, JSON.stringify(raw));
  const mine = created("Mine");
  assert.deepEqual(
    readGroups().map((g) => g.name),
    ["Work", "Personal", "From another server", "Mine"],
  );
  assert.equal(deleteGroup(mine.id), true);
  assert.equal(deleteGroup("other-id"), true); // leave the store as this test's own groups only
});

test("assignSession sets, moves and clears one session's group", () => {
  const [work, personal] = readGroups();
  assert.deepEqual(assignSession("s1", work!.id), { ok: true });
  assert.deepEqual(assignSession("s2", work!.id), { ok: true });
  assert.deepEqual(assignSession("s1", personal!.id), { ok: true });
  assert.deepEqual(readAssignments(), { s1: personal!.id, s2: work!.id });
  assert.deepEqual(assignSession("s1", null), { ok: true });
  assert.deepEqual(readAssignments(), { s2: work!.id });
  assert.deepEqual(onDisk().assignments, { s2: work!.id });
});

test("assignSession refuses an unknown group, and a null clears even when nothing is set", () => {
  const before = readFileSync(file, "utf8");
  const r = assignSession("s2", "no-such-group");
  assert.ok(!r.ok && r.status === 404);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(assignSession("never-assigned", null), { ok: true });
  assert.deepEqual(readAssignments(), { s2: readGroups()[0]!.id });
});

test("renameGroup keeps the order and the assignments; an unknown id is 404", () => {
  const [work, personal] = readGroups();
  const assignments = readAssignments();
  const r = renameGroup(work!.id, "Day job");
  assert.ok(r.ok && r.group.name === "Day job");
  assert.deepEqual(
    readGroups().map((g) => g.name),
    ["Day job", "Personal"],
  );
  assert.deepEqual(readAssignments(), assignments);
  const missing = renameGroup("nope", "Anything");
  assert.ok(!missing.ok && missing.status === 404);
  const bad = renameGroup(personal!.id, "");
  assert.ok(!bad.ok && bad.status === 400);
  assert.equal(readGroups()[1]!.name, "Personal");
});

test("deleteGroup takes its assignments with it and leaves the other group alone", () => {
  const [work, personal] = readGroups();
  assert.deepEqual(assignSession("s3", personal!.id), { ok: true });
  assert.equal(deleteGroup(work!.id), true);
  assert.equal(deleteGroup(work!.id), false); // already gone
  assert.deepEqual(
    readGroups().map((g) => g.name),
    ["Personal"],
  );
  assert.deepEqual(readAssignments(), { s3: personal!.id });
});

test("dropGroupAssignments forgets deleted sessions in one write", () => {
  const personal = readGroups()[0]!;
  assignSession("gone-1", personal.id);
  assignSession("gone-2", personal.id);
  dropGroupAssignments(["gone-1", "gone-2", "never-was"]);
  assert.deepEqual(readAssignments(), { s3: personal.id });
});

test("a corrupt or malformed store is read as empty and replaced on the next write", () => {
  writeFileSync(file, "{not json");
  assert.deepEqual(readGroups(), []);
  assert.deepEqual(readAssignments(), {});
  created("Recovered");
  assert.deepEqual(readGroups().map((x) => x.name), ["Recovered"]);

  // Malformed entries and dangling assignments are dropped, not fatal.
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      groups: [{ id: "keep", name: "Keep", createdAt: "2026-01-01T00:00:00.000Z" }, { id: "keep", name: "Duplicate id" }, { name: "No id" }, "junk", { id: "blank", name: "  " }, null],
      assignments: { a: "keep", b: "missing-group", c: 7 },
    }),
  );
  // members is absent on disk here: it comes back derived from the assignments.
  assert.deepEqual(readGroups(), [{ id: "keep", name: "Keep", createdAt: "2026-01-01T00:00:00.000Z", members: [{ id: "a" }] }]);
  assert.deepEqual(readAssignments(), { a: "keep" });
  assert.deepEqual(assignSession("b", "keep"), { ok: true });
  assert.deepEqual(readAssignments(), { a: "keep", b: "keep" });
});

// --- member metadata (order + labels) -------------------------------------------------------
// Each of these starts from a store it wrote itself, so it doesn't depend on the tests above.

const reset = (store: unknown) => writeFileSync(file, JSON.stringify(store));
const membersOf = (id: string) => readGroups().find((g) => g.id === id)?.members;

test("cleanGroupLabel trims, clears on blank and null, and rejects a long or non-string label", () => {
  assert.deepEqual(cleanGroupLabel("  sonnet ×2 "), { ok: true, label: "sonnet ×2" });
  assert.deepEqual(cleanGroupLabel(""), { ok: true, label: null });
  assert.deepEqual(cleanGroupLabel("   "), { ok: true, label: null });
  assert.deepEqual(cleanGroupLabel(null), { ok: true, label: null });
  assert.deepEqual(cleanGroupLabel("x".repeat(GROUP_LABEL_MAX)), { ok: true, label: "x".repeat(GROUP_LABEL_MAX) });
  assert.deepEqual(cleanGroupLabel("x".repeat(GROUP_LABEL_MAX + 1)), { ok: false });
  assert.deepEqual(cleanGroupLabel(7), { ok: false });
  assert.deepEqual(cleanGroupLabel(undefined), { ok: false });
});

test("members and their labels survive a save/load round trip", () => {
  reset({ version: 1, groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z" }], assignments: {} });
  assignSession("s1", "g1", "sonnet ×2");
  assignSession("s2", "g1");
  assert.deepEqual(membersOf("g1"), [{ id: "s1", label: "sonnet ×2" }, { id: "s2" }]);
  // and on disk, inside the group object
  assert.deepEqual(onDisk().groups[0]!.members, [{ id: "s1", label: "sonnet ×2" }, { id: "s2" }]);
  assert.deepEqual(readAssignments(), { s1: "g1", s2: "g1" });
});

test("a store without members reads back as the assigned sessions in id order", () => {
  reset({
    version: 1,
    groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z" }],
    assignments: { zz: "g1", aa: "g1", mm: "g1" },
  });
  assert.deepEqual(membersOf("g1"), [{ id: "aa" }, { id: "mm" }, { id: "zz" }]);
});

test("load drops malformed, stale and duplicate members, and appends the ones the metadata missed", () => {
  reset({
    version: 1,
    groups: [
      {
        id: "g1",
        name: "Fanout",
        createdAt: "2026-01-01T00:00:00.000Z",
        members: [{ id: "b", label: "  kept  " }, { id: "b" }, { id: "not-assigned" }, { id: "a", label: 7 }, { id: "c", label: "x".repeat(GROUP_LABEL_MAX + 1) }, { label: "no id" }, "junk", null],
      },
      { id: "g2", name: "Other", createdAt: "2026-01-01T00:00:00.000Z", members: "not an array" },
    ],
    assignments: { a: "g1", b: "g1", d: "g1", e: "g2" },
  });
  // b keeps its (trimmed) label; the duplicate, the unassigned entry and the two bad labels go;
  // d, which no member entry mentioned, is appended.
  assert.deepEqual(membersOf("g1"), [{ id: "b", label: "kept" }, { id: "a" }, { id: "d" }]);
  assert.deepEqual(membersOf("g2"), [{ id: "e" }]);
});

test("updateGroup reorders, ignoring ids that are not in the group, and keeps the rest behind", () => {
  reset({ version: 1, groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z" }], assignments: { a: "g1", b: "g1", c: "g1", d: "g1" } });
  const r = updateGroup("g1", { order: ["c", "nope", "a"] });
  assert.ok(r.ok);
  assert.deepEqual(r.group.members, [{ id: "c" }, { id: "a" }, { id: "b" }, { id: "d" }]);
  assert.deepEqual(membersOf("g1"), [{ id: "c" }, { id: "a" }, { id: "b" }, { id: "d" }]);
  assert.deepEqual(readAssignments(), { a: "g1", b: "g1", c: "g1", d: "g1" }); // membership untouched
});

test("updateGroup sets and clears labels, and renames in the same write", () => {
  reset({ version: 1, groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z" }], assignments: { a: "g1", b: "g1" } });
  const set = updateGroup("g1", { name: "  Fan out  ", labels: [{ id: "a", label: " sonnet ×2 " }, { id: "b", label: "opus" }, { id: "gone", label: "ignored" }] });
  assert.ok(set.ok);
  assert.equal(set.group.name, "Fan out");
  assert.deepEqual(set.group.members, [{ id: "a", label: "sonnet ×2" }, { id: "b", label: "opus" }]);
  const cleared = updateGroup("g1", { labels: [{ id: "a", label: null }, { id: "b", label: "   " }] });
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.group.members, [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(membersOf("g1"), [{ id: "a" }, { id: "b" }]);
});

test("updateGroup: 404 unknown group, 400 empty patch and bad order/labels/name", () => {
  reset({ version: 1, groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z" }], assignments: { a: "g1" } });
  const missing = updateGroup("nope", { name: "Anything" });
  assert.ok(!missing.ok && missing.status === 404);
  for (const patch of [
    {},
    { name: "   " },
    { order: "a" },
    { order: ["a", 7] },
    { labels: { a: "x" } },
    { labels: [{ label: "no id" }] },
    { labels: [{ id: "a", label: 7 }] },
    { labels: [{ id: "a", label: "x".repeat(GROUP_LABEL_MAX + 1) }] },
  ]) {
    const r = updateGroup("g1", patch as Parameters<typeof updateGroup>[1]);
    assert.ok(!r.ok && r.status === 400, `expected 400 for ${JSON.stringify(patch)}`);
  }
  assert.deepEqual(membersOf("g1"), [{ id: "a" }]); // nothing changed
  assert.equal(readGroups()[0]!.name, "Fanout");
});

test("renameGroup still only renames, leaving the members alone", () => {
  reset({ version: 1, groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", members: [{ id: "b" }, { id: "a", label: "opus" }] }], assignments: { a: "g1", b: "g1" } });
  const r = renameGroup("g1", "Day job");
  assert.ok(r.ok);
  assert.equal(r.group.name, "Day job");
  assert.deepEqual(membersOf("g1"), [{ id: "b" }, { id: "a", label: "opus" }]);
});

test("moving a session between groups carries its label; an explicit one wins, null clears", () => {
  reset({
    version: 1,
    groups: [
      { id: "g1", name: "One", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "g2", name: "Two", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    assignments: {},
  });
  assignSession("s1", "g1", "sonnet ×2");
  assignSession("s2", "g2", "opus");
  assert.deepEqual(assignSession("s1", "g2"), { ok: true }); // move, label carried
  assert.deepEqual(membersOf("g1"), []);
  assert.deepEqual(membersOf("g2"), [{ id: "s2", label: "opus" }, { id: "s1", label: "sonnet ×2" }]);
  assignSession("s1", "g1", "haiku"); // an explicit label replaces the carried one
  assert.deepEqual(membersOf("g1"), [{ id: "s1", label: "haiku" }]);
  assignSession("s1", "g1", null); // re-assign to the same group, clearing the label
  assert.deepEqual(membersOf("g1"), [{ id: "s1" }]);
  assert.deepEqual(readAssignments(), { s1: "g1", s2: "g2" });
});

test("a refused assign leaves the member entry where it was; ungrouping drops it", () => {
  reset({ version: 1, groups: [{ id: "g1", name: "One", createdAt: "2026-01-01T00:00:00.000Z" }], assignments: {} });
  assignSession("s1", "g1", "sonnet ×2");
  const bad = assignSession("s1", "no-such-group");
  assert.ok(!bad.ok && bad.status === 404);
  assert.deepEqual(membersOf("g1"), [{ id: "s1", label: "sonnet ×2" }]);
  assert.deepEqual(readAssignments(), { s1: "g1" });
  assert.deepEqual(assignSession("s1", null), { ok: true });
  assert.deepEqual(membersOf("g1"), []);
  assert.deepEqual(readAssignments(), {});
});

test("dropGroupAssignments takes the member entries with the assignments", () => {
  reset({
    version: 1,
    groups: [
      { id: "g1", name: "One", createdAt: "2026-01-01T00:00:00.000Z", members: [{ id: "gone", label: "sonnet ×2" }, { id: "stays" }] },
      { id: "g2", name: "Two", createdAt: "2026-01-01T00:00:00.000Z", members: [{ id: "gone-too", label: "opus" }] },
    ],
    assignments: { gone: "g1", stays: "g1", "gone-too": "g2" },
  });
  dropGroupAssignments(["gone", "gone-too", "never-was"]);
  assert.deepEqual(readAssignments(), { stays: "g1" });
  assert.deepEqual(membersOf("g1"), [{ id: "stays" }]);
  assert.deepEqual(membersOf("g2"), []);
  assert.deepEqual(onDisk().groups.map((g) => g.members), [[{ id: "stays" }], []]);
});

test("deleting a group takes its members with it", () => {
  reset({
    version: 1,
    groups: [
      { id: "g1", name: "One", createdAt: "2026-01-01T00:00:00.000Z", members: [{ id: "s1", label: "sonnet ×2" }] },
      { id: "g2", name: "Two", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    assignments: { s1: "g1", s2: "g2" },
  });
  assert.equal(deleteGroup("g1"), true);
  assert.deepEqual(readGroups().map((g) => g.id), ["g2"]);
  assert.deepEqual(readAssignments(), { s2: "g2" });
  assert.deepEqual(onDisk().groups[0]!.members, [{ id: "s2" }]);
});

test("an unknown field written by another pi-web version survives our writes", () => {
  // The case this protects: a fanout group's `seed` (spec/14b), written by a build that has it,
  // must not be deleted by a build that doesn't when the user renames the group here.
  reset({
    futureTopLevel: { note: "from another build" },
    version: 7,
    groups: [
      { id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", seed: { parentSessionPath: "/p.jsonl", leafId: "e9" }, members: [{ id: "a", label: "opus", pinned: true }] },
    ],
    assignments: { a: "g1" },
  });
  const r = renameGroup("g1", "Renamed");
  assert.ok(r.ok);
  const raw = onDisk() as unknown as { version: number; futureTopLevel: unknown; groups: Record<string, unknown>[] };
  assert.equal(raw.groups[0]!.name, "Renamed", "the field we do know is the one that changed");
  assert.deepEqual(raw.groups[0]!.seed, { parentSessionPath: "/p.jsonl", leafId: "e9" }, "the group's unknown field is still there");
  assert.deepEqual(raw.groups[0]!.members, [{ pinned: true, id: "a", label: "opus" }], "and so is the member's");
  assert.deepEqual(raw.futureTopLevel, { note: "from another build" }, "top-level too");
  assert.equal(raw.version, 7, "a newer writer's version is not stamped back down to ours");
  // It reaches a reader as well, so a frontend that understands it can use it.
  assert.deepEqual((readGroups()[0] as unknown as { seed: unknown }).seed, { parentSessionPath: "/p.jsonl", leafId: "e9" });
});

test("a store we create ourselves is version 1 with nothing extra", () => {
  rmSync(file, { force: true });
  created("Fresh");
  const raw = onDisk();
  assert.deepEqual(Object.keys(raw).sort(), ["assignments", "groups", "version"]);
  assert.equal(raw.version, 1);
});

// --- auto-dissolve of a fanout group (spec/14 "Emptying a group") ---------------------------
// `seed` is written by the fanout stage and isn't a typed field yet; the store carries unknown
// keys through, so these tests write one the way a newer build would.

const SEED = { parentSessionPath: "/s/root.jsonl", leafId: "e9" };

test("unassigning the last member of a fanout group dissolves it, and says so", () => {
  reset({
    version: 1,
    groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", seed: SEED, members: [{ id: "a" }] }],
    assignments: { a: "g1" },
  });
  assert.deepEqual(assignSession("a", null), { ok: true, dissolved: true });
  assert.deepEqual(readGroups(), []);
  assert.deepEqual(readAssignments(), {});
});

test("moving the last member OUT of a fanout group dissolves it too", () => {
  reset({
    version: 1,
    groups: [
      { id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", seed: SEED, members: [{ id: "a", label: "opus" }] },
      { id: "g2", name: "Hand-made", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    assignments: { a: "g1" },
  });
  assert.deepEqual(assignSession("a", "g2"), { ok: true, dissolved: true });
  assert.deepEqual(readGroups().map((g) => g.id), ["g2"]);
  assert.deepEqual(membersOf("g2"), [{ id: "a", label: "opus" }], "the member arrives with its label");
});

test("a fanout group with members left is not dissolved", () => {
  reset({
    version: 1,
    groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", seed: SEED }],
    assignments: { a: "g1", b: "g1" },
  });
  assert.deepEqual(assignSession("a", null), { ok: true });
  assert.deepEqual(readGroups().map((g) => g.id), ["g1"]);
  assert.deepEqual(membersOf("g1"), [{ id: "b" }]);
});

test("a HAND-MADE group stands empty: no seed, no dissolve", () => {
  reset({
    version: 1,
    groups: [{ id: "g1", name: "Work", createdAt: "2026-01-01T00:00:00.000Z", members: [{ id: "a" }] }],
    assignments: { a: "g1" },
  });
  assert.deepEqual(assignSession("a", null), { ok: true }, "no dissolved flag");
  assert.deepEqual(readGroups().map((g) => g.name), ["Work"], "the group the user named is still there");
  assert.deepEqual(membersOf("g1"), []);
});

test("re-assigning the only member to the same fanout group does not dissolve it", () => {
  reset({
    version: 1,
    groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", seed: SEED, members: [{ id: "a" }] }],
    assignments: { a: "g1" },
  });
  assert.deepEqual(assignSession("a", "g1", "sonnet ×2"), { ok: true });
  assert.deepEqual(membersOf("g1"), [{ id: "a", label: "sonnet ×2" }]);
});

test("a malformed seed is not a fanout group", () => {
  reset({
    version: 1,
    groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", seed: "yes", members: [{ id: "a" }] }],
    assignments: { a: "g1" },
  });
  assert.deepEqual(assignSession("a", null), { ok: true });
  assert.deepEqual(readGroups().map((g) => g.id), ["g1"]);
});

test("archive cleanup empties a fanout group WITHOUT dissolving it (deliberate, documented)", () => {
  reset({
    version: 1,
    groups: [{ id: "g1", name: "Fanout", createdAt: "2026-01-01T00:00:00.000Z", seed: SEED, members: [{ id: "a" }] }],
    assignments: { a: "g1" },
  });
  dropGroupAssignments(["a"]);
  assert.deepEqual(readGroups().map((g) => g.id), ["g1"], "no client is listening to that call");
  assert.deepEqual(membersOf("g1"), []);
});
