// bench: the A/B over the frozen copy (plan.md, The harness).
//
//   bun bench/search-ab/bench.ts [--copy <agent dir>] [--private <dir>]      instrument check, dev, sweep
//   bun bench/search-ab/bench.ts --label [--private <dir>]                  grade the held-out pool
//   bun bench/search-ab/bench.ts --heldout                                  held-out scoring (needs grades)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SEARCH_LIMIT_MS, snippetOf } from "../../server/overseer-roundup";
import { buildIndex, type Constants, DEFAULTS, type Doc, type Index, search } from "./bm25f";
import { copyDir, opt, privateDir, readJson, sha256, writeJson } from "./common";
import { type ListingRow, loadCorpus, type Session } from "./corpus";
import { type IncumbentRun, type Project, runIncumbent, scopeAsOf } from "./incumbent";
import { falseAnswerRate, firstRank, gradedScores, percentile, pickHeldoutRow, pickZeroFalseRow, pool, summarize } from "./metrics";
import { type LoggedSearch, type Query, rng, shuffle } from "./mine";

const args = process.argv.slice(2);
const COPY = copyDir(args);
const PRIV = privateDir(args);
/** Where the dev run writes its private outputs (instrument check, per-query runs, held-out
    constants): `--out`, else the private folder. For a private folder that is read-only. */
const OUT = opt(args, "out") ? privateDir(["--private", opt(args, "out")!]) : PRIV;
const ASOF = join(COPY, "..", "asof");

export interface CheckRow {
  i: number;
  words: string;
  logged: NonNullable<LoggedSearch["details"]>;
  replay: Pick<IncumbentRun, "hits" | "searched" | "total" | "stoppedShort">;
  hitsMatch: boolean;
  totalMatch: boolean;
  /** Not exact, but equal once the sessions active within NEAR_T_MS of the query are set aside. */
  nearT: boolean;
}

/** plan.md amendment 1: a session active this close to the query time may have had its last lines
    unwritten, or its mtime a moment off, when the Overseer searched; the copy cannot tell. */
export const NEAR_T_MS = 10 * 60_000;

/** The instrument check's verdict on one call: the replay's hits are the logged ones in order (a
    prefix of them, when the logged call was stopped short and so searched fewer sessions). */
export function checkOne(
  logged: NonNullable<LoggedSearch["details"]>,
  replay: { hits: { id: string }[]; total: number },
  near: ReadonlySet<string> = new Set(),
  cap = 20,
): { hitsMatch: boolean; totalMatch: boolean; nearT: boolean } {
  const same = (a: readonly string[], b: readonly string[], prefix: boolean) => (prefix ? a.every((id, k) => b[k] === id) : a.length === b.length && a.every((id, k) => b[k] === id));
  const mine = replay.hits.map((h) => h.id);
  const hitsMatch = same(logged.hits, mine, logged.stoppedShort);
  let nearT = false;
  if (!hitsMatch) {
    const a = logged.hits.filter((id) => !near.has(id));
    const b = mine.filter((id) => !near.has(id));
    // A side that hit the cap may have had its last places taken by a session set aside.
    nearT = mine.length >= cap ? same(b, a, true) : logged.hits.length >= cap || logged.stoppedShort ? same(a, b, true) : same(a, b, false);
  }
  return { hitsMatch, totalMatch: logged.total === replay.total, nearT };
}

export async function instrumentCheck(corpus: readonly Session[], logged: readonly LoggedSearch[], projects: readonly Project[]): Promise<CheckRow[]> {
  const out: CheckRow[] = [];
  for (const [i, l] of logged.entries()) {
    if (!l.details || l.isError) continue;
    const { rows } = scopeAsOf(corpus, l.at, { since: l.since, project: l.project, projects });
    const r = await runIncumbent(rows, l.words, { limitMs: Infinity, asofDir: ASOF, cursor: l.cursor });
    const near = new Set(rows.filter((x) => l.at - Date.parse(x.s.lastActiveAt) <= NEAR_T_MS).map((x) => x.s.id));
    out.push({ i, words: l.words, logged: l.details, replay: r, ...checkOne(l.details, r, near) });
  }
  return out;
}

// ---- the comparison -----------------------------------------------------------------------------

export const SETS = ["mined-search", "mined-list", "title", "prompt"] as const;
const SET_BIAS: Record<string, string> = {
  "mined-search": "the Overseer mostly opened what the incumbent showed it: favors the incumbent",
  "mined-list": "words chosen for a title/folder/summary match: favors a system weighing titles",
  title: "title words sit in the first user message: easy for both",
  prompt: "words from one message: the incumbent's every-word-in-one-message rule fits by construction",
  negative: "no session holds every word: the incumbent's false-answer rate is 0 by construction",
};

