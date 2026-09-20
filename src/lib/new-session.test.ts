// Run: npx tsx --test src/lib/new-session.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createThenArchive, newSessionCwd } from "./new-session";

test("newSessionCwd prefers the chat's own folder", () => {
  assert.equal(newSessionCwd("/a", [{ cwd: "/b", lastActiveAt: "2026-01-02T00:00:00Z" }]), "/a");
});

test("newSessionCwd falls back to the most recently active session, then to nothing", () => {
  const sessions = [
    { cwd: "/old", lastActiveAt: "2026-01-01T00:00:00Z" },
    { cwd: "/new", lastActiveAt: "2026-01-03T00:00:00Z" },
    { cwd: "/mid", lastActiveAt: "2026-01-02T00:00:00Z" },
  ];
  assert.equal(newSessionCwd(undefined, sessions), "/new");
  assert.equal(newSessionCwd("", sessions), "/new");
  assert.equal(newSessionCwd(null, []), null);
  assert.equal(newSessionCwd(null, [{ cwd: "", lastActiveAt: "2026-01-01T00:00:00Z" }]), null);
});

test("createThenArchive creates first, then archives the source", async () => {
  const calls: string[] = [];
  const out = await createThenArchive("/w", "/s.jsonl", {
    create: async (cwd) => (calls.push(`create ${cwd}`), { path: "/n.jsonl" }),
    archive: async (path) => calls.push(`archive ${path}`),
  });
  assert.deepEqual(calls, ["create /w", "archive /s.jsonl"]);
  assert.deepEqual(out, { ok: true, session: { path: "/n.jsonl" }, archiveError: null });
});

test("createThenArchive leaves the source alone when creating fails", async () => {
  let archived = false;
  const out = await createThenArchive("/w", "/s.jsonl", {
    create: async () => {
      throw new Error("That folder doesn't exist.");
    },
    archive: async () => (archived = true),
  });
  assert.equal(archived, false);
  assert.deepEqual(out, { ok: false, error: "That folder doesn't exist." });
});

test("createThenArchive keeps the new session when archiving fails", async () => {
  const out = await createThenArchive("/w", "/s.jsonl", {
    create: async () => "new",
    archive: async () => {
      throw new Error("Not found.");
    },
  });
  assert.deepEqual(out, { ok: true, session: "new", archiveError: "Not found." });
});

test("createThenArchive archives nothing for a source the caller keeps", async () => {
  let archived = false;
  const out = await createThenArchive("/w", null, {
    create: async () => "new",
    archive: async () => (archived = true),
  });
  assert.equal(archived, false);
  assert.deepEqual(out, { ok: true, session: "new", archiveError: null });
});
