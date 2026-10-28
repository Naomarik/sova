// The merge captain's landing queue (§chat.merge-round/round, §chat.offers/sova-landing): Sova shows the
// Landing card itself for each queued branch, once, from the captain's chat; only a captain's queue counts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
const dir = mkdtempSync(join(tmpdir(), "sova-landing-queue-"));
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
after(() => rmSync(dir, { recursive: true, force: true }));
const q = await import("./landing-queue");
const { OfferRefusal } = await import("./session-offers");

const HEAD = "a".repeat(40);
const queueFile = join(dir, "queue.json");
const shownFile = join(dir, "shown.json");
const entry = (over: Record<string, unknown> = {}) => ({ id: "q1", branch: "feat/x", path: "/wt/x", head: HEAD, owner: "own", captain: "cap", at: 1_000, ...over });
const writeQueue = (entries: object[]) => writeFileSync(queueFile, JSON.stringify({ v: 1, entries }));

function deps(over: Partial<Parameters<typeof q.processLandingQueue>[0]> = {}) {
  const shows: unknown[] = [];
  const rows: unknown[] = [];
  const profiles: Record<string, string | undefined> = { "/s/cap": "merge-captain", "/s/own": undefined };
  return {
    shows,
    rows,
    d: {
      pathOf: async (id: string) => (id === "cap" || id === "own" || id === "other" ? `/s/${id}` : undefined),
      summary: async (path: string) => ({ id: path.slice(3), path, profile: profiles[path] ? { id: profiles[path] } : undefined }) as unknown as SessionSummary,
      head: async () => HEAD,
      show: async (input: unknown) => (shows.push(input), { id: "of_1" }),
      addRow: async (input: { branch: string }) => (rows.push(input), { card: "of_9", row: "r_1" }),
      now: () => 2_000,
      queueFile: () => queueFile,
      shownFile: () => shownFile,
      ...over,
    },
  };
}

test("a captain's queued branch is shown once, for that worktree, from the captain's chat", async () => {
  rmSync(shownFile, { force: true });
  writeQueue([entry()]);
  const { d, shows } = deps();
  assert.equal(await q.processLandingQueue(d), 1);
  assert.deepEqual(shows, [{ path: "/s/own", sessionId: "own", offer: "landing", by: "another-chat", from: "/s/cap", tree: "/wt/x" }]);
  assert.deepEqual(q.readShown(shownFile).q1, { at: 2_000, card: "of_1", row: { card: "of_9", row: "r_1" } }, "and a row on the captain's landing card");
  assert.equal(await q.processLandingQueue(d), 0, "answered once");
  assert.equal(shows.length, 1);
});

test("refused, and said why: not a captain, a moved head, an old entry, Sova's own refusal", async () => {
  rmSync(shownFile, { force: true });
  writeQueue([entry({ id: "a", captain: "other" }), entry({ id: "b", at: 2_000 - q.QUEUE_MAX_AGE_MS - 1 }), entry({ id: "c" }), entry({ id: "d", owner: "nobody" })]);
  const { d, shows } = deps({
    head: async () => "b".repeat(40),
  });
  await q.processLandingQueue(d);
  const r = q.readShown(shownFile) as Record<string, { refused?: string }>;
  assert.match(r.a!.refused!, /Only a Merge Captain session's queue/);
  assert.match(r.b!.refused!, /more than a day ago/);
  assert.match(r.c!.refused!, /feat\/x moved to bbbbbbb since it was queued at aaaaaaa/);
  assert.match(r.d!.refused!, /No session nobody/);
  assert.equal(shows.length, 0);
  rmSync(shownFile, { force: true });
  writeQueue([entry({ id: "e" })]);
  const refusing = deps({ show: async () => { throw new OfferRefusal('"landing" shows only when the branch is ready to land, and it doesn\'t now. Nothing was shown.'); } });
  await q.processLandingQueue(refusing.d);
  assert.match((q.readShown(shownFile).e as { refused: string }).refused, /ready to land/);
});

test("q1: a refusal about the owner's chat alone still adds the captain's row; one about the branch adds none", async () => {
  rmSync(shownFile, { force: true });
  writeQueue([entry({ id: "chat" }), entry({ id: "branch" })]);
  const { d, rows } = deps({
    show: async (input: unknown) => {
      if ((input as { path: string }).path === "/s/own" && rows.length === 0) throw new OfferRefusal('The offer "x" is still open in this session; the user answers it first. Nothing was shown.', 409, true);
      throw new OfferRefusal('"landing" shows only when the branch is ready to land, and it doesn\'t now. Nothing was shown.');
    },
  });
  await q.processLandingQueue(d);
  const r = q.readShown(shownFile) as Record<string, { refused?: string; row?: unknown }>;
  assert.match(r.chat!.refused!, /still open/);
  assert.deepEqual(r.chat!.row, { card: "of_9", row: "r_1" });
  assert.match(r.branch!.refused!, /ready to land/);
  assert.equal(r.branch!.row, undefined);
  assert.equal(rows.length, 1);
});
