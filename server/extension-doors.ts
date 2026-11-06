import type { Context } from "hono";
import { queueChatRole } from "../shared/merge-queue";
import { DEPLOY_READ_VERBS, DEPLOY_VERBS, MERGE_READ_VERBS, MERGE_VERBS, RELEASE_READ_VERBS, RELEASE_VERBS } from "../shared/project-contract";
import { judgedPath } from "./mesh/paths";
import { pageExtensionSender } from "./extension-sender";
import { notPage } from "./page-only";
import { projectOverseerOfPath } from "./project-overseer-store";
import { getSessionSummary } from "./sessions-index";

/** What a key's prompt or steer frame is answered with (§app.extensions/not-you). */
export const EXTENSION_SPEAKS_REFUSAL = "An extension speaks through session.send, which names it. Nothing was sent.";

/** The never list (§app.extensions/not-you): each door names the promise it holds. */
export type NeverPromise = "user's word" | "approve" | "rules" | "overseer" | "sova's own";

export interface ExtensionDoor {
  /** One method, or every write: POST, PUT, PATCH, DELETE, anything but GET and HEAD. */
  method: "WRITE" | "PUT";
  /** As registered, `:name` for one segment; `/*` at the end: it and everything below. */
  route: string;
  promise: NeverPromise;
  error: string;
  /** A page under `/ext/<id>/` is answered as its key would be (§app.extensions/page-badge): an accident guard. */
  pages?: true;
}

const NOTHING = "Nothing changed.";
const LAND = `Only the user lands a branch or answers the merge queue. ${NOTHING}`;
const OVERSEER = `An extension doesn't write to an overseer: what it reads is the user's. ${NOTHING}`;
const SETTINGS = `Sova's settings are the user's. ${NOTHING}`;
const YOURS = `That is the user's own to do. ${NOTHING}`;
const OPERATORS = `That is the operator's to do. ${NOTHING}`;

/** A project verb as a key would call it, at both of its routes. */
const verbDoors = (verbs: readonly string[], read: readonly string[], error: string): ExtensionDoor[] =>
  verbs
    .filter((v) => !read.includes(v))
    .flatMap((v) => [
      { method: "WRITE" as const, route: `/api/project-services/${v}`, promise: "sova's own" as const, error },
      { method: "WRITE" as const, route: `/api/projects/:pid/services/${v}`, promise: "sova's own" as const, error },
    ]);

/**
 * The doors an extension's key never opens, in one place, whatever else it carries (§app.extensions/not-you). Read at
 * the main gate, so a route needs no check of its own, and by an extension card's button and view commands, which run
 * in-process with no key. It is about a key: a program holding the operator's token is a script, and an extension's
 * page rides the user's login. Everything a key is refused is in this file, so a door reopens by removing its row. A door that already answers a key in its own words (server/page-only.ts, the approvals)
 * isn't listed. server/extension-doors.test.ts fails on a new route that looks like one and is in neither place.
 */
