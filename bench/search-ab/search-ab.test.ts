// Run: pnpm test -- bench/search-ab/search-ab.test.ts. The search A/B harness (bench/search-ab/plan.md)
// on synthetic sessions only: throwaway files under a scratch root; no real session is read.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { scratchRoot } from "../../server/test-scratch";
import { changesOf, checkOne, falseRows, gradeLoop, NEAR_T_MS, type PoolItem } from "./bench";
import { bestWindow, buildIndex, compoundsOf, DEFAULTS, type Doc, queryTerms, search, tokens } from "./bm25f";
import { privateDir, ROOT, splitOf } from "./common";
import { asOf, type ListingRow, loadCorpus, readSession, truncatedCopy } from "./corpus";
import { stem } from "./topic";
import { agreement, indexOf, median3, medianGrades, packets, pairsOf, relevantMessages, trimAround, validateJudge } from "./judge";
import { runIncumbent, scopeAsOf } from "./incumbent";
import { falseAnswerRate, firstRank, gradedScores, percentile, pickHeldoutRow, pickZeroFalseRow, pool, summarize } from "./metrics";
import { distinctive, mineLog, rng, shuffle } from "./mine";

const root = scratchRoot("search-ab-");
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2030-01-10T00:00:00.000Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const header = (id: string, at: number, cwd = "/w/proj") => JSON.stringify({ type: "session", version: 3, id, timestamp: iso(at), cwd });
const msg = (role: "user" | "assistant", text: string, at: number) =>
  JSON.stringify({ type: "message", id: Math.random().toString(16).slice(2, 10), parentId: null, timestamp: iso(at), message: { role, content: [{ type: "text", text }], timestamp: at } });
const tool = (text: string, at: number) =>
  JSON.stringify({ type: "message", id: "t", parentId: null, timestamp: iso(at), message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text }] } });

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A session file under the scratch copy, its mtime its last line's time. */
function session(n: number, lines: [string, number][], extra: Partial<ListingRow> = {}): ListingRow {
  const dir = join(root, "agent", "sessions", "--w-proj--");
  mkdirSync(dir, { recursive: true });
  const name = `2030-01-01T00-00-00-000Z_${ID(n)}.jsonl`;
  const born = lines[0]![1];
  writeFileSync(join(dir, name), [header(ID(n), born), ...lines.map(([l]) => l)].join("\n") + "\n");
  const last = lines[lines.length - 1]![1];
  utimesSync(join(dir, name), new Date(last), new Date(last));
  return {
    id: ID(n), rel: `sessions/--w-proj--/${name}`, listed: true, cwd: "/w/proj", project: null, createdAt: iso(born), lastActiveAt: iso(last),
    title: null, originalTitle: null, outlineGist: null, outlineNow: null, outlineTopics: null, outlineAt: null, archived: false, skipped: null, ...extra,
  };
}

describe("tokens", () => {
  test("a branch-like name stays one term beside its parts (topic.mjs's own stems)", () => {
    const ts = tokens("see fix-widget-sort-flake now");
    assert.ok(ts.includes("fix-widget-sort-flake"));
    for (const w of ["widget", "sort", "flake"]) assert.ok(ts.includes(stem(w)), w);
    assert.deepEqual(compoundsOf("a snake_case_name and plain"), ["snake_case_name"]);
  });
  test("a query counts coverage over its words; the joined compound only adds score", () => {
    const q = queryTerms("fix-widget-sort-flake");
    assert.deepEqual([...q.base.keys()], ["fix", "widget", "sort", "flake"].map(stem));
    assert.deepEqual(q.joined, ["fix-widget-sort-flake"]);
  });
});

