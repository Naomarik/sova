import type { PoLimitKind, ProjectOverseerSettings } from "../shared/project-overseer";
import { atOnceCounts, buildEnvelope, type ActBy, type Envelope, type EnvelopeCard, type LedgerCounts } from "./org-envelope";
import type { OrgHostApi } from "./org-engine";

/**
 * Stamping an envelope from the org's charts as they stand (engine API: the host asks `stamp(sid,
 * event, payload)` for a chart-driven act and for a held act at its release, and every route and
 * tool stamps its own act the same way). It reads, in the same synchronous step: the project's
 * settings file, the project session (archived), its watch session (paused, the ledgers), the
 * people (anyone active) and the batons and builds (the at-once counts).
 */

/** Session ids: `<chart>/<org>/<project>/…` for project-scoped charts (design §1.1). */
const SCOPED = new Set(["project", "watch", "item", "decision", "conflict", "reconciler", "build", "baton"]);

/** The project a session belongs to: its data's projectId, else the id's third segment for a project-scoped chart. */
export function projectOfSession(host: Pick<OrgHostApi, "data">, sid: string): string | null {
  const pid = host.data(sid)?.projectId;
  if (typeof pid === "string" && pid) return pid;
  const [chart, , project] = sid.split("/");
  return chart && SCOPED.has(chart) && project ? project : null;
}

const KINDS: readonly PoLimitKind[] = ["gather", "promote", "create", "prompt"];
const counts = (v: unknown): Partial<Record<PoLimitKind, number>> => {
  const out: Partial<Record<PoLimitKind, number>> = {};
  if (typeof v === "object" && v !== null) for (const k of KINDS) if (typeof (v as Record<string, unknown>)[k] === "number") out[k] = (v as Record<string, number>)[k];
  return out;
};

/** The ledgers as the watch session's data holds them (`ledger {message, day}`, `looksToday`); none: all 0. */
export function ledgerOf(watch: Record<string, unknown> | null): LedgerCounts {
  const ledger = (watch?.ledger ?? {}) as Record<string, unknown>;
  const looks = watch?.looksToday;
  return { message: counts(ledger.message), day: counts(ledger.day), looksToday: typeof looks === "number" ? looks : 0 };
}

/** A held act as the host lists it (engine API: `holds()`, every held act of every loaded session). */
export interface HeldAct {
  id: string;
  sessionId: string;
  event: string;
  data?: Record<string, unknown>;
  by?: string;
  until?: number;
}

/** What an act counts against, as its chart declares it (`:counts` in the chart's acts): `null` when it
    counts nothing. Read from the registry, never a table kept here, so a renamed act can't count
    nothing silently. */
export type CountsOf = (sessionId: string, event: string) => string | null;

export function countsFrom(host: Pick<OrgHostApi, "chartOf" | "chartInfo">): CountsOf {
  return (sessionId, event) => {
    const chart = host.chartOf(sessionId);
    const counts = chart ? host.chartInfo(chart)?.acts?.[event]?.counts : undefined;
    return typeof counts === "string" && counts ? counts : null;
  };
}

const isKind = (k: string | null): k is PoLimitKind => !!k && (KINDS as readonly string[]).includes(k);

/** The kind and number a held act will take when it goes ahead (a promotion: one per decision id), or null. */
export function heldUse(h: HeldAct, countsOf: CountsOf): { kind: PoLimitKind; n: number } | null {
  const kind = countsOf(h.sessionId, h.event);
  if (!isKind(kind)) return null;
  const ids = h.data?.ids;
  return { kind, n: kind === "promote" && Array.isArray(ids) ? ids.length : 1 };
}

/**
 * Fold a project's pending holds into what the ledgers and the at-once counts say (the F2 ruling):
 * the charts' caps read only the envelope, so an act waiting in a hold is counted as if it had gone
 * ahead, on the day ledger (a held act is always unattended) and in the at-once counts (a held start
 * of a gathering, one that is not an offer on an existing session, or of a coding session). The
 * hold being released now (`releasing`) is not counted twice. Pure.
 */
export function withHolds(
  base: { used: LedgerCounts; gatheringsOpen: number; codingRunning: number },
  holds: readonly HeldAct[],
  inProject: (h: HeldAct) => boolean,
  releasing: string | null,
  countsOf: CountsOf,
): { used: LedgerCounts; gatheringsOpen: number; codingRunning: number } {
  const day = { ...base.used.day };
  let { gatheringsOpen, codingRunning } = base;
  for (const h of holds) {
    if (h.id === releasing || !inProject(h)) continue;
    const use = heldUse(h, countsOf);
    if (!use) continue;
    day[use.kind] = (day[use.kind] ?? 0) + use.n;
    if (use.kind === "gather" && !h.sessionId.startsWith("baton/")) gatheringsOpen++;
    if (use.kind === "create") codingRunning++;
  }
  return { used: { ...base.used, day }, gatheringsOpen, codingRunning };
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
  host: Pick<OrgHostApi, "sessions" | "data" | "configuration" | "holds" | "chartOf" | "chartInfo">,
  orgId: string,
  projectId: string | null,
  who: StampWho,
  settings: (projectId: string) => Pick<ProjectOverseerSettings, "autonomy" | "caps" | "holdMin">,
  fallback: Pick<ProjectOverseerSettings, "autonomy" | "caps" | "holdMin">,
  /** The hold this act releases (the payload's `sovaReleased`): not counted as pending. */
  releasing: string | null = null,
): Envelope {
  const people = host.sessions("person");
  const rosterActive = people.some((p) => p.configuration.includes("active"));
  if (!projectId)
    return buildEnvelope({ ...who, settings: fallback, paused: false, rosterActive, archived: false, used: ledgerOf(null), gatheringsOpen: 0, codingRunning: 0 });
  const projectSid = `project/${orgId}/${projectId}`;
  const watchSid = `watch/${orgId}/${projectId}`;
  const archived = !!host.configuration(projectSid)?.includes("archived");
  const paused = !!host.configuration(watchSid)?.includes("paused");
  const counted = { used: ledgerOf(host.data(watchSid)), ...atOnceCounts([...host.sessions("baton"), ...host.sessions("build")], projectId) };
  const inProject = (h: HeldAct) => projectOfSession(host, h.sessionId) === projectId;
  const folded = withHolds(counted, host.holds() as HeldAct[], inProject, releasing, countsFrom(host));
  return buildEnvelope({ ...who, settings: settings(projectId), paused, rosterActive, archived, ...folded, projectId });
}
