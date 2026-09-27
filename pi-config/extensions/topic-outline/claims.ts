/**
 * Claims: which stretch of the transcript each topic update covers.
 *
 * Every summarizer run sees the messages after its offset (refs m1, m2, …) plus a short lookback
 * before it (refs p1, p2, …, context only). Each topic update claims one consecutive range of the
 * new messages, and within one run no two claims may cover the same messages: a section of
 * transcript belongs to exactly one topic. Two neighbours may share one boundary message (a reply
 * that closes one ask and opens the next), as long as each keeps a message of its own.
 *
 * Pure; imports nothing.
 */

/** A claimed range, as message ordinals (m3 → 3). */
export interface Claim {
  from: number;
  to: number;
}

/** The ordinal of a new-message ref ("m12" → 12); undefined for anything else, lookback refs included. */
export function refOrdinal(ref: string): number | undefined {
  const match = /^m(\d+)$/.exec(ref);
  if (!match) return undefined;
  const n = Number(match[1]);
  return n > 0 ? n : undefined;
}

/** A lookback ref ("p3"): context only, never a valid claim. */
export function lookbackRef(n: number): string {
  return `p${n}`;
}

/** The claim a (from, to) pair of refs makes, or undefined when either is not a new-message ref
 *  or the range runs backwards. */
export function claimOf(from: string, to: string): Claim | undefined {
  const a = refOrdinal(from);
  const b = refOrdinal(to);
  if (a === undefined || b === undefined || a > b) return undefined;
  return { from: a, to: b };
}

/**
 * Whether two claims may both stand in one run: they are disjoint, or one ends exactly where the
 * other begins and each still covers a message the other doesn't.
 */
export function claimsCompatible(a: Claim, b: Claim): boolean {
  if (a.to < b.from || b.to < a.from) return true;
  const [first, second] = a.from <= b.from ? [a, b] : [b, a];
  return first.from < second.from && first.to === second.from && second.to > first.to;
}

/** Whether a claim may join the ones already accepted this run (first wins). */
export function claimFits(claim: Claim, accepted: readonly Claim[]): boolean {
  return accepted.every(other => claimsCompatible(claim, other));
}