/** The candidate's documents: every session the overview may cover (listed, not skipped). */
export function docsOf(corpus: readonly Session[]): Doc[] {
  return corpus
    .filter((s) => s.row.listed && !s.row.skipped)
    .map((s) => ({
      id: s.row.id,
      title: [s.row.title ?? "", s.row.originalTitle ?? ""].join("\n"),
      summary: [s.row.outlineGist ?? "", s.row.outlineNow ?? ""].join("\n"),
      summaryAt: s.row.outlineAt ?? 0,
      messages: s.messages.map((m) => ({ who: m.who, lineAt: m.lineAt, text: m.text })),
    }));
}

interface QueryRun {
  qid: string;
  set: string;
  labels: string[];
  scope: number;
  /** labels in the as-of scope (reachable by either system) */
  reachable: number;
  incumbent: { ids: string[]; ms: number; refused?: string; snippets: Record<string, string[]> };
  incumbent10s: { ids: string[]; ms: number; stoppedShort: boolean; searched: number };
  bm25f: { ids: string[]; ms: number; snippets: Record<string, string[]> };
  bm25fAll: { ids: string[]; ms: number; scope: number };
}

export async function runQuery(corpus: readonly Session[], ix: Index, q: Query, projects: readonly Project[], c: Constants = DEFAULTS, opts: { incumbent: boolean } = { incumbent: true }): Promise<QueryRun> {
  const { rows } = scopeAsOf(corpus, q.at, { since: q.since, project: q.project, projects });
  const ids = rows.map((r) => r.s.id);
  const inScope = new Set(ids);
  const out: QueryRun = {
    qid: q.qid,
    set: q.set,
    labels: q.labels,
    scope: ids.length,
    reachable: q.labels.filter((l) => inScope.has(l)).length,
    incumbent: { ids: [], ms: 0, snippets: {} },
    incumbent10s: { ids: [], ms: 0, stoppedShort: false, searched: 0 },
    bm25f: { ids: [], ms: 0, snippets: {} },
    bm25fAll: { ids: [], ms: 0, scope: 0 },
  };
  if (opts.incumbent) {
    try {
      const r = await runIncumbent(rows, q.words, { limitMs: Infinity, asofDir: ASOF });
      out.incumbent = { ids: r.hits.map((h) => h.id), ms: r.ms, snippets: Object.fromEntries(r.hits.map((h) => [h.id, h.snippets.map((s) => s.text)])) };
      const r10 = await runIncumbent(rows, q.words, { limitMs: SEARCH_LIMIT_MS, asofDir: ASOF });
      out.incumbent10s = { ids: r10.hits.map((h) => h.id), ms: r10.ms, stoppedShort: r10.stoppedShort, searched: r10.searched };
    } catch (err) {
      out.incumbent.refused = (err as Error).message; // a Refusal: the Overseer got no list
    }
  }
  let t0 = performance.now();
  const hits = search(ix, ids, q.words, q.at, c);
  out.bm25f = { ids: hits.map((h) => h.id), ms: performance.now() - t0, snippets: Object.fromEntries(hits.map((h) => [h.id, h.snippets.map((s) => s.text)])) };
  const all = scopeAsOf(corpus, q.at, { project: q.project, projects, allTime: true }).rows.map((r) => r.s.id);
  t0 = performance.now();
  out.bm25fAll = { ids: search(ix, all, q.words, q.at, c).map((h) => h.id), ms: performance.now() - t0, scope: all.length };
  return out;
}

/** A full collection before a heap reading (Bun's; a no-op elsewhere). */
const gc = (): void => (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);

type SystemKey = "incumbent" | "incumbent10s" | "bm25f" | "bm25fAll";
const SYSTEMS: SystemKey[] = ["incumbent", "incumbent10s", "bm25f", "bm25fAll"];

