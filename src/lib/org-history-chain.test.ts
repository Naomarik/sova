import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChainEdge, EventSummary, HistoryChain } from "../../shared/org-history";
import { boundLine, chainSections, mergeChain, type ChainItem, type ChainSections } from "./org-history-chain";

const node = (id: string, hop: number, t: number, headline = id) => ({ id, hop, recordedAt: t, headline }) as EventSummary & { hop: number };
const chain = (over: Partial<HistoryChain>): HistoryChain =>
  ({ root: "r", nodes: [], edges: [], omitted: { before: 0, after: 0 }, frontier: { before: [], after: [] }, cursor: null, noTrigger: [], freshness: { through: null, events: 0, current: true, rebuiltAt: null }, ...over }) as HistoryChain;
const cause = (from: string, to: string, via: ChainEdge["via"] = "effect"): ChainEdge => ({ from, to, via, link: "cause" });
const rel = (from: string, to: string, type: ChainEdge["type"]): ChainEdge => ({ from, to, type, link: "relation" });

/** Every item of a section, depth first, in reading order. */
const walk = (items: ChainItem[]): ChainItem[] => items.flatMap((i) => [i, ...walk(i.children)]);
const all = (s: ChainSections) => [...walk(s.causes), ...walk(s.consequences), ...walk(s.related)];

// The scenario's chain for "Drafts wait in Xero…": one cause (itself untriggered, naming the conflict it
// settled), four relations onto this event, and a trigger between two of them.
const xero = chain({
  nodes: [
    node("opened", -2, 1, "Conflict opened"),
    node("settled", -1, 2, "Conflict settled"),
    node("r", 0, 3, "Drafts wait in Xero"),
    node("sup1", 1, 3, "Decision superseded"),
    node("sup2", 1, 3, "Decision superseded"),
    node("promStart", 1, 5, "Decisions promoted"),
    node("promDone", 1, 6, "Decisions promoted"),
  ],
  edges: [
    rel("sup1", "r", "related"),
    rel("promDone", "r", "adopts"),
    cause("settled", "r"),
    rel("settled", "opened", "named-target"),
    rel("sup2", "r", "related"),
    cause("promStart", "promDone"),
    rel("promStart", "r", "named-target"),
  ],
  noTrigger: ["opened", "settled", "sup1", "sup2", "promStart"],
});

test("causes, consequences and relations are three sections; a relation never sits in a cause section", () => {
  const s = chainSections(xero);
  assert.deepEqual(walk(s.causes).map((i) => i.id), ["settled"]);
  assert.deepEqual(s.consequences, []);
  assert.deepEqual(s.related.map((i) => i.id), ["sup1", "sup2", "promDone", "opened"], "onto this event first, by time; then what links to a cause");
  for (const i of [...walk(s.causes), ...walk(s.consequences)]) assert.equal(i.edge?.link, "cause", `${i.id} is placed by a trigger`);
  // Each returned event once, the root in none of them.
  const ids = all(s).map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ["opened", "promDone", "promStart", "settled", "sup1", "sup2"]);
});

test("each edge is said once, from the card's side, toward this event or the card it hangs from", () => {
  const s = chainSections(xero);
  const [settled] = s.causes;
  assert.deepEqual({ words: settled!.words, arrow: settled!.arrow, causal: settled!.causal }, { words: "triggered this · effect", arrow: "down", causal: true });
  assert.equal(settled!.cap, true, "its own trigger wasn't recorded: said, no line");
  const byId = new Map(walk(s.related).map((i) => [i.id, i]));
  assert.equal(byId.get("promDone")!.words, "adopts this");
  assert.equal(byId.get("promDone")!.arrow, "up");
  assert.equal(byId.get("sup1")!.words, "related to this");
  // A trigger between two related events nests under the one it triggered, on its own solid rail.
  const nested = byId.get("promDone")!.children[0]!;
  assert.equal(nested.id, "promStart");
  assert.deepEqual({ words: nested.words, causal: nested.causal, cap: nested.cap }, { words: "triggered it · effect", causal: true, cap: true });
  // Its second edge, onto this event, is said on the card, not dropped and not drawn twice.
  assert.deepEqual(nested.also.map((a) => a.words), ["also names this as its target"]);
  // A relation of a cause, not of this event: worded toward the event it links to, by name.
  assert.equal(byId.get("opened")!.words, "“Conflict settled” names it as its target");
  assert.equal(byId.get("opened")!.arrow, null);
  assert.equal(byId.get("sup1")!.cap, false, "a relation's own missing trigger isn't this chain's to say");
  // Every returned edge is said exactly once.
  const said = all(s).flatMap((i) => [...(i.edge ? [i.edge] : []), ...i.also.map((a) => a.edge)]);
  assert.equal(said.length, xero.edges.length);
  // No relation is ever worded as a trigger.
  for (const i of all(s)) for (const w of [{ edge: i.edge, words: i.words }, ...i.also]) if (w.edge?.link === "relation") assert.doesNotMatch(w.words ?? "", /trigger/, w.words ?? "");
});

