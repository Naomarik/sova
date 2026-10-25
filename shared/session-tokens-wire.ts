// One Agents board row's output tokens as GET /api/insights/agents sends them (`tokens`,
// §app.insights/session-token-rate): a single string per row, so the browser's 5 s poll compares
// each row in one step instead of walking an object of lists (Solid's reconcile costs per object).
// Pure: the server encodes, the board decodes.

import type { SessionTokens } from "./protocol";

/**
 * `"{end} {own30} {workers30} {own} {workers}"`, plus ` p` when partial: `end` the server's 30 s
 * epoch slot, `own30`/`workers30` the 30-minute totals, `own`/`workers` the last 5 minutes' slots
 * joined by commas, oldest first and ending at `end` (`-` for none).
 */
export function encodeSessionTokens(t: SessionTokens): string {
  const list = (l: readonly number[] | undefined) => (l && l.length ? l.join(",") : "-");
  return `${t.end} ${t.own30 ?? 0} ${t.workers30 ?? 0} ${list(t.own)} ${list(t.workers)}${t.partial ? " p" : ""}`;
}

/** The row as sent; null when it isn't one (an unknown row reads as no tokens, never a guess). */
export function decodeSessionTokens(s: unknown): SessionTokens | null {
  if (typeof s !== "string") return null;
  const f = s.split(" ");
  if (f.length < 5 || f.length > 6 || (f.length === 6 && f[5] !== "p")) return null;
  const n = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN);
  const list = (v: string | undefined): number[] | undefined | null => {
    if (v === "-") return undefined;
    const out = (v ?? "").split(",").map(n);
    return out.length && out.every(Number.isSafeInteger) ? out : null;
  };
  const end = n(f[0]);
  const own30 = n(f[1]);
  const workers30 = n(f[2]);
  const own = list(f[3]);
  const workers = list(f[4]);
  if (!Number.isSafeInteger(end) || !Number.isSafeInteger(own30) || !Number.isSafeInteger(workers30) || own === null || workers === null) return null;
  return { end, ...(own ? { own, own30 } : {}), ...(workers ? { workers, workers30 } : {}), ...(f[5] === "p" ? { partial: true as const } : {}) };
}
