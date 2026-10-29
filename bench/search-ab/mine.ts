// mine: the query sets and their labels, frozen to <private>/judgments.json (plan.md, Ground truth).
//
//   bun bench/search-ab/mine.ts [--copy <agent dir>] [--private <dir>] [--force]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wordsOf } from "./topic";
import { copyDir, OVERSEER_DIR, privateDir, readJson, sha256, splitOf, writeJson } from "./common";
import { type ListingRow, loadCorpus, type Session } from "./corpus";

export type SetName = "mined-search" | "mined-list" | "title" | "prompt" | "negative";

export interface Query {
  qid: string;
  set: SetName;
  split: "dev" | "heldout";
  words: string;
  /** The call's own window and project (mined), as given. */
  since?: string;
  project?: string;
  /** When it was asked (ms): mined, the call's time; synthetic, the freeze time. */
  at: number;
  labels: string[];
  /** Mined: the user's request before the call (what the Overseer was after), for the grader only. */
  ask?: string;
}

/** One logged sova_search_sessions call and what it returned (the instrument check's answer key). */
export interface LoggedSearch {
  at: number;
  words: string;
  since?: string;
  project?: string;
  cursor?: string;
  details: { searched: number; total: number; hits: string[]; stoppedShort: boolean } | null;
  isError: boolean;
}

const SEARCH = "sova_search_sessions";
const LIST = "sova_list_sessions";
const OPENS = new Set(["sova_session", "sova_read_session"]);
const LINK = /sova:\/\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const MAX_LABELS = 3;

/** Walk one Overseer log: each search (and list-with-query) call, its result, and the sessions it
    opened (sova_session, sova_read_session) or linked (sova://s/<id>) before the next search or
    user message. Pure over the lines, so the unit tests drive it with synthetic ones. */
export function mineLog(lines: readonly string[], resolveId: (ref: string) => string | null): { queries: Omit<Query, "qid" | "split">[]; logged: LoggedSearch[] } {
  const queries: Omit<Query, "qid" | "split">[] = [];
  const logged: LoggedSearch[] = [];
  const pendingSearch = new Map<string, LoggedSearch>();
  let open: Omit<Query, "qid" | "split"> | null = null;
  let ask = "";
  const addLabel = (ref: unknown) => {
    if (!open || typeof ref !== "string") return;
    const id = resolveId(ref.trim());
    if (id && !open.labels.includes(id) && open.labels.length < MAX_LABELS) open.labels.push(id);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e?.message;
    if (e?.type !== "message" || !m) continue;
    const at = Date.parse(e.timestamp) || 0;
    if (m.role === "user") {
      open = null;
      const said = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";
      if (said.trim()) ask = said.trim().slice(0, 600);
      continue;
    }
    if (m.role === "toolResult") {
      const s = pendingSearch.get(m.toolCallId);
      if (s) {
        pendingSearch.delete(m.toolCallId);
        s.isError = !!m.isError;
        const d = m.details;
        if (d && Array.isArray(d.hits)) s.details = { searched: d.searched, total: d.total, hits: d.hits, stoppedShort: !!d.stoppedShort };
      }
      continue;
    }
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type === "text" && typeof b.text === "string") for (const l of b.text.matchAll(LINK)) addLabel(l[1]);
      if (b?.type !== "toolCall") continue;
      const a = b.arguments ?? {};
      if (b.name === SEARCH || (b.name === LIST && typeof a.query === "string" && a.query.trim())) {
        const words = String(b.name === SEARCH ? (a.words ?? "") : a.query).trim();
        if (b.name === SEARCH) {
          const s: LoggedSearch = { at, words, isError: false, details: null };
          if (typeof a.since === "string") s.since = a.since;
          if (typeof a.project === "string") s.project = a.project;
          if (typeof a.cursor === "string") s.cursor = a.cursor;
          logged.push(s);
          pendingSearch.set(b.id, s);
        }
        open = { set: b.name === SEARCH ? "mined-search" : "mined-list", words, at, labels: [], ...(ask ? { ask } : {}) };
        if (b.name === SEARCH && typeof a.since === "string") open.since = a.since;
        if (typeof a.project === "string") open.project = a.project;
        if (b.name === SEARCH && typeof a.cursor === "string") open = null; // a cursor page is not a new hunt
        else if (words) queries.push(open);
        continue;
      }
      if (OPENS.has(b.name)) addLabel(a.session);
    }
  }
  return { queries, logged };
}