export function score(runs: readonly QueryRun[], sys: SystemKey) {
  const per: Record<string, ReturnType<typeof summarize>> = {};
  for (const set of SETS) per[set] = summarize(runs.filter((r) => r.set === set).map((r) => firstRank(r[sys].ids, r.labels)));
  const labelled = runs.filter((r) => r.set !== "negative");
  const pooled = summarize(labelled.map((r) => firstRank(r[sys].ids, r.labels)));
  const neg = falseAnswerRate(runs.filter((r) => r.set === "negative").map((r) => r[sys].ids.length));
  const ms = runs.map((r) => r[sys].ms);
  return { per, pooled, falseRate: neg.rate, negatives: neg.n, p50: percentile(ms, 50), p95: percentile(ms, 95), max: Math.max(0, ...ms) };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const f3 = (x: number) => x.toFixed(3);
const msS = (x: number) => (x >= 100 ? `${Math.round(x)} ms` : `${x.toFixed(1)} ms`);
const table = (head: string[], rows: string[][]) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** One sweep axis at a time from DEFAULTS (plan.md, protocol step 5). */
export function sweepRows(): { name: string; c: Constants }[] {
  const rows: { name: string; c: Constants }[] = [];
  const set = (name: string, f: (c: Constants) => void) => {
    const c = structuredClone(DEFAULTS);
    f(c);
    rows.push({ name, c });
  };
  for (const v of [0.6, 0.9, 1.5, 2.0]) set(`k1 ${v}`, (c) => (c.k1 = v));
  for (const v of [0.3, 0.5, 0.9, 1.0]) set(`b ${v}`, (c) => (c.b = v));
  for (const v of [1, 2, 8]) set(`title ${v}`, (c) => (c.weights.title = v));
  for (const v of [0, 1, 4]) set(`summary ${v}`, (c) => (c.weights.summary = v));
  for (const v of [0.5, 2]) set(`user ${v}`, (c) => (c.weights.user = v));
  for (const v of [0, 0.5, 2]) set(`assistant ${v}`, (c) => (c.weights.assistant = v));
  for (const v of [0, 0.34, 0.67, 1]) set(`minCoverage ${v}`, (c) => (c.minCoverage = v));
  return rows;
}

/** How many constants a configuration changes from DEFAULTS (a tie between rows goes to fewer). */
export function changesOf(c: Constants): number {
  const flat = (o: object, p = ""): [string, unknown][] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v] as [string, unknown]]));
  const d = new Map(flat(DEFAULTS));
  return flat(c).filter(([k, v]) => d.get(k) !== v).length;
}

/** plan.md amendment 4: the false-answer sweep. Single changes from the starting constants first,
    then each on top of minCoverage 1, then combinations (written after the single rows were logged). */
export function falseRows(): { name: string; c: Constants }[] {
  const rows: { name: string; c: Constants }[] = [];
  const set = (name: string, f: (c: Constants) => void) => {
    const c = structuredClone(DEFAULTS);
    f(c);
    rows.push({ name, c });
  };
  const singles: [string, (c: Constants) => void][] = [
    ["coverageOn surface", (c) => (c.coverageOn = "surface")],
    ...[1, 2, 3].map((k): [string, (c: Constants) => void] => [`window ${k}`, (c) => (c.window = k)]),
    ...[0.25, 0.5].map((v): [string, (c: Constants) => void] => [`floorRel ${v}`, (c) => (c.floorRel = v)]),
    ...[5, 10, 15].map((v): [string, (c: Constants) => void] => [`floorAbs ${v}`, (c) => (c.floorAbs = v)]),
  ];
  for (const [name, f] of singles) set(name, f);
  set("minCoverage 1", (c) => (c.minCoverage = 1));
  for (const [name, f] of singles)
    set(`minCoverage 1 + ${name}`, (c) => {
      c.minCoverage = 1;
      f(c);
    });
  // Combinations, added after the rows above were logged: around the best zero-false row.
  set("minCoverage 0.67 + coverageOn surface", (c) => {
    c.minCoverage = 0.67;
    c.coverageOn = "surface";
  });
  for (const [name, f] of singles.filter(([n]) => n !== "coverageOn surface"))
    set(`minCoverage 1 + coverageOn surface + ${name}`, (c) => {
      c.minCoverage = 1;
      c.coverageOn = "surface";
      f(c);
    });
  return rows;
}

export interface FalseRow {
  name: string;
  changes: number;
  recall3: number;
  mrr: number;
  falseRate: number;
  per: Record<string, { recall3: number; mrr: number }>;
}

