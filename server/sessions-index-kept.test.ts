// Run: pnpm test server/sessions-index-kept.test.ts
// The kept listing (§app.session-list/listing-reuse): listSessions keeps its last list, and a build
// keeps each row, while nothing they read has moved. The rule: after any change a row reads, the
// next listing is what a fresh build of every row gives, and shows the change; with nothing changed,
// no build runs at all, and a change to one file builds that file's row only.
//
// Seen to fail in a scratch copy: with the live records left out of the comparison ("the live record's
// status moving" stays stale), and with the file stats left out ("a new chat" is missing, and a
// write to one file builds no row).
//
// "The next listing" is taken after sessionFileWritten(): it moves the generation (so the 1 s
// sharing window can't answer) and nothing else, which is where a listing past that window stands.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-kept-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-session-kept--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { keptStats, listSessions, listStats } = await import("./sessions-index");
const { listInputsMoved, sessionFileWritten, sessionRowChanged, sessionsChanged } = await import("./list-generation");
const { setArchived } = await import("./archived-sessions");
const { setSessionTitle } = await import("./session-titles");
const { stateRoot } = await import("./state-root");
const { canonicalPath } = await import("./paths");
const { writeJob } = await import("../pi-config/extensions/subagents/job-store.ts");
const { jobsDir } = await import("./background-jobs");

/** Another live process: the live registry keeps only records of a pid that is alive. */
const otherPid = process.ppid;
let n = 0;
const uuid = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd: "/tmp" });
const user = (text: string) => JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, message: { role: "user", content: text } });
const reply = (text: string) =>
  JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() } });
function session(name: string): { id: string; path: string } {
  const id = uuid();
  const path = canonicalPath(join(sessionsDir, `2026-09-27T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, `${header(id)}\n${user(`hello from ${name}`)}\n`);
  return { id, path };
}
const byId = <R extends { id: string }>(rows: readonly R[], id: string): R | undefined => rows.find((r) => r.id === id);
/** Every row built again: a store bump keeps no row. */
const fresh = async () => {
  sessionsChanged();
  return listSessions();
};
const next = async () => {
  sessionFileWritten();
  return listSessions();
};
/** A store written within STORE_SETTLE_MS (a short-cached reader may not have read it yet) matches
    no stamp: settled here by dating every store file back past it, each to a time of its own. */
let back = 0;
const settle = () => {
  for (const f of readdirSync(stateRoot())) {
    if (!f.endsWith(".json")) continue;
    const t = new Date(Date.now() - 10_000 - ++back);
    utimesSync(join(stateRoot(), f), t, t);
  }
};

const a = session("a");
const b = session("b");
session("c");

test("every change a row reads shows in the next listing, as a fresh build has it", async () => {
  const live = join(liveDir, "p-kept.json");
  let added: { id: string } | null = null;
  const changes: { name: string; make: () => void | Promise<void>; shows: (rows: Awaited<ReturnType<typeof listSessions>>, before: Awaited<ReturnType<typeof listSessions>>) => boolean }[] = [
    { name: "a new chat (written from outside)", make: () => void (added = session("new")), shows: (rows) => !!byId(rows, added!.id) },
    { name: "a chat finishing a turn", make: () => appendFileSync(a.path, `${reply("all done")}\n`), shows: (rows, before) => byId(rows, a.id)?.lastActiveAt !== byId(before, a.id)?.lastActiveAt },
    { name: "archive", make: () => setArchived(b.id, true), shows: (rows) => byId(rows, b.id)?.archived === true },
    { name: "unarchive", make: () => setArchived(b.id, false), shows: (rows) => byId(rows, b.id)?.archived === false },
    { name: "rename", make: () => void setSessionTitle(a.id, "Its own name"), shows: (rows) => byId(rows, a.id)?.title === "Its own name" },
    {
      name: "a live mark appearing",
      make: () => writeFileSync(live, JSON.stringify({ session: { pid: otherPid, sessionFile: b.path, mode: "tui" }, presence: { status: "idle" } })),
      shows: (rows) => byId(rows, b.id)?.live?.pid === otherPid,
    },
    {
      name: "the live record's status moving",
      make: () => writeFileSync(live, JSON.stringify({ session: { pid: otherPid, sessionFile: b.path, mode: "tui" }, presence: { status: "busy", activity: { state: "working", since: 1 } } })),
      shows: (rows) => byId(rows, b.id)?.live?.status === "busy",
    },
    { name: "a live mark going", make: () => rmSync(live), shows: (rows) => byId(rows, b.id)?.live === null },
    {
      name: "a title another server wrote",
      make: async () => {
        writeFileSync(join(stateRoot(), "session-titles.json"), JSON.stringify({ titles: { [b.id]: { title: "From elsewhere", by: "user" } } }));
        settle(); // settled: only its stat tells the change
      },
      shows: (rows) => byId(rows, b.id)?.title === "From elsewhere",
    },
    {
      name: "a background job starting",
      make: () => writeJob(jobsDir(), { v: 1, id: "j1", sessionId: a.id, path: a.path, unit: "u", startedAt: Date.now(), command: "sleep 1" } as never),
      shows: (rows) => byId(rows, a.id)?.jobsRunning === 1,
    },
  ];
  await fresh();
  for (const c of changes) {
    settle(); // the stores written so far are settled: only `make` can move the stamp
    const before = await next();
    await c.make();
    const got = await next();
    assert.ok(c.shows(got, before), `${c.name}: shows in the next listing`);
    assert.deepEqual(got, await fresh(), `${c.name}: the next listing is a fresh build's`);
  }
});

test("with nothing changed the list is kept, and a change to one file or one row builds that row only", async () => {
  await fresh();
  settle();
  await next();
  const builds = listStats.builds;
  const kept = keptStats.kept;
  const same = await next();
  assert.equal(listStats.builds, builds, "no build");
  assert.equal(keptStats.kept, kept + 1, "the kept list answered");
  assert.deepEqual(same, await fresh());

  settle();
  await next();
  appendFileSync(a.path, `${user("one more")}\n`);
  const built = keptStats.rowsBuilt;
  const rows = await next();
  assert.equal(keptStats.rowsBuilt - built, 1, "only the written file's row is built");
  assert.deepEqual(rows, await fresh());

  // One row's own change (a readiness answer): that row is built, and only that one.
  settle();
  await next();
  const before = keptStats.rowsBuilt;
  sessionRowChanged(b.path);
  const again = await listSessions();
  assert.equal(keptStats.rowsBuilt - before, 1, "only the changed row is built");
  assert.deepEqual(again, await fresh());

  // A change told some other way than a bump (an org statechart step): no row is kept past it.
  settle();
  const rows2 = await next();
  const before2 = keptStats.rowsBuilt;
  listInputsMoved();
  await next();
  assert.equal(keptStats.rowsBuilt - before2, rows2.length, "every row is built");
});
