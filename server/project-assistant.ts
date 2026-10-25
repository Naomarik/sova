import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { OPERATOR } from "../shared/baton";
import type { HEntry } from "../shared/harness";
import { ASSISTANT_TEXT_MAX, type AssistantMessage, type AssistantServerMessage, type AssistantView, type OwnerVersionRow } from "../shared/project-assistant";
import type { BatonPhotoSettings } from "../shared/baton";
import { acquireChatHandle, chatHandle, isSessionBusy } from "./chat-handle";
import { dropStaged, PhotoRefusal, takeStaged, type SdkImage } from "./baton-images";
import { readBatonSettings } from "./baton-settings";
import { ownerVersionOf } from "./owner-page";
import { versionRows } from "./owner-versions";
import { createSessionFile } from "./harness/pi/state";
import { joinedText, readBranch } from "./harness/pi/reader";
import { stateView } from "./harness/state-view";
import { BATON_SENT, PROJECT_ASSISTANT } from "./harness/state-kinds";
import { operatorName, orgDir, OrgError, ownerOf, readIndex, readRoster } from "./orgs";
import { sessionIdOfFile } from "./project-overseer-store";
import { canonicalPath } from "./paths";
import { conversationOf, readAssistantStore, setConversation } from "./project-assistant-store";
import { assistantReplyState } from "./project-assistant-ready";
import { pathOfId } from "./session-prompt";
import { markSeen } from "./seen";
import { cleanSessionTitle, setSessionTitle } from "./session-titles";
import { markupBackstop, redactPhrases } from "./baton-view";
import { onShareChange, onShareStream, outsiderRedactor } from "./share/hub";
import { addWebSession } from "./web-sessions";
import { markOwned } from "./write-guard";
import { batonById } from "./baton";
import { handleOf } from "./person-links";

/**
 * The Project Assistant's conversations (§app.project-assistant/chat): one per org and owner, a
 * session file in the org's workspace `sessions/` beside its batons, with the PROJECT_ASSISTANT
 * marker; `<workspace>/project-assistant.json` names the current one per owner. This module makes
 * and finds them, builds the owner's view of one (messages only: who and what, never a tool, a
 * model or an id), sends the owner's messages into it, and keeps the owner page's sockets.
 */

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The org's workspace sessions folder: baton sessions and assistant conversations alike. */
const sessionsDirOf = (orgId: string) => join(orgDir(orgId), "sessions");

/** A session file as an assistant conversation: its org, owner and id, and whether it is the current one for that owner. */
export function assistantOfPath(path: string): { orgId: string; personId: string; sessionId: string } | null {
  const id = sessionIdOfFile(path);
  for (const o of readIndex().orgs.map((x) => x.id)) {
    if (canonicalPath(sessionsDirOf(o)) !== canonicalPath(join(path, ".."))) continue;
    for (const [personId, sid] of Object.entries(readAssistantStore(o).conversations)) if (sid === id) return { orgId: o, personId, sessionId: sid };
  }
  return null;
}

const ensuring = new Map<string, Promise<{ id: string; path: string }>>();

/** The owner's current conversation, made when there is none (or its file is gone). Single-flight per org. */
export function ensureAssistant(orgId: string): Promise<{ id: string; path: string; personId: string }> {
  const owner = ownerOf(orgId);
  if (!owner) return Promise.reject(new OrgError("This organization has no owner.", 409));
  const k = `${orgId}:${owner.id}`;
  let run = ensuring.get(k);
  if (!run) {
    run = (async () => {
      const sid = conversationOf(orgId, owner.id);
      if (sid) {
        const path = await pathOfId(sid);
        if (path && existsSync(path)) return { id: sid, path };
      }
      const dir = sessionsDirOf(orgId);
      mkdirSync(dir, { recursive: true });
      const made = createSessionFile({ cwd: orgDir(orgId), sessionsDir: dir, seed: [[PROJECT_ASSISTANT, { v: 1, orgId, personId: owner.id }]] });
      const path = canonicalPath(made.path);
      markOwned(path);
      addWebSession(made.id);
      markSeen(made.id);
      setSessionTitle(made.id, cleanSessionTitle(`Project Assistant · ${firstOf(owner.name)}`) ?? null);
      setConversation(orgId, owner.id, made.id);
      return { id: made.id, path };
    })().finally(() => ensuring.delete(k));
    ensuring.set(k, run);
  }
  return run.then((r) => ({ ...r, personId: owner.id }));
}

