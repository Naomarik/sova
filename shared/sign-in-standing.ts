// Whether a usage reading's sign-in still works: one rule for the Usage page, Settings → Accounts and the Lookbook's
// Setup card (which leaves off a provider that can't run). Pure, no DOM.
import type { UsageAuth, UsageProvider } from "./protocol";

/** Its renewal is gone too: only a new sign-in helps. */
export const refreshDead = (a: UsageAuth, now: number): boolean => (a.refreshExpiresAt !== undefined ? a.refreshExpiresAt <= now : a.refreshExpired === true);

/** The access token passed its own expiry and nothing says the refresh token has: the CLI that owns it renews it the next
    time it runs (a token refused before its expiry was revoked, and only a new sign-in helps). */
export function tokenTimedOut(a: UsageAuth | undefined, now: number): boolean {
  return a?.kind === "oauth" && !!a.source && a.expiresAt !== undefined && a.expiresAt <= now && !refreshDead(a, now);
}

/**
 * The usage reading says pi's OpenAI sign-in stopped working: OpenAI refused it, or its renewal expired (a token that
 * only timed out renews the next time pi uses OpenAI, so it hasn't). A reading of the Codex app's own sign-in says
 * nothing about pi's.
 */
export function openAiSignInStopped(p: UsageProvider | undefined, now = Date.now()): boolean {
  if (!p || p.id !== "openai" || p.auth?.source === "codex-cli") return false;
  if (p.auth?.kind === "oauth" && refreshDead(p.auth, now)) return true;
  return p.state === "expired" && !tokenTimedOut(p.auth, now);
}
