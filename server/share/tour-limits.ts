import { RateLimiter } from "./rate-limit";

export const OWNER_READS_PER_MINUTE = 120;
const ownerReads = new RateLimiter(OWNER_READS_PER_MINUTE);
const pictures = { h: new RateLimiter(240), i: new RateLimiter(120), t: new RateLimiter(240) };
export const ownerReadTokenLimited = (token: string, now = Date.now()): boolean => ownerReads.limited(token, now);
/** Call only after current authorization and exact immutable inventory membership are established. */
export const tourImageTokenLimited = (kind: "h" | "i" | "t", token: string, now = Date.now()): boolean => pictures[kind].limited(token, now);
export class TourReadRateLimit extends Error {
  constructor() { super("Too many tour requests. Wait a minute, then try again."); }
}
