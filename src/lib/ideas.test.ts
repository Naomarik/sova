// Run: npx tsx --test src/lib/ideas.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDEA_STATUSES, type IdeaStatus, type IdeasToc } from "../../shared/protocol";
import { canonicalId, countsLine, exploreMessage, IDEA_STATUS_CHIP, parseTags, startMessage, tocGroups } from "./ideas";

const counts = (c: Partial<Record<IdeaStatus, number>>): Record<IdeaStatus, number> => ({ open: 0, exploring: 0, started: 0, done: 0, dropped: 0, ...c });

const toc: IdeasToc = {
  total: 6,
  namespaces: [
    {
      ns: "mesh",
      counts: counts({ open: 1, exploring: 1, done: 1 }),
      entries: [
        { id: "§mesh/retry-backoff", title: "Retry with backoff", status: "done" },
        { id: "§mesh.retry-backoff/jitter", title: "Add jitter", status: "exploring", parent: "§mesh/retry-backoff" },
        { id: "§mesh/health", title: "Health probes", status: "open" },
      ],
    },
    { ns: "old", counts: counts({ dropped: 1 }), entries: [{ id: "§old/thing", title: "An old thing", status: "dropped" }] },
    {
      ns: "sova",
      counts: counts({ open: 1, started: 1 }),
      entries: [
        { id: "§sova/ideas-panel", title: "Ideas panel", status: "started" },
        { id: "§sova/graph", title: "Link graph", status: "open" },
      ],
    },
  ],
};

test("every status has a chip with a word; no two statuses share a word", () => {
  const words = IDEA_STATUSES.map((s) => IDEA_STATUS_CHIP[s].label);
  assert.ok(words.every((w) => w.length > 0));
  assert.equal(new Set(words).size, IDEA_STATUSES.length);
});

test("settled ideas leave the ToC unless asked; a sub-entry stays, indented, when its parent goes", () => {
  const g = tocGroups(toc, { showSettled: false });
  assert.deepEqual(
    g.map((x) => [x.ns, x.rows.map((r) => `${r.depth}:${r.name}`), x.hidden]),
    [
      ["mesh", ["1:jitter", "0:health"], 1],
      ["old", [], 1],
      ["sova", ["0:ideas-panel", "0:graph"], 0],
    ],
  );
  const all = tocGroups(toc, { showSettled: true });
  assert.deepEqual(
    all.map((x) => x.rows.length),
    [3, 1, 2],
  );
  assert.ok(all.every((x) => x.hidden === 0));
});

test("a query keeps matching ids or titles, any case, and drops namespaces with nothing left", () => {
  assert.deepEqual(
    tocGroups(toc, { showSettled: true, query: "GRAPH" }).map((x) => [x.ns, x.rows.map((r) => r.id)]),
    [["sova", ["§sova/graph"]]],
  );
  assert.deepEqual(
    tocGroups(toc, { showSettled: true, query: "jitter" }).map((x) => x.rows.map((r) => r.id)),
    [["§mesh.retry-backoff/jitter"]],
  );
  assert.deepEqual(tocGroups(toc, { showSettled: false, query: "old thing" }), [], "a settled-only match is not shown as an empty group");
});

test("the counts line: most active first, zeros left out, settled only when shown", () => {
  const c = counts({ open: 2, exploring: 1, done: 3 });
  assert.equal(countsLine(c, false), "1 exploring · 2 open");
  assert.equal(countsLine(c, true), "1 exploring · 2 open · 3 done");
  assert.equal(countsLine(counts({}), true), "");
});

test("explore launches for an idea with no explorer, and asks the linked one otherwise", () => {
  const launch = exploreMessage({ id: "§mesh/health" });
  assert.match(launch, /§mesh\/health/);
  assert.match(launch, /launch/i);
  const ask = exploreMessage({ id: "§mesh/health", explorerId: "ag_03" });
  assert.match(ask, /§mesh\/health/);
  assert.doesNotMatch(ask, /launch/i, "never a second explorer for the same idea");
  assert.match(startMessage({ id: "§sova/graph" }), /session.*§sova\/graph/);
});

test("ids and tags as typed", () => {
  assert.equal(canonicalId("mesh/health"), "§mesh/health");
  assert.equal(canonicalId("§mesh/health"), "§mesh/health");
  assert.deepEqual(parseTags(" UX, #perf  ux\nnet,"), ["ux", "perf", "net"]);
  assert.deepEqual(parseTags(""), []);
});
