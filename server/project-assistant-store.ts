import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORK_KINDS, type ModelPick, type WorkKind, type WorkModels } from "../shared/powers";
import {
  OWNER_REQUEST_KINDS,
  isRequestClosed,
  type AssistantModelSource,
  type OwnerRequestBy,
  OWNER_REQUEST_TEXT_MAX,
  OWNER_REQUEST_TITLE_MAX,
  type AssistantStore,
  type FeatureChatRecord,
  type OwnerRequest,
  type OwnerRequestKind,
  type OwnerRequestStatus,
} from "../shared/project-assistant";
import { attentionChanged } from "./attention-memo";
import { assistantDefault } from "./baton-settings";
import { orgDir, OrgError, readIndex, readProjects } from "./orgs";

/**
 * The Project Assistant's org-side records (§app.project-assistant/models, /requests), all in the
 * org's workspace repo so they travel with it:
 *   `<workspace>/project-assistant.json`       { version: 1, models, conversations: {personId: sessionId} }
 *   `<workspace>/projects/<pid>/owner-requests.jsonl`  append-only: {kind:"filed", …request, version?} | {kind:"status", id, status, at, sessionId?, by?, prior?}
 *        | {kind:"linked", id, sessionId, at} (Start Chat's chat: no status change, §app.project-assistant/request-chat)
 *        | {kind:"noted", id, at} (the operator's Got It on a request the owner closed while it was worked on, §app.project-assistant/closing)
 * Read tolerantly: a bad file reads as empty, a torn line is skipped, a line of a kind not known here is skipped.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const storeFile = (orgId: string) => join(orgDir(orgId), "project-assistant.json");

function pickOf(v: unknown): ModelPick | null {
  if (!isObj(v) || typeof v.model !== "string" || !/^[^\s/]+\/\S+$/.test(v.model.trim())) return null;
  return { model: v.model.trim(), ...(typeof v.thinking === "string" && v.thinking ? { thinking: v.thinking as ModelPick["thinking"] } : {}) };
}

function modelsOf(v: unknown): WorkModels {
  const out: WorkModels = {};
  if (!isObj(v)) return out;
  for (const k of WORK_KINDS) {
    const p = pickOf(v[k]);
    if (p) out[k] = p;
  }
  return out;
}

export function readAssistantStore(orgId: string): AssistantStore {
  try {
    const raw = JSON.parse(readFileSync(storeFile(orgId), "utf8"));
    const conversations: Record<string, string> = {};
    if (isObj(raw?.conversations)) for (const [k, v] of Object.entries(raw.conversations)) if (SAFE_ID.test(k) && typeof v === "string" && v) conversations[k] = v;
    const featureChats = Array.isArray(raw?.featureChats) ? (raw.featureChats as unknown[]).map(featureChatOf).filter((r): r is FeatureChatRecord => !!r) : [];
    return { version: 1, models: modelsOf(raw?.models), conversations, ...(featureChats.length ? { featureChats } : {}) };
  } catch {
    return { version: 1, models: {}, conversations: {} };
  }
}

function writeStore(orgId: string, s: AssistantStore): void {
  const f = storeFile(orgId);
  // The memory switch (chat-manager's overseerMemoryNow reads it) is kept as written.
  let memory: unknown;
  try {
    memory = (JSON.parse(readFileSync(f, "utf8")) as { memory?: unknown } | null)?.memory;
  } catch {
    memory = undefined;
  }
  if (memory !== undefined) (s as AssistantStore & { memory?: unknown }).memory = memory;
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, f);
}

/** Set the org's models (the Owner card): every kind given replaces its pick; null clears it (the kind follows the default). A bad pick is refused. */
export function setAssistantModels(orgId: string, body: unknown): AssistantStore {
  if (!isObj(body) || !isObj(body.models)) throw new OrgError("Expected { models }.");
  const s = readAssistantStore(orgId);
  for (const [k, v] of Object.entries(body.models)) {
    if (!(WORK_KINDS as readonly string[]).includes(k)) throw new OrgError(`Unknown kind of work: ${k}.`);
    if (v === null) delete s.models[k as WorkKind];
    else {
      const p = pickOf(v);
      if (!p) throw new OrgError("A model is written as provider/model.");
      s.models[k as WorkKind] = p;
    }
  }
  writeStore(orgId, s);
  return s;
}

