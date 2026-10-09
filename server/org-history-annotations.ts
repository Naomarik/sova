import type { Context, Hono } from "hono";
import type { EventId, HistoryEvent, HistoryInput } from "../shared/org-history";
import { hostOf } from "./org-engine";
import type { OrgHistory } from "./org-history/service";
import { readRationale } from "./org-history/store";
import { OrgError, readOrg, readProjects } from "./orgs";
import { OVERSEER_SENDER_HEADER } from "./overseer-sender";

/**
 * The operator's notes and corrections on an organization's history: an append-only write, the operator's
 * own request only (never the global Overseer, a project overseer or any model; the models' history tools
 * only read). A note or a correction is a new event about the one it names, marked "Added later" and
 * attributed to the operator; it never rewrites that event, its state, who did it or what caused it, and it
 * starts or authorizes nothing (it reaches no statechart, spec or roster). It is written through the org
 * host's journal and answered only once saved; the same request id records it once.
 *
 * POST /api/orgs/:id/history/events/:eid/annotate {requestId, what, reason}            -> {event, replayed}
 * POST /api/orgs/:id/history/events/:eid/correct  {requestId, what, reason, projects?} -> {event, replayed}
 *
 * Its words (`what`, `reason`) are the event's private rationale, read exactly where the event it is about
 * may be read; its structural row holds ids only.
 */

export const NOTES = { adapter: "history-notes", version: 1 } as const;

export const NOT_OPERATOR = {
  annotate: "Only the operator adds a note to the history, on the History tab.",
  correct: "Only the operator records a correction, on the History tab.",
} as const;

export interface NoteRequest {
  requestId: string;
  what: string;
  reason: string;
  /** A correction's: the projects the event should have belonged to. */
  projects?: { primary: string | null; affected?: string[] };
}

type Kind = "annotate" | "correct";
const OPERATOR = { kind: "operator" } as const;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const text = (v: unknown, max: number): string | undefined => {
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t.slice(0, max) : undefined;
};