async function falseSweep(corpus: readonly Session[], ix: Index, dev: readonly Query[], projects: readonly Project[]): Promise<FalseRow[]> {
  const out: FalseRow[] = [];
  for (const row of [{ name: "starting constants", c: DEFAULTS }, ...falseRows()]) {
    const rs: QueryRun[] = [];
    for (const q of dev) rs.push(await runQuery(corpus, ix, q, projects, row.c, { incumbent: false }));
    const x = score(rs, "bm25f");
    const per = Object.fromEntries(SETS.map((s) => [s, { recall3: x.per[s]!.recall3, mrr: x.per[s]!.mrr }]));
    out.push({ name: row.name, changes: changesOf(row.c), recall3: x.pooled.recall3, mrr: x.pooled.mrr, falseRate: x.falseRate, per });
    console.log(`  ${row.name.padEnd(50)} R@3 ${pct(x.pooled.recall3)} MRR ${f3(x.pooled.mrr)} false ${pct(x.falseRate).padStart(6)} | ${SETS.map((s) => `${s} ${pct(per[s]!.recall3)}/${f3(per[s]!.mrr)}`).join(" ")}`);
  }
  return out;
}

const constantsOf = (name: string): Constants => (name === "starting constants" ? DEFAULTS : [...sweepRows(), ...falseRows()].find((r) => r.name === name)!.c);

/** `--tune-false`: the index and the false-answer sweep on dev only (no instrument check, no
    incumbent), then the held-out constants under amendment 4. */
async function tuneFalse(corpus: readonly Session[], queries: readonly Query[], projects: readonly Project[]): Promise<void> {
  const ix = buildIndex(docsOf(corpus));
  console.log("== FALSE-ANSWER SWEEP (dev, bm25f; plan.md amendment 4)");
  const rows = await falseSweep(corpus, ix, queries.filter((q) => q.split === "dev"), projects);
  writeJson(join(OUT, "false-sweep-dev.json"), rows);
  const pick = pickZeroFalseRow(rows);
  console.log(`  held-out runs: ${pick ? pick.name : "no row has zero false answers"} (plan.md amendment 4)`);
  if (pick) writeJson(join(OUT, "heldout-constants.json"), { row: pick.name, rule: "amendment 4", constants: constantsOf(pick.name) });
  process.exit(0);
}

