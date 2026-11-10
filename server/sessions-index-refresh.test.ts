// Run: pnpm test server/sessions-index-refresh.test.ts
// A refresh shows what no watch heard (§app.session-list/listing-reuse): while the folders are
// watched a list may be kept for up to KEEP_UNHEARD_MS, but a window loading never reads it: its
// GET /api/sessions is built afresh, and its feed connection makes the feed's next comparison read
// every folder. A session file is written here where nothing hears it (the feed's watch only tracks
// files and watches no folder), then: a plain listing within the limit is the kept list, and both
// page-load paths show the new chat at once; several page loads at once share a build that started
// after they arrived. Seen to fail in a scratch copy with the route reading
// listSessions (b), and with a new connection not making the feed read every folder (c).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-session-refresh-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-session-refresh--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
after(() => {
  Date.now = realNow;
  rmSync(agentDir, { recursive: true, force: true });
});

const { KEEP_UNHEARD_MS, LIST_REUSE_MS, listSessions, listSessionsTracked, listStamps, listStats, trackSessionFiles } = await import("./sessions-index");
const { configureSessionFeed } = await import("./session-feed");
const { canonicalPath } = await import("./paths");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });

let n = 0;
function session(name: string): { id: string; path: string } {
  const id = `01234567-89ab-7cde-8f01-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-09-27T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const header = { type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd: "/tmp" };
  const said = { type: "message", id: `m${n}`, parentId: null, message: { role: "user", content: `hello from ${name}` } };
  writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(said)}\n`);
  return { id, path };
}
const has = (rows: readonly SessionSummary[], id: string) => rows.some((r) => r.id === id);

test("a chat no watch heard: a plain listing within the limit is the kept list; a page load shows it at once", async () => {
  session("before");
  // The server's feed, deaf: the file tracker runs (the folders count as watched), but no folder is watched.
  const feed = configureSessionFeed({
    list: (opts) => listSessionsTracked(opts),
    stamps: listStamps,
    debounceMs: 0,
    minGapMs: 0,
    intervalMs: 1_000_000,
    watch: () => trackSessionFiles().stop,
  });
  const sent: SessionFeedMessage[] = [];
  const leave = feed.add((m) => sent.push(m), { rows: true });
  const leaves = [leave];
  try {
    await feed.idle();
    await listSessions();

    const unheard = session("written where nothing hears");
    // (a) Within KEEP_UNHEARD_MS a plain listing may be the kept list, and here is.
    skew += LIST_REUSE_MS + 1;
    assert.equal(has(await listSessions(), unheard.id), false, "a plain listing within the limit: the kept list");
    assert.ok(skew < KEEP_UNHEARD_MS);

    // (b) The page's list read, GET /api/sessions: built afresh.
    const res = await app.request("/api/sessions");
    assert.equal(res.status, 200);
    assert.equal(has((await res.json()) as SessionSummary[], unheard.id), true, "GET /api/sessions shows it at once");

    // (c) The page's feed connection: the feed's comparison reads every folder, and sends the row.
    const second = session("written where nothing hears, again");
    skew += LIST_REUSE_MS + 1;
    assert.equal(has(await listSessions(), second.id), false, "kept again until something is heard");
    leaves.push(feed.add(() => {}, { rows: true }));
    await feed.idle();
    const upserted = sent.flatMap((m) => (m.type === "rows" ? m.upsert : []));
    assert.ok(upserted.some((r) => r.id === second.id), "a new connection's comparison sends the new chat's row");
    skew += LIST_REUSE_MS + 1;
    assert.equal(has(await listSessions(), second.id), true, "and no kept list from before it is served");

    // Several pages at once (tabs, peers): they share a build that started after they arrived.
    const third = session("written before three pages load");
    const builds = listStats.builds;
    const pages = await Promise.all([app.request("/api/sessions"), app.request("/api/sessions"), app.request("/api/sessions")]);
    assert.ok(listStats.builds - builds <= 2, `three page loads built ${listStats.builds - builds} lists`);
    for (const p of pages) assert.equal(has((await p.json()) as SessionSummary[], third.id), true, "each shows the chat written before it");
  } finally {
    await feed.idle();
    for (const l of leaves) l();
  }
});