/** The request as given, or why not. */
export function noteRequest(kind: Kind, body: unknown, orgProjects: readonly string[]): NoteRequest {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const allowed = kind === "correct" ? ["requestId", "what", "reason", "projects"] : ["requestId", "what", "reason"];
  const extra = Object.keys(b).find((k) => !allowed.includes(k));
  if (extra) throw new OrgError(`Unknown field ${extra}: give ${allowed.join(", ")}.`);
  if (typeof b.requestId !== "string" || !REQUEST_ID.test(b.requestId)) throw new OrgError("Give a requestId (8–64 letters, digits, - or _).");
  const what = text(b.what, 300);
  if (!what) throw new OrgError(kind === "correct" ? "Say what the correction covers: { what }." : "Say what the note covers: { what }.");
  const reason = text(b.reason, 2000);
  if (!reason) throw new OrgError(kind === "correct" ? "A correction says why: give its reason." : "A note says why: give its reason.");
  const out: NoteRequest = { requestId: b.requestId, what, reason };
  if (kind === "correct" && b.projects !== undefined) {
    const p = b.projects as Record<string, unknown> | null;
    if (typeof p !== "object" || p === null) throw new OrgError("projects is { primary, affected? }.");
    const primary = p.primary === null ? null : typeof p.primary === "string" ? p.primary : undefined;
    if (primary === undefined) throw new OrgError("projects.primary is a project id, or null for the organization.");
    const affected = Array.isArray(p.affected) ? p.affected : p.affected === undefined ? [] : null;
    if (!affected || affected.some((x) => typeof x !== "string")) throw new OrgError("projects.affected is a list of project ids.");
    for (const id of [primary, ...affected]) if (id !== null && !orgProjects.includes(id as string)) throw new OrgError(`${id} is not a project of this organization.`);
    out.projects = { primary, affected: [...new Set(affected as string[])].filter((x) => x !== primary) };
  }
  return out;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

const keyOf = (kind: Kind, req: NoteRequest) => `${kind === "correct" ? "correction" : "note"}:${req.requestId}`;

/** The event recording the request, about `target` (its projects as they are now). Pure but for reads. */
export function noteInput(kind: Kind, target: EventId, req: NoteRequest, history: OrgHistory): HistoryInput {
  const e = history.index.entry(target);
  if (!e || !e.ok) throw new OrgError("No such event in this organization.", 404);
  if (e.kind === "history.gap") throw new OrgError("A capture gap can't be annotated or corrected.", 409);
  if (e.kind === "rationale.purged") throw new OrgError("A purge can't be annotated or corrected.", 409);
  const now = history.reads.projectsOf(e);
  if (req.projects && req.projects.primary === now.primary && sameSet(req.projects.affected ?? [], now.affected)) throw new OrgError("Those are already its projects.");
  return {
    kind: kind === "correct" ? "correction.recorded" : "annotation.added",
    outcome: "recorded",
    projects: { primary: now.primary, affected: now.affected },
    actors: { initiatedBy: OPERATOR, decidedBy: OPERATOR, recordedBy: OPERATOR, executedBy: { kind: "sova" }, authorization: { kind: "operator-act" } },
    source: { adapter: NOTES.adapter, version: NOTES.version, key: keyOf(kind, req) },
    about: target,
    ...(kind === "correct" ? { relations: [{ type: "corrects" as const, target: { event: target } }] } : {}),
    ...(req.projects ? { correction: { projects: { primary: req.projects.primary, affected: req.projects.affected ?? [] } } } : {}),
    rationale: { what: req.what, reason: { text: req.reason, author: OPERATOR, contemporaneous: false } },
  };
}

/** A request id already recorded: the same note again (answered with it), or another one (refused). Asked
    before the request is checked against the event as it is now (a correction already applies to it). The
    words are compared with the earlier event's rationale; once purged they can't be, and it is refused. */
function replayOf(kind: Kind, target: EventId, req: NoteRequest, history: OrgHistory): EventId | null {
  const id = history.index.byKey.get(keyOf(kind, req));
  if (!id) return null;
  const was: HistoryEvent | undefined = history.index.event(id) ?? undefined;
  const r = was?.rationale ? readRationale(history.paths, id) : null;
  const words = r?.state === "present" ? r.rationale : null;
  const same =
    !!was &&
    was.kind === (kind === "correct" ? "correction.recorded" : "annotation.added") &&
    was.about === target &&
    JSON.stringify(was.correction?.projects ?? null) === JSON.stringify(req.projects ? { primary: req.projects.primary, affected: req.projects.affected ?? [] } : null) &&
    !!words &&
    words.what === req.what &&
    words.reason?.text === req.reason;
  if (!same) throw new OrgError("That requestId was already used for another note; send a new one.", 409);
  return id;
}

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      // history can't be saved (or the workspace's journal has a problem): the answer every history write gives
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "history") return c.json({ error: (err as Error).message, code: "history" }, 503);
      throw err;
    }
  };

async function note(c: Context, kind: Kind): Promise<Response> {
  const orgId = c.req.param("id")!;
  if (Object.keys(c.req.queries()).length) throw new OrgError(`Unknown parameter ${Object.keys(c.req.queries())[0]}.`);
  // A call carrying the Overseer's sender header at all is not the operator's own request.
  if (c.req.header(OVERSEER_SENDER_HEADER) !== undefined) throw new OrgError(NOT_OPERATOR[kind], 403);
  readOrg(orgId);
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    // no body: refused below
  }
  const host = hostOf(orgId);
  const req = noteRequest(kind, body, readProjects(orgId).map((p) => p.id));
  const again = replayOf(kind, c.req.param("eid")!, req, host.history);
  if (again) return c.json({ event: again, replayed: true });
  const input = noteInput(kind, c.req.param("eid")!, req, host.history);
  let ids: EventId[];
  try {
    ids = await host.record([input]);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "history") throw err;
    // saved in the journal, applied when the workspace reloads: the same answer an act gets, never an id yet
    if (code === "pending-apply") throw new OrgError((err as Error).message, 409, "pending-apply");
    throw new OrgError(err instanceof Error ? err.message : String(err), 409);
  }
  return c.json({ event: ids[0]!, replayed: false });
}

export function registerOrgHistoryAnnotationRoutes(app: Hono<any>): void {
  app.post("/api/orgs/:id/history/events/:eid/annotate", handle((c) => note(c, "annotate")));
  app.post("/api/orgs/:id/history/events/:eid/correct", handle((c) => note(c, "correct")));
}
