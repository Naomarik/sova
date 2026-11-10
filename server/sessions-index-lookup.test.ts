// Run: pnpm test server/sessions-index-lookup.test.ts
// listedSession / listedSessionAt: one session's row as the list has it, built alone when it can be.
// The rule: for every kind of session (and ids or paths that name none), the answer is the row a
// fresh listing finds, and a session the last listing came from costs no listing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-lookup-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-session-lookup--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { listedSession, listedSessionAt, listSessions, listStats } = await import("./sessions-index");
const { sessionsChanged } = await import("./list-generation");
const { setArchived } = await import("./archived-sessions");
const { setSessionTitle } = await import("./session-titles");
const { setDraft } = await import("./drafts");
const { canonicalPath } = await import("./paths");

let n = 0;
const uuid = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
const fileOf = (name: string) => canonicalPath(join(sessionsDir, `2026-09-27T00-00-${String(n).padStart(2, "0")}-000Z_${name}.jsonl`));
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd: "/tmp" });
const said = (text: string) => JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, message: { role: "user", content: text } });
function session(id: string, name: string, user = true): string {
  const path = fileOf(name);
  writeFileSync(path, `${header(id)}\n${user ? `${said(`hello from ${name}`)}\n` : ""}`);
  return path;
}

test("a lookup by id or path answers what a fresh listing finds, for every kind of session", async () => {
  const plain = uuid();
  const archived = uuid();
  const renamed = uuid();
  const husk = uuid();
  const drafted = uuid();
  const twin = uuid();
  const paths = new Map<string, string>();
  paths.set(plain, session(plain, "plain"));
  paths.set(archived, session(archived, "archived"));
  paths.set(renamed, session(renamed, "renamed"));
  paths.set(husk, session(husk, "husk", false));
  paths.set(drafted, session(drafted, "drafted", false));
  const twinA = session(twin, "twin-a");
  const twinB = session(twin, "twin-b");
  const gone = uuid();
  paths.set(gone, session(gone, "gone"));
  setArchived(archived, true);
  setSessionTitle(renamed, "A name of its own");
  setDraft(drafted, "half a thought");
  sessionsChanged();
  await listSessions();

  // After that listing: one file is removed, one is new, and a store write renames a listed one.
  rmSync(paths.get(gone)!);
  const late = uuid();
  paths.set(late, session(late, "late"));
  setSessionTitle(plain, "Renamed since");

  const ids = [plain, archived, renamed, husk, drafted, twin, gone, late, uuid()];
  for (const id of ids) {
    sessionsChanged();
    const got = await listedSession(id);
    sessionsChanged();
    const want = (await listSessions()).find((s) => s.id === id);
    assert.deepEqual(got, want, `by id: ${id}`);
  }
  for (const path of [...paths.values(), twinA, twinB, join(sessionsDir, "none.jsonl")]) {
    sessionsChanged();
    const got = await listedSessionAt(path);
    sessionsChanged();
    const want = (await listSessions()).find((s) => s.path === path);
    assert.deepEqual(got, want, `by path: ${path}`);
  }
  assert.equal((await listedSession(plain))?.title, "Renamed since", "a store write shows in the next lookup");
  assert.equal(await listedSession(husk), undefined, "a husk is left out, as the list leaves it out");
  assert.equal((await listedSession(drafted))?.hasDraft, true, "a husk with a draft is listed, with its draft");
});

test("a session the last listing came from is looked up without a listing", async () => {
  const id = uuid();
  const path = session(id, "cheap");
  sessionsChanged();
  await listSessions();
  for (const ask of [() => listedSession(id), () => listedSessionAt(path)]) {
    sessionsChanged();
    const before = listStats.builds;
    assert.equal((await ask())?.id, id);
    assert.equal(listStats.builds, before, "no listing built");
  }
  // The stand-in a fallback would be: a new file, which only a listing finds.
  const fresh = uuid();
  session(fresh, "fresh");
  sessionsChanged();
  const before = listStats.builds;
  assert.equal((await listedSession(fresh))?.id, fresh);
  assert.equal(listStats.builds, before + 1, "a file the last listing didn't see is found by one");
});
