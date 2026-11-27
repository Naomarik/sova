// The session feed's label sockets (`/ws/watch?feed=sessions&rows=1&labels=…`): a socket that names
// label pairs gets its rows with those labels; every other socket's frames are what they were, byte
// for byte. Pure: an injected list and the real label store in a throwaway agent dir, no sockets.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionFeedMessage, SessionSummary } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-feed-labels-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const L = await import("./session-labels");
const { SessionFeed } = await import("./session-feed");
const { rowsDigest } = await import("../src/lib/summary-diff");
after(() => rmSync(agentDir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(agentDir, "sova", "session-labels.json"), { force: true });
  L.resetLabelsCache();
});

const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, path: `/s/${id}.jsonl`, cwd: "/w", title: id, createdAt: "", lastActiveAt: "2026-01-01T00:00:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false, ...over,
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const LABELS = { union: L.unionPairs, overlay: L.withLabels, project: L.projectLabels };

function harness(initial: SessionSummary[], withLabels: boolean, intervalMs = 60_000) {
  let list = initial;
  const feed = new SessionFeed({ list: async () => list.map(clone), intervalMs, debounceMs: 0, minGapMs: 0, ...(withLabels ? { labels: LABELS } : {}) });
  return {
    feed,
    async step(next?: SessionSummary[]) {
      if (next) list = next;
      feed.nudge(0);
      await new Promise((r) => setTimeout(r, 5));
      await feed.idle();
    },
  };
}
const settle = async (feed: InstanceType<typeof SessionFeed>) => {
  await new Promise((r) => setTimeout(r, 5));
  await feed.idle();
};
/** A socket's frames with the run's own epoch taken out, so two feeds' frames compare as JSON. */
const scrub = (ms: SessionFeedMessage[]) => ms.map((m) => JSON.stringify({ ...m, ...("epoch" in m ? { epoch: "E" } : {}) }));

async function script(withLabels: boolean, labelSocket: boolean) {
  const h = harness([row("a"), row("b")], withLabels, 20);
  const old: SessionFeedMessage[] = [];
  const rows: SessionFeedMessage[] = [];
  h.feed.add((m) => old.push(m));
  h.feed.add((m) => rows.push(m), { rows: true });
  if (labelSocket) h.feed.add(() => {}, { rows: true, labels: L.parseLabelPairs("alpha:owner") });
  await settle(h.feed);
  await h.step([row("a", { title: "A" }), row("b")]);
  await h.step([row("c"), row("a", { title: "A" })]);
  await new Promise((r) => setTimeout(r, 40)); // a safety net: rows_check
  await settle(h.feed);
  h.feed.stop();
  // The safety net's timer fires a varying number of times in the wait: each distinct frame, in first-seen order.
  const distinct = (ms: SessionFeedMessage[]) => [...new Set(scrub(ms))];
  return { old: distinct(old), rows: distinct(rows) };
}

describe("inert when no socket names labels, or no label is stored", () => {
  test("a plain socket's frames are byte-identical with the labels option, and with a label socket over an empty store", async () => {
    const before = await script(false, false);
    assert.ok(before.rows.some((f) => f.includes('"rows_check"')), "the script reaches a safety net");
    assert.deepEqual(await script(true, false), before);
    assert.deepEqual(await script(true, true), before);
  });
});

