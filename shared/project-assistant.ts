/**
 * Wire and store types of the Project Assistant (§app/project-assistant): the org owner's own chat
 * on the owner page, their requests, the versions they can try, and the assistant's models.
 * Imported by the server, the operator app and the share build, so it imports only types.
 *
 * Share listener (T = the owner token):
 * GET  /api/i/T/assistant        -> AssistantView
 * POST /api/i/T/assistant        body { text, images? } -> 202 { ok: true } | 409 { code: "not-ready" | "busy" | "no-photos" | "photo-expired" } | 400 too-many | 429
 * POST /api/i/T/assistant/image  raw image bytes -> 201 { id, size, mime } | 409 no-photos | 413 | 400 | 429 | 507 (§app.project-assistant/photos)
 * GET  /api/i/T/assistant/img/<n> -> the n-th photo of the chat's view (AssistantImage.n)
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
 * GET  /api/orgs/:id/owner/preview?assistant=1&img=<n> -> the Preview as's n-th photo
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

export type OwnerRequestKind = "bug" | "outage" | "question" | "feature" | "fix" | "deploy" | "try";
export const OWNER_REQUEST_KINDS: readonly OwnerRequestKind[] = ["bug", "outage", "question", "feature", "fix", "deploy", "try"];
export type OwnerRequestStatus = "with-team" | "started" | "done" | "declined";

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
  /** "starting": the assistant started it and it hasn't answered yet; "failed": it didn't start
      (§app.project-assistant/versions). */
  state: "running" | "starting" | "not-running" | "failed";
}

/** A photo in a message: `n` numbers the photos of THIS view in order (fetched from
    `/api/i/<token>/assistant/img/<n>`); the bytes never ride the view. */
export interface AssistantImage {
  n: number;
  mime: string;
}

/** POST /api/i/T/assistant's body. */
export interface AssistantSend {
  text: string;
  /** Ids of photos this link staged. */
  images?: string[];
}

/** One message of the assistant's conversation as the owner sees it. */
export interface AssistantMessage {
  n: number;
  role: "owner" | "operator" | "assistant";
  /** The operator's first name on their messages. */
  name?: string;
  text: string;
  at: string;
  /** The owner's own photos in their message (§app.project-assistant/photos). */
  images?: AssistantImage[];
  /** On the assistant's message after a start_version that started or found a copy: that version,
      resolved at each read (§app.project-assistant/versions). */
  versions?: OwnerVersionRow[];
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
  /** Present only while photos are on and the reply model sees images: the composer shows its paperclip. */
  photos?: { perMessage: number; maxBytes: number };
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
  /** Whether the reply model sees images; null with no reply model (the card's "can't see photos" line). */
  seesPhotos?: boolean | null;
  /** Every request, newest first (open ones are Needs you's). */
  requests: OwnerRequest[];
}
