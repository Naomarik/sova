// Run: npx tsx --test src/lib/new-session.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createThenArchive, dropArchived, hiddenRecentNote, MAX_RECENT, newSessionCwd, offersCwd, recentFolders, recentRemoteFolders } from "./new-session";

test("newSessionCwd prefers the chat's own folder", () => {
  assert.equal(newSessionCwd({ cwd: "/a" }, [{ cwd: "/b", lastActiveAt: "2026-01-02T00:00:00Z" }]), "/a");
});

test("newSessionCwd falls back to the most recently active session, then to nothing", () => {
  const sessions = [
    { cwd: "/old", lastActiveAt: "2026-01-01T00:00:00Z" },
    { cwd: "/new", lastActiveAt: "2026-01-03T00:00:00Z" },
    { cwd: "/mid", lastActiveAt: "2026-01-02T00:00:00Z" },
  ];
  assert.equal(newSessionCwd(undefined, sessions), "/new");
  assert.equal(newSessionCwd({ cwd: "" }, sessions), "/new");
  assert.equal(newSessionCwd(null, []), null);
  assert.equal(newSessionCwd(null, [{ cwd: "", lastActiveAt: "2026-01-01T00:00:00Z" }]), null);
});

test("the Overseer's folder is never a new session's folder: not from its page, not as the latest (E2E F5)", () => {
  const sessions = [
    { cwd: "/state/overseer", lastActiveAt: "2026-01-09T00:00:00Z", overseer: true as const },
    { cwd: "/work", lastActiveAt: "2026-01-02T00:00:00Z" },
  ];
  assert.equal(newSessionCwd({ cwd: "/state/overseer", overseer: true }, sessions), "/work");
  assert.equal(newSessionCwd(null, sessions), "/work");
  assert.equal(newSessionCwd(null, [sessions[0]!]), null);
});

const WORKTREE = "/home/u/webapps/.worktrees/sova-x";
const OFF = (cwd: string) => offersCwd(cwd, false);

/** A remote session's local cwd is a placeholder; the path ON the target is what matters. */
const PLACEHOLDER = "/home/u/.pi/agent/sova/targets/acme/home/deploy/.cache";
const PLACEHOLDER_VISIBLE = "/home/u/.pi/agent/sova/targets/acme/home/deploy/site";

test("a hidden folder is offered only while Show hidden folders is on", () => {
  assert.equal(offersCwd(WORKTREE, false), false);
  assert.equal(offersCwd(WORKTREE, true), true);
  assert.equal(offersCwd("/home/u/webapps/sova", false), true);
});

test("a remote folder is judged by its path on the target, never by the hidden placeholder", () => {
  assert.equal(offersCwd(PLACEHOLDER_VISIBLE, false), true);
  assert.equal(offersCwd(PLACEHOLDER, false), false);
});

test("a hidden prefill is passed over for the newest visible session's folder", () => {
  const sessions = [
    { cwd: WORKTREE, lastActiveAt: "2026-01-03T00:00:00Z" },
    { cwd: "/home/u/webapps/sova", lastActiveAt: "2026-01-02T00:00:00Z" },
  ];
  assert.equal(newSessionCwd({ cwd: WORKTREE }, sessions, OFF), "/home/u/webapps/sova");
  assert.equal(newSessionCwd(null, sessions, OFF), "/home/u/webapps/sova");
  assert.equal(newSessionCwd({ cwd: WORKTREE }, sessions, () => true), WORKTREE, "with the toggle on it is kept");
});

test("nothing visible to prefill leaves the field empty", () => {
  const sessions = [{ cwd: WORKTREE, lastActiveAt: "2026-01-03T00:00:00Z" }];
  assert.equal(newSessionCwd(null, sessions, OFF), null);
  assert.equal(newSessionCwd({ cwd: WORKTREE, overseer: true }, sessions, OFF), null);
});

test("recent folders: remote placeholders out, hidden out while off, newest first, capped", () => {
  const cwds = [WORKTREE, "/home/u/webapps/sova", PLACEHOLDER_VISIBLE, "/home/u/webapps/other"];
  assert.deepEqual(recentFolders(cwds, false), ["/home/u/webapps/sova", "/home/u/webapps/other"]);
  assert.deepEqual(recentFolders(cwds, true), [WORKTREE, "/home/u/webapps/sova", "/home/u/webapps/other"]);
  const many = Array.from({ length: MAX_RECENT + 5 }, (_, i) => `/home/u/p${i}`);
  assert.equal(recentFolders(many, false).length, MAX_RECENT);
  assert.equal(recentFolders(many, false)[0], "/home/u/p0", "the order given is kept, no re-sorting");
});

test("recent remote folders: judged by the remote path, up to the same cap", () => {
  const cwds = [PLACEHOLDER_VISIBLE, PLACEHOLDER, "/home/u/webapps/sova"];
  assert.deepEqual(recentRemoteFolders(cwds, false), [{ target: "acme", remoteCwd: "/home/deploy/site" }]);
  assert.deepEqual(
    recentRemoteFolders(cwds, true).map((p) => p.remoteCwd),
    ["/home/deploy/site", "/home/deploy/.cache"],
  );
});

test("the caption counts what was dropped, and reads right for one", () => {
  assert.equal(hiddenRecentNote(1), "1 hidden folder is not listed.");
  assert.equal(hiddenRecentNote(3), "3 hidden folders are not listed.");
});

test("createThenArchive creates first, then archives the source", async () => {  const calls: string[] = [];
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

test("dropArchived prunes the archived session from the created rows", () => {
  const created = new Map([["/a.jsonl", { path: "/a.jsonl" }], ["/b.jsonl", { path: "/b.jsonl" }]]);
  assert.equal(dropArchived(created, "/a.jsonl", true), true);
  assert.deepEqual([...created.keys()], ["/b.jsonl"]);
});

test("dropArchived leaves an unarchived session, and a path it never created, alone", () => {
  const created = new Map([["/b.jsonl", { path: "/b.jsonl" }]]);
  assert.equal(dropArchived(created, "/b.jsonl", false), false);
  assert.equal(dropArchived(created, "/gone.jsonl", true), false);
  assert.deepEqual([...created.keys()], ["/b.jsonl"]);
});
