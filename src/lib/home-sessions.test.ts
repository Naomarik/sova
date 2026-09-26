import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttentionItem, SessionSummary } from "../../shared/protocol";
import { sessionsGlance } from "./home-sessions";

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/w/a",
    title: id,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
    model: null,
    live: null,
    busy: false,
    origin: "external",
    archived: false,
    ...extra,
  }) as SessionSummary;

const act = (id: string, since: number): AttentionItem => ({ id: `i-${id}`, path: `/s/${id}.jsonl`, title: id, where: "~/w", tier: "act", kind: "baton-needs-you", since, href: `#/s/${id}` }) as AttentionItem;

const list = [
  session("a", { cwd: "/w/b", lastActiveAt: "2026-01-03T00:00:00Z", origin: "web" }),
  session("b", { live: { pid: 1, status: "idle" } as SessionSummary["live"], activity: { state: "working" } }),
  session("c", { origin: "web", busy: true, lastActiveAt: "2026-01-02T00:00:00Z" }),
  session("d", { archived: true, lastActiveAt: "2026-01-09T00:00:00Z" }),
  session("w", { workerSession: true, lastActiveAt: "2026-01-10T00:00:00Z" }),
  session("o", { overseer: true }),
];

test("counts main threads only; live is Live & web; working is a working record or a busy web run", () => {
  const g = sessionsGlance(list, undefined, "badge");
  assert.equal(g.total, 4, "no worker, no overseer; archived counts");
  assert.equal(g.folders, 2);
  assert.equal(g.live, 3, "a (web), b (terminal), c (web); d is archived");
  assert.equal(g.working, 2, "b working, c busy");
  assert.equal(g.last?.id, "a", "newest not archived, not a worker");
  assert.equal(g.needsYou, 0);
});

test("needs you: the region's rows, first two newest first; none while proactivity is Off or unknown", () => {
  const digest = { items: [act("a", 1), act("b", 3), act("c", 2), act("w", 9)] };
  const g = sessionsGlance(list, digest, "badge");
  assert.equal(g.needsYou, 3, "the worker's item has no main-thread row");
  assert.deepEqual(g.needsYouFirst.map((s) => s.id), ["b", "c"]);
  assert.equal(sessionsGlance(list, digest, "off").needsYou, 0);
  assert.equal(sessionsGlance(list, digest, undefined).needsYouFirst.length, 0);
});

test("an empty list", () => {
  assert.deepEqual(sessionsGlance([], undefined, "badge"), { total: 0, folders: 0, live: 0, working: 0, needsYou: 0, needsYouFirst: [], last: null });
});