/** The owner's current conversation's path, or null when none exists yet. */
export async function currentAssistantPath(orgId: string): Promise<string | null> {
  const owner = ownerOf(orgId);
  if (!owner) return null;
  const sid = conversationOf(orgId, owner.id);
  const path = sid ? await pathOfId(sid) : null;
  return path && existsSync(path) ? path : null;
}

// ---- the owner's view -----------------------------------------------------------------------------

/** How many messages the view carries (the newest). */
export const VIEW_MESSAGES = 200;

/** Who wrote a user message, as the owner's view shows it: its sent mark, else the team (the operator's name). */
const authorOf = (marks: ReturnType<typeof stateView>, e: HEntry): string => (e.id ? (marks.byTarget(BATON_SENT, e.id)?.data.by ?? OPERATOR) : OPERATOR);

/** The start_version tool's name, and the key of its details naming the version it started (or found running). */
const START_VERSION = "start_version";
const versionOfDetails = (d: unknown): string | null => {
  const v = d && typeof d === "object" ? (d as { version?: unknown }).version : undefined;
  return typeof v === "string" && /^v_[a-z0-9]{1,32}$/i.test(v) ? v : null;
};

/** The owner's own photos, in conversation order (§app.project-assistant/photos): what `/img/<n>` serves. */
export function assistantPhotos(branch: readonly HEntry[]): { data: string; mimeType: string }[] {
  const marks = stateView(branch);
  const out: { data: string; mimeType: string }[] = [];
  for (const e of branch)
    if (e.kind === "user" && authorOf(marks, e) !== OPERATOR) for (const b of e.blocks) if (b?.type === "image") out.push({ data: b.data, mimeType: b.mimeType });
  return out;
}

/**
 * The conversation as the owner reads it: owner, operator and assistant messages, text only, each
 * passed through the outsider redaction. The owner's own photos ride as `{n, mime}` (`n` numbering
 * them in conversation order, as assistantPhotos does), never bytes; an assistant message after a
 * start_version that named a version carries `versionHandles`, resolved to rows by assistantView.
 */
type RawMessage = AssistantMessage & { versionHandles?: string[]; featureSession?: string };

/** The feature request chat a start_feature_chat result opened (its details' session id), or null. */
const featureOfDetails = (d: unknown): string | null => {
  const v = d && typeof d === "object" ? (d as { featureChat?: unknown }).featureChat : undefined;
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
};

export function assistantMessages(orgId: string, branch: readonly HEntry[]): RawMessage[] {
  const marks = stateView(branch);
  const r = outsiderRedactor(orgId);
  const op = firstOf(operatorName());
  const out: RawMessage[] = [];
  let n = 0;
  let photo = 0;
  let started: string[] = [];
  let feature: string | null = null;
  for (const e of branch) {
    if (e.kind === "user") {
      const text = joinedText(e, { images: false }).trim();
      const by = authorOf(marks, e);
      const own = by !== OPERATOR;
      const images = own ? e.blocks.filter((b) => b?.type === "image").map((b) => ({ n: photo++, mime: (b as { mimeType: string }).mimeType })) : [];
      if (!text && !images.length) continue;
      out.push(!own ? { n: ++n, role: "operator", name: r.redact(op), text: r.redact(r.said(text)), at: e.at ?? "" } : { n: ++n, role: "owner", text: r.redact(text), at: e.at ?? "", ...(images.length ? { images } : {}) });
    } else if (e.kind === "tool-result") {
      const v = e.tool === START_VERSION && !e.isError ? versionOfDetails(e.details) : null;
      if (v && !started.includes(v)) started.push(v);
      const f = e.tool === "start_feature_chat" && !e.isError ? featureOfDetails(e.details) : null;
      if (f) feature = f;
    } else if (e.kind === "assistant") {
      const text = joinedText(e, { images: false }).trim();
      if (!text) continue;
      out.push({ n: ++n, role: "assistant", text: r.redact(r.said(text)), at: e.at ?? "", ...(started.length ? { versionHandles: started } : {}), ...(feature ? { featureSession: feature } : {}) });
      started = [];
      feature = null;
    }
  }
  return out.slice(-VIEW_MESSAGES);
}