describe("bm25f", () => {
  const doc = (id: string, title: string, msgs: [string, number][], summary = "", summaryAt = 0): Doc => ({
    id, title, summary, summaryAt, messages: msgs.map(([text, at], i) => ({ who: i % 2 ? "assistant" : "user", lineAt: at, text })),
  });
  const docs = [
    doc("a", "Durian pricing", [["the durian pricing page", T0], ["done", T0 + 1]]),
    doc("b", "Mango sorbet", [["durian appears once here", T0], ["sorbet recipe", T0 + 1]]),
    doc("c", "Kiwi crate", [["kiwi only", T0]]),
    doc("d", "Later work", [["durian pricing came later", T0 + 10 * H]]),
    doc("e", "Old", [["nothing"]].map(([t]) => [t!, T0]) as [string, number][], "durian pricing summary", T0 + 10 * H),
  ];
  const ix = buildIndex(docs);
  const scope = ["d", "c", "b", "a", "e"];

  test("every-word sessions rank above partial ones; below minCoverage nothing shows", () => {
    const hits = search(ix, scope, "durian pricing", T0 + 20 * H);
    assert.deepEqual(hits.slice(0, 3).map((h) => h.id).sort(), ["a", "d", "e"]);
    assert.equal(hits[3]?.id, "b");
    assert.equal(hits[3]?.coverage, 0.5);
    assert.deepEqual(search(ix, scope, "durian pricing", T0 + 20 * H, { ...DEFAULTS, minCoverage: 1 }).map((h) => h.id).includes("b"), false);
    assert.deepEqual(search(ix, scope, "zebra", T0 + 20 * H), []);
  });

  test("as of a time: later messages and a later summary do not count", () => {
    const hits = search(ix, scope, "durian pricing", T0 + H);
    assert.equal(hits[0]?.id, "a");
    assert.equal(hits.some((h) => h.id === "d" || h.id === "e"), false);
  });

  test("only the scope is searched; snippets are the top-scoring messages, around a query word", () => {
    const hits = search(ix, ["b"], "durian pricing", T0 + 20 * H);
    assert.deepEqual(hits.map((h) => h.id), ["b"]);
    assert.equal(hits[0]!.snippets.length, 1);
    assert.match(hits[0]!.snippets[0]!.text, /durian/);
  });

  // The no-answer cases: words whose stems meet in a session that never holds them as written, or
  // that sit far apart in it.
  const odd = buildIndex([
    doc("stems", "Parser", [["the cook pickles rows", T0], ["then slicing them", T0 + 1]]),
    doc("exact", "Parser", [["it pickle rows", T0], ["rows sliced", T0 + 1]]),
    doc("apart", "Notes", [["pickle here", T0], ["alpha", T0 + 1], ["beta", T0 + 2], ["gamma", T0 + 3], ["sliced there", T0 + 4]]),
    doc("titled", "Pickle sliced", [["nothing else", T0]]),
  ]);
  const oddScope = ["stems", "exact", "apart", "titled"];
  const ids = (c: Partial<typeof DEFAULTS>) => search(odd, oddScope, "pickle sliced", T0 + H, { ...DEFAULTS, minCoverage: 1, ...c }).map((h) => h.id).sort();

  test("surface coverage: a word counts only as written, whole, in a title, summary or message", () => {
    assert.deepEqual(ids({}), ["apart", "exact", "stems", "titled"]);
    assert.deepEqual(ids({ coverageOn: "surface" }), ["apart", "exact", "titled"]);
    // Below minCoverage 1 the stem-only session still shows, its coverage counted on surface words.
    const partial = search(odd, oddScope, "pickle sliced", T0 + H, { ...DEFAULTS, coverageOn: "surface", minCoverage: 0 }).find((h) => h.id === "stems");
    assert.equal(partial?.coverage, 0);
  });

  test("a window: every word within k adjacent messages; title and summary do not count", () => {
    assert.deepEqual(ids({ window: 1 }), []);
    assert.deepEqual(ids({ window: 2 }), ["exact", "stems"]);
    assert.deepEqual(ids({ window: 2, coverageOn: "surface" }), ["exact"]);
    assert.deepEqual(ids({ window: 5 }), ["apart", "exact", "stems"]);
    assert.equal(bestWindow([[0, 0], [4, 1]], 4, 2), 1);
    assert.equal(bestWindow([[0, 0], [4, 1]], 5, 2), 2);
    assert.equal(bestWindow([[3, 0], [3, 1], [9, 0]], 1, 2), 2);
    assert.equal(bestWindow([], 3, 2), 0);
  });

  test("score floors: relative to the best hit, or absolute", () => {
    const all = search(odd, oddScope, "pickle sliced", T0 + H, { ...DEFAULTS, minCoverage: 1 });
    const best = all[0]!.score;
    assert.deepEqual(search(odd, oddScope, "pickle sliced", T0 + H, { ...DEFAULTS, minCoverage: 1, floorRel: 1 }).map((h) => h.score), all.filter((h) => h.score >= best).map((h) => h.score));
    assert.deepEqual(search(odd, oddScope, "pickle sliced", T0 + H, { ...DEFAULTS, floorAbs: best + 1 }), []);
    assert.equal(search(odd, oddScope, "pickle sliced", T0 + H, { ...DEFAULTS, minCoverage: 1, floorAbs: 1e-9 }).length, all.length);
  });
});

