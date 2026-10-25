import type { HeldAct } from "../shared/pipeline";
import type { AttentionItem } from "../shared/protocol";
import { actOrThrow, envelopeFor, holdByRef, holdRef, hostOf, isOrgHostOpen, openEngineIds } from "./org-engine";
import { OrgError } from "./org-error";
import type { StampWho } from "./org-stamp";
import { holdDetailsOf, spaceOf } from "./projects/contributions";
import { engineOrThrow, listProjects } from "./projects/spaces";
import type { Hold } from "./statecharts";

/**
 * A project's acts waiting in a hold (§app.project-overseer/holds), read from the engine that holds it:
 * the Pipeline, sova_pipeline, sova_hold and Needs you list them, and the operator's Cancel is the
 * statechart's `hold/cancel`. What a held act is called comes from the statechart's own `what`, unless the
 * layer that owns the act words it (server/projects/contributions.ts `holdDetails`).
 */

const iso = (ms: unknown): string => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");

/** A hold's project: the one it was stamped for, else its session's (its data's `projectId`). */
export function projectOfHold(engine: string, h: Hold): string {
  if (h.projectId) return h.projectId;
  const pid = isOrgHostOpen(engine) ? hostOf(engine).data(h.sessionId)?.projectId : undefined;
  return typeof pid === "string" ? pid : "";
}

/** What a held act is, as the operator reads it ("{what} starts in {n} min unless you cancel it."). */
export function heldWhat(engine: string, h: Hold): string {
  return holdDetailsOf(engine, h)?.what || h.what || "An act";
}

function heldActOf(engine: string, h: Hold): HeldAct {
  const projectId = projectOfHold(engine, h);
  const more = holdDetailsOf(engine, h);
  const person = h.wait === "hours" ? more?.person : undefined;
  return {
    id: holdRef(h),
    projectId,
    ...(more?.itemId ? { itemId: more.itemId } : {}),
    ...(more?.gap ? { gap: more.gap } : {}),
    what: more?.what || h.what || "An act",
    kind: h.kind,
    goesAt: iso(h.until),
    since: iso(h.since),
    ...(h.by === "overseer" || h.by === "statechart" ? { by: h.by } : {}),
    ...(h.wait === "hours" ? { wait: "hours" as const, ...(person ? { person } : {}) } : h.wait === "outage" ? { wait: "outage" as const } : {}),
    ...(h.waiting ? { reviewSince: iso(h.until) } : {}),
  };
}

/** An engine's acts waiting in a hold (of one project, when given), soonest first. */
export function engineHeldActs(engine: string, projectId?: string): HeldAct[] {
  if (!isOrgHostOpen(engine)) return [];
  return hostOf(engine)
    .holds()
    .filter((h) => h.act !== false && (!projectId || projectOfHold(engine, h) === projectId))
    .sort((a, b) => a.until - b.until)
    .map((h) => heldActOf(engine, h));
}

/** The project's acts waiting in a hold, soonest first. */
export const heldActs = (projectId: string): HeldAct[] => engineHeldActs(engineOrThrow(projectId), projectId);

/** One of the project's holds by its ref, or undefined. */
export function projectHold(projectId: string, ref: string): Hold | undefined {
  const engine = engineOrThrow(projectId);
  const h = holdByRef(engine, ref);
  return h && projectOfHold(engine, h) === projectId ? h : undefined;
}

/**
 * The held acts as Needs-you items (r2): act tier, kind `held-act`, never pushed, linked to the project
 * page; the row recounts "{what} starts in {n} min unless you cancel it." from `held`.
 */
