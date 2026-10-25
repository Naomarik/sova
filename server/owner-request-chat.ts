import { isRequestClosed, OWNER_REQUEST_KIND_WORD, OWNER_REQUEST_NOTE, OWNER_REQUEST_STATUS_WORD, type OwnerRequest, type OwnerRequestCard } from "../shared/project-assistant";
import { isArchived } from "./archived-sessions";
import { acquireChatHandle, onAgentSettled, onAgentStarted } from "./chat-handle";
import { readBranch } from "./harness/pi/reader";
import { OVERSEER_SENT } from "./harness/state-kinds";
import { stateView } from "./harness/state-view";
import { ownerPageInfo } from "./owner";
import { OrgError, readIndex, readProjects } from "./orgs";
import { advanceRequest, findRequest, linkRequestChat, orgRequests, requestChatSession } from "./project-assistant-store";
import { archiveSession, idOf, indexedSessionPaths, listSessionFiles, onSessionArchived } from "./sessions-index";

/**
 * Start Chat on an owner request (§app.project-assistant/request-chat): a new project chat with the
 * request in it as a note that starts no turn, linked to the request without changing its status;
 * the request reads `started` once the operator's first message in that chat starts a turn, and
 * goes back to `with-team` when its chat is archived before it is done or declined.
 */

const first = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** The note the model reads: who asked, what, where and when, then the owner's words. */
export function requestNoteText(r: Pick<OwnerRequest, "kind" | "title" | "text" | "createdAt" | "status">, ownerName: string, project: string): string {
  const head = `Request from ${first(ownerName)} (the organization's owner) through the Project Assistant · ${OWNER_REQUEST_KIND_WORD[r.kind]} · ${project} · filed ${r.createdAt.slice(0, 10)} · ${OWNER_REQUEST_STATUS_WORD[r.status]}`;
  return `${head}\n\n${r.title}\n\n${r.text}\n\nThe operator will say what to do with it.`;
}

/** Session ids to paths, for the given ids: the listing cache first, then one walk of the sessions dir for the rest. */
async function pathsOf(ids: readonly string[]): Promise<Map<string, string>> {
  const known = indexedSessionPaths();
  const out = new Map<string, string>();
  const missing = new Set<string>();
  for (const id of ids) {
    const p = known.get(id);
    if (p) out.set(id, p);
    else missing.add(id);
  }
  if (missing.size)
    for (const p of await listSessionFiles()) {
      const id = idOf(p);
      if (missing.has(id)) out.set(id, p);
    }
  return out;
}

/** Each request with its `chat`, present only while that chat exists and isn't archived (read time). */
export async function withChats(requests: readonly OwnerRequest[]): Promise<OwnerRequest[]> {
  const ids = [...new Set(requests.map(requestChatSession).filter((id): id is string => !!id && !isArchived(id)))];
  const paths = ids.length ? await pathsOf(ids) : new Map<string, string>();
  return requests.map((r) => {
    const id = requestChatSession(r);
    const path = id ? paths.get(id) : undefined;
    if (!id || !path || isArchived(id)) return r;
    return { ...r, chat: { sessionId: id, path, ...(r.linked?.sessionId === id ? { startedAt: r.linked.at } : {}) } };
  });
}

/** What starts the chat: the project's New Coding Session with `worktree: "later"` (tests stand one in). */
export type StartChatSession = (projectId: string, body: { worktree: "later"; title: string }) => Promise<{ path: string; sessionId: string }>;
/** What writes the note: the chat's own appendNote (tests stand one in). False: not written. */
export type WriteNote = (path: string, noteType: string, text: string, details: OwnerRequestCard) => Promise<boolean>;

const defaultStart: StartChatSession = async (projectId, body) => (await import("./project-overseer")).startCoding(projectId, body);
const defaultNote: WriteNote = async (path, noteType, text, details) => (await acquireChatHandle(path)).appendNote(noteType, text, details);
/** What puts away a chat whose note wasn't written (tests stand one in). */
export type ArchiveChat = (path: string) => Promise<void>;
const defaultArchive: ArchiveChat = async (path) => {
  const out = await archiveSession(path, true);
  if (!out.ok) throw new Error(out.error);
};

/** A refusal with the existing chat (409 has-chat). */
export class HasChatError extends OrgError {
  constructor(readonly chat: { sessionId: string; path: string }) {
    super("This request already has a chat. Open it instead.", 409, "has-chat");
  }
}

const starting = new Set<string>();

