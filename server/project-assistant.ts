import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { OPERATOR } from "../shared/baton";
import type { HEntry } from "../shared/harness";
import { ASSISTANT_TEXT_MAX, type AssistantMessage, type AssistantServerMessage, type AssistantView } from "../shared/project-assistant";
import { acquireChatHandle, isSessionBusy } from "./chat-handle";
import { createSessionFile } from "./harness/pi/state";
import { joinedText, readBranch } from "./harness/pi/reader";
import { stateView } from "./harness/state-view";
import { BATON_SENT, OVERSEER_SENT, PROJECT_ASSISTANT, SESSION_SENT } from "./harness/state-kinds";
import { operatorName, orgDir, OrgError, ownerOf, readIndex, readRoster } from "./orgs";
import { sessionIdOfFile } from "./project-overseer-store";
import { canonicalPath } from "./paths";
import { conversationOf, readAssistantStore, setConversation } from "./project-assistant-store";
import { pathOfId } from "./session-prompt";
import { markSeen } from "./seen";
import { cleanSessionTitle, setSessionTitle } from "./session-titles";
import { outsiderRedactor } from "./share/hub";
import { addWebSession } from "./web-sessions";
import { markOwned } from "./write-guard";

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

/** Whether the newest user message of the branch is the operator's own turn (attended: their acts are never
    restricted). Fail-closed: only on a positive mark of the operator's composer (clientSend's sent mark, by the
    operator) with no other sender's mark beside it. The owner's mark, another session's (session_send), the
    Overseer's (chat.send) and no mark at all (a queued item, a crash between the entry and its mark) are all
    outside input: the client's power column decides. */
export function operatorStarted(branch: readonly HEntry[]): boolean {
  const marks = stateView(branch);
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.kind !== "user") continue;
    if (!e.id) return false;
    if (marks.byTarget(SESSION_SENT, e.id) || marks.byTarget(OVERSEER_SENT, e.id)) return false;
    return marks.byTarget(BATON_SENT, e.id)?.data.by === OPERATOR;
  }
  return false;
}

/** The conversation as the owner reads it: owner, operator and assistant messages, text only, each passed through the outsider redaction. */
export function assistantMessages(orgId: string, branch: readonly HEntry[]): AssistantMessage[] {
  const marks = stateView(branch);
  const r = outsiderRedactor(orgId);
  const op = firstOf(operatorName());
  const out: AssistantMessage[] = [];
  let n = 0;
  for (const e of branch) {
    if (e.kind === "user") {
      const text = joinedText(e, { images: false }).trim();
      if (!text) continue;
      const by = authorOf(marks, e);
      out.push(by === OPERATOR ? { n: ++n, role: "operator", name: r.redact(op), text: r.redact(r.said(text)), at: e.at ?? "" } : { n: ++n, role: "owner", text: r.redact(text), at: e.at ?? "" });
    } else if (e.kind === "assistant") {
      const text = joinedText(e, { images: false }).trim();
      if (!text) continue;
      out.push({ n: ++n, role: "assistant", text: r.redact(r.said(text)), at: e.at ?? "" });
    }
  }
  return out.slice(-VIEW_MESSAGES);
}

/** The view for the owner page (or the operator's preview): empty before the first message. */
export async function assistantView(orgId: string): Promise<AssistantView> {
  const ready = !!readAssistantStore(orgId).models.reply;
  const path = await currentAssistantPath(orgId);
  if (!path) return { ready, busy: false, messages: [] };
  const branch = await readBranch(path).catch((): HEntry[] => []);
  const busy = isSessionBusy(path);
  const streaming = busy ? streams.get(path) : undefined;
  return { ready, busy, messages: assistantMessages(orgId, branch), ...(streaming ? { streaming } : {}) };
}

// ---- the owner's messages -------------------------------------------------------------------------

export class AssistantRefusal extends Error {
  constructor(
    readonly code: "not-ready" | "busy" | "bad-request",
    message: string,
    readonly status: 400 | 409 | 503 = 409,
  ) {
    super(message);
  }
}

/** The owner sends a message: refused while no reply model is set or a reply is being written. */
export async function sendOwnerMessage(orgId: string, raw: unknown): Promise<void> {
  const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) throw new AssistantRefusal("bad-request", "Write something first.", 400);
  if (text.length > ASSISTANT_TEXT_MAX) throw new AssistantRefusal("bad-request", `Messages are limited to ${ASSISTANT_TEXT_MAX} characters.`, 400);
  if (text.startsWith("/")) throw new AssistantRefusal("bad-request", "Messages can't start with /.", 400);
  const reply = readAssistantStore(orgId).models.reply;
  if (!reply) throw new AssistantRefusal("not-ready", "The Project Assistant isn't ready yet.");
  const conv = await ensureAssistant(orgId);
  if (isSessionBusy(conv.path)) throw new AssistantRefusal("busy", "Wait for the answer first.");
  let chat;
  try {
    chat = await acquireChatHandle(conv.path);
  } catch (err) {
    throw new AssistantRefusal("busy", `The Project Assistant can't take a message right now (${err instanceof Error ? err.message : String(err)}).`, 503);
  }
  // Nothing runs on a model nobody chose (§app.project-assistant/models): the chat answers on the org's
  // reply model as it is now, and a model this host can't run leaves it not ready.
  if ((await chat.findModel(reply.model)).ok !== true) throw new AssistantRefusal("not-ready", "The Project Assistant isn't ready yet.");
  try {
    if (chat.mirror.model?.ref !== reply.model) await chat.setModel(reply.model);
    if (reply.thinking) await chat.setThinking(reply.thinking);
    await chat.assertModelAllowed();
  } catch (err) {
    throw new AssistantRefusal("not-ready", `The Project Assistant isn't ready yet (${err instanceof Error ? err.message : String(err)}).`);
  }
  // The sender IS the link's owner: never the operator, whatever the text says.
  await chat.send({ text, origin: "server", sentByBaton: { by: conv.personId } });
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
