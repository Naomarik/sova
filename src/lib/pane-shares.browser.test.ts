// Run: pnpm exec tsx --conditions=browser --test src/lib/pane-shares.browser.test.ts. Solid's reactive build (the browser
// condition), not the inert server build node and bun resolve by default: the bug lives between re-runs of the graph.
import assert from "node:assert/strict";
import { test } from "node:test";
// The browser condition is this file's whole setup: without it every effect below is inert.
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { paneShares } = await import("./pane-shares");
import type { SessionShare } from "../../shared/session-share";
import type { SessionSummary } from "../../shared/protocol";

const summary = (id: string) => ({ id, path: `/s/${id}.jsonl` }) as SessionSummary;
const share = (id: string, title = "t"): SessionShare => ({ id, sessionId: "a", sessionTitle: "a", title, mode: "live", cutAt: null, createdAt: "2026-09-30T00:00:00Z", recipients: [] });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The pane's shape: App hands it a row accessor; every value `shares()` takes is recorded. */
function pane(first: SessionSummary, answer: (id: string) => SessionShare[]) {
  return solid.createRoot((dispose) => {
    const [row, setRow] = solid.createSignal<SessionSummary | undefined>(first);
    const reads: string[] = [];
    const p = paneShares(row, async (_host, id) => {
      reads.push(id);
      return answer(id);
    });
    const seen: (SessionShare[] | null)[] = [];
    solid.createRenderEffect(() => seen.push(p.shares()));
    return { p, setRow, reads, seen, dispose };
  });
}

test("a session-list refetch (a new row object, same id) neither resets nor re-reads the shares", async (t) => {
  const a = pane(summary("a"), () => [share("ss_1")]);
  t.after(a.dispose);
  await settle();
  assert.deepEqual(a.reads, ["a"]);
  const before = a.seen.length;
  for (let i = 0; i < 3; i++) {
    a.setRow(summary("a"));
    await settle();
  }
  assert.deepEqual(a.reads, ["a"], "no read from a list refresh");
  assert.ok(a.seen.slice(before).every((v) => v !== null), "the list never returns to the placeholder");
  assert.equal(a.seen.length, before);
});

test("a new session resets the list to the placeholder and reads once", async (t) => {
  const a = pane(summary("a"), (id) => [share(`ss_${id}`)]);
  t.after(a.dispose);
  await settle();
  a.setRow(summary("b"));
  assert.equal(a.p.shares(), null);
  await settle();
  assert.deepEqual(a.reads, ["a", "b"]);
  assert.equal(a.p.shares()?.[0]?.id, "ss_b");
});

test("a re-read keeps each unchanged share's object; a changed one is new", async (t) => {
  let title = "t";
  const a = pane(summary("a"), () => [share("ss_1"), share("ss_2", title)]);
  t.after(a.dispose);
  await settle();
  const [one, two] = a.p.shares()!;
  a.p.reload();
  await settle();
  assert.equal(a.p.shares()![0], one);
  assert.equal(a.p.shares()![1], two);
  title = "renamed";
  a.p.reload();
  await settle();
  assert.equal(a.p.shares()![0], one);
  assert.notEqual(a.p.shares()![1], two);
  assert.equal(a.p.shares()![1]?.title, "renamed");
});