describe("a label socket", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => row(`r${String(i).padStart(4, "0")}`));

  test("joining a fresh feed over more labelled rows than a frame holds: no list_changed, no rows, after its join", async () => {
    const list = big(300);
    for (const r of list) L.setLabels(r.id, r.path, "alpha", { owner: "kim" });
    const h = harness(list, true);
    const lab: SessionFeedMessage[] = [];
    h.feed.add((m) => lab.push(m), { rows: true, labels: L.parseLabelPairs("alpha:owner") });
    await settle(h.feed);
    await h.step();
    await h.step();
    h.feed.stop();
    assert.deepEqual(lab.map((m) => m.type), ["rows_hello", "marks"]);
  });

  test("a union that grows: the sockets already there get no row they hold, and no list_changed", async () => {
    const list = big(300);
    for (const r of list) {
      L.setLabels(r.id, r.path, "alpha", { owner: "kim" });
      L.setLabels(r.id, r.path, "beta", { owner: "lee" });
    }
    const h = harness(list, true);
    const plain: SessionFeedMessage[] = [];
    const alpha: SessionFeedMessage[] = [];
    const beta: SessionFeedMessage[] = [];
    h.feed.add((m) => plain.push(m), { rows: true });
    h.feed.add((m) => alpha.push(m), { rows: true, labels: L.parseLabelPairs("alpha:owner") });
    await settle(h.feed);
    h.feed.add((m) => beta.push(m), { rows: true, labels: L.parseLabelPairs("beta:owner") });
    await settle(h.feed);
    await h.step();
    h.feed.stop();
    assert.deepEqual(beta.map((m) => m.type), ["rows_hello", "marks"]);
    for (const [name, ms] of [["plain", plain], ["alpha", alpha]] as const) {
      assert.ok(!ms.some((m) => m.type === "list_changed"), name);
      for (const m of ms) if (m.type === "rows") assert.deepEqual([m.upsert, m.remove], [[], []], name);
    }
    // The version the newcomer starts at is the one the others are at.
    const at = (ms: SessionFeedMessage[]) => {
      const r = ms.filter((m) => m.type === "rows").at(-1) as Extract<SessionFeedMessage, { type: "rows" }> | undefined;
      return r?.to ?? (ms[0] as Extract<SessionFeedMessage, { type: "rows_hello" }>).version;
    };
    assert.equal(at(plain), (beta[0] as Extract<SessionFeedMessage, { type: "rows_hello" }>).version);
    assert.equal(at(alpha), at(plain));
  });

  test("gets its pairs on its rows; a plain socket the same rows without them; a label write moves only rows", async () => {
    L.setLabels("a", "/s/a.jsonl", "alpha", { owner: "kim", where: "srv" });
    L.setLabels("a", "/s/a.jsonl", "beta", { owner: "zed" });
    const h = harness([row("a"), row("b")], true);
    const old: SessionFeedMessage[] = [];
    const plain: SessionFeedMessage[] = [];
    const lab: SessionFeedMessage[] = [];
    h.feed.add((m) => old.push(m));
    h.feed.add((m) => plain.push(m), { rows: true });
    h.feed.add((m) => lab.push(m), { rows: true, labels: L.parseLabelPairs("alpha:owner") });
    await settle(h.feed);
    const rowsOf = (ms: SessionFeedMessage[]) => ms.filter((m): m is Extract<SessionFeedMessage, { type: "rows" }> => m.type === "rows");
    // Its labels were in the base from its join: nothing follows the list it read for itself.
    assert.deepEqual(lab.map((m) => m.type), ["rows_hello", "marks"]);
    // A label write: the label socket hears it; the plain socket gets the same version with no rows; the old socket no list_changed.
    const oldCount = old.length;
    L.setLabels("a", "/s/a.jsonl", "alpha", { owner: "lee" });
    await h.step();
    const last = rowsOf(lab).at(-1)!;
    assert.deepEqual(last.upsert.map((r) => [r.id, r.labels]), [["a", { alpha: { owner: "lee" } }]]);
    assert.equal(rowsOf(plain).at(-1)!.to, last.to);
    // A label it doesn't read: its version moves, with no row it already holds.
    assert.deepEqual(rowsOf(plain).at(-1)!.upsert, []);
    assert.equal(old.slice(oldCount).some((m) => m.type === "list_changed"), false);
    h.feed.stop();
  });

  test("each socket's rows_check is the digest of its own rows", async () => {
    L.setLabels("a", "/s/a.jsonl", "alpha", { owner: "kim" });
    const h = harness([row("a"), row("b")], true, 20);
    const plain: SessionFeedMessage[] = [];
    const lab: SessionFeedMessage[] = [];
    h.feed.add((m) => plain.push(m), { rows: true });
    h.feed.add((m) => lab.push(m), { rows: true, labels: L.parseLabelPairs("alpha:owner") });
    await settle(h.feed);
    await new Promise((r) => setTimeout(r, 40));
    await settle(h.feed);
    h.feed.stop();
    const check = (ms: SessionFeedMessage[]) => (ms.filter((m) => m.type === "rows_check").at(-1) as Extract<SessionFeedMessage, { type: "rows_check" }>).digest;
    assert.equal(check(plain), rowsDigest([row("a"), row("b")]));
    assert.equal(check(lab), rowsDigest([{ ...row("a"), labels: { alpha: { owner: "kim" } } }, row("b")]));
  });
});
