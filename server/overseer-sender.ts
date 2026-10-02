import { randomBytes, timingSafeEqual } from "node:crypto";
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
