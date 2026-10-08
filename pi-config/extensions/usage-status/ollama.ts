// Pure Ollama response/cache boundary. Only allowlisted metadata and metrics survive.
export interface ActivityMetrics {
 request_count?: number;
 usage_usd?: number;
 input_tokens?: number;
 cached_input_tokens?: number;
 output_tokens?: number;
}
export interface ActivityBucket extends ActivityMetrics { from: string; until: string; partial: boolean }
export interface OllamaActivity {
 range: "24h" | "7d" | "30d";
 scope: "self" | "team";
 from: string;
 until: string;
 totals: ActivityMetrics;
 buckets: ActivityBucket[];
}
export interface OllamaCredits {
 included?: { balance_usd?: number; allowance_usd?: number; period?: { from: string; until: string } };
 purchased?: { balance_usd: number };
 session?: { remaining_percent: number; resets_at?: string };
 weekly?: { remaining_percent: number; resets_at?: string };
}
export interface OllamaEndpoint { fetchedAt?: number; error?: string }
export interface OllamaReading<T> extends OllamaEndpoint { data?: T }
/** Additive usage-endpoint status also covers legacy percentages without activity data. */
export function parseEndpoint(v: unknown): OllamaEndpoint | undefined {
 if (!rec(v)) return;
 const t = count(v.fetchedAt), fetchedAt = t !== undefined && t <= 8.64e15 ? t : undefined;
 const error = typeof v.error === "string" && /^(?:ollama (?:activity|balance) (?:HTTP \d{3}|unavailable|no key|bad key|request failed)|ollama reading unavailable)$/.test(v.error) ? v.error : v.error !== undefined ? "ollama reading unavailable" : undefined;
 return fetchedAt !== undefined || error ? { ...(fetchedAt !== undefined ? { fetchedAt } : {}), ...(error ? { error } : {}) } : undefined;
}
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const nonnegative = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const count = (v: unknown) => Number.isSafeInteger(v) ? nonnegative(v) : undefined;
/** Strict UTC RFC3339 instants: no local/nonzero offset, calendar rollover or precision loss. */
export function utc(v: unknown): string | undefined {
 if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(v)) return;
 const ms = Date.parse(v);
 if (!Number.isFinite(ms)) return;
 const canonical = new Date(ms).toISOString();
 if (canonical.slice(0, 19) !== v.slice(0, 19)) return;
 const normalized = v.replace(/\+00:00$/, "Z");
 return /\.\d{4,9}Z$/.test(normalized) ? normalized : canonical;
}
// RFC3339 strings with unequal fractional precision do not sort directly; pad only for ordering.
const utcKey = (v: string) => `${v.slice(0, 19)}.${(v.slice(19).match(/^\.(\d+)Z$/)?.[1] ?? "").padEnd(9, "0")}Z`;
function interval(v: unknown): { from: string; until: string } | undefined {
 if (!rec(v)) return;
 const from = utc(v.from), until = utc(v.until);
 return from && until && utcKey(from) < utcKey(until) ? { from, until } : undefined;
}
function metrics(v: unknown): ActivityMetrics {
 const out: ActivityMetrics = {};
 if (!rec(v)) return out;
 for (const key of ["request_count", "input_tokens", "cached_input_tokens", "output_tokens"] as const) {
  const n = count(v[key]);
  if (n !== undefined) out[key] = n;
 }
 const dollars = nonnegative(v.usage_usd);
 if (dollars !== undefined) out.usage_usd = dollars;
 return out;
}
export function parseActivity(v: unknown): OllamaActivity | undefined {
 if (!rec(v)) return;
 const span = interval(v);
 if (!span || typeof v.range !== "string" || !["24h", "7d", "30d"].includes(v.range) || typeof v.scope !== "string" || !["self", "team"].includes(v.scope) || !rec(v.totals) || !Array.isArray(v.buckets) || v.buckets.length > 32) return;
 const maxDays = v.range === "30d" ? 31 : v.range === "7d" ? 8 : 2;
 if (Date.parse(span.until) - Date.parse(span.from) > maxDays * 86_400_000 || count(v.totals.request_count) === undefined) return;
 const buckets: ActivityBucket[] = [];
 let end = span.from;
 for (const b of v.buckets) {
  const part = interval(b);
  if (!rec(b) || !part || count(b.request_count) === undefined || (b.partial !== undefined && typeof b.partial !== "boolean") || utcKey(part.from) < utcKey(end) || utcKey(part.from) < utcKey(span.from) || utcKey(part.until) > utcKey(span.until)) return;
  // A daily bucket never straddles UTC midnight (except its exclusive end).
  const start = Date.parse(part.from);
  const midnight = Math.floor(start / 86_400_000) * 86_400_000;
  const dayStart = utcKey(new Date(midnight).toISOString()), dayEnd = utcKey(new Date(midnight + 86_400_000).toISOString());
  if (utcKey(part.until) > dayEnd) return;
  buckets.push({ ...part, ...metrics(b), partial: b.partial === true || utcKey(part.from) !== dayStart || utcKey(part.until) !== dayEnd });
  end = part.until;
 }
 return { ...span, range: v.range as OllamaActivity["range"], scope: v.scope as OllamaActivity["scope"], totals: metrics(v.totals), buckets };
}
export function parseCredits(v: unknown): OllamaCredits | undefined {
 if (!rec(v)) return;
 const out: OllamaCredits = {};
 if (rec(v.included)) {
  const balance_usd = nonnegative(v.included.balance_usd), allowance_usd = nonnegative(v.included.allowance_usd), period = interval(v.included.period);
  if (balance_usd !== undefined || allowance_usd !== undefined || period) out.included = { ...(balance_usd !== undefined ? { balance_usd } : {}), ...(allowance_usd !== undefined ? { allowance_usd } : {}), ...(period ? { period } : {}) };
 }
 if (rec(v.purchased)) {
  const balance_usd = nonnegative(v.purchased.balance_usd);
  if (balance_usd !== undefined) out.purchased = { balance_usd };
 }
 for (const key of ["session", "weekly"] as const) {
  const w = v[key];
  if (!rec(w)) continue;
  const n = nonnegative(w.remaining_percent), resets_at = utc(w.resets_at);
  if (n !== undefined && n <= 100) out[key] = { remaining_percent: n, ...(resets_at ? { resets_at } : {}) };
 }
 return Object.keys(out).length ? out : undefined;
}
export function parseReading<T>(v: unknown, parse: (v: unknown) => T | undefined): OllamaReading<T> | undefined {
 if (!rec(v)) return;
 const data = parse(v.data);
 // Errors are controlled fetcher messages, never arbitrary persisted strings/identities.
 const endpoint = parseEndpoint(v);
 return data || endpoint?.error ? { ...(data ? { data } : {}), ...endpoint } : undefined;
}
export function includedPct(c: OllamaCredits | undefined): number | undefined {
 const a = c?.included?.allowance_usd, b = c?.included?.balance_usd;
 return a !== undefined && b !== undefined && a > 0 && b <= a ? (a - b) / a * 100 : undefined;
}
export function readingStale<T>(r: OllamaReading<T> | undefined, now: number): boolean {
 return !r?.data || r.fetchedAt === undefined || !!r.error || now - r.fetchedAt > 600_000 || r.fetchedAt > now;
}
export function creditsCurrent(r: OllamaReading<OllamaCredits> | undefined, now: number): boolean {
 const p = r?.data?.included?.period;
 return !readingStale(r, now) && !!p && Date.parse(p.from) <= now && now < Date.parse(p.until) && includedPct(r?.data) !== undefined;
}