export const EXTENSION_DOORS: readonly ExtensionDoor[] = [
  // Words first: these two carry their own sentence, inside the prefixes below.
  { method: "PUT", route: "/api/overseer/notes", promise: "rules", error: "An extension can't change the Standing notes: they are the user's own instructions. Nothing was saved." },
  { method: "PUT", route: "/api/settings/overseer", promise: "rules", error: "An extension can't change the Overseer's settings. Nothing was saved." },
  // Counting as the user.
  ...verbDoors(MERGE_VERBS, MERGE_READ_VERBS, LAND),
  { method: "WRITE", route: "/api/merge-queue/*", promise: "user's word", error: LAND },
  { method: "WRITE", route: "/api/session-groups/:id/prompt", promise: "user's word", error: EXTENSION_SPEAKS_REFUSAL, pages: true },
  { method: "WRITE", route: "/api/mode", promise: "user's word", error: YOURS },
  { method: "WRITE", route: "/api/mode/command", promise: "user's word", error: YOURS },
  // Approving.
  { method: "WRITE", route: "/api/session-offers/choose", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/projects/:pid/draft-specs/:sid/approve", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/projects/:pid/draft-specs/:sid/build", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/projects/:pid/setup/merge", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/projects/:pid/runtime/merge", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/tours/:sessionId/jobs/:jobId/approve", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/tours/:sessionId/jobs/:jobId/approve-all", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/schedules/revoke", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/baton/*", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/orgs/*", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/outreach/*", promise: "approve", error: YOURS },
  { method: "WRITE", route: "/api/mesh/*", promise: "approve", error: YOURS },
  // Writing rules.
  { method: "WRITE", route: "/api/settings/*", promise: "rules", error: SETTINGS },
  { method: "WRITE", route: "/api/push/settings", promise: "rules", error: SETTINGS },
  { method: "WRITE", route: "/api/projects/:pid/settings/undo", promise: "rules", error: SETTINGS },
  { method: "WRITE", route: "/api/projects/:pid/settings/cards/:card/withdraw", promise: "rules", error: SETTINGS },
  // Writing to an overseer, or acting in its runs.
  { method: "WRITE", route: "/api/overseer/*", promise: "overseer", error: OVERSEER },
  { method: "WRITE", route: "/api/projects/:pid/overseer/*", promise: "overseer", error: OVERSEER },
  // Sova's own actions.
  ...verbDoors(RELEASE_VERBS, RELEASE_READ_VERBS, OPERATORS),
  ...verbDoors(DEPLOY_VERBS, DEPLOY_READ_VERBS, OPERATORS),
  { method: "WRITE", route: "/api/updates/settings", promise: "sova's own", error: OPERATORS },
  { method: "WRITE", route: "/api/attention/dismiss", promise: "sova's own", error: YOURS },
];

/**
 * The rest of the table: what a key's frame into a chat is refused with, by the frame's type (a socket,
 * /api/chat/frames and /api/chat/action alike). Remove a row and that frame runs. `compact` only with instructions.
 */
export const EXTENSION_FRAME_DOORS: Readonly<Record<string, string>> = {
  prompt: EXTENSION_SPEAKS_REFUSAL,
  steer: EXTENSION_SPEAKS_REFUSAL,
  ui_response: "Only the user answers a chat's dialog. Nothing was answered.",
  rewind: `An extension doesn't move a chat back: its messages are the user's. ${NOTHING}`,
  regenerate: `An extension doesn't send a message over: its messages are the user's. ${NOTHING}`,
  compact: EXTENSION_SPEAKS_REFUSAL,
};

/** And the refusals other code reads, by what they hold. A chat closed to keys takes no frame; these sentences are the sites' words. */
/** `prompt` on `POST /api/sessions` (`session.new`): open the chat, then `session.send`. */
export const EXTENSION_FIRST_PROMPT = EXTENSION_SPEAKS_REFUSAL;
export const EXTENSION_CHAT_DOOR = "An extension takes no action in that chat. Nothing changed.";
export const EXTENSION_CARD_DOORS = {
  raiseOthers: "an extension raises only its own card types.",
  changeOthers: "an extension changes only its own cards.",
  answerOthers: "An extension answers only its own cards. Nothing was answered.",
  pressActing: "Only the user presses a button that acts. Nothing was answered.",
  sendToQueueChat: "That is one of the merge queue's own chats: an extension doesn't write in it.",
} as const;

const reOf = (route: string): RegExp => {
  const below = route.endsWith("/*");
  const body = (below ? route.slice(0, -2) : route)
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[a-z]+/g, "[^/]+");
  return new RegExp(`^${body}${below ? "(?:/.*)?" : ""}/?$`);
};
const matchers = EXTENSION_DOORS.map((door) => ({ door, re: reOf(door.route) }));

/** The door `method path` is, or null. A path the router can't be judged on is no door: the gate and the router refuse it. */
export function closedDoor(method: string, pathname: string): ExtensionDoor | null {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const path = judgedPath(pathname);
  if (path === null) return null;
  return matchers.find((m) => (m.door.method === "WRITE" || m.door.method === method) && m.re.test(path))?.door ?? null;
}

/** The door a key just knocked at, or null for anyone else and anywhere else. */
export function extensionDoorRefusal(c: Context): ExtensionDoor | null {
  const door = closedDoor(c.req.method, new URL(c.req.url).pathname);
  if (!door) return null;
  return notPage(c) === "extension" || (door.pages && pageExtensionSender(c)) ? door : null;
}

/** Whether a request is an extension's by its key, or by its page's `Referer` (a page only where a door says so). */
export const actsAsExtension = (c: Context): boolean => notPage(c) === "extension" || pageExtensionSender(c) !== null;

/** Why a key's frame into a chat is refused, whichever road it came by (a socket, /api/chat/frames, /api/chat/action); null: it may run. */
export function extensionFrameRefusal(msg: { type?: unknown; instructions?: unknown }): string | null {
  if (typeof msg.type !== "string" || !Object.hasOwn(EXTENSION_FRAME_DOORS, msg.type)) return null;
  if (msg.type === "compact" && !(typeof msg.instructions === "string" && msg.instructions.trim())) return null;
  return EXTENSION_FRAME_DOORS[msg.type]!;
}

/** The chats a key sends no frame into at all: an overseer's, a baton's, the merge queue's. */
export async function chatClosedToKeys(path: string): Promise<boolean> {
  if (projectOverseerOfPath(path)) return true;
  const s = await getSessionSummary(path);
  return !!s && (!!s.overseer || !!s.baton || !!queueChatRole(s.profile));
}
