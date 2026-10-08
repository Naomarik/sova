import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OPERATOR } from "../../shared/baton";
import { composeMessage, notSentReason, OUTREACH_NOT_READY, waDigits, type ChannelId, type LinkRef, type OutreachLogLine, type SendAnswer, type SendOutcome } from "../../shared/outreach";
import { batonById, currentOffer, targetOfPerson } from "../baton";
import { holdSendKey, releaseSendKey } from "../baton-links";
import { hostOf, heldAt, onOrgHostOpened, refusalError, type Effect, type OrgHostApi } from "../org-engine";
import type { Envelope } from "../org-envelope";
import { OrgError, placementSid, readRoster } from "../orgs";
import { projectSid } from "../projects/sids";
import { readOverseerState } from "../overseer-store";
import { stateRoot } from "../state-root";
import { LinkRefused, parseLinkRef, RESOLVERS } from "./links";
import { appendSendLog, applyReceipt, newSendId, rememberRef } from "./log";
import { readOutreach } from "./settings";
import type { Channel } from "./types";
import { whatsapp } from "./whatsapp";

/**
 * The outreach core (§app/outreach): send a roster person a link and/or a short note. The person's
 * address on the channel → pause and readiness → the link's resolver (a reference the server turns
 * into a URL in this step: server/outreach/links.ts) → the channel → the send log. Every trigger
 * goes through the project statechart's `outreach/send` act (holds, confirm kinds, working hours, the
 * confirm card), whose `outreach-send` effect runs `send`. Results name the outcome only: never a
 * token, a link, a number or the message.
 */

export interface SendResult {
  outcome: SendOutcome;
  channel: ChannelId;
  code?: string;
  why?: string;
  retryable?: boolean;
}

export interface SendInput {
  orgId: string;
  projectId: string;
  personId: string;
  link?: LinkRef;
  note?: string;
  by: OutreachLogLine["by"];
  /** Who a link made in this step records as its maker: `operator`, or the sending overseer's `session:<id>`. */
  createdBy?: string;
  /** The effect's key: part of the channel's idempotency key, and what a step run again finds. */
  key: string;
}

export const NOTE_MAX = 500;

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

/** Why the channel can't be used for this person now (§app.outreach/send), or null. */
export function notReady(orgId: string, personId: string): { code: keyof typeof OUTREACH_NOT_READY; why: string } | null {
  const f = readOutreach();
  if (f.sender === "off") return { code: "off", why: OUTREACH_NOT_READY.off };
  if (f.paused) return { code: "paused", why: OUTREACH_NOT_READY.paused };
  const p = readRoster(orgId).find((x) => x.id === personId);
  if (!waDigits(p?.contact?.whatsapp)) return { code: "no-number", why: `${p?.name ?? "They"} ${p ? "has" : "have"} no WhatsApp number on the roster.` };
  return null;
}

// ---- steps in flight: what a step made, so a step run again after a restart turns it off --------------

const pendingFile = () => join(stateRoot(), "outreach-pending.json");
function readPending(): Record<string, { kind: string; minted: Record<string, string> }> {
  try {
    const raw = JSON.parse(readFileSync(pendingFile(), "utf8"));
    return raw && typeof raw === "object" && raw.steps && typeof raw.steps === "object" ? raw.steps : {};
  } catch {
    return {};
  }
}
function writePending(steps: ReturnType<typeof readPending>): void {
  const path = pendingFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, steps })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
function setPending(key: string, v: { kind: string; minted: Record<string, string> } | null): void {
  const steps = readPending();
  if (v) steps[key] = v;
  else delete steps[key];
  writePending(steps);
}

// ---- the send --------------------------------------------------------------------------------------

export async function send(input: SendInput, channel: Channel = channels.whatsapp): Promise<SendResult> {
  // What this send mints is never handed out again (Get Link kept, another send) until it settles:
  // a definite failure turns it off.
  holdSendKey(input.key);
  try {
    return await sendStep(input, channel);
  } finally {
    releaseSendKey(input.key);
  }
}