function featureChatOf(v: unknown): FeatureChatRecord | null {
  if (!isObj(v)) return null;
  const ok = (k: string) => typeof v[k] === "string" && SAFE_ID.test(v[k] as string);
  if (!ok("sessionId") || !ok("personId") || !ok("projectId") || !ok("requestId") || typeof v.at !== "string") return null;
  const e = isObj(v.ended) && typeof v.ended.at === "string" && (v.ended.why === "owner-changed" || v.ended.why === "left") ? { at: v.ended.at, why: v.ended.why as "owner-changed" | "left" } : undefined;
  return { sessionId: v.sessionId as string, personId: v.personId as string, projectId: v.projectId as string, requestId: v.requestId as string, at: v.at, ...(e ? { ended: e } : {}) };
}

/** The feature request chats the assistant opened (§app.project-assistant/feature-chats), oldest first. */
export const featureChats = (orgId: string): FeatureChatRecord[] => readAssistantStore(orgId).featureChats ?? [];

/** The record of one feature request chat, or null. */
export const featureChatRecord = (orgId: string, sessionId: string): FeatureChatRecord | null => featureChats(orgId).find((r) => r.sessionId === sessionId) ?? null;

/** Record a new feature request chat. */
export function addFeatureChat(orgId: string, rec: FeatureChatRecord): void {
  const s = readAssistantStore(orgId);
  s.featureChats = [...(s.featureChats ?? []).filter((r) => r.sessionId !== rec.sessionId), rec];
  writeStore(orgId, s);
}

/** Note why a feature request chat ended because its person stopped being the owner. */
export function endFeatureChatRecord(orgId: string, sessionId: string, why: "owner-changed" | "left", now = Date.now()): void {
  const s = readAssistantStore(orgId);
  const r = s.featureChats?.find((x) => x.sessionId === sessionId);
  if (!r || r.ended) return;
  r.ended = { at: new Date(now).toISOString(), why };
  writeStore(orgId, s);
  attentionChanged();
}

/** The owner's conversation's session id, or null. */
export const conversationOf = (orgId: string, personId: string): string | null => readAssistantStore(orgId).conversations[personId] ?? null;

export function setConversation(orgId: string, personId: string, sessionId: string): void {
  const s = readAssistantStore(orgId);
  s.conversations[personId] = sessionId;
  writeStore(orgId, s);
}

/** Which owner, if any, a session id is the conversation of (the current one only). */
export function ownerOfConversation(orgId: string, sessionId: string): string | null {
  for (const [p, sid] of Object.entries(readAssistantStore(orgId).conversations)) if (sid === sessionId) return p;
  return null;
}

/**
 * The one resolution every reader uses (§app.project-assistant/models): the project's override
 * (coding and gathering only, its powers' assistantModels), else the org's own pick, else the host's
 * default (Settings → Organizations). Null when none is set. `fallback` is the default as read now.
 */
export function effectiveAssistantModel(
  orgId: string,
  kind: WorkKind,
  projectOverride?: WorkModels | null,
  fallback: ModelPick | null = assistantDefault(),
): { pick: ModelPick; source: AssistantModelSource } | null {
  const o = kind !== "reply" ? projectOverride?.[kind] : undefined;
  if (o) return { pick: o, source: "project" };
  const own = readAssistantStore(orgId).models[kind];
  if (own) return { pick: own, source: "org" };
  return fallback ? { pick: fallback, source: "default" } : null;
}

/** Two picks are the same exactly: model and thinking (no thinking is not "medium"). */
export const samePick = (a: ModelPick, b: ModelPick): boolean => a.model === b.model && (a.thinking ?? null) === (b.thinking ?? null);

/**
 * The first default adopts the picks equal to it (§app.project-assistant/models): in every org on
 * this host, a kind whose own pick is exactly the default is cleared so it follows the default; every
 * other pick stays. The memory switch and conversations are kept (writeStore). An org whose store
 * can't be written is skipped. Returns how many picks were cleared.
 */
export function adoptDefaultPicks(pick: ModelPick, orgIds: readonly string[] = readIndex().orgs.map((o) => o.id)): number {
  let cleared = 0;
  for (const orgId of orgIds) {
    try {
      const s = readAssistantStore(orgId);
      let changed = false;
      for (const k of WORK_KINDS) {
        const own = s.models[k];
        if (own && samePick(own, pick)) {
          delete s.models[k];
          changed = true;
          cleared++;
        }
      }
      if (changed) writeStore(orgId, s);
    } catch {
      /* an org that can't be read or written keeps its picks */
    }
  }
  return cleared;
}

