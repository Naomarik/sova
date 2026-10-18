import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORK_KINDS, type ModelPick, type WorkKind, type WorkModels } from "../shared/powers";
import {
  OWNER_REQUEST_KINDS,
  OWNER_REQUEST_TEXT_MAX,
  OWNER_REQUEST_TITLE_MAX,
  type AssistantStore,
  type OwnerRequest,
  type OwnerRequestKind,
  type OwnerRequestStatus,
} from "../shared/project-assistant";
import { attentionChanged } from "./attention-memo";
import { orgDir, OrgError, readProjects } from "./orgs";

/**
 * The Project Assistant's org-side records (§app.project-assistant/models, /requests), all in the
 * org's workspace repo so they travel with it:
 *   `<workspace>/project-assistant.json`       { version: 1, models, conversations: {personId: sessionId} }
 *   `<workspace>/projects/<pid>/owner-requests.jsonl`  append-only: {kind:"filed", …request} | {kind:"status", id, status, at, sessionId?}
 * Read tolerantly: a bad file reads as empty, a torn line is skipped.
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
    return { version: 1, models: modelsOf(raw?.models), conversations };
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

/** Set the org's models (the Owner card): every kind given replaces its pick; null clears it. A bad pick is refused. */
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

/** A coding or gathering model for a project: the project's override (its powers' assistantModels), else the org's. */
export function assistantModelFor(orgId: string, kind: WorkKind, projectOverride?: WorkModels | null): { pick: ModelPick | null; source: "org" | "project" } {
  const o = kind !== "reply" ? projectOverride?.[kind] : undefined;
  if (o) return { pick: o, source: "project" };
  return { pick: readAssistantStore(orgId).models[kind] ?? null, source: "org" };
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
      byId.set(l.id, { id: l.id, projectId, kind: l.request as OwnerRequestKind, title: l.title, text: l.text, status: "with-team", createdAt: l.at, updatedAt: l.at });
    } else if (l.kind === "status" && typeof l.at === "string") {
      const r = byId.get(l.id);
      if (!r) continue;
      if (l.status === "started" || l.status === "done" || l.status === "declined" || l.status === "with-team") r.status = l.status;
      if (typeof l.sessionId === "string" && l.sessionId) r.sessionId = l.sessionId;
      r.updatedAt = l.at;
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

/** File a request (the assistant's report_issue, start_fix, deploy). */
export function fileRequest(orgId: string, input: { projectId: string; kind: OwnerRequestKind; title: unknown; text: unknown }, now = Date.now()): OwnerRequest {
  if (!readProjects(orgId).some((p) => p.id === input.projectId)) throw new OrgError("Unknown project", 404);
  if (!OWNER_REQUEST_KINDS.includes(input.kind)) throw new OrgError("Unknown kind of request.");
  const title = clean(input.title, OWNER_REQUEST_TITLE_MAX, "title").replace(/\s+/g, " ");
  const text = clean(input.text, OWNER_REQUEST_TEXT_MAX, "text");
  const id = `or_${randomBytes(9).toString("base64url")}`;
  const at = new Date(now).toISOString();
  append(orgId, input.projectId, { kind: "filed", id, request: input.kind, title, text, at });
  attentionChanged(); // Needs you, and an outage's phone notification
  return { id, projectId: input.projectId, kind: input.kind, title, text, status: "with-team", createdAt: at, updatedAt: at };
}

/** A request's status changes (a fix started; the operator's Mark Done / Decline). */
export function setRequestStatus(orgId: string, id: string, status: OwnerRequestStatus, extra: { sessionId?: string } = {}, now = Date.now()): OwnerRequest {
  const r = findRequest(orgId, id);
  if (!r) throw new OrgError("Unknown request", 404);
  append(orgId, r.projectId, { kind: "status", id, status, at: new Date(now).toISOString(), ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) });
  attentionChanged();
  return findRequest(orgId, id)!;
}

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