describe("corpus and the incumbent replay", () => {
  const rows = [
    session(1, [[msg("user", "durian pricing please", T0), T0], [tool("durian pricing tool output", T0 + 1), T0 + 1], [msg("assistant", "on it", T0 + 2), T0 + 2]]),
    session(2, [[msg("user", "durian", T0 + H), T0 + H], [msg("assistant", "pricing durian answered later", T0 + 5 * H), T0 + 5 * H]]),
    session(3, [[msg("user", "durian pricing from a worker", T0 + 2 * H), T0 + 2 * H]], { skipped: "worker" }),
    session(4, [[msg("user", "durian pricing long ago", T0 - 40 * 24 * H), T0 - 40 * 24 * H]]),
  ];
  const copy = join(root, "agent");
  const corpus = loadCorpus(copy, rows);

  test("readSession keeps user and assistant text only, with each line's time", () => {
    const s = readSession(join(copy, rows[0]!.rel));
    assert.deepEqual(s.messages.map((m) => [m.who, m.text]), [["user", "durian pricing please"], ["assistant", "on it"]]);
    assert.equal(s.lineAt.length, 4);
  });

  test("asOf: absent before its first line, cut after its last line by then", () => {
    const s = corpus[1]!;
    assert.equal(asOf(s, T0).present, false);
    const mid = asOf(s, T0 + 2 * H);
    assert.equal(mid.present, true);
    assert.ok(mid.bytes < s.size);
    assert.equal(mid.activeAt, T0 + H);
    assert.equal(asOf(s, T0 + 9 * H).bytes, s.size);
  });

  test("truncatedCopy: the first bytes, in a file of its own; the whole file is the file itself", () => {
    const s = corpus[1]!;
    const { bytes } = asOf(s, T0 + 2 * H);
    const p = truncatedCopy(s.path, s.size, bytes, join(root, "asof"));
    assert.notEqual(p, s.path);
    assert.equal(statSync(p).size, bytes);
    assert.equal(statSync(s.path).size, s.size);
    assert.equal(truncatedCopy(s.path, s.size, s.size, join(root, "asof")), s.path);
  });

  test("the imported incumbent over the scope as of a time: window, skipped sessions, newest first", async () => {
    const at = T0 + 2 * H + 1;
    const { rows: scope } = scopeAsOf(corpus, at, { projects: [] });
    assert.deepEqual(scope.map((r) => r.s.id), [ID(2), ID(1)]);
    const r = await runIncumbent(scope, "durian pricing", { limitMs: Infinity, asofDir: join(root, "asof") });
    assert.deepEqual(r.hits.map((h) => h.id), [ID(1)]); // session 2's matching reply came later; tool output never matches
    const later = await runIncumbent(scopeAsOf(corpus, T0 + 6 * H, { projects: [] }).rows, "durian pricing", { limitMs: Infinity, asofDir: join(root, "asof") });
    assert.deepEqual(later.hits.map((h) => h.id), [ID(2), ID(1)]);
    assert.deepEqual(scopeAsOf(corpus, at, { projects: [], allTime: true }).rows.map((r) => r.s.id), [ID(2), ID(1), ID(4)]);
  });
});

describe("the instrument check's verdict", () => {
  const logged = (hits: string[], stoppedShort = false) => ({ hits, total: 9, searched: 9, stoppedShort });
  const replay = (ids: string[]) => ({ hits: ids.map((id) => ({ id })), total: 9 });
  test("exact, and a prefix only when the logged call stopped short", () => {
    assert.equal(checkOne(logged(["a", "b"]), replay(["a", "b"])).hitsMatch, true);
    assert.equal(checkOne(logged(["b", "a"]), replay(["a", "b"])).hitsMatch, false);
    assert.equal(checkOne(logged(["a"], true), replay(["a", "b"])).hitsMatch, true);
    assert.equal(checkOne(logged(["a"]), replay(["a", "b"])).hitsMatch, false);
  });
  test("near the query time: equal once those sessions are set aside, never otherwise", () => {
    assert.equal(checkOne(logged(["b", "a"]), replay(["a", "b"]), new Set(["a"])).nearT, true);
    assert.equal(checkOne(logged(["b", "a"]), replay(["a", "b"]), new Set(["z"])).nearT, false);
    // the replay reached its cap with a near session in it: what is left is a prefix of the logged list
    assert.equal(checkOne(logged(["a", "b", "c"]), replay(["n", "a", "b"]), new Set(["n"]), 3).nearT, true);
    assert.ok(NEAR_T_MS > 0);
  });
});

