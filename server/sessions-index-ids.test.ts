// Run: pnpm test server/sessions-index-ids.test.ts
// indexedSessionPaths: session id → path, from the summary cache. Its answer is kept until an id may
// have changed, so each test here changes the files and asks again; the id a file has comes from its
// header, so one path's id can change and two paths can share one.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-ids-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-session-ids--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { archiveSession, cleanupSessions, getSessionSummary, indexedSessionPaths, listSessions } = await import("./sessions-index");
const { sessionsChanged } = await import("./list-generation");
const { addWebSession } = await import("./web-sessions");
const { setArchived } = await import("./archived-sessions");
const { canonicalPath } = await import("./paths");
const { buildSessionPath, seedBuildEffectsForTest } = await import("./build-loadout");

let n = 0;
const uuid = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
const fileOf = (name: string) => join(sessionsDir, `2026-09-27T00-00-00-000Z_${name}.jsonl`);
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd: "/tmp" });
const said = (text: string) => JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, message: { role: "user", content: text } });
/** A session file: `name` in its file name, `id` in its header, which is where the index reads it. */
function session(id: string, name: string = id, user = true): string {
  writeFileSync(fileOf(name), `${header(id)}\n${user ? `${said("hello")}\n` : ""}`);
  return canonicalPath(fileOf(name));
}
const list = async () => {
  sessionsChanged();
  await listSessions();
};
const age = (path: string) => utimesSync(path, new Date(2026, 0, 1), new Date(2026, 0, 1));

// First in the file: this process has listed nothing yet.
test("cold start: an empty index, and the first file read is found", async () => {
  const empty = indexedSessionPaths();
  assert.equal(empty.size, 0);
  const id = uuid();
  const path = session(id);
  assert.equal(indexedSessionPaths().get(id), undefined, "nothing has read the file: the index doesn't walk the disk");
  await getSessionSummary(path);
  assert.equal(indexedSessionPaths().get(id), path, "an empty answer isn't kept past the first entry");
  assert.equal(empty.size, 0, "the first answer is unchanged in the caller's hands");
});

test("a new file is found after a listing", async () => {
  const id = uuid();
  indexedSessionPaths();
  const path = session(id);
  await list();
  assert.equal(indexedSessionPaths().get(id), path);
});

test("a file deleted behind the server is gone after a listing", async () => {
  const id = uuid();
  const path = session(id);
  await list();
  assert.equal(indexedSessionPaths().get(id), path);
  rmSync(path);
  await list();
  assert.equal(indexedSessionPaths().has(id), false);
});

test("a renamed file answers at its new path", async () => {
  const id = uuid();
  const path = session(id, `${id}-before`);
  await list();
  assert.equal(indexedSessionPaths().get(id), path);
  const moved = canonicalPath(fileOf(`${id}-after`));
  renameSync(path, moved);
  await list();
  assert.equal(indexedSessionPaths().get(id), moved);
});

test("a file rewritten under another id answers under the new id only", async () => {
  const [oldId, newId] = [uuid(), uuid()];
  const path = session(oldId, `${oldId}-rewritten`);
  await getSessionSummary(path);
  assert.equal(indexedSessionPaths().get(oldId), path);
  writeFileSync(path, `${header(newId)}\n${said("a longer first message, so the file's size changes")}\n`);
  await getSessionSummary(path);
  const ids = indexedSessionPaths();
  assert.equal(ids.get(newId), path);
  assert.equal(ids.has(oldId), false);
});

test("two files with one id: the later in the cache's order answers, through growth and deletion", async () => {
  const id = uuid();
  const a = session(id, `${id}-a`);
  await getSessionSummary(a);
  assert.equal(indexedSessionPaths().get(id), a, "A only");
  const b = session(id, `${id}-b`);
  await getSessionSummary(b);
  assert.equal(indexedSessionPaths().get(id), b, "B added");
  appendFileSync(a, `${said("A grew")}\n`);
  await getSessionSummary(a);
  assert.equal(indexedSessionPaths().get(id), b, "A grew: it keeps its place, so B still answers");
  rmSync(b);
  await list();
  assert.equal(indexedSessionPaths().get(id), a, "B deleted: A answers, not nothing");
});

test("archiving an empty husk deletes it and drops its id", async () => {
  const id = uuid();
  const path = session(id, id, false);
  addWebSession(id);
  await getSessionSummary(path);
  assert.equal(indexedSessionPaths().get(id), path);
  const archived = await archiveSession(path, true);
  assert.ok(archived.ok && archived.summary.deleted, JSON.stringify(archived));
  assert.equal(indexedSessionPaths().has(id), false);
});

test("Clean Up drops a deleted file's id", async () => {
  const id = uuid();
  const path = session(id);
  age(path);
  addWebSession(id);
  setArchived(id, true);
  await getSessionSummary(path);
  assert.equal(indexedSessionPaths().get(id), path);
  const done = await cleanupSessions({ mode: "paths", paths: [path], dryRun: false });
  assert.deepEqual(done.deletedIds, [id], JSON.stringify(done));
  assert.equal(indexedSessionPaths().has(id), false);
});

test("the answer is kept while no id changes, and a kept one never changes under its holder", async () => {
  const id = uuid();
  const path = session(id);
  await getSessionSummary(path);
  const kept = indexedSessionPaths();
  assert.equal(indexedSessionPaths(), kept, "nothing changed: the same answer, not a new pass");
  appendFileSync(path, `${said("the same id, a new size")}\n`);
  await getSessionSummary(path);
  assert.equal(indexedSessionPaths(), kept, "a file that only grew changes no id");

  const other = uuid();
  await getSessionSummary(session(other));
  assert.ok(indexedSessionPaths().has(other), "a new answer holds the new id");
  assert.equal(kept.has(other), false, "replaced, not mutated");
  // @ts-expect-error no caller can write to the shared answer: typecheck fails if it becomes a Map again
  void kept.set;
});

test("buildSessionPath: the index first, else the session file made here, and only a file that's there", async () => {
  const seed = (sessionId: string, path: string) => seedBuildEffectsForTest(sessionId, { path, made: {} });

  const notListed = uuid();
  const made = session(notListed);
  seed(notListed, made);
  assert.equal(indexedSessionPaths().has(notListed), false, "the index hasn't read it");
  assert.equal(buildSessionPath(notListed), made, "made here, not listed yet: found all the same");
  rmSync(made);
  assert.equal(buildSessionPath(notListed), null, "gone: another host's, or nothing");

  const listed = uuid();
  const indexed = session(listed, `${listed}-indexed`);
  const other = session(listed, `${listed}-other`);
  await getSessionSummary(indexed);
  seed(listed, other);
  assert.equal(buildSessionPath(listed), indexed, "the index wins");
  rmSync(indexed);
  assert.equal(buildSessionPath(listed), null, "and still wins when the file it names is gone, until a listing notices");
  await list();
  assert.equal(indexedSessionPaths().get(listed), other, "the listing found the other file");
  assert.equal(buildSessionPath(listed), other);
});
