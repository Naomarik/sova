// Run: pnpm test -- src/lib/team-inbox.browser.test.ts (Solid's reactive build).
// The reader behind a team member's Inbox tab (§app.subagents-pane/member-inbox): the list is read
// at once and on the poll while the tab is open, never while it isn't; a body is read only when its
// item opens, once; another member starts over; a failed read says so and Retry reads again.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createInboxReader } = await import("./team-inbox");
type View = import("../../shared/protocol").TeamInboxView;
type Key = import("./team-inbox").InboxKey;

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const view = (workerId: string, ids: string[]): View => ({
  teamId: "team_01",
  workerId,
  total: ids.length,
  counts: { open: ids.length, urgent: 0, total: ids.length },
  items: ids.map((id) => ({ id, from: { role: "lead", workerId: "ag_01" }, kind: "message", subject: id, urgent: false, status: "new", sentAt: 1 })),
});

function harness(opts: { failList?: () => boolean; failBody?: () => boolean } = {}) {
  const lists: Key[] = [];
  const bodies: [string, string][] = [];
  const [key, setKey] = solid.createSignal<Key | null>({ path: "/s.jsonl", teamId: "team_01", workerId: "ag_02" });
  const [active, setActive] = solid.createSignal(true);
  let reader!: ReturnType<typeof createInboxReader>;
  const dispose = solid.createRoot((d) => {
    reader = createInboxReader({
      key,
      active,
      pollMs: 30,
      list: async (k) => {
        lists.push(k);
        if (opts.failList?.()) throw new Error("Server said 500.");
        return view(k.workerId, k.workerId === "ag_02" ? ["i_2", "i_1"] : ["i_9"]);
      },
      body: async (k, id) => {
        bodies.push([k.workerId, id]);
        if (opts.failBody?.()) throw new Error("gone");
        return { id, body: `body of ${id}` };
      },
    });
    return d;
  });
  return { lists, bodies, setKey, setActive, reader: () => reader, dispose };
}

test("reads at once and on the poll while open; never while closed", async () => {
  const h = harness();
  try {
    await tick(5);
    assert.equal(h.lists.length, 1, "at once");
    assert.deepEqual(h.reader().view()?.items.map((i) => i.id), ["i_2", "i_1"]);
    await tick(70);
    assert.ok(h.lists.length >= 2, "polled");
    h.setActive(false);
    const n = h.lists.length;
    await tick(80);
    assert.equal(h.lists.length, n, "no read while the tab is closed");
  } finally {
    h.dispose();
  }
});

test("a body is read only when its item opens, once; a second press closes it", async () => {
  const h = harness();
  try {
    await tick(5);
    assert.deepEqual(h.bodies, [], "no body on the list");
    h.reader().toggle("i_1");
    assert.equal(h.reader().isOpen("i_1"), true);
    await tick(5);
    assert.deepEqual(h.reader().body("i_1"), { loading: false, text: "body of i_1" });
    h.reader().toggle("i_1");
    assert.equal(h.reader().isOpen("i_1"), false);
    h.reader().toggle("i_1");
    await tick(5);
    assert.deepEqual(h.bodies, [["ag_02", "i_1"]], "kept, not read again");
  } finally {
    h.dispose();
  }
});

test("a failed body read is tried again on the next open", async () => {
  let fail = true;
  const h = harness({ failBody: () => fail });
  try {
    await tick(5);
    h.reader().toggle("i_2");
    await tick(5);
    assert.equal(h.reader().body("i_2")?.error, "gone");
    fail = false;
    h.reader().toggle("i_2");
    h.reader().toggle("i_2");
    await tick(5);
    assert.equal(h.reader().body("i_2")?.text, "body of i_2");
  } finally {
    h.dispose();
  }
});

test("another member starts over: nothing of the previous one shows", async () => {
  const h = harness();
  try {
    await tick(5);
    h.reader().toggle("i_1");
    await tick(5);
    h.setKey({ path: "/s.jsonl", teamId: "team_01", workerId: "ag_03" });
    assert.equal(h.reader().view(), null, "the old list is gone at once");
    assert.equal(h.reader().isOpen("i_1"), false);
    assert.equal(h.reader().body("i_1"), undefined);
    await tick(5);
    assert.deepEqual(h.reader().view()?.items.map((i) => i.id), ["i_9"]);
    // The same member under a fresh key object is no change.
    const n = h.lists.length;
    h.setKey({ path: "/s.jsonl", teamId: "team_01", workerId: "ag_03" });
    assert.deepEqual(h.reader().view()?.items.map((i) => i.id), ["i_9"], "kept");
    assert.equal(h.lists.length, n, "no extra read");
  } finally {
    h.dispose();
  }
});

test("a failed list read says so and keeps nothing stale; Retry reads again", async () => {
  let fail = true;
  const h = harness({ failList: () => fail });
  try {
    h.setActive(false);
    await tick(5);
    assert.equal(h.reader().error(), "Server said 500.");
    assert.equal(h.reader().view(), null);
    fail = false;
    h.reader().retry();
    await tick(5);
    assert.equal(h.reader().error(), null);
    assert.equal(h.reader().view()?.items.length, 2);
  } finally {
    h.dispose();
  }
});

test("the summary line and the chips follow the poll: a safety-net close shows as Closed automatically; an older server shows no line", async () => {
  const { inboxSummary, statusChip } = await import("./team-inbox");
  let auto = false;
  let older = false;
  const [key] = solid.createSignal<Key | null>({ path: "/s.jsonl", teamId: "team_01", workerId: "ag_02" });
  let reader!: ReturnType<typeof createInboxReader>;
  let summary!: () => string | null;
  let chips!: () => string[];
  const dispose = solid.createRoot((d) => {
    reader = createInboxReader({
      key,
      active: () => true,
      pollMs: 20,
      list: async () => {
        const v = view("ag_02", ["i_2", "i_1"]);
        if (auto) {
          v.items[1] = { ...v.items[1]!, status: "addressed", closedBy: "auto", note: "closed automatically: seen, not closed by dev" };
          v.counts = { open: 1, urgent: 0, total: 2, closedByMember: 0, closedAutomatically: 1 };
        } else v.counts = { ...v.counts, closedByMember: 0, closedAutomatically: 0 };
        if (older) v.counts = { open: v.counts.open, urgent: 0, total: 2 };
        return v;
      },
      body: async (_k, id) => ({ id, body: id }),
    });
    summary = solid.createMemo(() => inboxSummary(reader.view()?.counts, "dev"));
    chips = solid.createMemo(() => (reader.view()?.items ?? []).map((i) => statusChip(i).word));
    return d;
  });
  try {
    await tick(5);
    assert.equal(summary(), "2 open");
    assert.deepEqual(chips(), ["New", "New"]);
    auto = true;
    await tick(40);
    assert.equal(summary(), "1 open · 1 closed automatically");
    assert.deepEqual(chips(), ["New", "Closed automatically"]);
    older = true;
    await tick(40);
    assert.equal(summary(), null, "no split from the server: no line");
  } finally {
    dispose();
  }
});