describe("mining the Overseer's logs", () => {
  const call = (name: string, args: object, at: number, id = "c1") =>
    JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
  const result = (id: string, details: object, at: number) =>
    JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "toolResult", toolCallId: id, toolName: "sova_search_sessions", content: [], details, isError: false } });
  const said = (text: string, at: number) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "assistant", content: [{ type: "text", text }] } });
  const user = (text: string, at: number) => JSON.stringify({ type: "message", timestamp: iso(at), message: { role: "user", content: [{ type: "text", text }] } });
  const known = new Set([ID(1), ID(2), ID(3)]);
  const resolve = (r: string) => (known.has(r) ? r : null);

  test("a search, its logged result, what was opened or linked next; a user message ends the hunt", () => {
    const lines = [
      user("find the durian work", T0),
      call("sova_search_sessions", { words: "durian", since: "30d" }, T0 + 1),
      result("c1", { searched: 3, total: 3, hits: [ID(1)], stoppedShort: false }, T0 + 2),
      call("sova_session", { session: ID(1) }, T0 + 3, "c2"),
      said(`It is [this](sova://s/${ID(2)}).`, T0 + 4),
      user("thanks", T0 + 5),
      call("sova_session", { session: ID(3) }, T0 + 6, "c3"),
      call("sova_list_sessions", { query: "kiwi" }, T0 + 7, "c4"),
      call("sova_read_session", { session: "not-a-session" }, T0 + 8, "c5"),
      call("sova_search_sessions", { words: "durian", cursor: "x" }, T0 + 9, "c6"),
    ];
    const out = mineLog(lines, resolve);
    assert.equal(out.queries.length, 2);
    assert.deepEqual(out.queries[0], { set: "mined-search", words: "durian", at: T0 + 1, labels: [ID(1), ID(2)], since: "30d", ask: "find the durian work" });
    assert.deepEqual(out.queries[1]!.labels, []);
    assert.equal(out.queries[1]!.set, "mined-list");
    assert.equal(out.logged.length, 2);
    assert.deepEqual(out.logged[0]!.details, { searched: 3, total: 3, hits: [ID(1)], stoppedShort: false });
    assert.equal(out.logged[1]!.cursor, "x");
  });

  test("seeded and stable: the same draw every run; distinctive words by rarity within a band", () => {
    assert.deepEqual(shuffle([1, 2, 3, 4, 5], rng(7)), shuffle([1, 2, 3, 4, 5], rng(7)));
    const df = new Map([["durian", 2], ["pricing", 5], ["the", 50], ["page", 1]]);
    assert.deepEqual(distinctive("The durian pricing page", df, 2, 10, 3), ["durian", "pricing"]);
    assert.equal(splitOf("x"), splitOf("x"));
  });
});

