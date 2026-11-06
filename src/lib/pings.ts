// A ping's card in the chat that pinged (§app.overseer-pings/tool "Its card"), as the page draws it. Who sent a
// passed-on note and the Overseer's ping turn are shared/senders.ts's. Pure: no DOM, no Solid.

import { PING_KINDS, type PingKind, type PingRoute } from "../../shared/protocol";
import { pingTurnBody } from "../../shared/senders";
import { pingCardData, PING_CARD_TYPE, type CardInfo } from "../../shared/transcript-cards";

/** What a successful `overseer_ping` call's result carries (server/overseer-pings.ts): its ping, kind and route, and
    the id of the card Sova raised for it, if it could. */
export interface PingCallDetails {
  v: 1;
  ping: string;
  kind: PingKind;
  route: PingRoute;
  card?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The call's details when they are a ping's, the same object (so a row's value keeps its identity); else undefined. */
export function pingDetailsOf(v: unknown): PingCallDetails | undefined {
  if (!isObject(v) || v.v !== 1 || typeof v.ping !== "string" || !PING_KINDS.includes(v.kind as PingKind)) return undefined;
  const r = v.route;
  if (!isObject(r) || !(r.kind === "overseer" || (r.kind === "project" && typeof r.projectName === "string"))) return undefined;
  if (v.card !== undefined && typeof v.card !== "string") return undefined;
  return v as unknown as PingCallDetails;
}

/** The ping turn's body as its row draws it (§app.overseer-pings/wake): each line its own, as the Overseer read it.
    The text is the model's, quoted line by line with `> `; as markdown, a label line would run on into the quote. */
export const pingTurnLines = (text: string): string => pingTurnBody(text).replace(/\n/g, "  \n");

/** The ping's card as it reads: "Told the Overseer", "{Kind}: {summary}", then one line per outcome. */
export interface PingCardView {
  title: string;
  line: string;
  outcomes: string[];
}

/**
 * The ping's card: the card Sova keeps for it once the page has it, revised in place with each outcome; until then
 * what the call itself says, with no outcome yet.
 */
export function pingCardView(details: PingCallDetails, args: unknown, stored: CardInfo | undefined): PingCardView {
  const data = stored?.type === PING_CARD_TYPE && isObject(stored.data) ? stored.data : undefined;
  if (data && typeof data.title === "string" && typeof data.line === "string") {
    const detail = typeof data.detail === "string" ? data.detail : "";
    return { title: data.title, line: data.line, outcomes: detail.split("\n").filter((l) => l.trim()) };
  }
  const summary = isObject(args) && typeof args.summary === "string" ? args.summary : "";
  const own = pingCardData({ kind: details.kind, summary, route: details.route, outcomes: [] });
  return { title: own.title, line: own.line, outcomes: [] };
}
