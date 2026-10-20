/**
 * Wire and store types of the Project Assistant (§app/project-assistant): the org owner's own chat
 * on the owner page, their requests, the versions they can try, and the assistant's models.
 * Imported by the server, the operator app and the share build, so it imports only types.
 *
 * Share listener (T = the owner token):
 * GET  /api/i/T/assistant        -> AssistantView
 * POST /api/i/T/assistant        body { text } -> 202 { ok: true } | 409 { code: "not-ready" | "busy" } | 429
 * WS   /ws/i?token=T&v=<tab>     server -> client AssistantServerMessage; client messages ignored
 * GET  /i/T/v/<v_…>              -> 302 to the version (an owner-bound preview link) | 404 | 410
 * POST /i/T/ask-link             -> 202 { ok, askedAt } | 409 (still works) | 410 | 404 (§app.owner-page/link)
 * OwnerHome gains `requests`, `versions` and `assistant` (shared/owner.ts).
 *
 * Operator routes (main listener only):
 * GET  /api/orgs/:id/owner/assistant              -> AssistantInfo
 * PUT  /api/orgs/:id/owner/assistant              body { models: WorkModels } -> AssistantInfo
 * POST /api/orgs/:id/owner/requests/:rid          body { status: "done" | "declined" } -> AssistantInfo
 * POST /api/orgs/:id/owner/assistant/open         -> { sessionId, path } (Open Assistant Chat; makes it when none)
 * POST /api/orgs/:id/owner/requests/:rid/chat     -> { sessionId, path } (Start Chat, §app.project-assistant/request-chat)
 *      | 404 unknown | 409 { code: "closed" } | 409 { code: "has-chat", sessionId, path }
 */

import type { ModelPick, WorkKind, WorkModels } from "./powers";

/** The marker of a Project Assistant conversation (its file's first entry; server/harness/state-kinds.ts). */
export const PROJECT_ASSISTANT_ENTRY = "sova-project-assistant";
export interface ProjectAssistantMarkerData {
  v: 1;
  orgId: string;
  /** The owner it talks to. */
  personId: string;
}

export type OwnerRequestKind = "bug" | "outage" | "question" | "feature" | "fix" | "deploy";
export const OWNER_REQUEST_KINDS: readonly OwnerRequestKind[] = ["bug", "outage", "question", "feature", "fix", "deploy"];
export type OwnerRequestStatus = "with-team" | "started" | "done" | "declined";

/** A kind and a status in the operator's words (the Requests tab, the request note). */
export const OWNER_REQUEST_KIND_WORD: Record<OwnerRequestKind, string> = { bug: "Problem", outage: "App down", question: "Question", feature: "New feature", fix: "Fix", deploy: "Release" };
export const OWNER_REQUEST_STATUS_WORD: Record<OwnerRequestStatus, string> = { "with-team": "With the team", started: "Being worked on", done: "Done", declined: "Declined" };

/** The note type of a request put in the chat Start Chat opened (§app.project-assistant/request-chat). */
export const OWNER_REQUEST_NOTE = "sova-owner-request";

/** The request note's card in a transcript: an `info` row's `ownerRequest` (shared/protocol.ts TranscriptItem). */
export interface OwnerRequestCard {
  orgId: string;
  requestId: string;
  kind: OwnerRequestKind;
  projectId: string;
  /** The project's name when the note was written. */
  project: string;
  title: string;
  text: string;
  /** When the owner filed it (ISO). */
  filedAt: string;
  /** The owner's whole name. */
  ownerName: string;
}

/** A request note's details as a card, or null when they don't read as one (a row falls back to its text). */
export function ownerRequestCardOf(details: unknown): OwnerRequestCard | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const d = details as Record<string, unknown>;
  const s = (k: string): string => (typeof d[k] === "string" ? (d[k] as string) : "");
  const card = { orgId: s("orgId"), requestId: s("requestId"), kind: s("kind") as OwnerRequestKind, projectId: s("projectId"), project: s("project"), title: s("title"), text: s("text"), filedAt: s("filedAt"), ownerName: s("ownerName") };
  if (!card.orgId || !card.requestId || !card.projectId || !card.title || !card.filedAt || !OWNER_REQUEST_KINDS.includes(card.kind)) return null;
  return card;
}