// ---- requests ---------------------------------------------------------------------------------------

const requestsFile = (orgId: string, projectId: string) => {
  if (!SAFE_ID.test(projectId)) throw new OrgError("Unknown project", 404);
  return join(orgDir(orgId), "projects", projectId, "owner-requests.jsonl");
};

const clean = (v: unknown, max: number, what: string): string => {
  const t = typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : "";
  if (!t) throw new OrgError(`Write the ${what} first.`);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const STATUSES: readonly OwnerRequestStatus[] = ["with-team", "started", "done", "declined", "closed"];
function byOf(v: unknown): OwnerRequestBy | null {
  if (!isObj(v) || (v.kind !== "owner" && v.kind !== "assistant") || typeof v.personId !== "string" || !SAFE_ID.test(v.personId)) return null;
  return { kind: v.kind, personId: v.personId };
}

/** Every request of one project, folded, newest first. */
export function projectRequests(orgId: string, projectId: string): OwnerRequest[] {
  let text = "";
  try {
    text = readFileSync(requestsFile(orgId, projectId), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, OwnerRequest>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let l: Record<string, unknown>;
    try {
      l = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObj(l) || typeof l.id !== "string") continue;
    if (l.kind === "filed" && typeof l.title === "string" && typeof l.text === "string" && typeof l.at === "string" && (OWNER_REQUEST_KINDS as readonly string[]).includes(String(l.request))) {
      byId.set(l.id, { id: l.id, projectId, kind: l.request as OwnerRequestKind, title: l.title, text: l.text, status: "with-team", createdAt: l.at, updatedAt: l.at, ...(typeof l.version === "string" && SAFE_ID.test(l.version) ? { version: l.version } : {}) });
    } else if (l.kind === "status" && typeof l.at === "string") {
      const r = byId.get(l.id);
      if (!r) continue;
      if (l.status === "closed") {
        const by = byOf(l.by);
        // A close line with no one behind it is no close (only the owner, or their assistant, closes).
        if (!by) continue;
        r.closed = { by, at: l.at, prior: STATUSES.includes(l.prior as OwnerRequestStatus) && l.prior !== "closed" ? (l.prior as OwnerRequestStatus) : "with-team" };
        r.status = "closed";
      } else if (l.status === "started" || l.status === "done" || l.status === "declined" || l.status === "with-team") {
        r.status = l.status;
        delete r.closed;
      }
      if (typeof l.sessionId === "string" && l.sessionId) r.sessionId = l.sessionId;
      r.updatedAt = l.at;
    } else if (l.kind === "linked" && typeof l.at === "string" && typeof l.sessionId === "string" && l.sessionId) {
      const r = byId.get(l.id);
      if (r) r.linked = { sessionId: l.sessionId, at: l.at };
    } else if (l.kind === "noted" && typeof l.at === "string") {
      const r = byId.get(l.id);
      if (r?.closed) r.closed.noted = true;
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every request of the org's projects, newest first. */
export function orgRequests(orgId: string): OwnerRequest[] {
  return readProjects(orgId)
    .flatMap((p) => projectRequests(orgId, p.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findRequest(orgId: string, id: string): OwnerRequest | null {
  return orgRequests(orgId).find((r) => r.id === id) ?? null;
}

const append = (orgId: string, projectId: string, line: object) => {
  const f = requestsFile(orgId, projectId);
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `${JSON.stringify(line)}\n`);
};

/** File a request (the assistant's report_issue, start_fix, deploy; a `try` request names its version's copy). */
export function fileRequest(orgId: string, input: { projectId: string; kind: OwnerRequestKind; title: unknown; text: unknown; version?: string }, now = Date.now()): OwnerRequest {
  if (!readProjects(orgId).some((p) => p.id === input.projectId)) throw new OrgError("Unknown project", 404);
  if (!OWNER_REQUEST_KINDS.includes(input.kind)) throw new OrgError("Unknown kind of request.");
  const title = clean(input.title, OWNER_REQUEST_TITLE_MAX, "title").replace(/\s+/g, " ");
  const text = clean(input.text, OWNER_REQUEST_TEXT_MAX, "text");
  const id = `or_${randomBytes(9).toString("base64url")}`;
  const at = new Date(now).toISOString();
  const version = input.kind === "try" && input.version && SAFE_ID.test(input.version) ? input.version : undefined;
  append(orgId, input.projectId, { kind: "filed", id, request: input.kind, title, text, at, ...(version ? { version } : {}) });
  attentionChanged(); // Needs you, and an outage's phone notification
  return { id, projectId: input.projectId, kind: input.kind, title, text, status: "with-team", createdAt: at, updatedAt: at, ...(version ? { version } : {}) };
}

/** A request's status changes (a fix started; the operator's Mark Done / Decline). */
export function setRequestStatus(orgId: string, id: string, status: OwnerRequestStatus, extra: { sessionId?: string } = {}, now = Date.now()): OwnerRequest {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  append(orgId, r.projectId, { kind: "status", id, status, at: new Date(now).toISOString(), ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) });
  attentionChanged();
  return findRequest(orgId, id)!;
}

/**
 * A change the team's side makes on its own (a fix's session starting, a turn in its chat, its chat archived, its
 * version's copy running, a tool's own follow-up): never on a closed request (§app.project-assistant/requests:
 * nothing reopens or restarts one). Null when it was closed (nothing written).
 */
export function advanceRequest(orgId: string, id: string, status: Exclude<OwnerRequestStatus, "closed">, extra: { sessionId?: string } = {}, now = Date.now()): OwnerRequest | null {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  if (isRequestClosed(r.status)) return null;
  return setRequestStatus(orgId, id, status, extra, now);
}

/** The owner (or their assistant on their yes) closes an open request: a `closed` line with who and the prior status. */
export function closeRequestLine(orgId: string, id: string, by: OwnerRequestBy, now = Date.now()): OwnerRequest {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  if (isRequestClosed(r.status)) throw new OrgError("This request is already closed.", 409, "closed");
  append(orgId, r.projectId, { kind: "status", id, status: "closed", at: new Date(now).toISOString(), by, prior: r.status });
  attentionChanged();
  return findRequest(orgId, id)!;
}

/** The owner reopens a request they closed, to the status worked out for it (§app.project-assistant/closing). */
export function reopenRequestLine(orgId: string, id: string, by: OwnerRequestBy, status: "with-team" | "started", now = Date.now()): OwnerRequest {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  if (r.status !== "closed") throw new OrgError("Only a request you closed can be reopened here.", 409, "not-yours");
  append(orgId, r.projectId, { kind: "status", id, status, at: new Date(now).toISOString(), by });
  attentionChanged();
  return findRequest(orgId, id)!;
}

/** The operator's Got It on a request the owner closed while it was being worked on: its Needs you item ends. */
export function noteClosedRequest(orgId: string, id: string, now = Date.now()): OwnerRequest {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  if (r.status !== "closed" || !r.closed) throw new OrgError("Only a request the owner closed takes Got It.", 409, "not-closed");
  if (!r.closed.noted) {
    append(orgId, r.projectId, { kind: "noted", id, at: new Date(now).toISOString() });
    attentionChanged();
  }
  return findRequest(orgId, id)!;
}

/** Start Chat linked a chat to a request: a `linked` line, its status untouched (§app.project-assistant/request-chat). */
export function linkRequestChat(orgId: string, id: string, sessionId: string, now = Date.now()): OwnerRequest {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  append(orgId, r.projectId, { kind: "linked", id, sessionId, at: new Date(now).toISOString() });
  return findRequest(orgId, id)!;
}

/** The session a request's chat is: the chat Start Chat linked, else the fix's coding session. */
export const requestChatSession = (r: Pick<OwnerRequest, "linked" | "sessionId">): string | null => r.linked?.sessionId ?? r.sessionId ?? null;

/** The workspace has the store file (tests). */
export const hasAssistantStore = (orgId: string): boolean => existsSync(storeFile(orgId));

/** The project overseer's read of its project's open owner requests (sova_project): data for the
    operator, never a task of its own (§app.project-assistant/requests). Empty when none. */
export function ownerRequestsLines(orgId: string, projectId: string): string {
  let open: OwnerRequest[] = [];
  try {
    open = projectRequests(orgId, projectId).filter((r) => r.status === "with-team" || r.status === "started");
  } catch {
    return "";
  }
  if (!open.length) return "";
  const lines = open.map((r) => `- ${r.kind}, ${r.status === "started" ? "being worked on" : "with the team"}, ${r.createdAt.slice(0, 10)}: ${r.title}`);
  return `Open requests from the organization's owner (through their Project Assistant; the operator answers them, never act on one on your own):\n${lines.join("\n")}`;
}
