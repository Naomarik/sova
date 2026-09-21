// Run: npx tsx --test server/session-groups.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-groups-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes its paths

const { assignSession, cleanGroupName, createGroup, deleteGroup, dropGroupAssignments, GROUP_NAME_MAX, readAssignments, readGroups, renameGroup } =
  await import("./session-groups");

const file = join(agentDir, "pi-web", "session-groups.json");
after(() => rmSync(agentDir, { recursive: true, force: true }));

const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as { version: number; groups: { id: string; name: string; createdAt: string }[]; assignments: Record<string, string> };
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
  assert.deepEqual(readGroups(), [{ id: "keep", name: "Keep", createdAt: "2026-01-01T00:00:00.000Z" }]);
  assert.deepEqual(readAssignments(), { a: "keep" });
  assert.deepEqual(assignSession("b", "keep"), { ok: true });
  assert.deepEqual(readAssignments(), { a: "keep", b: "keep" });
});