test("an untriggered event says so with no line; consequences read from this event down", () => {
  const s = chainSections(chain({ nodes: [node("r", 0, 1), node("c1", 1, 2), node("c2", 2, 3), node("x", 1, 4)], edges: [cause("r", "c1", "spawn"), cause("c1", "c2", "request"), rel("r", "x", "supersedes")], noTrigger: ["r"] }));
  assert.equal(s.rootCap, true);
  assert.deepEqual(s.causes, []);
  const [c1] = s.consequences;
  assert.deepEqual({ id: c1!.id, words: c1!.words, arrow: c1!.arrow }, { id: "c1", words: "this triggered it · spawned", arrow: "down" });
  assert.deepEqual(c1!.children.map((c) => [c.id, c.words]), [["c2", "the event above triggered it · requested"]]);
  // This event holds the relation: "this supersedes it", toward this event's own words.
  assert.deepEqual(s.related.map((i) => [i.id, i.words, i.arrow]), [["x", "this supersedes it", "down"]]);
});

test("two hops of causes nest, the earlier above; a diamond is placed once and its other edge said on the card", () => {
  const s = chainSections(chain({ nodes: [node("a", -2, 1), node("b", -1, 2), node("c", -1, 3), node("r", 0, 4)], edges: [cause("a", "b"), cause("b", "r", "tool-call"), cause("c", "r", "request"), cause("a", "c", "spawn")], noTrigger: ["a"] }));
  assert.deepEqual(s.causes.map((i) => i.id), ["b", "c"]);
  assert.equal(s.rootCap, false);
  assert.deepEqual(s.causes[0]!.children.map((i) => [i.id, i.words, i.cap]), [["a", "triggered it · effect", true]]);
  assert.equal(s.causes[0]!.cap, false, "b's trigger is recorded");
  assert.deepEqual(s.causes[1]!.also, [], "c is the edge's target: its other end, a, carries it");
  assert.deepEqual(s.causes[0]!.children[0]!.also.map((a) => a.words), ["also triggered “c” · spawned"]);
});

test("an edge to an event not returned is not shown; a duplicate once; nothing linked by time", () => {
  const s = chainSections(chain({ nodes: [node("r", 0, 5), node("p", -1, 1), node("q", 1, 9)], edges: [cause("p", "r"), cause("p", "r"), cause("r", "gone"), rel("q", "r", "supports")] }));
  const said = all(s).flatMap((i) => [...(i.edge ? [i.edge] : []), ...i.also.map((a) => a.edge)]);
  assert.equal(said.length, 2);
  assert.deepEqual(s.related.map((i) => i.words), ["supports this"]);
});

test("the bound in words: how many events, how far, and what was left out", () => {
  assert.equal(boundLine(7, { before: 0, after: 0 }), "7 events within 2 steps · nothing left out");
  assert.equal(boundLine(1, { before: 0, after: 0 }), "1 event within 2 steps · nothing left out");
  assert.equal(boundLine(16, { before: 0, after: 5 }), "16 events within 2 steps · 5 later events not shown");
  assert.equal(boundLine(16, { before: 1, after: 0 }), "16 events within 2 steps · 1 earlier event not shown");
  assert.equal(boundLine(16, { before: 2, after: 3 }), "16 events within 2 steps · 2 earlier and 3 later events not shown");
});

test("Expand merges the next page: nodes by id, edges once, the newer bound's counts", () => {
  const a = chain({ nodes: [node("r", 0, 3), node("p", -1, 2)], edges: [cause("p", "r", "request")], omitted: { before: 5, after: 0 }, cursor: "c1", noTrigger: ["p"] });
  const b = chain({ nodes: [node("p", -1, 2), node("q", -2, 1)], edges: [cause("q", "p", "spawn"), cause("p", "r", "request")], omitted: { before: 0, after: 0 }, cursor: null, noTrigger: ["q"] });
  const m = mergeChain(a, b);
  assert.deepEqual(m.nodes.map((n) => n.id).sort(), ["p", "q", "r"]);
  assert.equal(m.edges.length, 2);
  assert.deepEqual(m.omitted, { before: 0, after: 0 });
  assert.equal(m.cursor, null);
  assert.deepEqual(m.noTrigger, ["p", "q"]);
});

