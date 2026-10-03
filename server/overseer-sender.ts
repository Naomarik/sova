import { randomBytes, timingSafeEqual } from "node:crypto";
import type { EnvelopeCard } from "./org-envelope";
import { readOverseerState } from "./overseer-store";

/** The header the Overseer's in-process tool calls carry, and its value: a secret made at server
    start, held only in memory, never written or sent to a client. A prompt carrying it is tagged
    as the Overseer's; any HTTP client can send the header, but not the value. */
export const OVERSEER_SENDER_HEADER = "x-sova-overseer";
const SENDER_SECRET = randomBytes(32).toString("hex");
/** The value the Overseer's own in-process calls carry (server/overseer.ts). */
export const senderSecret = (): string => SENDER_SECRET;

/** The current Overseer's id when `header` is the sender secret (a tool call of its own), else undefined. */
export function overseerSender(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const got = Buffer.from(header);
  const want = Buffer.from(SENDER_SECRET);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  return readOverseerState()?.current || undefined;
}

/** The header carrying the confirm card the Overseer's tool call was opened by (overseer-tools cardHeader). */
export const OVERSEER_CARD_HEADER = "x-sova-overseer-card";

/** The confirm card in `header`; null when none or unreadable. Only trusted on a request overseerSender accepts. */
export function overseerCard(header: string | undefined): EnvelopeCard | null {
  if (!header) return null;
  try {
    const v = JSON.parse(header) as Record<string, unknown>;
    const ids = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
    return { people: ids("people"), projects: ids("projects"), sessions: ids("sessions") };
  } catch {
    return null;
  }
}
