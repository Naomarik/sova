// Run: pnpm test server/sessions-index-kept.test.ts
// The kept list (§app.session-list/listing-reuse). While the session folders are watched (a feed is
// connected), listSessions keeps a finished list until anything makes the feed compare or bumps the
// list generation, for at most KEEP_UNHEARD_MS; while nothing watches, a list serves for 1 s, as
// before. The rules, over the real feed and folder watch:
// - each change a row shows is heard, and the next listing shows it, equal to a fresh build;
// - with nothing heard, the list is kept past 1 s; a nudge, a new connection and the safety net drop it;
// - a change no watch hears waits for the age limit; unwatched, the 1 s rule stands;
// - a build keeps every row but the changed file's.
// Time is moved by Date.now, never waited out. Seen to fail in a scratch copy with the kept list
// ignoring what the feed heard (a chat added stays missing, a nudge builds nothing).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-kept-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsRoot = join(agentDir, "sessions");
const sessionsDir = join(sessionsRoot, "--tmp-session-kept--");
const liveDir = join(sessionsRoot, "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
after(() => {
  Date.now = realNow;
  rmSync(agentDir, { recursive: true, force: true });
});

const { KEEP_UNHEARD_MS, LIST_REUSE_MS, keptStats, listSessions, listSessionsTracked, listStamps, listStats, trackSessionFiles } = await import("./sessions-index");
const { heardGeneration, listInputsMoved, sessionRowChanged, sessionsChanged } = await import("./list-generation");
const { SessionFeed } = await import("./session-feed");
const { watchFeedInputs } = await import("./session-feed-watch");
const { setArchived } = await import("./archived-sessions");
const { setSessionTitle } = await import("./session-titles");
const { stateRoot } = await import("./state-root");
const { canonicalPath } = await import("./paths");

/** Another live process: the live registry keeps only records of a pid that is alive. */
const otherPid = process.ppid;
let n = 0;
const uuid = () => `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd: "/tmp" });
const user = (text: string) => JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, message: { role: "user", content: text } });
const reply = (text: string) =>
  JSON.stringify({ type: "message", id: `m${++n}`, parentId: null, timestamp: new Date(realNow()).toISOString(), message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: realNow() } });
function session(name: string): { id: string; path: string } {
  const id = uuid();
  const path = canonicalPath(join(sessionsDir, `2026-09-27T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, `${header(id)}\n${user(`hello from ${name}`)}\n`);
  return { id, path };
}
type Rows = Awaited<ReturnType<typeof listSessions>>;
const byId = (rows: Rows, id: string) => rows.find((r) => r.id === id);
const until = async (what: string, ok: () => boolean) => {
  const t = realNow();
  while (!ok()) {
    if (realNow() - t > 10_000) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
/** Every row built again, by a bump. */
const fresh = async () => {
  sessionsChanged();
  return listSessions();
};
/** The next listing past the 1 s window, with nothing else moved. */
const later = async () => {
  skew += LIST_REUSE_MS + 1;
  return listSessions();
};

/** A connected feed, as the server wires it: the file tracker and the folder and live-record watch. */
function connect(intervalMs = 1_000_000) {
  const feed = new SessionFeed({
    list: (opts) => listSessionsTracked(opts),
    stamps: listStamps,
    debounceMs: 0,
    minGapMs: 0,
    intervalMs,
    watch: (changed) => {
      const tracked = trackSessionFiles();
      const off = watchFeedInputs(changed, { sessionsDir: sessionsRoot, liveDir, roots: () => [], liveCheckMs: 100, files: tracked.note });
      return () => {
        off();
        tracked.stop();
      };
    },
  });
  const leave = feed.add(() => {});
  return { feed, stop: () => leave() };
}

const a = session("a");
const b = session("b");
session("c");

test("watched: each change is heard and shows in the next listing; with nothing heard the list is kept", async () => {
  const { feed, stop } = connect();
  try {
    await feed.idle();
    const live = join(liveDir, "p-kept.json");
    let added: { id: string; path: string } | null = null;
    const changes: { name: string; make: () => void; shows: (rows: Rows, before: Rows) => boolean }[] = [
      { name: "a chat added (by a TUI)", make: () => void (added = session("new")), shows: (rows) => !!byId(rows, added!.id) },
      { name: "a chat written (its turn finishing)", make: () => appendFileSync(a.path, `${reply("all done")}\n`), shows: (rows, before) => byId(rows, a.id)?.lastActiveAt !== byId(before, a.id)?.lastActiveAt },
      { name: "archive", make: () => setArchived(b.id, true), shows: (rows) => byId(rows, b.id)?.archived === true },
      { name: "unarchive", make: () => setArchived(b.id, false), shows: (rows) => byId(rows, b.id)?.archived === false },
      { name: "rename", make: () => void setSessionTitle(a.id, "Its own name"), shows: (rows) => byId(rows, a.id)?.title === "Its own name" },
      {
        name: "a TUI opening a chat (live mark)",
        make: () => writeFileSync(live, JSON.stringify({ session: { pid: otherPid, sessionFile: b.path, mode: "tui" }, presence: { status: "idle" } })),
        shows: (rows) => byId(rows, b.id)?.live?.pid === otherPid,
      },
      {
        name: "its turn starting",
        make: () => writeFileSync(live, JSON.stringify({ session: { pid: otherPid, sessionFile: b.path, mode: "tui" }, presence: { status: "busy", activity: { state: "working", since: 1 } } })),
        shows: (rows) => byId(rows, b.id)?.activity?.state === "working",
      },
      { name: "the TUI closing", make: () => rmSync(live), shows: (rows) => byId(rows, b.id)?.live === null },
      { name: "a chat removed", make: () => rmSync(added!.path), shows: (rows) => !byId(rows, added!.id) },
    ];
    for (const c of changes) {
      // Kept first: nothing heard since the last build.
      await listSessions();
      await feed.idle();
      const before = await later();
      const listed = listStats.listed;
      assert.equal((await later(), listStats.listed), listed, `${c.name}: before it, the list is kept`);
      const heard = heardGeneration();
      c.make();
      await until(`${c.name} to be heard`, () => heardGeneration() > heard);
      const got = await later();
      assert.ok(c.shows(got, before), `${c.name}: shows in the next listing`);
      assert.deepEqual(got, await fresh(), `${c.name}: the next listing is a fresh build's`);
    }
  } finally {
    await feed.idle();
    stop();
  }
});

test("watched: a branch state's answer, a nudge, a new connection and the safety net each drop the kept list", async () => {
  const { feed, stop } = connect();
  const leaves: (() => void)[] = [];
  try {
    await feed.idle();
    const drops: [string, () => void][] = [
      ["a readiness answer", () => sessionRowChanged(a.path)],
      ["a merge queue answer", () => sessionsChanged()],
      ["a nudge", () => feed.nudge(0)],
      ["a new connection", () => void leaves.push(feed.add(() => {}))],
    ];
    for (const [name, drop] of drops) {
      await later();
      await feed.idle();
      const listed = listStats.listed;
      await later();
      assert.equal(listStats.listed, listed, `${name}: kept before it`);
      drop();
      await later();
      assert.equal(listStats.listed, listed + 1, `${name}: the next listing is built`);
    }
  } finally {
    // A listener leaving while its first comparison runs keeps the feed on: wait it out first.
    await feed.idle();
    for (const leave of leaves) leave();
    stop();
  }
  // The safety net: its own feed, with a short period.
  const net = connect(150);
  try {
    await net.feed.idle();
    await later();
    const heard = heardGeneration();
    await until("the safety net", () => heardGeneration() > heard);
    const listed = listStats.listed;
    await later();
    assert.equal(listStats.listed, listed + 1, "the safety net: the next listing is built");
  } finally {
    await net.feed.idle();
    net.stop();
  }
});

test("a change no watch hears shows by the age limit; unwatched, a list serves 1 s as before", async () => {
  const { feed, stop } = connect();
  try {
    await feed.idle();
    await later();
    // Another server writes a title: nothing here hears it.
    writeFileSync(join(stateRoot(), "session-titles.json"), JSON.stringify({ titles: { [b.id]: { title: "From elsewhere", by: "user" } } }));
    assert.notEqual(byId(await later(), b.id)?.title, "From elsewhere", "kept while unheard");
    skew += KEEP_UNHEARD_MS;
    assert.equal(byId(await listSessions(), b.id)?.title, "From elsewhere", "past KEEP_UNHEARD_MS it shows");
  } finally {
    await feed.idle();
    stop();
  }
  // Unwatched: nothing is kept past the second.
  await listSessions();
  const listed = listStats.listed;
  await later();
  assert.equal(listStats.listed, listed + 1, "unwatched: a fresh build past 1 s");
});

test("watched: a write to one file builds that row only; one row's change, that row; a safety net or nudge of marks, every row", async () => {
  const { feed, stop } = connect();
  try {
    await feed.idle();
    await fresh();
    await feed.idle();
    const built = keptStats.rowsBuilt;
    const heard = heardGeneration();
    appendFileSync(a.path, `${user("one more")}\n`);
    await until("the write to be heard", () => heardGeneration() > heard);
    await feed.idle();
    const rows = await later();
    await feed.idle();
    assert.equal(keptStats.rowsBuilt - built, 1, "only the written file's row is built, by the feed's build and this one together");
    assert.deepEqual(rows, await fresh());

    await feed.idle();
    const before = keptStats.rowsBuilt;
    sessionRowChanged(b.path);
    await later();
    await feed.idle();
    assert.equal(keptStats.rowsBuilt - before, 1, "only the changed row is built");

    // A marks nudge (a pane attached) moves the inputs and nudges the feed: no row is kept.
    await feed.idle();
    const before2 = keptStats.rowsBuilt;
    listInputsMoved();
    feed.nudge(0);
    const all = await later();
    await feed.idle();
    assert.ok(keptStats.rowsBuilt - before2 >= all.length, "every row is built");
  } finally {
    await feed.idle();
    stop();
  }
});
