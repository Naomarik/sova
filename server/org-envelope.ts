import { PER_DAY, PER_TURN, PO_LIMIT_KINDS, type Allowance, type Autonomy, type PoLimitKind, type ProjectOverseerSettings } from "../shared/project-overseer";

/**
 * The envelope the host stamps on every act it sends into an org's statecharts (design §4.1): who acts,
 * whether the turn is the operator's, the level chosen, and the facts the statecharts' guards read that
 * no statechart owns (the settings file, the ledgers' counts, the at-once counts). The engine stamps
 * nothing about autonomy; this module is the one place that builds it, inside the org's serialized
 * step, so what a guard reads cannot change between check and act.
 *
 * Pure: the caller reads the project's settings (overseer.json, as read now), the watch session's
 * ledgers and the statechart states it counts, and passes them in.
 */

/** Who acts. `chart`: the statecharts on their own (a drive, a released hold); `wrapup`: a wrap-up turn's profile writes; `model`: a gathering model's tool call; `sova`: Sova on its own (a settle session's reconcile). */
export type ActBy = "operator" | "overseer" | "chart" | "system" | "model" | "person" | "wrapup" | "sova";

/** The confirm card a global Overseer act carries (§app.overseer/org-people-facing): every target it lists. */
export interface EnvelopeCard {
  people: string[];
  projects: string[];
  sessions: string[];
}

export interface Envelope {
  by: ActBy;
  via?: "overseer";
  overseerId?: string;
  /** The operator's turn (their message entered the run, or a confirm-card click started it). */
  attended: boolean;
  /** The level chosen (overseer.json); the level in force is the statecharts' to derive from paused/rosterActive. */
  autonomy: Autonomy;
  /** The project's overseer is paused at L0 by an attach on this host. */
  paused: boolean;
  /** Someone on the roster is active. */
  rosterActive: boolean;
  archived: boolean;
  /** The ledger this turn draws on: the operator's message's when attended, else today's on its own. */
  ledger: "message" | "day";
  allowance: Record<PoLimitKind, { used: number; max: Allowance }>;
  /** Looks on its own today, and their limit. */
  looks: { used: number; max: Allowance };
  atOnce: { gatheringsOpen: number; gatheringsCap: number; codingRunning: number; codingCap: number };
  card?: EnvelopeCard;
  /** How long a held act waits (the project's holdMin, in ms; 0 = no hold). */
  holdMs: number;
  /** The act kinds whose held acts wait for the overseer's confirmation (overseer.json, r8(4)). */
  confirmKinds: string[];
  turnId?: string;
  /** The project the act belongs to (the facts above are its); absent for an org-level act. The
      engine keeps it with a held act, so the act is stamped for the same project at its release. */
  projectId?: string;
  /** Per-act facts a route or tool adds (host lookups the statecharts can't make: `invalid`, `target`,
      `namesTaken`, `ownerAreas`, `chosen`, `live`, `leak`). */
  [extra: string]: unknown;
}

/** What the watch session's data says has been used (message and day ledgers, looks today). */
export interface LedgerCounts {
  message: Partial<Record<PoLimitKind, number>>;
  day: Partial<Record<PoLimitKind, number>>;
  looksToday: number;
}

export interface EnvelopeInput {
  by: ActBy;
  via?: "overseer";
  overseerId?: string;
  attended: boolean;
  settings: Pick<ProjectOverseerSettings, "autonomy" | "caps" | "holdMin" | "confirmKinds">;
  paused: boolean;
  rosterActive: boolean;
  archived: boolean;
  used: LedgerCounts;
  gatheringsOpen: number;
  codingRunning: number;
  card?: EnvelopeCard;
  turnId?: string;
  projectId?: string;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** The envelope for one act. Pure. */
export function buildEnvelope(i: EnvelopeInput): Envelope {
  const ledger = i.attended ? "message" : "day";
  const caps = i.settings.caps;
  const used = i.attended ? i.used.message : i.used.day;
  const keys = i.attended ? PER_TURN : PER_DAY;
  const allowance = Object.fromEntries(PO_LIMIT_KINDS.map((k) => [k, { used: count(used[k]), max: caps[keys[k]] as Allowance }])) as Envelope["allowance"];
  return {
    by: i.by,
    ...(i.via ? { via: i.via } : {}),
    ...(i.overseerId ? { overseerId: i.overseerId } : {}),
    attended: i.attended,
    autonomy: i.settings.autonomy,
    paused: i.paused,
    rosterActive: i.rosterActive,
    archived: i.archived,
    ledger,
    allowance,
    looks: { used: count(i.used.looksToday), max: caps.unattendedPerDay },
    atOnce: { gatheringsOpen: i.gatheringsOpen, gatheringsCap: caps.gatheringsOpen, codingRunning: i.codingRunning, codingCap: caps.codingRunning },
    ...(i.card ? { card: i.card } : {}),
    holdMs: i.settings.holdMin * 60_000,
    confirmKinds: [...i.settings.confirmKinds],
    ...(i.turnId ? { turnId: i.turnId } : {}),
    ...(i.projectId ? { projectId: i.projectId } : {}),
  };
}

/** A statechart session as the host's read API gives it. */
export interface SessionRead {
  id: string;
  chart: string;
  configuration: readonly string[];
  data: Record<string, unknown>;
}

/**
 * The at-once counts, from statechart states (never a separately kept number): this project overseer's
 * gathering sessions that are open (settle sessions it owns included, as today), and its own coding
 * sessions (kind `coding`, never the operator's) that run: their turn is working, or their turn
 * ended while their workers still run (`workers`, the build's exported count). Pure.
 */
export function atOnceCounts(sessions: readonly SessionRead[], projectId: string): { gatheringsOpen: number; codingRunning: number } {
  let gatheringsOpen = 0;
  let codingRunning = 0;
  for (const s of sessions) {
    if (s.data.projectId !== projectId) continue;
    if (s.chart === "baton") {
      const owner = s.data.owner as { overseerOf?: unknown } | undefined;
      if (typeof owner === "object" && owner !== null && owner.overseerOf === projectId && s.configuration.includes("open")) gatheringsOpen++;
    } else if (s.chart === "build") {
      // `running` (exported by the build) is "working or workers > 0"; read the parts when it is absent.
      const workers = typeof s.data.workers === "number" ? s.data.workers : 0;
      const running = typeof s.data.running === "boolean" ? s.data.running : s.configuration.includes("working") || workers > 0;
      if (s.data.kind === "coding" && running) codingRunning++;
    }
  }
  return { gatheringsOpen, codingRunning };
}