// The gap's chain from the re-run: two hops reach the gathering and its decisions; the next page brings the conflict
// that names a decision, the settle gathering it spawned, and the settle's decision. Merged, they take their place.
test("Expand: the next page's events join the sections by their edges, causal pairs on cause rails, none appended unlinked", () => {
  const page1 = chain({
    root: "gap",
    nodes: [node("gap", 0, 1, "Gap filed"), node("gath", 1, 2, "Gathering started"), node("dec", 2, 3, "Nothing posts on its own")],
    edges: [rel("gath", "gap", "named-target"), rel("dec", "gath", "recorded-in")],
    omitted: { before: 0, after: 3 },
    frontier: { before: [], after: ["dec"] },
    cursor: "c1",
    noTrigger: ["gap", "gath", "dec"],
  });
  const page2 = chain({
    root: "gap",
    nodes: [node("gap", 0, 1, "Gap filed"), node("opened", 3, 4, "Conflict opened"), node("settle", 4, 5, "Gathering started: Settle"), node("settled", 4, 6, "Conflict settled")],
    // the edge back to the frontier event is returned with the page that reaches past it
    edges: [rel("opened", "dec", "named-target"), cause("opened", "settle", "spawn"), rel("settled", "opened", "named-target")],
    omitted: { before: 0, after: 0 },
    frontier: { before: [], after: [] },
    cursor: null,
    noTrigger: ["opened", "settled"],
  });
  const before = chainSections(page1);
  assert.equal(before.expandAt.after, "related", "the bound cut the chain in Related: the button goes there, not under Led to");
  assert.equal(before.expandAt.before, null);
  assert.equal(walk(before.related).find((i) => i.id === "dec")!.cut, "after", "the card past which events weren't shown");
  const s = chainSections(mergeChain(page1, page2));
  assert.deepEqual(s.expandAt, { before: null, after: null });
  const items = new Map(all(s).map((i) => [i.id, i]));
  for (const id of ["opened", "settle", "settled"]) assert.ok(items.get(id)!.edge, `${id} is placed by its edge`);
  assert.equal(items.get("dec")!.cut, null);
  const dec = items.get("dec")!;
  assert.ok(dec.children.some((c) => c.id === "opened"), "the conflict hangs from the decision it names");
  assert.equal(items.get("opened")!.words, "names it as its target");
  const settle = items.get("settle")!;
  assert.deepEqual({ causal: settle.causal, words: settle.words }, { causal: true, words: "the event above triggered it · spawned" }, "a causal pair among them reads as a cause, on its rail");
  assert.deepEqual(s.consequences, [], "nothing triggered by the gap");
});

test("Expand: a consequence beyond two hops joins Led to; the frontier's place says where the button goes", () => {
  const page1 = chain({ nodes: [node("r", 0, 1), node("c1", 1, 2), node("c2", 2, 3)], edges: [cause("r", "c1"), cause("c1", "c2")], omitted: { before: 0, after: 1 }, frontier: { before: [], after: ["c2"] }, cursor: "c" });
  assert.equal(chainSections(page1).expandAt.after, "consequences");
  const page2 = chain({ nodes: [node("r", 0, 1), node("c3", 3, 4)], edges: [cause("c2", "c3", "request")], frontier: { before: [], after: [] } });
  const s = chainSections(mergeChain(page1, page2));
  assert.deepEqual(walk(s.consequences).map((i) => i.id), ["c1", "c2", "c3"]);
  assert.equal(walk(s.consequences).at(-1)!.words, "the event above triggered it · requested");
  // an older answer with no frontier: earlier events above Came from, later ones under Led to
  assert.deepEqual(chainSections({ ...page1, frontier: undefined } as never).expandAt, { before: null, after: "consequences" });
  // the root itself at the bound
  assert.equal(chainSections(chain({ nodes: [node("r", 0, 1)], omitted: { before: 2, after: 0 }, frontier: { before: ["r"], after: [] }, cursor: "c" })).expandAt.before, "causes");
});