async function main(): Promise<void> {
  const rows: ListingRow[] = readJson(join(PRIV, "listing.json")).rows;
  const j = readJson(join(PRIV, "judgments.json"));
  const judgmentsSha = sha256(readFileSync(join(PRIV, "judgments.json")));
  const projects: Project[] = readJson(join(PRIV, "projects.json"));
  const t0 = performance.now();
  const corpus = loadCorpus(COPY, rows);
  const readMs = performance.now() - t0;
  console.log(`corpus: ${corpus.length} sessions read in ${Math.round(readMs)} ms; dataset ${j.header.datasetHash.slice(0, 12)}; judgments ${judgmentsSha.slice(0, 12)}`);

  if (args.includes("--label")) return label(corpus, j.queries, projects, args.includes("--prepare"));
  if (args.includes("--heldout")) return heldout(corpus, j.queries, projects);
  if (args.includes("--tune-false")) return tuneFalse(corpus, j.queries, projects);

  console.log("== 1. INSTRUMENT CHECK");
  const check = await instrumentCheck(corpus, j.logged, projects);
  writeJson(join(OUT, "instrument-check.json"), check);
  const hitsOk = check.filter((c) => c.hitsMatch).length;
  const totalOk = check.filter((c) => c.totalMatch).length;
  const nearOk = check.filter((c) => c.nearT).length;
  const totalDiff = check.map((c) => Math.abs(c.replay.total - c.logged.total));
  console.log(`  hits reproduced in order: ${hitsOk}/${check.length} exact, ${nearOk} more once sessions active within ${NEAR_T_MS / 60_000} min of the query are set aside; scope totals equal: ${totalOk}/${check.length} (largest difference ${Math.max(...totalDiff)})`);
  for (const c of check.filter((c) => !c.hitsMatch))
    console.log(`  #${c.i}: hits logged ${c.logged.hits.length} replay ${c.replay.hits.length}${c.nearT ? ": differ only near the query time" : ": MISMATCH"}`);
  if (hitsOk + nearOk < check.length) {
    console.error("BLOCKER: the replay does not reproduce what the Overseer got: no comparison runs on it");
    process.exit(1);
  }

  console.log("== 2. INDEX");
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const t1 = performance.now();
  const ix = buildIndex(docsOf(corpus));
  const buildMs = performance.now() - t1;
  gc();
  // the index's own retained heap (the corpus it reads is shared with the incumbent's replay)
  const rssIndex = process.memoryUsage().heapUsed - heap0;
  console.log(`  ${ix.docs.length} sessions, ${ix.msgs.length} messages, ${ix.postings.size} terms: built in ${Math.round(buildMs)} ms (+${Math.round(rssIndex / 1e6)} MB heap retained; corpus read ${Math.round(readMs)} ms, total RSS ${Math.round(process.memoryUsage().rss / 1e6)} MB)`);

  console.log("== 3. DEV, starting constants (exploratory)");
  const dev: Query[] = j.queries.filter((q: Query) => q.split === "dev");
  const runs: QueryRun[] = [];
  for (const q of dev) runs.push(await runQuery(corpus, ix, q, projects));
  writeJson(join(OUT, "runs-dev.json"), runs);
  const scores = Object.fromEntries(SYSTEMS.map((s) => [s, score(runs, s)])) as Record<SystemKey, ReturnType<typeof score>>;
  const refused = runs.filter((r) => r.incumbent.refused).length;
  const stopped = runs.filter((r) => r.incumbent10s.stoppedShort).length;
  for (const s of SYSTEMS) {
    const x = scores[s];
    console.log(`  ${s.padEnd(13)} pooled R@3 ${pct(x.pooled.recall3)} MRR ${f3(x.pooled.mrr)} (n ${x.pooled.n}) · false answers ${pct(x.falseRate)} of ${x.negatives} · p50 ${msS(x.p50)} p95 ${msS(x.p95)}`);
    for (const set of SETS) console.log(`      ${set.padEnd(13)} R@3 ${pct(x.per[set]!.recall3)} MRR ${f3(x.per[set]!.mrr)} (n ${x.per[set]!.n})`);
  }
  const unreachable = runs.filter((r) => r.set !== "negative" && !r.reachable).length;
  console.log(`  incumbent refusals ${refused}; 10 s runs stopped short ${stopped}; labelled queries whose labels are outside their as-of scope ${unreachable}`);

  console.log("== 4. SWEEP (dev, bm25f, one constant at a time)");
  const base = { name: "starting constants", mrr: scores.bm25f.pooled.mrr, recall3: scores.bm25f.pooled.recall3, falseRate: scores.bm25f.falseRate };
  const sweep: (typeof base)[] = [];
  for (const row of sweepRows()) {
    const rs: QueryRun[] = [];
    for (const q of dev) rs.push(await runQuery(corpus, ix, q, projects, row.c, { incumbent: false }));
    const x = score(rs, "bm25f");
    sweep.push({ name: row.name, mrr: x.pooled.mrr, recall3: x.pooled.recall3, falseRate: x.falseRate });
    console.log(`  ${row.name.padEnd(16)} R@3 ${pct(x.pooled.recall3)} MRR ${f3(x.pooled.mrr)} false ${pct(x.falseRate)}`);
  }
  const pick2 = pickHeldoutRow(base, sweep);
  console.log(`  amendment 2 would run: ${pick2 ? pick2.name : "the starting constants"}`);

  console.log("== 5. FALSE-ANSWER SWEEP (dev, bm25f; plan.md amendment 4)");
  const falseSw = await falseSweep(corpus, ix, dev, projects);
  writeJson(join(OUT, "false-sweep-dev.json"), falseSw);
  const pick4 = pickZeroFalseRow(falseSw);
  // Amendment 4 (the user's call, after seeing dev): the zero-false-answer row; amendment 2 only when none has zero.
  const heldoutName = pick4?.name ?? pick2?.name ?? "starting constants";
  const rule = pick4 ? "amendment 4" : "amendment 2";
  console.log(`  held-out runs: ${heldoutName} (plan.md ${rule})`);
  writeJson(join(OUT, "heldout-constants.json"), { row: heldoutName === "starting constants" ? null : heldoutName, rule, constants: constantsOf(heldoutName) });

  // ---- results: totals only (no query, id, title, path or snippet) ----
  const date = new Date().toISOString().slice(0, 10);
  const name = `dev-${date}-${j.header.datasetHash.slice(0, 12)}`;
  const counts = Object.fromEntries([...SETS, "negative"].map((s) => [s, dev.filter((q) => q.set === s).length]));
  const totals = {
    dataset: j.header.datasetHash,
    judgments: judgmentsSha,
    copiedAt: j.header.copiedAt,
    split: "dev",
    queries: counts,
    instrumentCheck: { calls: check.length, exact: hitsOk, nearQueryTime: nearOk, totalsEqual: totalOk, largestTotalDiff: Math.max(...totalDiff) },
    index: { sessions: ix.docs.length, messages: ix.msgs.length, terms: ix.postings.size, buildMs: Math.round(buildMs), heapMB: Math.round(rssIndex / 1e6), processRssMB: Math.round(process.memoryUsage().rss / 1e6), corpusReadMs: Math.round(readMs) },
    systems: scores,
    incumbent: { refused, stoppedShort10s: stopped },
    unreachable,
    sweep: [base, ...sweep],
    falseSweep: falseSw,
    heldoutRow: heldoutName === "starting constants" ? null : heldoutName,
    heldoutRule: rule,
  };
  writeJson(join(import.meta.dirname, "results", `${name}.json`), totals);
  const row = (s: SystemKey, label: string) => {
    const x = scores[s];
    return [label, pct(x.pooled.recall3), f3(x.pooled.mrr), ...SETS.map((set) => `${pct(x.per[set]!.recall3)} / ${f3(x.per[set]!.mrr)}`), `${pct(x.falseRate)}`, msS(x.p50), msS(x.p95)];
  };
  const md = [
    `# Dev results, ${date}`,
    "",
    `Dataset \`${j.header.datasetHash}\` (copied ${j.header.copiedAt}); judgments \`${judgmentsSha}\`. Exploratory: dev split, starting constants, then a one-constant sweep. Totals only: the queries, labels and per-query ranks are in the private folder.`,
    "",
    `Queries (dev): ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
    "## Instrument check",
    "",
    `The imported incumbent, replayed over the copy as of each logged call's time with its own window and project: ${hitsOk} of ${check.length} logged calls reproduced exactly (same sessions, same order), ${nearOk} more once sessions active within ${NEAR_T_MS / 60_000} minutes of the call are set aside (plan.md amendment 1). Scope sizes equal on ${totalOk} of ${check.length}, the largest difference ${Math.max(...totalDiff)} sessions.`,
    "",
    "## Starting constants",
    "",
    table(["System", "R@3", "MRR", ...SETS.map((s) => `${s} R@3 / MRR`), "False answers", "p50", "p95"], [
      row("incumbent", "incumbent, no limit"),
      row("incumbent10s", "incumbent, 10 s limit"),
      row("bm25f", "bm25f, same window"),
      row("bm25fAll", "bm25f, all time"),
    ]),
    "",
    `R@3 and MRR are pooled over the ${scores.bm25f.pooled.n} labelled dev queries; false answers over ${scores.bm25f.negatives} no-answer queries. Incumbent refusals (over 8 words): ${refused}. Incumbent calls stopped short at 10 s: ${stopped}. Labelled queries whose labels were outside their as-of scope (a miss for both): ${unreachable}.`,
    "",
    `Index: ${ix.docs.length} sessions, ${ix.msgs.length} messages, ${ix.postings.size} terms, built in ${Math.round(buildMs)} ms, +${Math.round(rssIndex / 1e6)} MB heap retained by the index; the whole bench process peaked at ${Math.round(process.memoryUsage().rss / 1e6)} MB RSS (it holds the full copy's text for the replay too). Corpus read, shared by both systems: ${Math.round(readMs)} ms. The index is time-aware (one index answers every query time), a bench artifact: a live per-call index would differ.`,
    "",
    "Biases, per set:",
    "",
    ...Object.entries(SET_BIAS).map(([k, v]) => `- ${k}: ${v}.`),
    "",
    "## Sweep (dev, bm25f, one constant at a time)",
    "",
    table(["Row", "R@3", "MRR", "False answers"], [base, ...sweep].map((r) => [r.name, pct(r.recall3), f3(r.mrr), pct(r.falseRate)])),
    "",
    `Amendment 2 alone would run: ${pick2 ? pick2.name : "the starting constants"}.`,
    "",
    "## False-answer sweep (dev, bm25f; plan.md amendment 4)",
    "",
    "The user asked for zero false answers as the selection criterion, after seeing the dev results above. Single changes from the starting constants, then each on top of minCoverage 1, then combinations. Per set: R@3 / MRR.",
    "",
    table(["Row", "Changes", "R@3", "MRR", "False answers", ...SETS], falseSw.map((r) => [r.name, String(r.changes), pct(r.recall3), f3(r.mrr), pct(r.falseRate), ...SETS.map((s) => `${pct(r.per[s]!.recall3)} / ${f3(r.per[s]!.mrr)}`)])),
    "",
    `Held-out runs: ${heldoutName} (plan.md ${rule}).`,
    "",
  ].join("\n");
  writeFileSync(join(import.meta.dirname, "results", `${name}.md`), md);
  console.log(`results: bench/search-ab/results/${name}.md`);
  process.exit(0);
}


