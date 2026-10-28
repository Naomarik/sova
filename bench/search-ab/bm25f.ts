// bm25f: the ranked candidate (plan.md, The two systems). Per-session field-weighted BM25 over
// title, summary, user text and assistant text; partial matches rank below sessions holding every
// query term; snippets are the top-scoring messages. Tokens are topic.mjs's own (termsOf, wordsOf),
// plus one joined term per hyphen/underscore compound. Stems: topic.mjs's light stripper.
//
// The index is a bench artifact: per-message postings with each message's line time, so one index
// answers a query as of any time (only messages written by then count, and a summary only when it
// was written by then). A live index would hold one time: now.
import { termsOf, wordsOf } from "./topic";
import { snippetOf } from "../../server/overseer-roundup";

export const DEFAULTS = {
  k1: 1.2,
  b: 0.75,
  weights: { title: 4, summary: 2, user: 1, assistant: 1 },
  /** A session matching fewer than this share of the query's terms is not shown. */
  minCoverage: 0.5,
  /** How many sessions a call shows, and snippets each (the incumbent's 20 × 3). */
  sessions: 20,
  snippets: 3,
};
export type Constants = typeof DEFAULTS;
type Field = keyof Constants["weights"];
const FIELDS: Field[] = ["title", "summary", "user", "assistant"];

/** A hyphen or underscore compound kept whole (`fix-widget-sort-flake`): topic.mjs splits at hyphens. */
const COMPOUND = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+/gu;
export function compoundsOf(text: string): string[] {
  return [...String(text).matchAll(COMPOUND)].map((m) => m[0].toLowerCase());
}

/** A text's terms: topic.mjs's, plus each compound whole. */
export function tokens(text: string): string[] {
  return [...termsOf(text), ...compoundsOf(text)];
}

/** A query's terms: the words it counts coverage over (stems, first form as written), and the
    compounds that only add score. */
export function queryTerms(q: string): { base: Map<string, string>; joined: string[] } {
  const base = new Map<string, string>();
  for (const { term, word } of wordsOf(q)) if (!base.has(term)) base.set(term, word.toLowerCase());
  const joined = [...new Set(compoundsOf(q))].filter((c) => !base.has(c));
  return { base, joined };
}

export interface DocMessage {
  who: "user" | "assistant";
  lineAt: number;
  text: string;
}

export interface Doc {
  id: string;
  title: string;
  /** The summary fields' text and when it was written (ms; 0 unknown, treated as always there). */
  summary: string;
  summaryAt: number;
  messages: readonly DocMessage[];
}

interface Msg {
  doc: number;
  field: "user" | "assistant";
  lineAt: number;
  len: number;
  tf: Map<string, number>;
  /** The message's own text (a reference, not a copy), for its snippet. */
  text: string;
}

const tfOf = (ts: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
};

export interface Index {
  docs: readonly Doc[];
  byId: Map<string, number>;
  msgs: Msg[];
  /** term → message indexes holding it */
  postings: Map<string, number[]>;
  /** per doc: title and summary term frequencies and lengths */
  head: { title: Map<string, number>; titleLen: number; summary: Map<string, number>; summaryLen: number }[];
  /** per doc, per message field: message times (ascending) and running lengths, for lengths as of a time */
  runs: { user: { at: number[]; cum: number[] }; assistant: { at: number[]; cum: number[] } }[];
  avgMsgLen: number;
}

export function buildIndex(docs: readonly Doc[]): Index {
  const msgs: Msg[] = [];
  const postings = new Map<string, number[]>();
  const head: Index["head"] = [];
  const runs: Index["runs"] = [];
  let lenSum = 0;
  docs.forEach((d, di) => {
    const title = tokens(d.title);
    const summary = tokens(d.summary);
    head.push({ title: tfOf(title), titleLen: title.length, summary: tfOf(summary), summaryLen: summary.length });
    const run = { user: { at: [] as number[], cum: [] as number[] }, assistant: { at: [] as number[], cum: [] as number[] } };
    const sorted = [...d.messages].sort((a, b) => a.lineAt - b.lineAt);
    for (const m of sorted) {
      const ts = tokens(m.text);
      if (!ts.length) continue;
      const tf = tfOf(ts);
      const k = msgs.length;
      msgs.push({ doc: di, field: m.who, lineAt: m.lineAt, len: ts.length, tf, text: m.text });
      lenSum += ts.length;
      for (const t of tf.keys()) {
        let p = postings.get(t);
        if (!p) postings.set(t, (p = []));
        p.push(k);
      }
      const r = run[m.who];
      r.at.push(m.lineAt);
      r.cum.push((r.cum[r.cum.length - 1] ?? 0) + ts.length);
    }
    runs.push(run);
  });
  return { docs, byId: new Map(docs.map((d, i) => [d.id, i])), msgs, postings, head, runs, avgMsgLen: lenSum / (msgs.length || 1) };
}

/** Running length of a field's messages written by `t`. */
function lenAt(r: { at: number[]; cum: number[] }, t: number): number {
  let lo = 0;
  let hi = r.at.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (r.at[mid]! <= t) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return k < 0 ? 0 : r.cum[k]!;
}