async function sendStep(input: SendInput, channel: Channel): Promise<SendResult> {
  wireReceipts();
  const { orgId, projectId, personId, link, by, key } = input;
  const note = input.note?.trim() || undefined;
  const base: Omit<OutreachLogLine, "at" | "event"> = { id: newSendId(), personId, channel: channel.id, intent: "send", projectId, ...(link ? { link: link.kind } : {}), ...(note ? { note: true as const } : {}), by };
  const log = (event: OutreachLogLine["event"], code?: string, extra: Partial<OutreachLogLine> = {}) =>
    appendSendLog(orgId, { at: new Date().toISOString(), ...base, ...extra, event, ...(code ? { code } : {}) });
  const refuse = (code: string, why: string): SendResult => {
    log("refused", code);
    return { outcome: "refused", channel: channel.id, code, why };
  };

  // Run again after a restart: the message may or may not have gone. Nothing is sent twice; what the
  // step made stays (the person may have it), and the send is logged as unknown.
  const again = readPending()[key];
  if (again) {
    setPending(key, null);
    log("unknown", "unknown-after-restart");
    return { outcome: "failed", channel: channel.id, code: "unknown-after-restart", why: "Sova restarted during the send, so it may or may not have gone." };
  }
  const nr = notReady(orgId, personId);
  if (nr) return refuse(nr.code, nr.why);
  // A held send runs later: its link is checked again now.
  const resolver = link ? RESOLVERS[link.kind] : null;
  const ctx = { orgId, projectId, personId };
  const bad = resolver && link ? resolver.check(ctx, link) : null;
  if (bad) return refuse(bad.code, bad.why);
  const digits = waDigits(readRoster(orgId).find((x) => x.id === personId)?.contact?.whatsapp)!;

  let resolved: Awaited<ReturnType<NonNullable<typeof resolver>["resolve"]>> | null = null;
  if (resolver && link) {
    try {
      resolved = await resolver.resolve({ ...ctx, key, createdBy: input.createdBy ?? "operator" }, link);
    } catch (err) {
      return refuse(err instanceof LinkRefused ? err.code : "link", err instanceof Error ? err.message : String(err));
    }
    setPending(key, { kind: link.kind, minted: resolved.minted });
  }
  const text = composeMessage(note ?? resolved?.line, resolved?.url);
  const r = await channel.send({ idem: `${projectId}#${personId}#${key}`, address: digits, text });
  const ids = resolved?.log ?? {};
  if (r.ok) {
    const line: OutreachLogLine = { at: r.at, ...base, ...ids, event: "sent" };
    appendSendLog(orgId, line);
    rememberRef(r.ref, orgId, line);
    if (resolver?.settle && resolved) resolver.settle(resolved.minted);
    setPending(key, null);
    return { outcome: "sent", channel: channel.id };
  }
  setPending(key, null);
  // Uncertain (the request left, no answer): what the step made stays, and the send is logged as unknown.
  if (r.code === "unknown") {
    log("unknown", r.code, ids);
    return { outcome: "failed", channel: channel.id, code: r.code, why: r.why, retryable: false };
  }
  // A definite failure: exactly what this step made stops (a hand-off link's Needs you asks again).
  if (resolver && resolved) resolver.revoke(resolved.minted);
  log("failed", r.code, ids);
  return { outcome: "failed", channel: channel.id, code: r.code, why: r.why, retryable: r.retryable };
}

// ---- the act -----------------------------------------------------------------------------------------

/** A note repeating private text: refused like an owner update (the overseer's prompt holds it). */
async function noteLeak(orgId: string, projectId: string, note: string): Promise<string | null> {
  if (!note) return null;
  const { ownerUpdateLeak } = await import("../overseer-org-part");
  return ownerUpdateLeak(orgId, projectId, note)
    ? "This note repeats private text (About this organization, notes, a goal or briefing, a profile or a contact). Write it again in your own words."
    : null;
}

/**
 * The project statechart's `outreach/send`, settled: the statechart checks the person, the link (the host's
 * `invalid`), the note, the card and the level; an unattended overseer's send waits in the hold.
 * A refusal throws as the route answers it.
 */