// ---- grading (plan.md, Human grades; amendment 3) ------------------------------------------------

export const POOL_QUERIES = 40;
export const POOL_DEPTH = 5;

export interface PoolItem {
  qid: string;
  words: string;
  ask?: string;
  sessions: { id: string; view: string }[];
}

/** A pooled session as the grader sees it, the same whichever system found it. */
export function neutralView(s: Session, q: Pick<Query, "words" | "at">): string {
  const asOfMsgs = s.messages.filter((m) => m.lineAt <= q.at);
  const words = q.words.toLowerCase().split(/\s+/).filter(Boolean);
  let best: (typeof asOfMsgs)[number] | null = null;
  let bestN = 0;
  for (const m of asOfMsgs) {
    const lower = m.text.toLowerCase();
    const n = words.filter((w) => lower.includes(w)).length;
    if (n > 0 && n >= bestN) {
      best = m;
      bestN = n;
    }
  }
  const last = asOfMsgs.length ? asOfMsgs[asOfMsgs.length - 1]!.lineAt : s.mtimeMs;
  const opening = asOfMsgs.find((m) => m.who === "user")?.text ?? "";
  const lines = [
    `  title:   ${s.row.title ?? "Untitled"}`,
    `  folder:  ${s.row.cwd.split("/").filter(Boolean).pop() ?? ""} · last active ${new Date(Math.min(last, q.at)).toISOString().slice(0, 16).replace("T", " ")}`,
  ];
  if (s.row.outlineGist && (s.row.outlineAt ?? 0) <= q.at) lines.push(`  summary: ${s.row.outlineGist}`);
  if (opening) lines.push(`  opened:  ${snippetOf(opening, [""]).slice(0, 220)}`);
  if (best) lines.push(`  best ${best.who === "user" ? "USER" : "ASSISTANT"}: ${snippetOf(best.text, [words.find((w) => best!.text.toLowerCase().includes(w)) ?? ""])}`);
  return lines.join("\n");
}

