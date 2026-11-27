// Which archived chats the automatic pass compresses (§app.session-list/archive-compression "On its own"): pure.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { autoCandidates } from "./auto";

describe("autoCandidates", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const row = (path: string, days: number, extra: Record<string, unknown> = {}) => ({ path, lastActiveAt: ago(days), archived: true, live: null, busy: false, ...extra }) as any;
  test("archived chats last active over 60 days ago, oldest first; never a helper's, the Overseer's, an organization's, a queue chat, a live or compressed one", () => {
    const rows = [
      row("a", 61),
      row("b", 90),
      row("young", 59),
      row("open", 70, { archived: false }),
      row("helper", 70, { workerSession: true }),
      row("overseer", 70, { overseer: true }),
      row("org", 70, { org: { id: "o" } }),
      row("queue", 70, { queueChat: { role: "thread" } }),
      row("live", 70, { live: { pid: 1, status: "x" } }),
      row("done", 70, { compressed: true }),
    ];
    assert.deepEqual(autoCandidates(rows, now), ["b", "a"]);
  });
});