describe("metrics", () => {
  test("first rank, Recall@3, MRR, false answers, percentiles", () => {
    assert.equal(firstRank(["a", "b", "c"], ["c", "z"]), 3);
    assert.equal(firstRank(["a"], ["z"]), 0);
    assert.deepEqual(summarize([1, 4, 0, 2]), { n: 4, recall3: 0.5, mrr: (1 + 0.25 + 0.5) / 4 });
    assert.deepEqual(falseAnswerRate([0, 3, 0, 0]), { n: 4, rate: 0.25 });
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  });
  test("the pool is each system's top k, once each, in a shuffled order", () => {
    const p = pool([["a", "b", "c"], ["c", "d"]], 2, (xs) => [...xs].reverse());
    assert.deepEqual(p, ["d", "c", "b", "a"]);
  });
  test("graded scores: grade 2 is the hit; nDCG@5 against the ideal order", () => {
    const g = { a: 0, b: 2, c: 1 };
    const s = gradedScores(["a", "b", "c"], g);
    assert.equal(s.rank2, 2);
    assert.ok(s.ndcg5 > 0 && s.ndcg5 < 1);
    assert.equal(gradedScores(["b", "c", "a"], g).ndcg5, 1);
  });
  test("held-out takes a sweep row only for an MRR gain of 0.02 with no more false answers", () => {
    const base = { mrr: 0.5, falseRate: 0.2 };
    assert.equal(pickHeldoutRow(base, [{ mrr: 0.51, falseRate: 0.1 }]), null);
    assert.equal(pickHeldoutRow(base, [{ mrr: 0.6, falseRate: 0.3 }]), null);
    assert.deepEqual(pickHeldoutRow(base, [{ mrr: 0.53, falseRate: 0.2 }, { mrr: 0.55, falseRate: 0.1 }]), { mrr: 0.55, falseRate: 0.1 });
  });
  test("amendment 4: zero false answers, then the most Recall@3, then MRR, then fewer changes", () => {
    const r = (name: string, recall3: number, mrr: number, falseRate: number, changes: number) => ({ name, recall3, mrr, falseRate, changes });
    assert.equal(pickZeroFalseRow([r("a", 0.9, 0.9, 0.01, 1)]), null);
    assert.equal(pickZeroFalseRow([r("a", 0.5, 0.9, 0, 1), r("b", 0.6, 0.1, 0, 3)])?.name, "b");
    assert.equal(pickZeroFalseRow([r("a", 0.6, 0.5, 0, 1), r("b", 0.6, 0.6, 0, 3)])?.name, "b");
    assert.equal(pickZeroFalseRow([r("a", 0.6, 0.6, 0, 3), r("b", 0.6, 0.6, 0, 2), r("c", 0.6, 0.6, 0, 2)])?.name, "b");
  });
  test("a row's changes are the constants it moves from the starting ones; row names are unique", () => {
    assert.equal(changesOf(DEFAULTS), 0);
    assert.equal(changesOf({ ...DEFAULTS, minCoverage: 1, coverageOn: "surface" }), 2);
    assert.equal(changesOf({ ...DEFAULTS, weights: { ...DEFAULTS.weights, title: 1 } }), 1);
    const names = falseRows().map((x) => x.name);
    assert.equal(new Set(names).size, names.length);
    for (const x of falseRows()) assert.equal(changesOf(x.c), x.name.split(" + ").length, x.name);
  });
});

describe("grading", () => {
  const items: PoolItem[] = [
    { qid: "q1", words: "durian", sessions: [{ id: "s1", view: "  title: one" }, { id: "s2", view: "  title: two" }] },
    { qid: "q2", words: "kiwi", ask: "where is the kiwi crate", sessions: [{ id: "s3", view: "  title: three" }] },
  ];
  const feed = (xs: string[]) => xs[Symbol.iterator]() as unknown as AsyncIterator<string>;
  const asyncFeed = (xs: string[]): AsyncIterator<string> => {
    const it = feed(xs) as unknown as Iterator<string>;
    return { next: async () => it.next() };
  };

  test("grades save as they come, nonsense is asked again, and a quit resumes where it stopped", async () => {
    const path = join(root, "grades.json");
    const out: string[] = [];
    const first = await gradeLoop(items, path, asyncFeed(["2", "x", "s", "q"]), (s) => out.push(s));
    assert.deepEqual(first, { graded: 1, total: 3, quit: true });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).grades, { q1: { s1: 2 } });
    assert.ok(out.some((l) => l.includes("Search 1 of 2")));
    const second = await gradeLoop(items, path, asyncFeed(["0", "1"]), (s) => out.push(s));
    assert.deepEqual(second, { graded: 3, total: 3, quit: false });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).grades, { q1: { s1: 2, s2: 0 }, q2: { s3: 1 } });
    assert.ok(out.some((l) => l.includes("where is the kiwi crate")));
  });
});

