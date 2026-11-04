// The session feed reading another caller's build (listSessionsTracked `join`, sessions-index
// listStamps): a change that came after that build started still reaches the feed, whatever told of
// it, and the listing work a pass repeats is done once. A throwaway PI_CODING_AGENT_DIR, org workspace
// and project root under the OS temp dir; ~/.pi is never read.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { PROJECT_OVERSEER_ENTRY } from "../shared/project-overseer";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";
import { scratchRoot } from "./test-scratch";

const root = realpathSync(scratchRoot("sova-feed-join-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--join--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
await import("./org-sessions");
const { hostOf, onOrgChange } = await import("./org-engine");
const { seedBuild } = await import("./org-test-fixtures");
const { projectDir } = await import("./projects/spaces");
const { projectSessionLookup } = await import("./project-sessions");
const { listSessions, listSessionsTracked, listStamps, trackSessionFiles, trackedStats } = await import("./sessions-index");
const { listGeneration, onSessionsChanged, sessionsChanged } = await import("./list-generation");
const { canonicalPath } = await import("./paths");
const { SessionFeed } = await import("./session-feed");
const { setSessionTitle } = await import("./session-titles");
const { settled } = await import("./workspace-git");

after(async () => {
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function session(title: string, cwd = "/tmp"): { id: string; path: string } {
  const id = `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${[
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd }),
    JSON.stringify({ type: "message", id: `m${n}`, parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: title } }),
  ].join("\n")}\n`);
  return { id, path: canonicalPath(path) };
}

const until = async (what: string, ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < end, `timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A feed wired as server/index.ts wires it, its nudges sent by the sources that send them there;
    `sent` is what its rows client saw. A gap of 0, so a test's re-diff runs as soon as it is due. */
async function wiredFeed() {
  const sent: SessionFeedMessage[] = [];
  let note: (path: string | null) => void = () => {};
  const feed = new SessionFeed({
    list: (opts) => listSessionsTracked(opts),
    stamps: listStamps,
    debounceMs: 0,
    minGapMs: 0,
    intervalMs: 1_000_000,
    watch: (changed) => {
      const tracked = trackSessionFiles();
      note = tracked.note;
      const offBump = onSessionsChanged(() => {
        if (!quiet) changed();
      });
      return () => {
        offBump();
        tracked.stop();
      };
    },
  });
  feed.add((m) => sent.push(m), { rows: true });
  await until("the first comparison", () => sent.some((m) => m.type === "rows_hello"));
  await feed.idle();
  const upserted = (path: string): SessionSummary | undefined => sent.flatMap((m) => (m.type === "rows" ? m.upsert : [])).findLast((r) => r.path === path);
  stops.push(() => feed.stop());
  return { feed, sent, upserted, note: (path: string | null) => note(path) };
}
const stops: (() => void)[] = [];
let quiet = false;
/** The next listSessions builds, and the feed hears nothing of it: its build is there to be found. */
const callerBuilds = (): Promise<SessionSummary[]> => {
  quiet = true;
  sessionsChanged();
  quiet = false;
  return listSessions();
};
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/**
 * One round: a caller's build starts, then the change comes and its signal with it, so the re-diff
 * finds a list from before the change. Rounds repeat only for a machine too slow to reach that
 * re-diff within the reuse second: a round that joined nothing proves nothing, so one has to join.
 */
async function afterAJoin(change: (round: number) => void, told: (round: number) => boolean, feed: InstanceType<typeof SessionFeed>): Promise<void> {
  for (let round = 0; round < 8; round++) {
    const joined = trackedStats.joined;
    await callerBuilds();
    change(round);
    await until("a change told to the feed", () => told(round));
    await feed.idle();
    if (trackedStats.joined > joined) return;
  }
  assert.fail("no round's comparison joined the caller's build");
}

describe("a comparison on another caller's list", () => {
  test("a store write made after that build started reaches the feed", async () => {
    const s = session("store");
    const f = await wiredFeed();
    await afterAJoin((round) => setSessionTitle(s.id, `Renamed ${round}`), (round) => f.upserted(s.path)?.title === `Renamed ${round}`, f.feed);
  });

  test("a file changed outside this server after that build started reaches the feed", async () => {
    const f = await wiredFeed();
    const paths: string[] = [];
    await afterAJoin(
      (round) => {
        // Only the watch tells of it: no generation moves, as with a TUI writing.
        const g = listGeneration();
        const s = session(`outside ${round}`);
        paths[round] = s.path;
        f.note(s.path);
        f.feed.nudge(0);
        assert.equal(listGeneration(), g);
      },
      (round) => f.upserted(paths[round]!) !== undefined,
      f.feed,
    );
  });

  test("a statechart step after that build started reaches the feed, with no generation moved", async () => {
    const org = await orgs.createOrg({ name: "Join Co", dir: join(root, "ws") });
    const rootDir = join(root, "proj");
    mkdirSync(rootDir);
    const project = await orgs.addProject(org.id, { name: "Join", root: rootDir });
    const f = await wiredFeed();
    let live = true;
    onOrgChange(() => {
      if (live) f.feed.nudge(0);
    });
    stops.push(() => (live = false));
    const made: { id: string; path: string }[] = [];
    const seeds: Promise<void>[] = [];
    const steps: (() => void)[] = [];
    // The step is async: the session exists first, so its only change is the row's `org`.
    for (let i = 0; i < 8; i++) {
      made[i] = session(`coding ${i}`, rootDir);
      steps[i] = () => seeds.push(seedBuild(org.id, project.id, { sessionId: made[i]!.id, kind: "coding" }));
    }
    f.note(null);
    f.feed.nudge(0);
    await until("the rows", () => made.every((s) => f.upserted(s.path)));
    await afterAJoin(
      (round) => {
        const g = listGeneration();
        steps[round]!();
        assert.equal(listGeneration(), g);
      },
      (round) => f.upserted(made[round]!.path)?.org !== undefined,
      f.feed,
    );
    await Promise.all(seeds);
  });

  test("a file only a full build found stays listed by the tracked build after it", async () => {
    const f = await wiredFeed();
    for (let round = 0; round < 8; round++) {
      const diffs = f.feed.diffs;
      const s = session(`no watch told ${round}`);
      const joined = trackedStats.joined;
      await callerBuilds(); // it sees this file; the watch never told of it
      f.feed.nudge(0);
      await until("the comparison", () => f.feed.diffs > diffs);
      await f.feed.idle();
      if (trackedStats.joined === joined) continue;
      assert.ok(f.upserted(s.path), "the joined list holds it");
      const own = await listSessionsTracked();
      assert.ok(own.some((r) => r.path === s.path), "the next tracked build keeps it");
      return;
    }
    assert.fail("no round joined");
  });

  test("a file removed after that build started goes with the next list", async () => {
    const f = await wiredFeed();
    const doomed = Array.from({ length: 8 }, (_, i) => session(`doomed ${i}`).path);
    for (const path of doomed) f.note(path);
    f.feed.nudge(0);
    await until("the rows", () => doomed.every((path) => f.upserted(path)));
    await f.feed.idle();
    await afterAJoin(
      (round) => {
        unlinkSync(doomed[round]!);
        f.note(doomed[round]!);
        f.feed.nudge(0);
      },
      (round) => f.sent.some((m) => m.type === "rows" && m.remove.includes(doomed[round]!)),
      f.feed,
    );
  });

  test("a list is never read twice, nor one older than the last", async () => {
    const f = await wiredFeed();
    await callerBuilds();
    await listSessionsTracked({ join: true });
    const joined = trackedStats.joined;
    const builds = trackedStats.builds;
    await listSessionsTracked({ join: true });
    assert.equal(trackedStats.joined, joined, "that list was read already");
    assert.equal(trackedStats.builds, builds + 1, "so the feed builds");
    await listSessionsTracked({ join: true });
    assert.equal(trackedStats.joined, joined, "the feed's own build is newer than the caller's");
    assert.ok(f.feed.size > 0);
  });

  test("a new listener's snapshot is never another caller's list", async () => {
    const f = await wiredFeed();
    await callerBuilds();
    const joined = trackedStats.joined;
    let snapshot = false;
    f.feed.add((m) => (snapshot ||= m.type === "marks"));
    await until("the snapshot", () => snapshot);
    assert.equal(trackedStats.joined, joined);
  });

  test("listSessions never serves a tracked build: a file no watch told of is listed at once", async () => {
    const f = await wiredFeed();
    await listSessionsTracked();
    await new Promise((r) => setTimeout(r, 1_050)); // past the reuse window of any list before it
    await listSessionsTracked();
    const s = session("told to nobody");
    assert.ok((await listSessions()).some((r) => r.path === s.path));
    assert.ok(f.feed.size > 0);
  });
});

describe("one pass", () => {
  test("reads each engine's builds once, and a step between two passes shows in the second", async () => {
    const org = await orgs.createOrg({ name: "Pass Co", dir: join(root, "ws-pass") });
    const rootDir = join(root, "proj-pass");
    mkdirSync(rootDir);
    const project = await orgs.addProject(org.id, { name: "Pass", root: rootDir });
    const a = session("first build", rootDir);
    const b = session("second build", rootDir);
    await seedBuild(org.id, project.id, { sessionId: a.id, kind: "coding" });

    const host = hostOf(org.id);
    const real = host.sessions.bind(host);
    let reads = 0;
    host.sessions = ((kind: string) => {
      if (kind === "build") reads++;
      return real(kind);
    }) as typeof host.sessions;
    try {
      sessionsChanged();
      const rows = await listSessions();
      assert.ok(rows.find((r) => r.id === a.id)?.org, "a's build is read");
      assert.equal(rows.find((r) => r.id === b.id)?.org, undefined);
      assert.equal(reads, 1, "project and org lookups share one reading");

      await seedBuild(org.id, project.id, { sessionId: b.id, kind: "coding" });
      sessionsChanged();
      assert.ok((await listSessions()).find((r) => r.id === b.id)?.org, "nothing outlives the pass");
    } finally {
      host.sessions = real;
    }
  });

  test("a file's marker is told from the mtime the pass holds, with no stat of its own", async () => {
    const org = await orgs.createOrg({ name: "Marker Co", dir: join(root, "ws-marker") });
    const rootDir = join(root, "proj-marker");
    mkdirSync(rootDir);
    const project = await orgs.addProject(org.id, { name: "Marker", root: rootDir });
    const dir = join(projectDir(project.id), "sessions");
    mkdirSync(dir, { recursive: true });
    const id = "01234567-89ab-7cde-8f01-888888888888";
    const path = join(dir, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
    const at = "2026-09-21T00:00:00.000Z";
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: rootDir })}\n${JSON.stringify({ type: "custom", id: "c1", parentId: null, timestamp: at, customType: PROJECT_OVERSEER_ENTRY, data: { v: 1, orgId: org.id, projectId: project.id } })}\n`);
    const mtimeMs = statSync(path).mtimeMs;
    const lookup = projectSessionLookup();
    assert.equal(lookup.of(path, id, rootDir, mtimeMs)?.kind, "overseer");
    unlinkSync(path);
    assert.equal(lookup.of(path, id, undefined, mtimeMs)?.kind, "overseer", "the file is gone, and only a stat would know");
    assert.equal(lookup.of(path, id)?.kind, undefined, "with no mtime it stats");
  });

  test("the pass's organization reader answers as orgOfSessionPath does", async () => {
    const org = await orgs.createOrg({ name: "Late Co", dir: join(root, "ws-late") });
    const wsSessions = join(orgs.orgDir(org.id), "sessions");
    mkdirSync(wsSessions, { recursive: true });
    const id = "01234567-89ab-7cde-8f01-999999999999";
    const path = join(wsSessions, `2026-09-21T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-21T00:00:00.000Z", cwd: "/tmp" })}\n`);
    const { orgOfSessionPath, orgOfSessionPathReader } = orgs;
    assert.equal(orgOfSessionPathReader()(canonicalPath(path))?.orgId, org.id);
    assert.deepEqual(orgOfSessionPathReader()(canonicalPath(path)), orgOfSessionPath(canonicalPath(path)));
    assert.equal(orgOfSessionPathReader()(join(root, "elsewhere", "x.jsonl")), null);
  });
});
