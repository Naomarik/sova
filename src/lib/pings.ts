// Sessions ping the Overseer (§app/overseer-pings), as the page draws it: the ping's card in the
// pinging chat, the Overseer's ping turn, and a passed-on note's sender. Pure: no DOM, no Solid.

import { OVERSEER_PING_PREFIX, PING_KINDS, type PingKind, type PingRoute, type TranscriptItem } from "../../shared/protocol";
import { sendersOf, type Sender } from "../../shared/senders";
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

/** A ping's call as its card draws from it: the call's details (a row that keeps its content, or the running turn), or the
    card Sova keeps for the call (a slim row's: the page has only the card). */
export type PingCall = PingCallDetails | CardInfo;

/** The value a ping's call draws from, the same object it was given; else undefined. */
export function pingCallOf(v: unknown): PingCall | undefined {
  return pingDetailsOf(v) ?? (isObject(v) && v.type === PING_CARD_TYPE && typeof v.id === "string" ? (v as unknown as CardInfo) : undefined);
}

/** The id of the card the ping's call stands for, if any. */
export const pingCardId = (call: PingCall): string | undefined => ("type" in call ? call.id : call.card);

/** The ping's card as it reads: "Told the Overseer", "{Kind}: {summary}", then one line per outcome. */
export interface PingCardView {
  title: string;
  line: string;
  outcomes: string[];
}

/**
 * The ping's card (§app.overseer-pings/tool "Its card"): the card Sova keeps for it once the page has it, revised in
 * place with each outcome; until then what the call itself says, with no outcome yet.
 */
export function pingCardView(call: PingCall, args: unknown, stored: CardInfo | undefined): PingCardView {
  const card = stored?.type === PING_CARD_TYPE ? stored : "type" in call && call.type === PING_CARD_TYPE ? call : undefined;
  const data = card && isObject(card.data) ? card.data : undefined;
  if (data && typeof data.title === "string" && typeof data.line === "string") {
    const detail = typeof data.detail === "string" ? data.detail : "";
    return { title: data.title, line: data.line, outcomes: detail.split("\n").filter((l) => l.trim()) };
  }
  if ("type" in call) return { title: call.title, line: "", outcomes: [] };
  const summary = isObject(args) && typeof args.summary === "string" ? args.summary : "";
  const own = pingCardData({ kind: call.kind, summary, route: call.route, outcomes: [] });
  return { title: own.title, line: own.line, outcomes: [] };
}

/** An Overseer ping turn (§app.overseer-pings/wake), by its prefix: never the user's own words. */
export const isPingText = (text: string | undefined): boolean => !!text && text.trimStart().startsWith(OVERSEER_PING_PREFIX);
/** The ping turn's own words, without the prefix. */
export const pingTurnBody = (text: string): string => text.trimStart().slice(OVERSEER_PING_PREFIX.length).trim();

/** A note the Overseer passed on (its `sova-relay-sent` marker, §app.overseer-pings/relay): from the session that pinged. */
export type RelaySender = { kind: "relay"; sessionId: string; title: string; hop: number };
/** A user row's sender as the views draw it. */
export type ViewSender = Sender | RelaySender;

/** Target entry id → the passed-on note's sender, from every `sova-relay-sent` marker in `items`, in either arrival order. */
export function relaySendersOf(items: readonly TranscriptItem[]): Map<string, RelaySender> {
  const out = new Map<string, RelaySender>();
  for (const it of items) if (it.relayMark?.kind === "sent") out.set(it.relayMark.targetId, { kind: "relay", ...it.relayMark.from, hop: it.relayMark.hop });
  return out;
}

/** shared/senders.ts `sendersOf`, plus the passed-on notes' markers, which name their row over any other marker. */
export function viewSendersOf(items: readonly TranscriptItem[]): Map<string, ViewSender> {
  const out: Map<string, ViewSender> = sendersOf(items);
  for (const [id, s] of relaySendersOf(items)) out.set(id, s);
  return out;
}

const RELAY_HEADER = "[passed on by the Overseer";
/** A passed-on note's words as the views show them: without its `[passed on by the Overseer …]` line. */
export function relayBody(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith(RELAY_HEADER)) return text;
  const nl = t.indexOf("\n");
  return nl < 0 ? "" : t.slice(nl + 1).trimStart();
}