async function drawPool(corpus: readonly Session[], queries: readonly Query[], projects: readonly Project[]): Promise<PoolItem[]> {
  const hc = readJson(join(PRIV, "heldout-constants.json"));
  const ix = buildIndex(docsOf(corpus));
  const r = rng(40);
  const held = queries.filter((q) => q.split === "heldout");
  const order = [...shuffle(held.filter((q) => q.set.startsWith("mined")), r), ...shuffle(held.filter((q) => q.set === "title" || q.set === "prompt"), r)];
  const byId = new Map(corpus.map((s) => [s.row.id, s]));
  const items: PoolItem[] = [];
  for (const q of order) {
    if (items.length >= POOL_QUERIES) break;
    const run = await runQuery(corpus, ix, q, projects, hc.constants);
    const ids = pool([run.incumbent.ids, run.bm25f.ids], POOL_DEPTH, (xs) => shuffle(xs, r));
    if (!ids.length) continue;
    items.push({ qid: q.qid, words: q.words, ...(q.ask ? { ask: q.ask } : {}), sessions: ids.map((id) => ({ id, view: neutralView(byId.get(id)!, q) })) });
  }
  return items;
}

/** The grading loop: one line per answer from `input`, grades saved after each. Resumable. */
export async function gradeLoop(items: readonly PoolItem[], gradesPath: string, lines: AsyncIterator<string>, print: (s: string) => void): Promise<{ graded: number; total: number; quit: boolean }> {
  const saved: { grades: Record<string, Record<string, number>> } = existsSync(gradesPath) ? readJson(gradesPath) : { grades: {} };
  const total = items.reduce((a, it) => a + it.sessions.length, 0);
  const count = () => Object.values(saved.grades).reduce((a, g) => a + Object.keys(g).length, 0);
  print(`Grade each session for the search above it: 2 = the one it was after, 1 = related, 0 = not it. s = skip for now, q = quit (progress is saved). ${count()} of ${total} graded so far.`);
  for (const [qi, it] of items.entries()) {
    const g = (saved.grades[it.qid] ??= {});
    const todo = it.sessions.filter((s) => g[s.id] === undefined);
    if (!todo.length) continue;
    print(`\n=== Search ${qi + 1} of ${items.length}: "${it.words}"`);
    if (it.ask) print(`    (what was asked just before: ${it.ask.replace(/\s+/g, " ").slice(0, 400)})`);
    for (const s of todo) {
      print(`\n[${it.sessions.indexOf(s) + 1}/${it.sessions.length}]\n${s.view}`);
      for (;;) {
        print("grade 0/1/2, s, q > ");
        const next = await lines.next();
        if (next.done) return { graded: count(), total, quit: true };
        const a = next.value.trim().toLowerCase();
        if (a === "q") return { graded: count(), total, quit: true };
        if (a === "s") break;
        if (a === "0" || a === "1" || a === "2") {
          g[s.id] = Number(a);
          writeJson(gradesPath, saved);
          break;
        }
      }
    }
  }
  return { graded: count(), total, quit: false };
}