/** Each message's version handles as rows, resolved now (state included); a version no longer listed is dropped. A
    feature request chat it opened becomes its `Open Feature Chat` row while it is the current owner's to read
    (§app.project-assistant/feature-chats); its session id never leaves. */
async function withVersions(orgId: string, msgs: RawMessage[]): Promise<AssistantMessage[]> {
  const { ownersFeatureChat } = await import("./feature-chats");
  const ownerId = ownerOf(orgId)?.id ?? null;
  const featureRow = (sid: string | undefined): AssistantMessage["featureChat"] | undefined => {
    if (!sid || !ownerId || !ownersFeatureChat(orgId, sid, ownerId)) return undefined;
    const row = batonById(sid)?.row;
    return row ? { conversation: handleOf("k", sid), title: outsiderRedactor(orgId).redact(row.publicTitle) } : undefined;
  };
  const r = outsiderRedactor(orgId);
  const rows = new Map<string, OwnerVersionRow | null>();
  for (const m of msgs)
    for (const h of m.versionHandles ?? [])
      if (!rows.has(h)) {
        const v = await ownerVersionOf(orgId, h).catch(() => null);
        rows.set(h, v ? (versionRows([v], r, orgId)[0] ?? null) : null);
      }
  return msgs.map(({ versionHandles, featureSession, ...m }) => {
    const versions = (versionHandles ?? []).map((h) => rows.get(h)).filter((x): x is OwnerVersionRow => !!x);
    const featureChat = featureRow(featureSession);
    return { ...m, ...(versions.length ? { versions } : {}), ...(featureChat ? { featureChat } : {}) };
  });
}

/** Whether the assistant's resolved reply model (the org's pick, else the default) sees images: the open
    chat's model when it is that one, else the model list's `input`. Null when none resolves; unknown is no. */
export async function assistantSeesImages(orgId: string): Promise<boolean | null> {
  const state = await assistantReplyState(orgId);
  if (!state) return null;
  const path = await currentAssistantPath(orgId);
  const live = path ? chatHandle(path)?.mirror.model : undefined;
  if (live && live.ref === state.pick.model) return live.images;
  return state.images;
}

/** What the owner may send now: the outsider photo limits, or null (photos off, not ready, or a model without vision). */
export async function assistantPhotoLimits(orgId: string, settings: BatonPhotoSettings = readBatonSettings().photos): Promise<BatonPhotoSettings | null> {
  if (!settings.enabled) return null;
  if ((await assistantReplyState(orgId))?.ready !== true) return null;
  return (await assistantSeesImages(orgId)) === true ? settings : null;
}

/** The staging key of the owner's photos (§app.project-assistant/photos): per org and owner, before any conversation exists. */
export const assistantStagingKey = (orgId: string, personId: string): string => `pa-${createHash("sha256").update(`${orgId}\0${personId}`).digest("hex").slice(0, 24)}`;

/** The view for the owner page (or the operator's preview): empty before the first message. */
export async function assistantView(orgId: string): Promise<AssistantView> {
  const ready = (await assistantReplyState(orgId))?.ready === true;
  const path = await currentAssistantPath(orgId);
  const limits = ready ? await assistantPhotoLimits(orgId).catch(() => null) : null;
  const photos = limits ? { photos: { perMessage: limits.perMessage, maxBytes: limits.maxBytes } } : {};
  if (!path) return { ready, busy: false, messages: [], ...photos };
  const branch = await readBranch(path).catch((): HEntry[] => []);
  const busy = isSessionBusy(path);
  const streaming = busy ? streams.get(path) : undefined;
  return { ready, busy, messages: await withVersions(orgId, assistantMessages(orgId, branch)), ...(streaming ? { streaming } : {}), ...photos };
}

/** The owner's n-th photo (assistantPhotos order), or null. */
export async function assistantPhoto(orgId: string, n: number): Promise<{ data: string; mimeType: string } | null> {
  if (!Number.isInteger(n) || n < 0) return null;
  const path = await currentAssistantPath(orgId);
  if (!path) return null;
  return assistantPhotos(await readBranch(path).catch((): HEntry[] => []))[n] ?? null;
}