/** A seeded PRNG (mulberry32), so the synthetic sets are the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Distinct words of a text as written (lowercased), with their stems: topic.mjs's own cut. */
const wordSet = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  // Plain words only (a path, a hash or a number is not what a person types to hunt a session).
  for (const { term, word } of wordsOf(text)) if (/^[a-z][a-z'-]*[a-z]$/i.test(word)) out.set(word.toLowerCase(), term);
  return out;
};

/** The most distinctive `k` words of `text` among those `df` holds in [lo, hi] sessions, best first. */
export function distinctive(text: string, df: Map<string, number>, lo: number, hi: number, k: number): string[] {
  return [...wordSet(text).keys()]
    .filter((w) => (df.get(w) ?? 0) >= lo && (df.get(w) ?? 0) <= hi)
    .sort((a, b) => df.get(a)! - df.get(b)! || a.localeCompare(b))
    .slice(0, k);
}

const sessionText = (s: Session): string => [s.row.title ?? "", s.row.originalTitle ?? "", ...s.messages.map((m) => m.text)].join("\n").toLowerCase();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const COPY = copyDir(args);
  const PRIV = privateDir(args);
  if (existsSync(join(PRIV, "judgments.json")) && !args.includes("--force")) {
    console.error(`${join(PRIV, "judgments.json")} is frozen: pass --force to mine again (and say so in the results).`);
    process.exit(2);
  }
  const manifest = readJson(join(PRIV, "manifest.json"));
  const rows: ListingRow[] = readJson(join(PRIV, "listing.json")).rows;
  const ids = new Set(rows.map((r) => r.id));
  const resolveId = (ref: string): string | null => {
    if (ids.has(ref)) return ref;
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(ref);
    if (m && ids.has(m[1]!)) return m[1]!;
    const hits = ref.length >= 8 ? [...ids].filter((i) => i.startsWith(ref)) : [];
    return hits.length === 1 ? hits[0]! : null;
  };

  // 1-2. Mined, from the Overseer's own logs in the copy.
  const mined: Omit<Query, "qid" | "split">[] = [];
  const logged: LoggedSearch[] = [];
  for (const r of rows.filter((r) => r.rel.startsWith(`sessions/${OVERSEER_DIR}/`)).sort((a, b) => a.rel.localeCompare(b.rel))) {
    const out = mineLog(readFileSync(join(COPY, r.rel), "utf8").split("\n"), resolveId);
    mined.push(...out.queries);
    logged.push(...out.logged);
  }
  const seen = new Set<string>();
  const minedKept = mined.filter((q) => {
    if (!q.labels.length) return false;
    const key = `${q.set}\t${q.words.toLowerCase().replace(/\s+/g, " ")}\t${[...q.labels].sort().join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 3-4. Synthetic, over today's scope.
  const frozenAt = Date.parse(manifest.copiedAt);
  const corpus = loadCorpus(COPY, rows);
  const scoped = corpus.filter((s) => s.row.listed && !s.row.skipped);
  const df = new Map<string, number>();
  for (const s of scoped) for (const w of wordSet([s.row.title ?? "", ...s.messages.map((m) => m.text)].join("\n")).keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const N = scoped.length;
  const r = rng(20261028);
  const recent = shuffle(scoped.filter((s) => s.mtimeMs >= frozenAt - 14 * 86_400_000), r);
  const synthetic: Omit<Query, "qid" | "split">[] = [];
  const PER_SET = 60;
  for (const s of recent) {
    if (synthetic.filter((q) => q.set === "title").length >= PER_SET) break;
    const w = distinctive(s.row.title ?? "", df, 2, Math.ceil(N / 10), 3);
    if (w.length >= 2) synthetic.push({ set: "title", words: w.join(" "), at: frozenAt, labels: [s.row.id] });
  }
  for (const s of recent) {
    if (synthetic.filter((q) => q.set === "prompt").length >= PER_SET) break;
    const first = s.messages.find((m) => m.who === "user")?.text ?? "";
    if (first.length < 200) continue;
    const w = distinctive(first.slice(80), df, 3, Math.ceil(N / 10), 3);
    if (w.length === 3) synthetic.push({ set: "prompt", words: w.join(" "), at: frozenAt, labels: [s.row.id] });
  }
  const vocab = [...df].filter(([w, n]) => n >= 3 && n <= Math.ceil(N / 20) && /^[a-z]+$/.test(w)).map(([w]) => w).sort();
  const texts = corpus.map(sessionText);
  for (let tries = 0; synthetic.filter((q) => q.set === "negative").length < PER_SET && tries < 5000; tries++) {
    const w = [0, 1, 2].map(() => vocab[Math.floor(r() * vocab.length)]!);
    if (new Set(w).size < 3) continue;
    if (texts.some((t) => w.every((x) => t.includes(x)))) continue;
    synthetic.push({ set: "negative", words: w.join(" "), at: frozenAt, labels: [] });
  }

  const queries: Query[] = [...minedKept, ...synthetic].map((q, i) => ({
    qid: `q${String(i + 1).padStart(3, "0")}`,
    ...q,
    split: splitOf(q.labels[0] ?? q.words),
  }));
  const count = (set: SetName, split?: string) => queries.filter((q) => q.set === set && (!split || q.split === split)).length;
  writeJson(join(PRIV, "judgments.json"), {
    header: {
      datasetHash: manifest.datasetHash,
      copiedAt: manifest.copiedAt,
      frozenAt: new Date().toISOString(),
      minedCalls: { search: mined.filter((q) => q.set === "mined-search").length, list: mined.filter((q) => q.set === "mined-list").length },
    },
    queries,
    logged,
  });
  const j = readFileSync(join(PRIV, "judgments.json"), "utf8");
  writeJson(join(PRIV, "judgments.sha256.json"), { sha256: sha256(j) });
  for (const set of ["mined-search", "mined-list", "title", "prompt", "negative"] as SetName[]) console.log(`${set.padEnd(13)} dev ${count(set, "dev")} · heldout ${count(set, "heldout")}`);
  const unlabeled = mined.filter((q) => !q.labels.length).length;
  console.log(`logged search calls: ${logged.length} (${logged.filter((l) => l.details).length} with details); mined hunts ${mined.length}: ${unlabeled} without a label, ${mined.length - unlabeled - minedKept.length} duplicates, ${minedKept.length} kept`);
  process.exit(0);
}

if (import.meta.main) await main();
