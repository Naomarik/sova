import { OPERATOR } from "../shared/baton";
import type { HEntry, ToolSpec } from "../shared/harness";
import type { OwnerRequest } from "../shared/project-assistant";
import { stateView } from "./harness/state-view";
import { BATON_SENT } from "./harness/state-kinds";
import { handleOf } from "./person-links";
import { orgRequests } from "./project-assistant-store";
import { closeOwnerRequests, reopenOwnerRequest } from "./owner-request-close";

/**
 * The Project Assistant's view of the owner's requests and its close and reopen (§app.project-assistant/tools,
 * /closing): `owner_requests` names each request by a handle of its own for this conversation (never a request id),
 * and `close_request` / `reopen_request` change them only on the owner's yes in the current turn. The first call
 * changes nothing: its answer names the requests back and its details keep the ask. The same call again acts only
 * when the owner's own message (never the operator's) came right after that ask and is the newest message. Whether
 * that message is a yes is the model's reading; the tool makes sure there was one, and that it was the owner's.
 */

export interface RequestToolCtx {
  orgId: string;
  sessionId: string;
  /** The owner now. */
  owner(): { id: string; name: string } | null;
  /** The shown projects (the owner's page's). */
  projects(): { id: string; name: string }[];
  /** The branch as its run started: a call's own branch when the call carries none. */
  branch(): readonly HEntry[];
}

/** A request's handle in this conversation: opaque, stable, meaningless elsewhere (not the page's `r_` handle). */
export const requestHandle = (sessionId: string, requestId: string): string => `req-${handleOf("r", `${sessionId}:${requestId}`).slice(2)}`;

const STATUS_WORDS: Record<OwnerRequest["status"], string> = { "with-team": "with the team", started: "being worked on", done: "done", declined: "not planned", closed: "closed" };

const say = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

type Ask = { action: "close" | "reopen"; requests: string[] };
const askOf = (d: unknown): Ask | null => {
  const a = d && typeof d === "object" ? (d as { ask?: unknown }).ask : undefined;
  if (!a || typeof a !== "object") return null;
  const { action, requests } = a as { action?: unknown; requests?: unknown };
  if ((action !== "close" && action !== "reopen") || !Array.isArray(requests) || !requests.every((x) => typeof x === "string")) return null;
  return { action, requests: requests as string[] };
};
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * Whether the owner said something after this very ask, as the newest message: the last ask of the tool for exactly
 * these requests, then the first user message after it is the owner's (never the operator's), and no message came
 * after that one. Pure over the branch; exported for tests.
 */
export function ownerAnsweredAsk(branch: readonly HEntry[], tool: string, action: Ask["action"], requests: readonly string[]): boolean {
  let at = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.kind !== "tool-result" || e.tool !== tool || e.isError) continue;
    const ask = askOf(e.details);
    if (ask) {
      // The newest ask decides: an older ask for these requests no longer counts once another was made.
      if (ask.action === action && sameSet(ask.requests, requests)) at = i;
      break;
    }
  }
  if (at < 0) return false;
  const users = branch.slice(at + 1).flatMap((e, j) => (e.kind === "user" ? [at + 1 + j] : []));
  if (users.length !== 1) return false;
  const e = branch[users[0]!]!;
  const by = e.id ? stateView(branch).byTarget(BATON_SENT, e.id)?.data.by : undefined;
  return !!by && by !== OPERATOR;
}

