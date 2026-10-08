import type { OllamaActivity, OllamaCredits, OllamaReading, UsageProvider } from "../../shared/protocol";
const valid = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function includedCreditPct(c: OllamaCredits | undefined): number | undefined {
 const a = c?.included?.allowance_usd, b = c?.included?.balance_usd;
 return valid(a) && valid(b) && a > 0 && b <= a ? (a - b) / a * 100 : undefined;
}
export function endpointPrevious<T>(r: OllamaReading<T> | undefined, now: number): boolean {
 return !r?.data || !valid(r.fetchedAt) || r.fetchedAt > now || now - r.fetchedAt > 600_000 || !!r.error;
}
export function currentIncluded(p: UsageProvider, now: number): boolean {
 const r = p.credits, period = r?.data?.included?.period;
 return !endpointPrevious(r, now) && !!period && Date.parse(period.from) <= now && now < Date.parse(period.until) && includedCreditPct(r?.data) !== undefined;
}
export const reportedMoney = (n: number | undefined) => valid(n) ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n) : "Unknown";
export const reportedCount = (n: number | undefined) => valid(n) && Number.isSafeInteger(n) ? n.toLocaleString("en-US") : "Unknown";
export function activityMetrics(a: OllamaActivity): { label: string; value: string }[] {
 return [
  { label: "Reported USD", value: reportedMoney(a.totals.usage_usd) },
  { label: "Requests", value: reportedCount(a.totals.request_count) },
  { label: "Input tokens", value: reportedCount(a.totals.input_tokens) },
  { label: "Cached input tokens (included in input)", value: reportedCount(a.totals.cached_input_tokens) },
  { label: "Output tokens", value: reportedCount(a.totals.output_tokens) },
 ];
}
/** UTC day slots; absent days/amounts remain gaps, never a zero-height reported value. */
export function activityTrend(a: OllamaActivity): { date: string; usd?: number; partial: boolean; from: string; until: string }[] {
 const start = Date.parse(a.from), end = Date.parse(a.until);
 if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
 const rows = [];
 for (let t = Math.floor(start / 86_400_000) * 86_400_000; t < end && rows.length < 32; t += 86_400_000) {
  const buckets = a.buckets.filter((b) => Date.parse(b.from) >= t && Date.parse(b.from) < t + 86_400_000);
  const date = new Date(t).toISOString().slice(0, 10);
  if (!buckets.length) rows.push({ date, partial: start > t || end < t + 86_400_000, from: new Date(Math.max(start, t)).toISOString(), until: new Date(Math.min(end, t + 86_400_000)).toISOString() });
  for (const b of buckets) rows.push({ date: buckets.length > 1 ? `${date} ${b.from.slice(11, 16)}` : date, ...(valid(b.usage_usd) ? { usd: b.usage_usd } : {}), partial: b.partial || start > t || end < t + 86_400_000, from: b.from, until: b.until });
 }
 return rows;
}
