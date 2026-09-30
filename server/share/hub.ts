import type { WebSocket } from "ws";
import { OPERATOR, type BatonSession, type GoneWhy, type BatonView, type BatonViewItem, type PersonRef, type ShareServerMessage } from "../../shared/baton";
import { batonById, linkAccess, namesOf, outsiderCut, sessionPathOf } from "../baton";
import { batonView, conversationVocabulary, redactPhrases, secretPhrases } from "../baton-view";
import { profileRedactTexts, publicTerms, readOrg, readRoster } from "../orgs";

const orgName = (orgId: string): string => {
  try {
    return readOrg(orgId).name.trim();
  } catch {
    return "";
  }
};
import { hashToken } from "../baton-links";
import { serverRedactor } from "../overseer-redact";
import { readActiveBranch } from "../transcript";
import { photosFor } from "../baton-images";

/**
 * The share page's live side (§app.baton/outsider-view): who is watching which baton session, and
 * what they are sent. A socket gets the filtered view again after every change, and, while the model
 * writes, ONLY the reply's text so far — the raw event stream the operator's /ws/chat carries never
 * reaches it. One socket per token: a new one replaces the old (a reload must not lock anyone out).
 */

/** Every string an outsider may see goes through the server's secret redactor (`redact`). What
    the model wrote also loses the roster's profile phrases (`said`), except those that are ordinary
    words of this org or conversation (`vocabulary`): no one sees anyone's profile or the org's
    name, and no one's job title or decision area is blanked for it (§app.organizations/privacy). */
export function outsiderRedactor(orgId: string, vocabulary: readonly string[] = []) {
  const roster = readRoster(orgId);
  // The org's name too: the model is never told it, but a goal may carry it.
  const phrases = secretPhrases([...roster.flatMap(profileRedactTexts), orgName(orgId)], [...publicTerms(roster), ...vocabulary]).filter(Boolean);
  const secrets = serverRedactor();
  return { redact: (text: string) => secrets.redact(text), said: (text: string) => redactPhrases(text, phrases), phrases };
}

/** The phrases each session's last view hid, for its streaming text between views. */
const streamPhrases = new Map<string, string[]>();

/** The filtered view of a baton session for `viewer` (a person id), or with no viewer (the project
    overseer's reads: every briefing). */
export async function readView(
  row: BatonSession,
  dir: string,
  viewer?: PersonRef,
  untilOffer?: number,
  /** Receives the view's photos in order (the image route), and the branch it read. */
  out?: { collect?: { data: string; mimeType: string }[]; branch?: Record<string, any>[] },
): Promise<BatonView> {
  const branch = (await readActiveBranch(sessionPathOf(dir, row)).catch(() => [])) as Record<string, any>[];
  if (out) out.branch = branch;
  const r = outsiderRedactor(row.orgId, [row.publicTitle, ...conversationVocabulary(branch)]);
  streamPhrases.set(row.sessionId, r.phrases);
  return batonView({
    row,
    branch,
    names: namesOf(row.orgId),
    ...(viewer ? { viewer } : {}),
    ...(untilOffer !== undefined ? { untilOffer } : {}),
    redact: r.redact,
    said: r.said,
    ...(out?.collect ? { collect: out.collect } : {}),
  });
}

/** The view a token's holder gets, with what their link may do now. An offer's invitee who has not
    held THAT offer sees the conversation only up to it: never what another invitee said since, even
    when they held an earlier hand-off of the session, and through any link of theirs (outsiderCut). */
