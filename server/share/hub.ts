import type { WebSocket } from "ws";
import type { BatonSession, BatonView, PersonRef, ShareServerMessage } from "../../shared/baton";
import { batonById, linkAccess, namesOf, sessionPathOf } from "../baton";
import { batonView, redactPhrases } from "../baton-view";
import { profileRedactTexts, readRoster } from "../orgs";
import { serverRedactor } from "../overseer-redact";
import { readActiveBranch } from "../transcript";

/**
 * The share page's live side (§app.baton/outsider-view): who is watching which baton session, and
 * what they are sent. A socket gets the filtered view again after every change, and, while the model
 * writes, ONLY the reply's text so far — the raw event stream the operator's /ws/chat carries never
 * reaches it. One socket per token: a new one replaces the old (a reload must not lock anyone out).
 */

/** Every string an outsider may see goes through this: the server's secret redactor, then every
    roster person's profile phrases (no one sees anyone's profile, their own included). */
export function outsiderRedactor(orgId: string): (text: string) => string {
  const phrases = readRoster(orgId).flatMap(profileRedactTexts);
  const secrets = serverRedactor();
  return (text) => redactPhrases(secrets.redact(text), phrases);
}

/** The filtered view of a baton session for `viewer` (a person id), or for the operator's replay
    (no viewer: every briefing). */
export async function readView(row: BatonSession, dir: string, viewer?: PersonRef, untilOffer?: number): Promise<BatonView> {
  const branch = (await readActiveBranch(sessionPathOf(dir, row)).catch(() => [])) as Record<string, any>[];
  return batonView({
    row,
    branch,
    names: namesOf(row.orgId),
    ...(viewer ? { viewer } : {}),
    ...(untilOffer !== undefined ? { untilOffer } : {}),
    redact: outsiderRedactor(row.orgId),
  });
}

/** The view a token's holder gets, with what their link may do now. An offer's invitee who has not
    held it sees the conversation only up to the offer: never what another invitee said since. */
export async function viewForToken(token: string): Promise<BatonView | { status: 404 | 410 }> {
  const access = linkAccess(token);
  if (!access.ok) return { status: access.status };
  const outsider = !!access.link.offerId && !access.row.participants.includes(access.link.personId);
  const view = await readView(access.row, access.dir, access.link.personId, outsider ? access.link.n : undefined);
  const names = namesOf(access.row.orgId);
  return { ...view, viewer: { name: names[access.link.personId] ?? "You", canWrite: access.canWrite, ...(access.reason ? { reason: access.reason } : {}) } };
}

interface Watcher {
  socket: WebSocket;
  token: string;
}

const watchers = new Map<string, Set<Watcher>>();
const pending = new Map<string, NodeJS.Timeout>();
const lastStream = new Map<string, number>();

function send(w: Watcher, msg: ShareServerMessage): void {
  if (w.socket.readyState === w.socket.OPEN) w.socket.send(JSON.stringify(msg));
}

export function addWatcher(sessionId: string, socket: WebSocket, token: string): void {
  let set = watchers.get(sessionId);
  if (!set) watchers.set(sessionId, (set = new Set()));
  for (const w of [...set])
    if (w.token === token) {
      set.delete(w);
      w.socket.close(4000, "Opened elsewhere");
    }
  const w = { socket, token };
  set.add(w);
  socket.on("close", () => {
    set!.delete(w);
    if (!set!.size) watchers.delete(sessionId);
  });
}

/** Push every watcher of a session its view again (debounced: a burst of entries is one push). */
export function refreshShare(sessionId: string): void {
  if (!watchers.has(sessionId) || pending.has(sessionId)) return;
  pending.set(
    sessionId,
    setTimeout(() => {
      pending.delete(sessionId);
      void pushViews(sessionId);
    }, 60),
  );
}

async function pushViews(sessionId: string): Promise<void> {
  for (const w of [...(watchers.get(sessionId) ?? [])]) {
    const view = await viewForToken(w.token).catch(() => null);
    if (!view) continue;
    if ("status" in view) {
      send(w, { type: "error", code: view.status === 410 ? "gone" : "not-found", message: view.status === 410 ? "This link is no longer active." : "Unknown link." });
      w.socket.close(4410, "gone");
      continue;
    }
    send(w, { type: "view", view });
  }
}

/** The reply being written, text only, at most ~10 pushes a second. */
export function streamShare(sessionId: string, text: string): void {
  const set = watchers.get(sessionId);
  if (!set?.size) return;
  const now = Date.now();
  if (now - (lastStream.get(sessionId) ?? 0) < 100) return;
  lastStream.set(sessionId, now);
  const hit = batonById(sessionId);
  if (!hit) return;
  const redacted = outsiderRedactor(hit.row.orgId)(text);
  // An invitee who never held the offer sees the conversation only up to it: not its replies either.
  for (const w of set) if (!offerOutsider(w.token)) send(w, { type: "streaming", text: redacted });
}

/** Whether a token is an offer link of someone who has never held the baton in this session. */
export function offerOutsider(token: string): boolean {
  const access = linkAccess(token);
  return !access.ok || (!!access.link.offerId && !access.row.participants.includes(access.link.personId));
}

export const watcherCount = (sessionId: string): number => watchers.get(sessionId)?.size ?? 0;