describe("model judges (amendment 5)", () => {
  const items = [
    { qid: "q1", sessions: [{ id: "s1" }, { id: "s2" }] },
    { qid: "q2", sessions: [{ id: "s3" }] },
  ];
  const pairs = pairsOf(items);
  const A = { q1: { s1: 2, s2: 0 }, q2: { s3: 1 } };
  const B = { q1: { s1: 2, s2: 2 }, q2: { s3: 1 } };
  const C = { q1: { s1: 1, s2: 1 }, q2: { s3: 1 } };

  test("a complete answer passes; a gap, a bad value or a stranger is each named", () => {
    assert.deepEqual(validateJudge("A", A, pairs), []);
    const errs = validateJudge("X", { q1: { s1: 3, s9: 0 }, q7: {} }, pairs);
    assert.equal(errs.length, 5, errs.join("\n"));
    for (const bit of ["s1 is graded 3", "s2 is not graded", "s9 is not in the pool", "query q2 has no grades", "query q7 is not in the pool"]) assert.ok(errs.some((e) => e.includes(bit)), bit);
    assert.ok(validateJudge("X", { q1: { s1: "2", s2: 1.5 }, q2: { s3: null } }, pairs).length === 3);
    assert.equal(validateJudge("X", [], pairs).length, 1);
  });

  test("the grade is the per-pair median, whatever order the judges come in", () => {
    assert.equal(median3(2, 0, 1), 1);
    assert.equal(median3(0, 2, 2), 2);
    const m = medianGrades(pairs, [A, B, C]);
    assert.deepEqual(m, { q1: { s1: 2, s2: 1 }, q2: { s3: 1 } });
    assert.deepEqual(medianGrades(pairs, [C, A, B]), m);
  });

  test("agreement: pairwise, all three, Fleiss' kappa and the 0-to-2 spreads", () => {
    const ag = agreement(pairs, ["A", "B", "C"], [A, B, C], medianGrades(pairs, [A, B, C]));
    assert.deepEqual(ag.pairwise, { "A~B": 2 / 3, "A~C": 1 / 3, "B~C": 1 / 3 });
    assert.equal(ag.allThree, 1 / 3);
    assert.equal(ag.spread0to2, 1);
    assert.deepEqual(ag.distribution.median, [0, 2, 1]);
    // by hand: P_i = 1/3, 0, 1 → P̄ = 4/9; p = (1/9, 5/9, 3/9) → Pe = 35/81
    assert.ok(Math.abs(ag.fleissKappa! - (4 / 9 - 35 / 81) / (1 - 35 / 81)) < 1e-12);
    const same = agreement(pairs, ["A", "B", "C"], [A, A, A], A);
    assert.equal(same.allThree, 1);
    assert.equal(same.spread0to2, 0);
    assert.equal(agreement(pairs, ["A", "B", "C"], [C, C, C], C).fleissKappa, null);
  });

  test("packets: blind, in the pool's order, quotes cut at the search time, split by whole searches", () => {
    const msgs = [
      { who: "user" as const, lineAt: 1, text: "open the durian crate" },
      { who: "assistant" as const, lineAt: 2, text: "x ".repeat(500) + "durian kiwi here" },
      { who: "user" as const, lineAt: 3, text: "nothing relevant" },
      { who: "assistant" as const, lineAt: 9, text: "durian kiwi later" },
    ];
    const quotes = relevantMessages(msgs, "Durian kiwi", 5, 5, msgs[0]);
    assert.deepEqual(quotes, [msgs[1]]);
    assert.ok(trimAround(msgs[1]!.text, ["durian"], 400).includes("durian kiwi here"));
    assert.ok(trimAround(msgs[1]!.text, ["durian"], 400).length <= 402);
    const sess = (id: string) => ({ id, title: `t ${id}`, folder: "proj", lastActive: 0, summary: null, firstPrompt: "open", quotes, path: `/copy/${id}.jsonl` });
    const qs = [
      { qid: "q1", words: "durian kiwi", at: 5, sessions: [sess("s2"), sess("s1")] },
      { qid: "q2", words: "fig", at: 5, ask: "where is the fig", sessions: [sess("s3")] },
    ];
    const one = packets(qs, 1e9);
    assert.equal(one.length, 1);
    const body = one[0]!.body;
    assert.ok(body.indexOf("`s2`") < body.indexOf("`s1`"));
    assert.ok(!/bm25|incumbent|system [ab]\b/i.test(body));
    assert.ok(body.includes("**2**") && body.includes("where is the fig") && body.includes("/copy/s1.jsonl"));
    assert.ok(!body.includes("later"));
    const two = packets(qs, 10);
    assert.deepEqual(two.map((p) => p.qids), [["q1"], ["q2"]]);
    assert.deepEqual(two.map((p) => p.file), ["packet-01-of-02.md", "packet-02-of-02.md"]);
    const ix = indexOf(two, qs);
    assert.ok(ix.includes("2 packets, 2 searches, 3 sessions"));
    assert.deepEqual(Object.keys(JSON.parse(ix.split("```json\n")[1]!.split("\n```")[0]!)), ["q1", "q2"]);
  });
});

describe("where private data may go", () => {
  test("never the repo's tracked tree; its gitignored .cache is allowed", () => {
    assert.throws(() => privateDir(["--private", join(ROOT, "bench", "x")]));
    assert.equal(privateDir(["--private", join(ROOT, ".cache", "x")]), join(ROOT, ".cache", "x"));
  });
});