// ---- the owner's messages -------------------------------------------------------------------------

export class AssistantRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 409 | 413 | 429 | 503 | 507 = 409,
  ) {
    super(message);
  }
}

/** The owner sends a message, with photos they staged (ids): refused while no reply model is set or a reply is being written. */
export async function sendOwnerMessage(orgId: string, raw: unknown, imageIds: readonly string[] = []): Promise<void> {
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (!text && !imageIds.length) throw new AssistantRefusal("bad-request", "Write something first.", 400);
  if (text.length > ASSISTANT_TEXT_MAX) throw new AssistantRefusal("bad-request", `Messages are limited to ${ASSISTANT_TEXT_MAX} characters.`, 400);
  if (text.startsWith("/")) throw new AssistantRefusal("bad-request", "Messages can't start with /.", 400);
  // The one readiness predicate (project-assistant-ready.ts): a resolved reply model this host runs and policy allows.
  const state = await assistantReplyState(orgId);
  if (!state?.ready) throw new AssistantRefusal("not-ready", "The Project Assistant isn't ready yet.");
  const reply = state.pick;
  const limits = imageIds.length ? await assistantPhotoLimits(orgId).catch(() => null) : null;
  if (imageIds.length && !limits) throw new AssistantRefusal("no-photos", "Photos can't be sent here.");
  if (limits && imageIds.length > limits.perMessage) throw new AssistantRefusal("too-many", `Up to ${limits.perMessage} photos per message.`, 400);
  const owner = ownerOf(orgId);
  const key = owner ? assistantStagingKey(orgId, owner.id) : "";
  // The photos, read before anything is sent: an expired one sends the page back to upload it.
  let images: SdkImage[] | undefined;
  if (imageIds.length)
    try {
      images = takeStaged(key, owner!.id, imageIds);
    } catch (err) {
      if (err instanceof PhotoRefusal) throw new AssistantRefusal(err.code, err.message, err.status);
      throw err;
    }
  const conv = await ensureAssistant(orgId);
  if (isSessionBusy(conv.path)) throw new AssistantRefusal("busy", "Wait for the answer first.");
  let chat;
  try {
    chat = await acquireChatHandle(conv.path);
  } catch (err) {
    throw new AssistantRefusal("busy", `The Project Assistant can't take a message right now (${err instanceof Error ? err.message : String(err)}).`, 503);
  }
  // Nothing runs on a model nobody chose (§app.project-assistant/models): the chat answers on the org's
  // resolved reply model as it is now (its pick, else the default), and a model this host can't run leaves it not ready.
  if ((await chat.findModel(reply.model)).ok !== true) throw new AssistantRefusal("not-ready", "The Project Assistant isn't ready yet.");
  try {
    if (chat.mirror.model?.ref !== reply.model) await chat.setModel(reply.model);
    if (reply.thinking) await chat.setThinking(reply.thinking);
    await chat.assertModelAllowed();
  } catch (err) {
    throw new AssistantRefusal("not-ready", `The Project Assistant isn't ready yet (${err instanceof Error ? err.message : String(err)}).`);
  }
  // The sender IS the link's owner: never the operator, whatever the text says.
  await chat.send({ text, ...(images ? { images } : {}), origin: "server", sentByBaton: { by: conv.personId } });
  // In the transcript now, inline: the staged copies go (a refused message keeps them for the retry).
  if (images) dropStaged(key, imageIds);
  refreshAssistant(orgId);
}

// ---- the owner page's sockets ---------------------------------------------------------------------

const sockets = new Map<string, Set<{ socket: WebSocket; token: string }>>();
/** The reply so far, per conversation path, while it is written (text only, redacted at push). */
const streams = new Map<string, string>();
const pending = new Map<string, NodeJS.Timeout>();
const lastStream = new Map<string, number>();

