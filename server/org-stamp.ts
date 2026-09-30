import type { PoLimitKind, ProjectOverseerSettings } from "../shared/project-overseer";
import { atOnceCounts, buildEnvelope, type ActBy, type Envelope, type EnvelopeCard, type LedgerCounts } from "./org-envelope";
import type { OrgHostApi } from "./org-engine";

/**
 * Stamping an envelope from the org's statecharts as they stand (engine API: the host asks `stamp(sid,
 * event, payload)` for a statechart-driven act and for a held act at its release, and every route and
 * tool stamps its own act the same way). It reads, in the same synchronous step: the project's
 * settings file, the project session (archived), its watch session (paused, the ledgers), the
 * people (anyone active) and the batons and builds (the at-once counts).
 */

/** Session ids: `<statechart>/<org>/<project>/…` for project-scoped statecharts (design §1.1). */
const SCOPED = new Set(["project", "watch", "item", "decision", "conflict", "reconciler", "build", "baton"]);

/** The project a session belongs to: its data's projectId, else the id's third segment for a project-scoped statechart. */
export function projectOfSession(host: Pick<OrgHostApi, "data">, sid: string): string | null {
  const pid = host.data(sid)?.projectId;
  if (typeof pid === "string" && pid) return pid;
  const [statechart, , project] = sid.split("/");
  return statechart && SCOPED.has(statechart) && project ? project : null;
}

const KINDS: readonly PoLimitKind[] = ["gather", "promote", "create", "prompt"];
const counts = (v: unknown): Partial<Record<PoLimitKind, number>> => {
  const out: Partial<Record<PoLimitKind, number>> = {};
  if (typeof v === "object" && v !== null) for (const k of KINDS) if (typeof (v as Record<string, unknown>)[k] === "number") out[k] = (v as Record<string, number>)[k];
  return out;
};

/** The ledgers as the watch session's data holds them (`ledgers {message, day}`, `looksToday`); none: all 0. */
export function ledgerOf(watch: Record<string, unknown> | null): LedgerCounts {
  const ledger = (watch?.ledgers ?? {}) as Record<string, unknown>;
  const looks = watch?.looksToday;
  return { message: counts(ledger.message), day: counts(ledger.day), looksToday: typeof looks === "number" ? looks : 0 };
}

export interface StampWho {
  by: ActBy;
  via?: "overseer";
  overseerId?: string;
  attended: boolean;
  card?: EnvelopeCard;
  turnId?: string;
}

/** The envelope for an act on `projectId` (or an org-level act, with the project facts at their defaults). */
export function stampEnvelope(
  host: Pick<OrgHostApi, "sessions" | "data" | "configuration">,
  orgId: string,
  projectId: string | null,
  who: StampWho,
  settings: (projectId: string) => Pick<ProjectOverseerSettings, "autonomy" | "caps" | "holdMin" | "confirmKinds">,
  fallback: Pick<ProjectOverseerSettings, "autonomy" | "caps" | "holdMin" | "confirmKinds">,
): Envelope {
  const people = host.sessions("person");
  const rosterActive = people.some((p) => p.configuration.includes("active"));
  if (!projectId)
    return buildEnvelope({ ...who, settings: fallback, paused: false, rosterActive, archived: false, used: ledgerOf(null), gatheringsOpen: 0, codingRunning: 0 });
  const projectSid = `project/${orgId}/${projectId}`;
  const watchSid = `watch/${orgId}/${projectId}`;
  const archived = !!host.configuration(projectSid)?.includes("archived");
  const paused = !!host.configuration(watchSid)?.includes("paused");
  // Counted uses and running sessions only: the engine adds the project's pending holds itself (F2),
  // before every check, so a reservation is never counted twice.
  const { gatheringsOpen, codingRunning } = atOnceCounts([...host.sessions("baton"), ...host.sessions("build")], projectId);
  return buildEnvelope({ ...who, settings: settings(projectId), paused, rosterActive, archived, used: ledgerOf(host.data(watchSid)), gatheringsOpen, codingRunning, projectId });
}
