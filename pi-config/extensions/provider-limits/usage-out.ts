/**
 * Whether a failed request or turn says its provider is OUT OF USAGE: the usage, credits, quota,
 * balance or billing ran out, a usage limit was reached (monthly, weekly or 5-hour included), or
 * the sign-in no longer works. A plain 429 "rate limit" / "too many requests" is not, and neither is
 * a quota or limit over a short window (per minute, second or hour, RPM, TPM, "requests per",
 * "tokens per"): that is a short wait, retried where it happens.
 *
 * One classifier for two readers: the provider-limits gate (a 429 that is out of usage is not
 * re-queued, §app.provider-limits/rate-limit) and the subagents extension (a coordinator or
 * monitor that fails out of usage moves to its fallback at once, §teams.defaults/runtime-fallback).
 * Imports nothing, so either extension can load it.
 */

export type UsageOutKind = "usage" | "auth";

export interface UsageOut {
	kind: UsageOutKind;
	/** A short phrase that follows the model's name: "hit its monthly usage limit", "can't sign in". */
	reason: string;
}

/** A usage limit reached, by its window. Matches Claude Code's own texts (claude-code/transport.ts LIMIT_TEXT) too. */
const MONTHLY = /\bmonthly (?:usage )?limit|\bmonth(?:ly)? quota/i;
const WEEKLY = /\bweekly (?:usage )?limit|\bweek(?:ly)? quota/i;
const LIMIT = /usage limit|hit your (?:usage )?limit|out of (?:extra )?usage|limit will reset|(?:5|five)[- ]?h(?:our)? limit/i;
/** A 5-hour window: usage, not a short wait ("Usage limit reached for 5 hour", "5h limit"). */
const FIVE_HOUR = /\b(?:5|five)[- ]?h(?:ours?)?\b/i;
/**
 * A short window: per minute, second or hour, RPM/TPM, "requests per", "tokens per". Such a quota or
 * limit is a rate limit, waited out where it happens ("429 RESOURCE_EXHAUSTED: Quota exceeded for
 * metric x, limit: 15 per minute"), never spent usage.
 */
const SHORT_WINDOW = /\bper[- ]?(?:minute|min|second|sec|hour)\b|\b(?:rpm|tpm|rps|tps)\b|\brequests? per\b|\btokens? per\b/i;
/** Credits, quota, balance or billing ran out. */
const FUNDS = /quota|\bcredits?\b|billing|insufficient|\bbalance\b|payment required|\b402\b/i;
/** The sign-in no longer works (Claude Code's AUTH_TEXT words included). */
const AUTH = /not logged in|please (?:run )?\/?log ?in\b|\/login\b|sign-?in (?:failed|expired|required)|invalid (?:api[ _-]?key|bearer token|x-api-key|credentials)|authentication(?:_error| failed| error)|failed to authenticate|oauth token (?:has )?(?:expired|been revoked|revoked)|\bunauthori[sz]ed\b|\bforbidden\b|(?:^|[^\w.])40[13](?![\w.])/i;

/** The out-of-usage reading of an error text, or undefined when it is something else (a blip, a bug, a plain rate limit). */
export function usageOut(message: string | undefined): UsageOut | undefined {
	const text = (message ?? "").slice(0, 4_000);
	if (!text.trim()) return undefined;
	if (MONTHLY.test(text)) return { kind: "usage", reason: "hit its monthly usage limit" };
	if (WEEKLY.test(text)) return { kind: "usage", reason: "hit its weekly usage limit" };
	if (LIMIT.test(text) && FIVE_HOUR.test(text)) return { kind: "usage", reason: "hit its usage limit" };
	// A quota or limit over a short window is a rate limit, whatever else it says.
	if (SHORT_WINDOW.test(text)) return undefined;
	if (LIMIT.test(text)) return { kind: "usage", reason: "hit its usage limit" };
	if (FUNDS.test(text)) return { kind: "usage", reason: "ran out of credits or quota" };
	if (AUTH.test(text)) return { kind: "auth", reason: "can't sign in" };
	return undefined;
}

/** Whether the text says the usage itself ran out (not a sign-in failure): what a rate-limit retry must never re-queue. */
export function isUsageExhausted(message: string | undefined): boolean {
	return usageOut(message)?.kind === "usage";
}