export function heldAttention(): AttentionItem[] {
  const out: AttentionItem[] = [];
  const projects = new Map(listProjects().map((p) => [p.id, p]));
  for (const engine of openEngineIds()) {
    for (const h of engineHeldActs(engine)) {
      const p = projects.get(h.projectId);
      const space = p ? spaceOf(engine, p.id) : null;
      const goesAt = Date.parse(h.goesAt);
      const mins = Math.max(0, Math.ceil((goesAt - Date.now()) / 60_000));
      out.push({
        id: `held-act:${h.id}`,
        path: "",
        title: p?.name ?? "A project",
        where: space?.kind === "org" ? space.orgName : "Projects",
        tier: "act",
        kind: "held-act",
        since: Date.parse(h.since) || 0,
        detail:
          h.wait === "hours"
            ? `${h.what} waits for ${h.person ?? "the person"}'s working hours: it starts in ${mins} min unless you cancel it.`
            : h.wait === "outage"
              ? `${h.what} waits for WhatsApp to come back: it goes when WhatsApp is back, and is not sent if WhatsApp is still down in ${mins} min.`
              : `${h.what} starts in ${mins} min unless you cancel it.`,
        href: `#/projects/${encodeURIComponent(h.projectId)}`,
        ...(space?.kind === "org" && p
          ? { org: { orgId: space.orgId, orgName: space.orgName, projectId: p.id, projectName: p.name, ...(p.archived ? { projectArchived: true as const } : {}) } }
          : {}),
        held: {
          id: h.id,
          goesAt,
          what: h.what,
          ...(h.wait ? { wait: h.wait } : {}),
          ...(h.person ? { person: h.person } : {}),
          ...(h.reviewSince ? { reviewSince: Date.parse(h.reviewSince) } : {}),
        },
      });
    }
  }
  return out;
}

/** The operator's Cancel: `hold/cancel` on the hold's session (a declared correction). 404 unknown; the statechart's
    sentence when it already went ahead. */
export async function cancelHeld(projectId: string, ref: string, reason: string | undefined, who: StampWho = { by: "operator", attended: true }): Promise<void> {
  const h = projectHold(projectId, ref);
  if (!h) throw new OrgError("That act is no longer held: it went ahead or was cancelled.", 404);
  const engine = engineOrThrow(projectId);
  await actOrThrow(engine, h.sessionId, "hold/cancel", { id: h.id, ...(reason ? { reason } : {}) }, envelopeFor(engine, projectId, who), { settle: true });
}

/**
 * The owner closed a fix request whose start still waits (§app.project-assistant/closing, q8): every held `build/start`
 * act of the project with that request as its basis is cancelled (`hold/cancel`, a correction any caller may make).
 * Returns how many. An engine not open on this host holds none.
 */
export async function cancelHeldForRequest(projectId: string, requestId: string): Promise<number> {
  const engine = engineOrThrow(projectId);
  if (!isOrgHostOpen(engine)) return 0;
  const basisOf = (h: Hold): unknown => (h.data as { basis?: { kind?: unknown; id?: unknown } } | undefined)?.basis;
  const mine = hostOf(engine)
    .holds()
    .filter((h) => h.act !== false && h.event === "build/start" && projectOfHold(engine, h) === projectId)
    .filter((h) => {
      const b = basisOf(h) as { kind?: unknown; id?: unknown } | undefined;
      return b?.kind === "owner-request" && b.id === requestId;
    });
  let n = 0;
  for (const h of mine) {
    await actOrThrow(engine, h.sessionId, "hold/cancel", { id: h.id, reason: "The owner closed the request." }, envelopeFor(engine, projectId, { by: "system", attended: false }), { settle: true });
    n++;
  }
  return n;
}

/** The owner requests whose fix start waits in a hold on this project (their held `build/start` acts' basis ids). */
export function heldRequestIds(projectId: string): Set<string> {
  const out = new Set<string>();
  let engine: string;
  try {
    engine = engineOrThrow(projectId);
  } catch {
    return out;
  }
  if (!isOrgHostOpen(engine)) return out;
  for (const h of hostOf(engine).holds()) {
    if (h.act === false || h.event !== "build/start" || projectOfHold(engine, h) !== projectId) continue;
    const b = (h.data as { basis?: { kind?: unknown; id?: unknown } } | undefined)?.basis;
    if (b?.kind === "owner-request" && typeof b.id === "string") out.add(b.id);
  }
  return out;
}
