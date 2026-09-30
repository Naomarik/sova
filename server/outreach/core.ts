import { LINK_WARNINGS } from "../../shared/public-links";
import { OPERATOR } from "../../shared/baton";
import { linkMessage, OUTREACH_NOT_READY, waDigits, type ChannelId, type OutreachLogLine, type SendLinkAnswer, type SendOutcome } from "../../shared/outreach";
import { linksOfKey, mintLink, revokeLinks } from "../baton-links";
import { batonAct, batonById, currentOffer, operatorOn, targetOfPerson } from "../baton";
import { operatorName, OrgError, readRoster, type OperatorBy } from "../orgs";
import { awaitShareLinks } from "../share/links-events";
import { linkUrl, shareState } from "../share/listener";
import { appendSendLog, applyReceipt, newSendId, rememberRef } from "./log";
import { readOutreach } from "./settings";
import type { Channel } from "./types";
import { whatsapp } from "./whatsapp";

/**
 * The outreach core (§app/outreach): an intent (send-link today) → the person's address on the
 * channel → pause and readiness → mint → the channel → the send log. Called by the baton chart's
 * `send-link` effect (server/baton-loadout.ts), so every trigger shares it. The result reaches the
 * transition log: outcome and code only, never the token, the link, the number or the message.
 */

export interface SendLinkResult {
  outcome: SendOutcome;
  channel: ChannelId;
  code?: string;
  why?: string;
  retryable?: boolean;
}

export interface SendLinkInput {
  orgId: string;
  sessionId: string;
  n: number;
  personId: string;
  offerId?: string;
  by: OutreachLogLine["by"];
  /** The effect's key: the minted link's key and part of the channel's idempotency key. */
  key: string;
}

const channels: Record<ChannelId, Channel> = { whatsapp };

let receiptsWired = false;
function wireReceipts(): void {
  if (receiptsWired) return;
  receiptsWired = true;
  for (const ch of Object.values(channels)) ch.onReceipt((r) => applyReceipt(r));
}

/** At server start: receipts of earlier sends find their log lines as soon as the sender replays them. */
export function startOutreach(): void {
  wireReceipts();
  void whatsapp.status().catch(() => {});
}

/** Why the channel can't be used for this person now (§app.outreach/send-link), or null. */
export function notReady(orgId: string, personId: string): { code: keyof typeof OUTREACH_NOT_READY; why: string } | null {
  const f = readOutreach();
  if (f.sender === "off") return { code: "off", why: OUTREACH_NOT_READY.off };
  if (f.paused) return { code: "paused", why: OUTREACH_NOT_READY.paused };
  const p = readRoster(orgId).find((x) => x.id === personId);
  if (!waDigits(p?.contact?.whatsapp)) return { code: "no-number", why: `${p?.name ?? "They"} ${p ? "has" : "have"} no WhatsApp number on the roster.` };
  return null;
}

/**
 * The operator's Send on WhatsApp (and the global Overseer's `send_link`, with its card in `by`):
 * the chart's `baton/send-link` act, settled, so the answer is the effect's outcome. `personId`
 * defaults to the holder; an offer needs one invitee named. A guard's refusal throws as the route answers it.
 */
export async function sendLinkAct(sessionId: string, personId: string | undefined, by: OperatorBy = { kind: "operator" }): Promise<SendLinkAnswer> {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const row = hit.row;
  const offer = currentOffer(row);
  const pid = personId || (offer ? undefined : row.holder && row.holder !== OPERATOR ? row.holder : undefined);
  if (!pid) throw new OrgError(offer ? "Name one of the invitees (person)." : "No person holds the baton, so there is no link to send.", offer ? 400 : 409);
  const p = readRoster(row.orgId).find((x) => x.id === pid);
  const payload = { ...(p ? { target: targetOfPerson({ ...p, orgId: row.orgId }) } : { invalid: "person must be a roster person's id" }), ...(by.via ? { via: by.via } : {}) };
  const out = await batonAct(sessionId, "baton/send-link", payload, operatorOn(by), { settle: true });
  const name = p?.name ?? "They";
  const eff = out.effects?.find((e) => e.kind === "send-link");
  const r = eff?.result as SendLinkResult | undefined;
  if (!r) return { outcome: "failed", channel: "whatsapp", name, code: "internal", why: eff?.error ?? "The send didn't report back." };
  return { ...r, name };
}

export async function sendLink(input: SendLinkInput, channel: Channel = channels.whatsapp): Promise<SendLinkResult> {
  wireReceipts();
  const { orgId, sessionId, n, personId, offerId, by, key } = input;
  const base: Omit<OutreachLogLine, "at" | "event"> = { id: newSendId(), personId, channel: channel.id, intent: "send-link", sessionId, n, ...(offerId ? { offerId } : {}), by };
  const log = (event: OutreachLogLine["event"], code?: string) => appendSendLog(orgId, { at: new Date().toISOString(), ...base, event, ...(code ? { code } : {}) });
  const refuse = (code: string, why: string): SendLinkResult => {
    log("refused", code);
    return { outcome: "refused", channel: channel.id, code, why };
  };

  // Run again after a restart: whatever happened, nobody has that link now. It stops, and nothing is sent twice.
  if (linksOfKey(key).length) {
    revokeLinks((l) => l.key === key);
    log("failed", "unknown-after-restart");
    return { outcome: "failed", channel: channel.id, code: "unknown-after-restart", why: "Sova restarted during the send, so it may not have gone: send it again." };
  }
  const nr = notReady(orgId, personId);
  if (nr) return refuse(nr.code, nr.why);
  const warn = shareState().warningCode;
  if (warn === "off" || warn === "unreachable" || warn === "not-accepted") return refuse(`link-${warn}`, LINK_WARNINGS[warn]);
  const hit = batonById(sessionId);
  if (!hit) return refuse("no-session", "That session is gone.");
  const person = readRoster(orgId).find((x) => x.id === personId)!;
  const digits = waDigits(person.contact?.whatsapp)!;

  // As Get Link: the older links of that hand-off (or that invitee's, in the offer) stop working.
  if (offerId) revokeLinks((l) => l.sessionId === sessionId && l.offerId === offerId && l.personId === personId);
  else revokeLinks((l) => l.sessionId === sessionId && l.n === n);
  const { result: token } = await awaitShareLinks(() => mintLink({ orgId, sessionId, n, personId, ...(offerId ? { offerId } : {}), key }));
  const text = linkMessage(operatorName(), hit.row.publicTitle, linkUrl("h", token));
  const r = await channel.send({ idem: `${sessionId}#${n}#${personId}#${key}`, address: digits, text });
  if (r.ok) {
    const line: OutreachLogLine = { at: r.at, ...base, event: "sent" };
    appendSendLog(orgId, line);
    rememberRef(r.ref, orgId, line);
    return { outcome: "sent", channel: channel.id };
  }
  // A definite failure: exactly the link it minted stops, so Needs you asks again.
  revokeLinks((l) => l.key === key);
  log("failed", r.code);
  return { outcome: "failed", channel: channel.id, code: r.code, why: r.why, retryable: r.retryable };
}