/** The most characters of a request's title (the owner's own words) and its text. */
export const OWNER_REQUEST_TITLE_MAX = 120;
export const OWNER_REQUEST_TEXT_MAX = 2000;
/** The most characters of one owner message to the assistant. */
export const ASSISTANT_TEXT_MAX = 4000;

/** One owner request, as the org workspace keeps it (`projects/<pid>/owner-requests.jsonl`, folded). Operator-side. */
export interface OwnerRequest {
  id: string;
  projectId: string;
  kind: OwnerRequestKind;
  title: string;
  text: string;
  status: OwnerRequestStatus;
  /** The coding session a fix started (its request's version is "Fix: {title}"). */
  sessionId?: string;
  /** The chat Start Chat linked, newest (its `linked` line; it changes no status). */
  linked?: { sessionId: string; at: string };
  /** Operator routes only: the request's chat (the linked one, else the fix's session), present
      only while it exists and isn't archived (worked out at read time). `startedAt`: when Start
      Chat linked it; absent for a fix's session. */
  chat?: { sessionId: string; path: string; startedAt?: string };
  createdAt: string;
  updatedAt: string;
}

/** A request as the owner page shows it: no ids but a handle, the project by name. */
export interface OwnerRequestRow {
  /** r_…: an HMAC handle, meaningless elsewhere. */
  handle: string;
  project: string;
  kind: OwnerRequestKind;
  title: string;
  status: OwnerRequestStatus;
  at: string;
}

/** A version the owner can try (§app.project-assistant/versions). */
export interface OwnerVersionRow {
  /** v_…: opened at /i/<token>/v/<handle>. */
  handle: string;
  project: string;
  /** "Current version", "Fix: {title}" or "Fix {n} · started {date}". */
  label: string;
  state: "running" | "not-running";
}

/** One message of the assistant's conversation as the owner sees it. */
export interface AssistantMessage {
  n: number;
  role: "owner" | "operator" | "assistant";
  /** The operator's first name on their messages. */
  name?: string;
  text: string;
  at: string;
}

export interface AssistantView {
  /** A reply model is set: messages are taken. */
  ready: boolean;
  /** A reply is being written now. */
  busy: boolean;
  /** The last 200, oldest first. */
  messages: AssistantMessage[];
  /** The reply so far, while it is written. */
  streaming?: string;
}

export type AssistantServerMessage = { type: "view"; view: AssistantView } | { type: "streaming"; text: string } | { type: "error"; code: string; message: string };

/** `<workspace>/project-assistant.json`: the org's assistant models and its conversation per owner. */
export interface AssistantStore {
  version: 1;
  models: WorkModels;
  /** Owner person id -> their conversation's session id (the newest; earlier ones stay in the workspace, closed). */
  conversations: Record<string, string>;
}

/** A model as the Owner card shows it: the pick, its price per million tokens when known. */
export interface PricedPick extends ModelPick {
  /** USD per million input / output tokens; absent when its price isn't known. */
  price?: { input: number; output: number };
}

/** The Owner card's Project Assistant part. */
export interface AssistantInfo {
  /** The org's models per kind of work. */
  models: Partial<Record<WorkKind, PricedPick | null>>;
  /** Per project: which coding/gathering model applies and where it comes from. */
  projects: { projectId: string; name: string; coding: { pick: PricedPick | null; source: "org" | "project" }; gathering: { pick: PricedPick | null; source: "org" | "project" } }[];
  /** The owner's conversation, once it exists. */
  sessionId: string | null;
  /** Every request, newest first (open ones are Needs you's). */
  requests: OwnerRequest[];
}
