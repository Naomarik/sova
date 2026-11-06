/**
 * The OpenAI (ChatGPT subscription) sign-in of Settings → Accounts (§app.openai-login): the words
 * its section and sign-in panel show. DOM- and Solid-free, so the unit tests read the same sentences.
 */
import type { OpenAiAccountInfo, OpenAiLoginFlow, UsageProvider } from "../../shared/protocol";
import { stampTime } from "./format";
import { openAiSignInStopped, planLabel } from "./insights";

export type { OpenAiAccountInfo, OpenAiLoginFlow };

/** The flow is still running: the panel stays open, polls, and closing Settings cancels it. */
export const flowOpen = (f: OpenAiLoginFlow | null | undefined): boolean =>
  !!f && (f.state === "starting" || f.state === "code" || f.state === "browser" || f.state === "finishing");

/** What the section shows, from the sign-in's standing and the latest usage reading of OpenAI. */
export type OpenAiStanding = "signed-out" | "signed-in" | "sign-in-again";

export function standingOf(info: OpenAiAccountInfo, usage: UsageProvider | undefined, now = Date.now()): OpenAiStanding {
  if (!info.signedIn) return "signed-out";
  return openAiSignInStopped(usage, now) ? "sign-in-again" : "signed-in";
}

/** The section's one muted note for this device, or null. */
export function sectionNote(info: OpenAiAccountInfo): string | null {
  if (info.apiKeysOnly) return "This device shares API keys only, so this sign-in stays on this device.";
  if (!info.signedIn && info.codexAppSignedIn) return "The Codex app is signed in here, but Sova's chats need their own sign-in.";
  return null;
}

/**
 * The facts after "Signed in": the plan once a usage reading named it, then when the sign-in renews,
 * in the Usage page's words for its sign-in line.
 */
export function signedInFacts(info: OpenAiAccountInfo, usage: UsageProvider | undefined, now = Date.now()): string[] {
  const plan = usage?.id === "openai" && usage.auth?.source !== "codex-cli" ? planLabel(usage) : null;
  const renews = info.expiresAt !== undefined && info.expiresAt > now ? `Sign-in renews by ${stampTime(info.expiresAt, now)}` : null;
  return [plan, renews].filter((s): s is string => !!s);
}

/** What Sign Out's question says goes away, then what stays. */
export function signOutText(info: OpenAiAccountInfo): string {
  const who = info.email ?? "OpenAI";
  const where = info.meshSharesLogins
    ? `Sova signs ${who} out here and on the other devices that share sign-ins.`
    : `Sova signs ${who} out on this device.`;
  return `${where} Chats on ChatGPT models stop until you sign in again. The Codex app's sign-in and other providers' stay.`;
}

/** A sentence that ends with its period, then what wasn't saved. */
export const failedText = (error: string): string => `${error.trim().replace(/([^.?])$/, "$1.")} Nothing was saved.`;

/** The panel's sentence for a sign-in that ended itself. */
export const EXPIRED_TEXT = "The sign-in was left alone for 15 minutes and ended. Nothing was saved.";
