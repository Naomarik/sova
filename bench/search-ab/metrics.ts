// metrics: the pure scoring of plan.md, What is compared. No I/O.

/** 1-based rank of the first labelled id in `ranked`, or 0 when none is there. */
export function firstRank(ranked: readonly string[], labels: readonly string[]): number {
  const want = new Set(labels);
  const i = ranked.findIndex((id) => want.has(id));
  return i < 0 ? 0 : i + 1;
}

export interface Summary {
  n: number;
  recall3: number;
  mrr: number;
}

/** Recall@3 and MRR over labelled queries' first ranks (0: not shown). */
export function summarize(ranks: readonly number[]): Summary {
  const n = ranks.length;
  if (!n) return { n, recall3: 0, mrr: 0 };
  return { n, recall3: ranks.filter((r) => r >= 1 && r <= 3).length / n, mrr: ranks.reduce((a, r) => a + (r ? 1 / r : 0), 0) / n };
}

/** Share of no-answer queries that showed any session. */
export function falseAnswerRate(shown: readonly number[]): { n: number; rate: number } {
  return { n: shown.length, rate: shown.length ? shown.filter((k) => k > 0).length / shown.length : 0 };
}

/** The p-th percentile (0..100) of `xs`, nearest rank. */
export function percentile(xs: readonly number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** The pool of plan.md amendment 3: the union of each system's top `k`, deduplicated, in a shuffled
    order that names no system. */
export function pool(lists: readonly (readonly string[])[], k: number, shuffle: <T>(xs: readonly T[]) => T[]): string[] {
  const seen = new Set<string>();
  for (const l of lists) for (const id of l.slice(0, k)) seen.add(id);
  return shuffle([...seen]);
}

/** Graded relevance of a ranking: Recall@3 and MRR counting grade 2 as the hit, and nDCG@5. */
export function gradedScores(ranked: readonly string[], grades: Readonly<Record<string, number>>): { rank2: number; ndcg5: number } {
  const rank2 = ranked.findIndex((id) => grades[id] === 2) + 1;
  const dcg = ranked.slice(0, 5).reduce((a, id, i) => a + ((2 ** (grades[id] ?? 0)) - 1) / Math.log2(i + 2), 0);
  const ideal = Object.values(grades).sort((a, b) => b - a).slice(0, 5).reduce((a, g, i) => a + ((2 ** g) - 1) / Math.log2(i + 2), 0);
  return { rank2, ndcg5: ideal ? dcg / ideal : 0 };
}

/** plan.md amendment 2: the sweep row held-out runs, or null for the starting constants. */
export function pickHeldoutRow<R extends { mrr: number; falseRate: number }>(base: R, rows: readonly R[]): R | null {
  let best: R | null = null;
  for (const r of rows) if (r.mrr >= base.mrr + 0.02 && r.falseRate <= base.falseRate && (!best || r.mrr > best.mrr)) best = r;
  return best;
}

/** plan.md amendment 4: among rows with no false answer, the one keeping the most pooled Recall@3,
    then MRR; a tie goes to fewer changes from the starting constants. Null when none has zero. */
export function pickZeroFalseRow<R extends { recall3: number; mrr: number; falseRate: number; changes: number }>(rows: readonly R[]): R | null {
  let best: R | null = null;
  for (const r of rows) {
    if (r.falseRate !== 0) continue;
    if (!best || r.recall3 > best.recall3 || (r.recall3 === best.recall3 && (r.mrr > best.mrr || (r.mrr === best.mrr && r.changes < best.changes)))) best = r;
  }
  return best;
}