function send(socket: WebSocket, msg: AssistantServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

/** A page's socket joins its org's assistant: one per token (a reload replaces it). */
export function addAssistantSocket(orgId: string, socket: WebSocket, token: string): void {
  let set = sockets.get(orgId);
  if (!set) sockets.set(orgId, (set = new Set()));
  for (const w of [...set])
    if (w.token === token) {
      set.delete(w);
      w.socket.close(4000, "Opened elsewhere");
    }
  const w = { socket, token };
  set.add(w);
  socket.on("close", () => {
    set!.delete(w);
    if (!set!.size) sockets.delete(orgId);
  });
  void assistantView(orgId).then((view) => send(socket, { type: "view", view }));
}

/** Push every socket of an org its view again (debounced). */
export function refreshAssistant(orgId: string): void {
  if (!sockets.has(orgId) || pending.has(orgId)) return;
  pending.set(
    orgId,
    setTimeout(() => {
      pending.delete(orgId);
      void assistantView(orgId).then((view) => {
        for (const w of sockets.get(orgId) ?? []) send(w.socket, { type: "view", view });
      });
    }, 60),
  );
}

/** The reply being written: its text so far, redacted, at most ~10 pushes a second. */
export function streamAssistant(orgId: string, path: string, text: string): void {
  streams.set(path, text);
  const set = sockets.get(orgId);
  if (!set?.size) return;
  const now = Date.now();
  if (now - (lastStream.get(path) ?? 0) < 100) return;
  lastStream.set(path, now);
  const r = outsiderRedactor(orgId);
  const out = r.redact(r.said(text));
  for (const w of set) send(w.socket, { type: "streaming", text: out });
}

/** The reply ended: its streaming text goes. */
export function endAssistantStream(orgId: string, path: string): void {
  streams.delete(path);
  lastStream.delete(path);
  refreshAssistant(orgId);
}

// ---- the owner's feature request chats on the same socket (§app.project-assistant/feature-chats) ----------------

/** The org and the owner's handle of a feature request chat the current owner opened, or null. */
async function ownersChat(sessionId: string): Promise<{ orgId: string; handle: string; publicTitle: string } | null> {
  const row = batonById(sessionId)?.row;
  if (!row || !sockets.has(row.orgId)) return null;
  const owner = ownerOf(row.orgId)?.id;
  const { ownersFeatureChat } = await import("./feature-chats");
  return owner && ownersFeatureChat(row.orgId, sessionId, owner) ? { orgId: row.orgId, handle: handleOf("k", sessionId), publicTitle: row.publicTitle } : null;
}

const conversationPending = new Set<string>();
onShareChange((sessionId) => {
  if (conversationPending.has(sessionId)) return;
  conversationPending.add(sessionId);
  setTimeout(() => {
    conversationPending.delete(sessionId);
    void ownersChat(sessionId).then((hit) => {
      if (!hit) return;
      for (const w of sockets.get(hit.orgId) ?? []) send(w.socket, { type: "conversation", conversation: hit.handle });
    });
  }, 60).unref?.();
});

const lastConversationStream = new Map<string, number>();
onShareStream((sessionId, text) => {
  const now = Date.now();
  if (now - (lastConversationStream.get(sessionId) ?? 0) < 100) return;
  lastConversationStream.set(sessionId, now);
  void ownersChat(sessionId).then((hit) => {
    if (!hit) return;
    // Filtered as a hand-off page's streaming text: the secret redactor, the profile phrases, the markup backstop.
    const r = outsiderRedactor(hit.orgId, [hit.publicTitle]);
    const out = markupBackstop(redactPhrases(r.redact(text), r.phrases), r.phrases);
    for (const w of sockets.get(hit.orgId) ?? []) send(w.socket, { type: "conversation-streaming", conversation: hit.handle, text: out });
  });
});

/** Close every socket of an org whose token no longer opens (a sweep calls it with the check). */
export function sweepAssistantSockets(alive: (token: string) => boolean): number {
  let n = 0;
  for (const set of sockets.values())
    for (const w of [...set])
      if (!alive(w.token)) {
        send(w.socket, { type: "error", code: "gone", message: "This link is no longer active." });
        w.socket.close(4410, "gone");
        set.delete(w);
        n++;
      }
  return n;
}

/** The owner's first name, for the prompt (never their profile). */
export function ownerFirstName(orgId: string, personId: string): string {
  const p = readRoster(orgId).find((x) => x.id === personId);
  return p ? firstOf(p.name) : "there";
}
