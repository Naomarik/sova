import type { ProviderLimits } from "../../shared/provider-limits";

/**
 * Settings → Models' "At once" fields (§app.provider-limits/setting), pure. The draft is each
 * provider's field text as typed ("" = no limit); the saved side is the file's limits
 * (GET/PUT /api/settings/provider-limits, ~/.pi/agent/provider-limits.json). Save re-reads the file
 * and applies only the fields the user changed, like the policy's save.
 */
export type LimitsDraft = Record<string, string>;

export const LIMIT_MIN = 1;
export const LIMIT_MAX = 999;

/** A field's value: a limit, null for none (empty), or "invalid". */
export function parseLimitField(text: string): number | null | "invalid" {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= LIMIT_MIN && n <= LIMIT_MAX ? n : "invalid";
}

export const limitsDraftOf = (limits: ProviderLimits): LimitsDraft => Object.fromEntries(Object.entries(limits).map(([p, n]) => [p, String(n)]));

/** The draft as limits, or the first provider whose field isn't a limit. */
export function limitsOfDraft(draft: LimitsDraft): { limits: ProviderLimits } | { invalid: string } {
  const limits: ProviderLimits = {};
  for (const [provider, text] of Object.entries(draft)) {
    const v = parseLimitField(text);
    if (v === "invalid") return { invalid: provider };
    if (v !== null) limits[provider] = v;
  }
  return { limits };
}

const fieldOf = (limits: ProviderLimits, provider: string): string => (limits[provider] === undefined ? "" : String(limits[provider]));

export function sameLimits(draft: LimitsDraft, saved: ProviderLimits): boolean {
  const parsed = limitsOfDraft(draft);
  if ("invalid" in parsed) return false;
  const a = parsed.limits;
  const keys = new Set([...Object.keys(a), ...Object.keys(saved)]);
  for (const k of keys) if (a[k] !== saved[k]) return false;
  return true;
}

/** `draft` was an edit of `base`; the file now has `fresh`: keep the fields the user changed, follow the file elsewhere. */
export function rebaseLimits(draft: LimitsDraft, base: ProviderLimits, fresh: ProviderLimits): LimitsDraft {
  const out: LimitsDraft = limitsDraftOf(fresh);
  for (const [provider, text] of Object.entries(draft)) {
    const edited = parseLimitField(text) === "invalid" || parseLimitField(text) !== parseLimitField(fieldOf(base, provider));
    if (edited) out[provider] = text;
  }
  // A field the user cleared (removed a limit the base had) is an edit too.
  for (const provider of Object.keys(base)) if (!(provider in draft)) out[provider] = "";
  return out;
}

/** Why the draft can't be saved, naming the provider, or null. */
export function limitsProblem(draft: LimitsDraft): string | null {
  const parsed = limitsOfDraft(draft);
  return "invalid" in parsed ? `Request limits: ${parsed.invalid}'s At once must be a whole number from ${LIMIT_MIN} to ${LIMIT_MAX}, or empty for no limit.` : null;
}