export interface Hit {
  id: string;
  score: number;
  coverage: number;
  snippets: { who: "user" | "assistant"; at: number; text: string }[];
}

/**
 * Rank `scope` (ids, newest first: the order ties fall back to) for query `q` as of time `t`.
 * Scores mirror topic.mjs's field-weighted BM25: per field, idf × saturated tf, weighted and summed.
 */
export function search(ix: Index, scope: readonly string[], q: string, t: number, c: Constants = DEFAULTS): Hit[] {
  const { base, joined } = queryTerms(q);
  if (!base.size) return [];
  const terms = [...base.keys(), ...joined];
  const inScope = new Map<number, number>(); // doc → recency rank
  scope.forEach((id, r) => {
    const d = ix.byId.get(id);
    if (d !== undefined) inScope.set(d, r);
  });
  const N = inScope.size;
  if (!N) return [];
  const summaryOn = (d: number) => ix.docs[d]!.summaryAt <= t;
  // field lengths as of t, and their averages over the scope
  const len = new Map<number, Record<Field, number>>();
  const sum: Record<Field, number> = { title: 0, summary: 0, user: 0, assistant: 0 };
  for (const d of inScope.keys()) {
    const h = ix.head[d]!;
    const l = { title: h.titleLen, summary: summaryOn(d) ? h.summaryLen : 0, user: lenAt(ix.runs[d]!.user, t), assistant: lenAt(ix.runs[d]!.assistant, t) };
    len.set(d, l);
    for (const f of FIELDS) sum[f] += l[f];
  }
  const avg = Object.fromEntries(FIELDS.map((f) => [f, sum[f] / N || 1])) as Record<Field, number>;
  // per term: tf per doc and field, as of t
  const tfs = new Map<string, Map<number, Record<Field, number>>>();
  const msgHits = new Map<number, number[]>(); // doc → its matching messages (indexes)
  for (const term of terms) {
    const per = new Map<number, Record<Field, number>>();
    const get = (d: number) => {
      let r = per.get(d);
      if (!r) per.set(d, (r = { title: 0, summary: 0, user: 0, assistant: 0 }));
      return r;
    };
    for (const d of inScope.keys()) {
      const h = ix.head[d]!;
      const ti = h.title.get(term);
      if (ti) get(d).title += ti;
      const su = summaryOn(d) ? h.summary.get(term) : 0;
      if (su) get(d).summary += su;
    }
    for (const k of ix.postings.get(term) ?? []) {
      const m = ix.msgs[k]!;
      if (m.lineAt > t || !inScope.has(m.doc)) continue;
      get(m.doc)[m.field] += m.tf.get(term)!;
      let mh = msgHits.get(m.doc);
      if (!mh) msgHits.set(m.doc, (mh = []));
      if (mh[mh.length - 1] !== k) mh.push(k);
    }
    tfs.set(term, per);
  }
  const idf = new Map(terms.map((term) => {
    const n = tfs.get(term)!.size;
    return [term, Math.log(1 + (N - n + 0.5) / (n + 0.5))];
  }));
  const scored: { d: number; score: number; coverage: number; all: boolean }[] = [];
  const docs = new Set<number>();
  for (const per of tfs.values()) for (const d of per.keys()) docs.add(d);
  for (const d of docs) {
    let s = 0;
    let covered = 0;
    const l = len.get(d)!;
    for (const term of terms) {
      const r = tfs.get(term)!.get(d);
      if (!r) continue;
      if (base.has(term)) covered++;
      for (const f of FIELDS) {
        const tf = r[f];
        if (tf) s += c.weights[f] * idf.get(term)! * (tf * (c.k1 + 1)) / (tf + c.k1 * (1 - c.b + c.b * (l[f] / avg[f])));
      }
    }
    const coverage = covered / base.size;
    if (s > 0 && coverage >= c.minCoverage) scored.push({ d, score: s, coverage, all: covered === base.size });
  }
  scored.sort((a, b) => Number(b.all) - Number(a.all) || b.score - a.score || inScope.get(a.d)! - inScope.get(b.d)!);
  const words = [...base.values()];
  return scored.slice(0, c.sessions).map(({ d, score, coverage }) => {
    // snippets: the messages scoring highest on the query (newest on a tie)
    const ms = (msgHits.get(d) ?? []).map((k) => {
      const m = ix.msgs[k]!;
      let ms = 0;
      for (const term of terms) {
        const tf = m.tf.get(term);
        if (tf) ms += idf.get(term)! * (tf * (c.k1 + 1)) / (tf + c.k1 * (1 - c.b + c.b * (m.len / ix.avgMsgLen)));
      }
      return { k, ms };
    });
    ms.sort((a, b) => b.ms - a.ms || ix.msgs[b.k]!.lineAt - ix.msgs[a.k]!.lineAt);
    const snippets = ms.slice(0, c.snippets).map(({ k }) => {
      const m = ix.msgs[k]!;
      const text = m.text;
      const lower = text.toLowerCase();
      const first = words.find((w) => lower.includes(w)) ?? words[0]!;
      return { who: m.field, at: m.lineAt, text: snippetOf(text, [first]) };
    });
    return { id: ix.docs[d]!.id, score, coverage, snippets };
  });
}