export function assistantRequestTools(ctx: RequestToolCtx): ToolSpec[] {
  const shown = () => {
    const names = new Map(ctx.projects().map((p) => [p.id, p.name]));
    return { names, rows: orgRequests(ctx.orgId).filter((r) => names.has(r.projectId)) };
  };
  const byHandle = (handle: unknown): OwnerRequest => {
    const h = typeof handle === "string" ? handle.trim() : "";
    const hit = shown().rows.find((r) => requestHandle(ctx.sessionId, r.id) === h);
    if (!hit) throw new Error(`"${h}" is none of the owner's requests: owner_requests lists them, each with its handle.`);
    return hit;
  };
  const named = (rs: OwnerRequest[]) => {
    const { names } = shown();
    return rs.map((r) => `- "${r.title}" (${names.get(r.projectId) ?? "a project"}, ${STATUS_WORDS[r.status]})`).join("\n");
  };
  const ownerNow = () => {
    const o = ctx.owner();
    if (!o) throw new Error("This conversation has no owner now.");
    return o;
  };

  const ownerRequests: ToolSpec = {
    name: "owner_requests",
    label: "The owner's requests",
    description:
      "The owner's requests and where each one stands (with the team, being worked on, done, not planned, closed), newest first, each with its handle (for close_request and reopen_request; never say a handle to the owner).",
    promptSnippet: "owner_requests: the owner's requests and where they stand",
    parameters: obj({}, []),
    async execute() {
      const { names, rows } = shown();
      if (!rows.length) return say("The owner has no requests yet.");
      const line = (r: OwnerRequest) => {
        const closed = r.status === "closed" && r.closed ? (r.closed.by.kind === "assistant" ? " (closed by you for the owner; they can reopen it)" : " (closed by the owner; they can reopen it)") : "";
        return `- [${requestHandle(ctx.sessionId, r.id)}] ${r.title} (${names.get(r.projectId)}, ${r.kind === "try" ? "a version to try" : r.kind}): ${STATUS_WORDS[r.status]}${closed}, since ${r.updatedAt.slice(0, 10)}`;
      };
      return say(rows.map(line).join("\n"));
    },
  };

  const closeRequest: ToolSpec = {
    name: "close_request",
    label: "Close requests",
    description:
      "Close one or more of the owner's open requests (with the team or being worked on), on their say-so: they no longer need it, or something later made it moot. The first call closes nothing: it names the requests back for you to ask the owner. Call it again with the same requests only after the owner's clear yes in their next message. The team is told quietly; work already started is not stopped. They can reopen it later.",
    promptSnippet: "close_request: close requests the owner no longer needs (only after their clear yes)",
    parameters: obj(
      {
        requests: { type: "array", items: { type: "string" }, minItems: 1, description: "The requests' handles, as owner_requests gives them." },
        why: { type: "string", description: "Why the owner wants them closed, in a few words (optional)." },
      },
      ["requests"],
    ),
    async execute(_id, params, _signal, _update, call) {
      const list = Array.isArray(params.requests) ? (params.requests as unknown[]) : [];
      if (!list.length) throw new Error("Name at least one request by its handle.");
      const rs = [...new Map(list.map((h) => byHandle(h)).map((r) => [r.id, r])).values()];
      const notOpen = rs.filter((r) => r.status !== "with-team" && r.status !== "started");
      if (notOpen.length) throw new Error(`Not open, so not closed (nothing changed):\n${named(notOpen)}`);
      const handles = rs.map((r) => requestHandle(ctx.sessionId, r.id));
      const branch = call?.branch() ?? ctx.branch();
      if (!ownerAnsweredAsk(branch, "close_request", "close", handles))
        return say(
          `Nothing is closed yet. Ask the owner, naming each one, whether to close:\n${named(rs)}\nTell them the team stops on it and they can reopen it later. Only after their clear yes in their next message, call close_request again with exactly these requests.`,
          { ask: { action: "close", requests: handles }, closed: false },
        );
      const o = ownerNow();
      await closeOwnerRequests(ctx.orgId, rs.map((r) => r.id), { kind: "assistant", personId: o.id });
      return say(`Closed:\n${named(rs.map((r) => ({ ...r, status: "closed" as const })))}\nTell the owner they're closed, the team knows, and they can reopen them under Your requests.`, { closed: true });
    },
  };

  const reopenRequest: ToolSpec = {
    name: "reopen_request",
    label: "Reopen a request",
    description:
      "Reopen one request the owner closed (never one the team marked done or not planned), on their say-so. The first call reopens nothing: it names the request back for you to ask the owner. Call it again with the same request only after the owner's clear yes in their next message.",
    promptSnippet: "reopen_request: reopen a request the owner closed (only after their clear yes)",
    parameters: obj({ request: { type: "string", description: "The request's handle, as owner_requests gives it." } }, ["request"]),
    async execute(_id, params, _signal, _update, call) {
      const r = byHandle(params.request);
      if (r.status !== "closed") throw new Error(r.status === "done" || r.status === "declined" ? `"${r.title}" was ${STATUS_WORDS[r.status]} by the team: only the team changes that. Offer to file it again instead.` : `"${r.title}" is open: nothing to reopen.`);
      const handle = requestHandle(ctx.sessionId, r.id);
      const branch = call?.branch() ?? ctx.branch();
      if (!ownerAnsweredAsk(branch, "reopen_request", "reopen", [handle]))
        return say(`Nothing is reopened yet. Ask the owner whether to reopen:\n${named([r])}\nOnly after their clear yes in their next message, call reopen_request again with this request.`, { ask: { action: "reopen", requests: [handle] }, reopened: false });
      const o = ownerNow();
      const after = await reopenOwnerRequest(ctx.orgId, r.id, { kind: "assistant", personId: o.id });
      return say(`Reopened: "${r.title}", now ${STATUS_WORDS[after.status]}. Tell the owner it's back with the team.`, { reopened: true });
    },
  };

  return [ownerRequests, closeRequest, reopenRequest];
}