async function label(corpus: readonly Session[], queries: readonly Query[], projects: readonly Project[], prepareOnly: boolean): Promise<void> {
  const poolPath = join(PRIV, "pool.json");
  if (!existsSync(join(PRIV, "heldout-constants.json"))) {
    console.error("Run the dev bench first: it fixes the candidate's held-out constants the pool is drawn with.");
    process.exit(2);
  }
  if (!existsSync(poolPath)) {
    const items = await drawPool(corpus, queries, projects);
    writeJson(poolPath, { drawnAt: new Date().toISOString(), items });
    console.log(`pool: ${items.length} held-out searches, ${items.reduce((a, it) => a + it.sessions.length, 0)} sessions to grade (${poolPath})`);
  }
  if (prepareOnly) process.exit(0);
  const { items } = readJson(poolPath) as { items: PoolItem[] };
  const rl = createInterface({ input: process.stdin, terminal: false });
  const r = await gradeLoop(items, join(PRIV, "grades.json"), rl[Symbol.asyncIterator](), (s) => process.stdout.write(s.endsWith("> ") ? s : s + "\n"));
  rl.close();
  console.log(`\n${r.graded} of ${r.total} graded${r.graded === r.total ? ": done. The held-out scoring can run (--heldout)." : ". Run the same command again to continue."}`);
  process.exit(0);
}

async function heldout(corpus: readonly Session[], queries: readonly Query[], projects: readonly Project[]): Promise<void> {
  const poolPath = join(PRIV, "pool.json");
  const gradesPath = join(PRIV, "grades.json");
  if (!existsSync(poolPath) || !existsSync(gradesPath)) {
    console.error("The held-out scoring waits for the grades: run --label first.");
    process.exit(2);
  }
  const { items } = readJson(poolPath) as { items: PoolItem[] };
  const { grades } = readJson(gradesPath) as { grades: Record<string, Record<string, number>> };
  const missing = items.reduce((a, it) => a + it.sessions.filter((s) => grades[it.qid]?.[s.id] === undefined).length, 0);
  if (missing) {
    console.error(`${missing} pooled sessions are not graded yet: finish --label first.`);
    process.exit(2);
  }
  const j = readJson(join(PRIV, "judgments.json"));
  const name = `heldout-${j.header.datasetHash.slice(0, 12)}`;
  if (readdirSync(join(import.meta.dirname, "results")).some((f) => f.startsWith(name)) && !args.includes("--force")) {
    console.error("Held-out already scored on this dataset: a held-out set queried twice is a dev set (plan.md).");
    process.exit(2);
  }
  const hc = readJson(join(PRIV, "heldout-constants.json"));
  const ix = buildIndex(docsOf(corpus));
  const runs: QueryRun[] = [];
  for (const q of queries.filter((q) => q.split === "heldout")) runs.push(await runQuery(corpus, ix, q, projects, hc.constants));
  writeJson(join(PRIV, "runs-heldout.json"), runs);
  const byQ = new Map(runs.map((r) => [r.qid, r]));
  const graded = (sys: SystemKey) => {
    const g = items.map((it) => gradedScores(byQ.get(it.qid)![sys].ids, grades[it.qid]!));
    return { ...summarize(g.map((x) => x.rank2)), ndcg5: g.reduce((a, x) => a + x.ndcg5, 0) / (g.length || 1) };
  };
  const totals = Object.fromEntries(SYSTEMS.map((s) => [s, { ...score(runs, s), graded: graded(s) }]));
  const out = { dataset: j.header.datasetHash, split: "heldout", constants: hc.row ?? "starting constants", systems: totals, at: new Date().toISOString() };
  writeJson(join(import.meta.dirname, "results", `${name}.json`), out);
  for (const s of SYSTEMS) {
    const x = totals[s]!;
    console.log(`${s.padEnd(13)} implicit R@3 ${pct(x.pooled.recall3)} MRR ${f3(x.pooled.mrr)} · graded R@3 ${pct(x.graded.recall3)} MRR ${f3(x.graded.mrr)} nDCG@5 ${f3(x.graded.ndcg5)} · false ${pct(x.falseRate)} · p95 ${msS(x.p95)}`);
  }
  console.log(`results: bench/search-ab/results/${name}.json (totals only)`);
  process.exit(0);
}

if (import.meta.main) await main();
