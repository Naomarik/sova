import type { PoLimitKind, ProjectOverseerSettings } from "../shared/project-overseer";
import { atOnceCounts, buildEnvelope, type ActBy, type Ceiling, type Envelope, type EnvelopeCard, type LedgerCounts } from "./org-envelope";
import type { OrgHostApi } from "./org-engine";
import { projectSid, watchSid } from "./projects/sids";

/**
 * Stamping an envelope from an engine's statecharts as they stand (engine API: the host asks `stamp(sid,
 * event, payload)` for a statechart-driven act and for a held act at its release, and every route and
 * tool stamps its own act the same way). It reads, in the same synchronous step: the project's
 * settings file, the project session (archived), its watch session (paused, the ledgers), the
 * contributed ceiling and the sessions it counts at once.
 */

/** The project a session belongs to: its data's projectId (every project-scoped statechart carries one), else none. */
export function projectOfSession(host: Pick<OrgHostApi, "data">, sid: string): string | null {
  const pid = host.data(sid)?.projectId;
  return typeof pid === "string" && pid ? pid : null;
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

type SettingsPart = Pick<ProjectOverseerSettings, "autonomy" | "caps" | "holdMin" | "confirmKinds">;

/** The envelope for an act on `projectId` (or an act on no project, with the project facts at their defaults). */
export function stampEnvelope(
  host: Pick<OrgHostApi, "sessions" | "data" | "configuration">,
  projectId: string | null,
  who: StampWho,
  settings: (projectId: string) => SettingsPart,
  fallback: SettingsPart,
  ceiling: (projectId: string | null) => Ceiling | null,
): Envelope {
  if (!projectId)
    return buildEnvelope({ ...who, settings: fallback, paused: false, ceiling: ceiling(null), archived: false, used: ledgerOf(null), gatheringsOpen: 0, codingRunning: 0 });
  const archived = !!host.configuration(projectSid(projectId))?.includes("archived");
  const paused = !!host.configuration(watchSid(projectId))?.includes("paused");
  // Counted uses and running sessions only: the engine adds the project's pending holds itself (F2),
  // before every check, so a reservation is never counted twice.
  const { gatheringsOpen, codingRunning } = atOnceCounts([...host.sessions("baton"), ...host.sessions("build")], projectId);
  return buildEnvelope({ ...who, settings: settings(projectId), paused, ceiling: ceiling(projectId), archived, used: ledgerOf(host.data(watchSid(projectId))), gatheringsOpen, codingRunning, projectId });
}