export async function viewForToken(token: string): Promise<BatonView | { status: 404 | 410; why?: GoneWhy }> {
  const access = linkAccess(token);
  if (!access.ok) return { status: access.status, ...(access.why ? { why: access.why } : {}) };
  const out: { branch?: Record<string, any>[] } = {};
  const view = await readView(access.row, access.dir, access.link.personId, outsiderCut(access.row, access.link.personId), out);
  const names = namesOf(access.row.orgId);
  // The paperclip only while this link writes, photos are on and the model sees images (§app.baton/images).
  const photos = access.canWrite ? await photosFor(access.row, access.dir, undefined, out.branch).catch(() => null) : null;
  return {
    ...view,
    items: opaqueSenders(view.items, access.link.personId),
    viewer: {
      name: names[access.link.personId] ?? "You",
      canWrite: access.canWrite,
      ...(access.reason ? { reason: access.reason } : {}),
      ...(photos ? { photos: { perMessage: photos.perMessage, maxBytes: photos.maxBytes } } : {}),
    },
  };
}

/** The `n`-th photo of the view this token's person gets (the same cuts), or the dead link's
    status, or null when the view has no such photo. */
export async function imageForToken(token: string, n: number): Promise<{ data: string; mimeType: string } | null | { status: 404 | 410; why?: GoneWhy }> {
  const access = linkAccess(token);
  if (!access.ok) return { status: access.status, ...(access.why ? { why: access.why } : {}) };
  const collect: { data: string; mimeType: string }[] = [];
  await readView(access.row, access.dir, access.link.personId, outsiderCut(access.row, access.link.personId), { collect });
  return collect[n] ?? null;
}

/**
 * A share page never learns a roster person's id: a message's `by` becomes "you" (the viewer),
 * "operator", or a label numbered in order of appearance in this view ("person-1", …), which
 * tells two senders apart and means nothing outside the view.
 */
export function opaqueSenders(items: BatonViewItem[], viewer: PersonRef): BatonViewItem[] {
  const labels = new Map<string, string>();
  return items.map((it) => {
    if (it.kind !== "message") return it;
    let by = it.by === viewer ? "you" : it.by === OPERATOR ? OPERATOR : it.by ? labels.get(it.by) : "";
    if (by === undefined) labels.set(it.by, (by = `person-${labels.size + 1}`));
    return { ...it, by };
  });
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

/**
 * Close every open socket whose link no longer reads (it expired, or was turned off by a path that
 * pushes nothing): an expired link's page must not stay connected until the session next changes.
 * Runs on a ticker; returns how many it closed.
 */
export function sweepWatchers(): number {
  let closed = 0;
  for (const set of watchers.values())
    for (const w of [...set]) {
      const access = linkAccess(w.token);
      if (access.ok) continue;
      send(w, { type: "error", code: "gone", message: "This link is no longer active.", ...(access.why ? { why: access.why } : {}) });
      w.socket.close(4410, "gone");
      set.delete(w);
      closed++;
    }
  for (const [sid, set] of watchers) if (!set.size) watchers.delete(sid);
  return closed;
}
/** The token hashes of every open hand-off page socket, for the Shares page's "viewing now". */
export function watchedHashes(): Set<string> {
  const out = new Set<string>();
  for (const set of watchers.values()) for (const w of set) if (w.socket.readyState === w.socket.OPEN) out.add(hashToken(w.token));
  return out;
}

export const SWEEP_MS = 30_000;
setInterval(sweepWatchers, SWEEP_MS).unref();

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
      send(w, { type: "error", code: view.status === 410 ? "gone" : "not-found", message: view.status === 410 ? "This link is no longer active." : "Unknown link.", ...(view.why ? { why: view.why } : {}) });
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
  const r = outsiderRedactor(hit.row.orgId, [hit.row.publicTitle]);
  const cached = streamPhrases.get(sessionId);
  const redacted = cached ? redactPhrases(r.redact(text), cached) : r.said(r.redact(text));
  // An invitee who never held the offer sees the conversation only up to it: not its replies either.
  for (const w of set) if (!offerOutsider(w.token)) send(w, { type: "streaming", text: redacted });
}

/** Whether a token's person reads the session only up to an offer they never held (outsiderCut). */
export function offerOutsider(token: string): boolean {
  const access = linkAccess(token);
  return !access.ok || outsiderCut(access.row, access.link.personId) !== undefined;
}

export const watcherCount = (sessionId: string): number => watchers.get(sessionId)?.size ?? 0;