/** Start Chat: refuses an unknown request (404), a closed one (409 closed) and one with a live chat (409 has-chat). */
export async function startRequestChat(orgId: string, rid: string, deps: { start?: StartChatSession; note?: WriteNote; archive?: ArchiveChat } = {}): Promise<{ sessionId: string; path: string }> {
  const r = findRequest(orgId, rid);
  if (!r) throw new OrgError("Unknown request", 404);
  if (isRequestClosed(r.status)) throw new OrgError(`This request is ${r.status === "done" ? "done" : r.status === "declined" ? "declined" : "closed by the owner"}: it takes no new chat.`, 409, "closed");
  const [withChat] = await withChats([r]);
  if (withChat?.chat) throw new HasChatError({ sessionId: withChat.chat.sessionId, path: withChat.chat.path });
  const key = `${orgId}/${rid}`;
  if (starting.has(key)) throw new OrgError("A chat for this request is starting now.", 409, "starting");
  starting.add(key);
  try {
    const project = readProjects(orgId).find((p) => p.id === r.projectId);
    const made = await (deps.start ?? defaultStart)(r.projectId, { worktree: "later", title: r.title });
    const ownerName = ownerPageInfo(orgId).person?.name ?? "the owner";
    const projectName = project?.name ?? "the project";
    const card: OwnerRequestCard = { orgId, requestId: rid, kind: r.kind, projectId: r.projectId, project: projectName, title: r.title, text: r.text, filedAt: r.createdAt, ownerName };
    // The note first: the request is linked only to a chat that has it in it.
    let written = false;
    try {
      written = await (deps.note ?? defaultNote)(made.path, OWNER_REQUEST_NOTE, requestNoteText(r, ownerName, projectName), card);
    } catch (err) {
      console.warn(`[owner-request] ${rid}: its note: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!written) {
      // A chat without the request is no chat of it: put it away, link nothing, and say so.
      try {
        await (deps.archive ?? defaultArchive)(made.path);
      } catch (err) {
        console.warn(`[owner-request] ${rid}: the chat its note missed (${made.sessionId}) wasn't archived: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw new OrgError("Couldn't start the chat. Try again.", 409, "not-started");
    }
    linkRequestChat(orgId, rid, made.sessionId);
    chatIndex()?.set(made.sessionId, { orgId, rid });
    return { sessionId: made.sessionId, path: made.path };
  } finally {
    starting.delete(key);
  }
}

// ---- the request follows its chat ---------------------------------------------------------------------

type Ref = { orgId: string; rid: string };
/** Session id of the chat Start Chat linked → its request (open requests only; rebuilt from the store at wiring). */
let index: Map<string, Ref> | null = null;
const chatIndex = (): Map<string, Ref> | null => index;

function buildIndex(): Map<string, Ref> {
  const out = new Map<string, Ref>();
  for (const o of readIndex().orgs) {
    let rows: OwnerRequest[] = [];
    try {
      rows = orgRequests(o.id);
    } catch {
      continue;
    }
    for (const r of rows) {
      if (isRequestClosed(r.status)) continue;
      // Only the chat Start Chat linked: a fix's own session keeps today's behaviour.
      const id = r.linked?.sessionId;
      if (id) out.set(id, { orgId: o.id, rid: r.id });
    }
  }
  return out;
}

/** The operator has spoken in the chat: a user message no Overseer sent. */
export async function operatorSpoke(path: string): Promise<boolean> {
  const branch = await readBranch(path);
  const fromOverseer = new Set(stateView(branch).list(OVERSEER_SENT).map((r) => r.data.targetId));
  return branch.some((e) => e.kind === "user" && !(e.id && fromOverseer.has(e.id)));
}

/** A turn in a request's chat: `started` once the operator spoke there, while it is still with the team. Safe to run twice. */
export async function noteRequestChatTurn(path: string, ref?: Ref): Promise<boolean> {
  const sessionId = idOf(path);
  const hit = ref ?? index?.get(sessionId);
  if (!hit) return false;
  const r = findRequest(hit.orgId, hit.rid);
  if (!r || r.status !== "with-team" || r.linked?.sessionId !== sessionId || isArchived(sessionId)) return false;
  if (!(await operatorSpoke(path))) return false;
  return advanceRequest(hit.orgId, hit.rid, "started", { sessionId }) !== null;
}

/** The chat Start Chat linked was archived: back to `with-team` while it is still `started` (never a closed one).
    A fix's own session is not that chat: archiving it changes nothing here. */
export function noteRequestChatArchived(sessionId: string, ref?: Ref): boolean {
  const hit = ref ?? index?.get(sessionId);
  if (!hit) return false;
  const r = findRequest(hit.orgId, hit.rid);
  if (!r || r.linked?.sessionId !== sessionId) return false;
  if (r.status !== "started") return false;
  return advanceRequest(hit.orgId, hit.rid, "with-team") !== null;
}

const warn = (what: string) => (err: unknown) => console.warn(`[owner-request] ${what}: ${err instanceof Error ? err.message : String(err)}`);

/**
 * Wire it once at boot: the index from the store, the chats' turns and archives, and what happened while
 * no server listened (a first message sent, a chat archived) caught up.
 */
export function wireRequestChats(): Promise<void> {
  if (index) return Promise.resolve();
  try {
    index = buildIndex();
  } catch (err) {
    warn("index")(err);
    index = new Map();
  }
  // The user entry (and an Overseer's marker) is written just after the turn starts: look shortly after, and at its end.
  onAgentStarted((path) => {
    if (!index?.has(idOf(path))) return;
    setTimeout(() => void noteRequestChatTurn(path).catch(warn("a turn")), 1500).unref?.();
  });
  onAgentSettled((path) => {
    if (index?.has(idOf(path))) void noteRequestChatTurn(path).catch(warn("a turn"));
  });
  onSessionArchived((sessionId) => {
    try {
      noteRequestChatArchived(sessionId);
    } catch (err) {
      warn("an archive")(err);
    }
  });
  return (async () => {
    const entries = [...index!.entries()];
    const paths = await pathsOf(entries.map(([id]) => id));
    for (const [id, ref] of entries) {
      try {
        if (isArchived(id)) noteRequestChatArchived(id, ref);
        else {
          const path = paths.get(id);
          if (path) await noteRequestChatTurn(path, ref);
        }
      } catch (err) {
        warn("catching up")(err);
      }
    }
  })().catch(warn("catching up"));
}

/** A reopened request's chat Start Chat linked is tracked again (§app.project-assistant/closing). */
export function trackRequestChat(sessionId: string, ref: Ref): void {
  index?.set(sessionId, ref);
}

/** Tests: forget the wiring's index. */
export function resetRequestChatsForTests(next: Map<string, Ref> | null = null): void {
  index = next;
}
