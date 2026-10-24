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
 * POST /api/i/T/requests/<r_…>   body { action: "close" | "reopen" } -> 202 { ok: true } | 404 | 409 { code: "closed" | "not-yours" } | 429
 *                                (the owner closes or reopens their own request, §app.project-assistant/closing)
 * OwnerHome gains `requests`, `versions` and `assistant` (shared/owner.ts).
 *
 * Operator routes (main listener only):
 * GET  /api/orgs/:id/owner/assistant              -> AssistantInfo
 * PUT  /api/orgs/:id/owner/assistant              body { models: WorkModels } -> AssistantInfo (a kind's null: follow the default)
 * POST /api/orgs/:id/owner/requests/:rid          body { status: "done" | "declined" } | { noted: true } -> AssistantInfo
 *      ({ noted: true }: Got It on a request the owner closed while it was being worked on)
 * POST /api/orgs/:id/owner/assistant/open         -> { sessionId, path } (Open Assistant Chat; makes it when none)
 * POST /api/orgs/:id/owner/requests/:rid/chat     -> { sessionId, path } (Start Chat, §app.project-assistant/request-chat)
 *      | 404 unknown | 409 { code: "closed" } | 409 { code: "has-chat", sessionId, path } | 409 { code: "not-started" } (its note not written; nothing linked)
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
export type OwnerRequestStatus = "with-team" | "started" | "done" | "declined" | "closed";

/** Closed: done or declined by the team, or closed by the owner (§app.project-assistant/closing). The one test every
    reader uses: a closed request takes no new chat, leaves the to-do lists, and nothing moves it on its own. */
export const isRequestClosed = (status: OwnerRequestStatus): boolean => status === "done" || status === "declined" || status === "closed";

/** Who closed (or reopened) a request for the owner: the owner on their page, or their assistant on their yes. */
export interface OwnerRequestBy {
  kind: "owner" | "assistant";
  personId: string;
}

/** A kind and a status in the operator's words (the Requests tab, the request note). */
export const OWNER_REQUEST_KIND_WORD: Record<OwnerRequestKind, string> = { bug: "Problem", outage: "App down", question: "Question", feature: "New feature", fix: "Fix", deploy: "Release", try: "Version to try" };
export const OWNER_REQUEST_STATUS_WORD: Record<OwnerRequestStatus, string> = { "with-team": "With the team", started: "Being worked on", done: "Done", declined: "Declined", closed: "Closed by the owner" };

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
  /** While `closed`: who closed it, when, the status it was closed from, and whether the operator pressed Got It
      (only asked of one closed while `started`). */
  closed?: { by: OwnerRequestBy; at: string; prior: OwnerRequestStatus; noted?: boolean };
  /** A `try` request: the id of the version's copy it asked for (absent on one filed before). */
  version?: string;
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
  /** A closed request (status `closed`): "you" when the owner closed it on their page, "assistant" when their
      Project Assistant did on their yes. */
  closedBy?: "you" | "assistant";
  /** A `feature` request's feature request chat, as it stands now (§app.project-assistant/feature-chats):
      "planning" while it is open, "agreed" once done; worked out at read time. */
  plan?: "planning" | "agreed";
}

/** A version the owner can try (§app.project-assistant/versions). */
export interface OwnerVersionRow {
  /** v_…: opened at /i/<token>/v/<handle>. */
  handle: string;
  project: string;
  /** "Current version", "Fix: {title}" or "Work in progress · started {date}", unique within its project (a repeat gets " (2)"). */
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
  /** On the assistant's message after a start_feature_chat that opened one: that chat, while it is
      the owner's to read (§app.project-assistant/feature-chats). */
  featureChat?: { conversation: string; title: string };
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

export type AssistantServerMessage =
  | { type: "view"; view: AssistantView }
  | { type: "streaming"; text: string }
  | { type: "error"; code: string; message: string }
  /** One of the owner's feature request chats changed: read it again (§app.project-assistant/feature-chats). */
  | { type: "conversation"; conversation: string }
  /** Its reply so far, filtered as a hand-off page's streaming text. */
  | { type: "conversation-streaming"; conversation: string; text: string };

/** A feature request chat the Project Assistant opened (§app.project-assistant/feature-chats): who it belongs to. */
export interface FeatureChatRecord {
  sessionId: string;
  /** The owner who opened it (a person id). */
  personId: string;
  projectId: string;
  /** Its `feature` request. */
  requestId: string;
  at: string;
  /** Closed because its person stopped being the owner. */
  ended?: { at: string; why: "owner-changed" | "left" };
}

/** `<workspace>/project-assistant.json`: the org's assistant models and its conversation per owner. */
export interface AssistantStore {
  version: 1;
  models: WorkModels;
  /** Owner person id -> their conversation's session id (the newest; earlier ones stay in the workspace, closed). */
  conversations: Record<string, string>;
  /** The feature request chats it opened, oldest first. */
  featureChats?: FeatureChatRecord[];
}

/** A model as the Owner card shows it: the pick, its price per million tokens when known. */
export interface PricedPick extends ModelPick {
  /** USD per million input / output tokens; absent when its price isn't known. */
  price?: { input: number; output: number };
}

/** Where a kind's model comes from (§app.project-assistant/models): a project's override (coding and
    gathering only), the organization's own pick, or the host's default. */
export type AssistantModelSource = "project" | "org" | "default";

/** A resolved model with its source. */
export interface ResolvedPick extends PricedPick {
  source: AssistantModelSource;
}

/** Why a resolved reply model doesn't run: this host can't run it (not in its model list, so unknown or
    without credentials), or Settings → Models turned it off. */
export type AssistantModelProblem = "unavailable" | "turned-off";

/** The Owner card's Project Assistant part. */
export interface AssistantInfo {
  /** The org's resolved model per kind of work (its own pick, else the default); null when neither is set. */
  models: Partial<Record<WorkKind, ResolvedPick | null>>;
  /** The host's default (Settings → Organizations), or null. */
  default: PricedPick | null;
  /** The resolved reply model runs here: the assistant answers (§app.project-assistant/chat). */
  ready: boolean;
  /** Why the resolved reply model doesn't run, when one resolves and it doesn't. */
  replyProblem?: AssistantModelProblem | null;
  /** Per project: which coding/gathering model applies and where it comes from. */
  projects: { projectId: string; name: string; coding: { pick: PricedPick | null; source: AssistantModelSource | null }; gathering: { pick: PricedPick | null; source: AssistantModelSource | null } }[];
  /** The owner's conversation, once it exists. */
  sessionId: string | null;
  /** Whether the reply model sees images; null with no reply model (the card's "can't see photos" line). */
  seesPhotos?: boolean | null;
  /** Every request, newest first (open ones are Needs you's). */
  requests: OwnerRequest[];
}