export async function sendAct(input: { orgId: string; projectId: string; personId: string; link?: LinkRef; note?: string; sentBy: OutreachLogLine["by"] }, envelope: Envelope): Promise<SendAnswer> {
  const { orgId, projectId, personId, link } = input;
  const p = readRoster(orgId).find((x) => x.id === personId);
  const note = (input.note ?? "").trim();
  const invalid = p && link ? (RESOLVERS[link.kind].check({ orgId, projectId, personId }, link)?.why ?? null) : null;
  const leak = await noteLeak(orgId, projectId, note);
  const payload = {
    ...(p ? { target: targetOfPerson({ ...p, orgId }) } : {}),
    ...(link ? { link } : {}),
    ...(note ? { note } : {}),
    ...(invalid ? { invalid } : {}),
    ...(leak ? { leak } : {}),
    sentBy: input.sentBy,
  };
  const sid = placementSid(orgId, projectId);
  const out = await hostOf(orgId).act(sid, "outreach/send", payload, envelope, { settle: true });
  if (!out.taken) throw refusalError(out.refusal ?? { sentence: "That can't be done now." });
  const name = p?.name ?? "They";
  if (out.held) {
    const h = heldAt(sid, out.held);
    return { outcome: "sent", channel: "whatsapp", name, held: { id: h.id, goesAt: new Date(h.until).toISOString(), what: `A WhatsApp message to ${name}` } };
  }
  const eff = out.effects?.find((e) => e.kind === "outreach-send");
  const r = eff?.result as SendResult | undefined;
  if (!r) return { outcome: "failed", channel: "whatsapp", name, code: "internal", why: eff?.error ?? "The send didn't report back." };
  return { ...r, name };
}

/**
 * The operator's Send on WhatsApp on a gathering (and the global Overseer's, with its card in the
 * envelope): its hand-off link to the holder, or to one reached invitee of the open offer.
 */
export async function sendHandoffLink(sessionId: string, personId: string | undefined, note: string | undefined, envelope: (orgId: string, projectId: string) => Envelope, sentBy: OutreachLogLine["by"]): Promise<SendAnswer> {
  const hit = batonById(sessionId);
  if (!hit) throw new OrgError("Unknown baton session", 404);
  const row = hit.row;
  const offer = currentOffer(row);
  const pid = personId || (offer ? undefined : row.holder && row.holder !== OPERATOR ? row.holder : undefined);
  if (!pid) throw new OrgError(offer ? "Name one of the invitees (person)." : "No person holds the baton, so there is no link to send.", offer ? 400 : 409);
  return sendAct({ orgId: row.orgId, projectId: row.projectId, personId: pid, link: { kind: "handoff", session: sessionId }, ...(note ? { note } : {}), sentBy }, envelope(row.orgId, row.projectId));
}

// ---- the effect --------------------------------------------------------------------------------------

/** Who a link a send makes records as its maker (§app.outreach/links): the operator, else the overseer that sent it —
    the project's overseer conversation (its project statechart's own), or the current global Overseer. */
function makerOf(host: OrgHostApi, projectId: string, by: OutreachLogLine["by"]): string {
  const id = by === "project-overseer" ? (host.data(projectSid(projectId))?.overseer as { id?: unknown } | undefined)?.id : by === "operator-via-overseer" ? readOverseerState()?.current : null;
  return typeof id === "string" && id ? `session:${id}` : "operator";
}

/**
 * A project overseer's send that did not go (§app.outreach/send) is a feed entry of its project, so its
 * pipeline and next look say "not sent" with the reason; the release that ran it never reads as a send.
 */
async function feedNotSent(host: OrgHostApi, orgId: string, sessionId: string, projectId: string, personId: string, r: SendResult): Promise<void> {
  const name = readRoster(orgId).find((x) => x.id === personId)?.name ?? "They";
  await host.logAct({
    session: sessionId,
    statechart: host.statechartOf(sessionId) ?? null,
    event: "outreach/not-sent",
    by: "overseer",
    project: projectId,
    before: [],
    after: [],
    effects: [],
    refused: `Not sent to ${name}: ${r.why ?? notSentReason(r.code)}`,
    ...(r.code ? { code: r.code } : {}),
  });
}

function registerOutreachEffects(host: OrgHostApi, orgId: string): void {
  host.effects.register("outreach-send", async (e: Effect) => {
    // `placement/<org>/<project>`
    const sessionId = String(e.sessionId);
    const projectId = String(host.data(sessionId)?.projectId ?? "");
    const link = parseLinkRef(e.link) ?? undefined;
    const by = e.by === "operator-via-overseer" || e.by === "project-overseer" ? e.by : "operator";
    const key = typeof e.statechartKey === "string" && e.statechartKey ? e.statechartKey : String(e.key);
    const personId = String(e.personId);
    const r = await send({ orgId, projectId, personId, ...(link ? { link } : {}), ...(typeof e.note === "string" ? { note: e.note } : {}), by, createdBy: makerOf(host, projectId, by), key });
    if (r.outcome !== "sent" && by === "project-overseer") await feedNotSent(host, orgId, sessionId, projectId, personId, r).catch((err) => console.warn(`[outreach] could not log a send that did not go: ${err instanceof Error ? err.name : "error"}`));
    return r;
  });
}
onOrgHostOpened(registerOutreachEffects);
