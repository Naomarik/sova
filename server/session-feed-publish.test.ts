// Run: pnpm test server/session-feed-publish.test.ts. A push published while a socket is still joining
// (its first list being read) reaches it once, right after its join frames; joined sockets see the same
// order as before; a socket that closes or whose join fails mid-way holds nothing and gets nothing.
// In process: the list is a promise the test releases; no file, socket or timer of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";
import { SessionFeed } from "./session-feed";

const row = (id: string): SessionSummary => ({
  id, path: `/s/${id}.jsonl`, cwd: "/w", title: id, createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false,
});

/** A feed whose next list read waits until `release()` (or fails on `fail()`). */
function gatedFeed() {
  let gate: { resolve: (v: SessionSummary[]) => void; reject: (e: Error) => void } | null = null;
  const feed = new SessionFeed({
    list: () => new Promise<SessionSummary[]>((resolve, reject) => (gate = { resolve, reject })),
    intervalMs: 60_000,
    debounceMs: 0,
    minGapMs: 0,
  });
  const waitGate = async () => {
    for (let i = 0; i < 100 && !gate; i++) await new Promise((r) => setTimeout(r, 1));
    assert.ok(gate, "the join read the list");
  };
  return {
    feed,
    release: async (list: SessionSummary[] = [row("a")]) => {
      await waitGate();
      const g = gate!;
      gate = null;
      g.resolve(list);
      await feed.idle();
    },
    fail: async () => {
      await waitGate();
      const g = gate!;
      gate = null;
      g.reject(new Error("list failed"));
      await feed.idle().catch(() => undefined);
    },
  };
}

const PUSH: SessionFeedMessage = { type: "claude_models_changed" };
const types = (got: SessionFeedMessage[]) => got.map((m) => m.type);

test("a push published during the join reaches the joiner exactly once, after its join frames", async () => {
  const { feed, release } = gatedFeed();
  const got: SessionFeedMessage[] = [];
  const close = feed.add((m) => got.push(m), { rows: true });
  feed.publish(PUSH);
  assert.deepEqual(got, [], "nothing is sent before the join frames");
  await release();
  assert.deepEqual(types(got), ["rows_hello", "marks", "claude_models_changed"]);
  feed.publish({ type: "public_links_changed" });
  assert.deepEqual(types(got), ["rows_hello", "marks", "claude_models_changed", "public_links_changed"], "after the join: sent at once, nothing held twice");
  close();
  feed.stop();
});

test("a socket already joined sees the same order as before while another joins", async () => {
  const { feed, release } = gatedFeed();
  const first: SessionFeedMessage[] = [];
  const closeFirst = feed.add((m) => first.push(m));
  await release();
  assert.deepEqual(types(first), ["marks"]);
  const second: SessionFeedMessage[] = [];
  const closeSecond = feed.add((m) => second.push(m));
  feed.publish(PUSH);
  feed.publish({ type: "public_links_changed" });
  assert.deepEqual(types(first), ["marks", "claude_models_changed", "public_links_changed"], "the joined socket gets each push at once, in order");
  await release();
  assert.deepEqual(types(first), ["marks", "claude_models_changed", "public_links_changed"], "and no second copy when the other joins");
  assert.deepEqual(types(second), ["marks", "claude_models_changed", "public_links_changed"]);
  closeFirst();
  closeSecond();
  feed.stop();
});

test("a socket closed mid-join holds nothing and gets nothing", async () => {
  const { feed, release } = gatedFeed();
  const keep: SessionFeedMessage[] = [];
  const closeKeep = feed.add((m) => keep.push(m));
  await release();
  const gone: SessionFeedMessage[] = [];
  const close = feed.add((m) => gone.push(m));
  feed.publish(PUSH);
  close();
  assert.equal((feed as unknown as { held: Set<unknown> }).held.size, 0, "no buffer left once it closed");
  feed.publish({ type: "public_links_changed" });
  await release();
  assert.deepEqual(gone, [], "a closed joiner is sent nothing");
  assert.equal((feed as unknown as { held: Set<unknown> }).held.size, 0, "none after its join ended either");
  assert.deepEqual(types(keep), ["marks", "claude_models_changed", "public_links_changed"]);
  closeKeep();
  feed.stop();
});

test("a join whose list read fails holds nothing and gets nothing", async () => {
  const { feed, fail } = gatedFeed();
  const got: SessionFeedMessage[] = [];
  const close = feed.add((m) => got.push(m));
  feed.publish(PUSH);
  await fail();
  feed.publish({ type: "public_links_changed" });
  assert.deepEqual(got, [], "a failed join never joined");
  assert.equal((feed as unknown as { held: Set<unknown> }).held.size, 0, "its buffer was dropped");
  close();
  feed.stop();
});
