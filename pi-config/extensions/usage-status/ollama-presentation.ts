import { creditsCurrent, includedPct, parseActivity, parseCredits, parseReading, readingStale } from "./ollama.ts";
import type { OllamaData } from "./fetch.ts";
const usd = (n: number | undefined) => n === undefined ? "Unknown" : `$${n.toFixed(2)}`;
const count = (n: number | undefined) => n === undefined ? "Unknown" : n.toLocaleString("en-US");
/** Pure, Bun-compatible presentation seam: no pi/TUI import or global theme. */
export function ollamaDetail(o: OllamaData, now: number): string[] {
 const rows: string[] = [];
 const a = parseReading(o.activity, parseActivity), c = parseReading(o.credits, parseCredits);
 const freshness = (name: string, r: typeof a | typeof c, expired = false) => `${name}: ${readingStale(r, now) || expired ? "Previous reading" : "as of"}${r?.fetchedAt !== undefined ? ` ${new Date(r.fetchedAt).toISOString()}` : " · time unknown"}${r?.error ? ` · ${r.error}` : ""}`;
 if (c) {
  const i = c.data?.included, p = i?.period;
  rows.push(freshness("Credits", c, !!p && (now < Date.parse(p.from) || now >= Date.parse(p.until))));
  rows.push(`Included remaining: ${usd(i?.balance_usd)}`, `Included allowance: ${usd(i?.allowance_usd)}`);
  if (p) rows.push(`Included period: ${p.from} → ${p.until} UTC (end exclusive)`);
  const pct = includedPct(c.data);
  if (pct !== undefined) rows.push(`Included credits used: ${Math.round(pct)}%`);
  rows.push(`Purchased remaining: ${usd(c.data?.purchased?.balance_usd)}`);
  for (const key of ["session", "weekly"] as const) {
   const w = c.data?.[key];
   if (w) rows.push(`${key}: ${w.remaining_percent}% remaining${w.resets_at ? ` · resets ${w.resets_at}` : ""}`);
  }
 }
 if (a) {
  rows.push(freshness("Activity", a));
  if (a.data) {
   const d = a.data;
   rows.push(`${d.from} → ${d.until} UTC (end exclusive) · ${d.scope}`, `Reported USD: ${usd(d.totals.usage_usd)} (request value, plan + purchased)`, `Requests: ${count(d.totals.request_count)}`, `Input tokens: ${count(d.totals.input_tokens)}`, `Cached input tokens (included in input): ${count(d.totals.cached_input_tokens)}`, `Output tokens: ${count(d.totals.output_tokens)}`, "Usage may be delayed.");
  }
 }
 return rows;
}
export function ollamaCompact(o: OllamaData, now: number): string | undefined {
 const c = parseReading(o.credits, parseCredits), a = parseReading(o.activity, parseActivity);
 if (o.state === "ok" && !a?.data && !c?.data?.included?.period) return undefined;
 if (c?.data) return creditsCurrent(c, now) ? `oll incl ${usd(c.data.included?.balance_usd)}` : "oll credits ?";
 if (a?.data) return `oll act ${a.data.totals.request_count === undefined ? "?" : count(a.data.totals.request_count)} req${readingStale(a, now) ? " (previous)" : ""} · credits ?`;
 if (a || c) return "oll credits ?";
 return undefined;
}
