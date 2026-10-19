import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state-root";
import { idOf } from "../sessions-index";
import { containedPath } from "./assets";
import { isTourSession } from "./store";
import { TourShares } from "./shares";
import { TourJobStore } from "./job";
import { tourSessionDeletionStatus } from "./deleted";
import { captureTourOwnerRoots, knownTourOwnerSessions, knownTourOwnerState, readKnownTourOwner, rememberTourOwner, scanTourOwnerFiles, tourOwnerHeader, tourOwnerIndexesKnown, type TourOwnerRoot } from "./ownership";

export type TourOwnerState = "present" | "missing" | "unknown";
export interface TourSweepResult { checked: number; removed: number; unknown: number; failed: number }
export interface TourSweepOptions {
  root?: string;
  sessionRoots?: readonly TourOwnerRoot[];
  candidates?(): Promise<readonly string[]>;
  owners?(sessions: readonly string[], roots: readonly TourOwnerRoot[]): Promise<ReadonlyMap<string, TourOwnerState>>;
  cleanup?(sessionId: string): Promise<void>;
  warning?(): void;
  intervalMs?: number;
  schedule?(tick: () => void, intervalMs: number): () => void;
  /** Marker-less absence must hold on two passes at least `minMs` apart over the same session
      folders. In memory only: a restart starts over, so the first pass after a start never cleans on
      absence alone. Without a ledger (direct calls) one pass decides, as before. */
  absence?: TourAbsenceLedger;
  /** For startTourSweep's own ledger (default one minute). */
  absenceMs?: number;
  now?(): number;
  /** Told, with nothing else, each time absence alone cleaned a chat's tours. */
  removedAbsent?(): void;
}
export interface TourAbsenceLedger { seen: Map<string, { at: number; roots: string }>; minMs: number }
const warning = () => console.error("[tours] Deleted-chat cleanup is still pending; it will be retried.");
const removedAbsent = () => console.warn("[tours] Removed the recorded tours of a chat that is no longer in Sova's session folders.");
async function candidates(root: string): Promise<{ sessions: string[]; failed: boolean }> {
  const sessions = new Set<string>(); let failed = false;
  for (const name of ["tours", "tour-private"]) {
    try {
      const directory = join(root, name);
      if (!existsSync(directory)) continue;
      containedPath(root, directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && isTourSession(entry.name)) sessions.add(entry.name);
    } catch { failed = true; }
  }
  try {
    const jobs = join(root, "tour-jobs");
    if (existsSync(jobs)) { containedPath(root, jobs); for (const job of new TourJobStore(jobs).list()) sessions.add(job.sessionId); }
  } catch { failed = true; }
  try { for (const session of new TourShares(root).sessions()) sessions.add(session); } catch { failed = true; }
  const known = knownTourOwnerSessions(root); for (const id of known.sessions) sessions.add(id); failed ||= known.unknown;
  return { sessions: [...sessions], failed }; 
}
/** Cheap per-tick path: a remembered owner whose exact file is still a plain transcript with its own
    header, under a currently visible root, is present without listing any root. Only ever "present". */
async function rememberedPresent(id: string, roots: readonly TourOwnerRoot[], root: string): Promise<boolean> {
  const birth = readKnownTourOwner(id, root);
  return birth.status === "known" && await knownTourOwnerState(birth.owner, roots) === "present";
}
export async function tourOwnerStates(sessions: readonly string[], suppliedRoots?: readonly TourOwnerRoot[], root = stateRoot(), scanOwners: typeof scanTourOwnerFiles = scanTourOwnerFiles): Promise<ReadonlyMap<string, TourOwnerState>> {
  const roots = suppliedRoots ?? captureTourOwnerRoots(), found = new Map<string, TourOwnerState>();
  const rest: string[] = [];
  for (const id of new Set(sessions)) if (await rememberedPresent(id, roots, root)) found.set(id, "present"); else rest.push(id);
  if (!rest.length) return found;
  const scan = await scanOwners(roots), wanted = new Set(rest);
  let headersComplete = true;
  for (const file of scan.files) {
    const header = await tourOwnerHeader(file), named = idOf(file);
    if (!header?.id) { headersComplete = false; if (wanted.has(named)) found.set(named, "unknown"); continue; }
    if (wanted.has(header.id)) { found.set(header.id, "present"); await rememberTourOwner(header.id, file, { root, sessionRoots: roots }); }
    else if (wanted.has(named) && found.get(named) !== "present") found.set(named, "unknown");
  }
  for (const id of rest) if (!found.has(id)) {
    const birth = readKnownTourOwner(id, root);
    found.set(id, scan.complete && headersComplete && tourOwnerIndexesKnown(root) && birth.status === "known" ? await knownTourOwnerState(birth.owner, roots) : "unknown");
  }
  return found;
}
/** Filesystem-only recovery. Never equates an unreadable listing or a filtered-out husk with absence. */
export async function sweepMissingTourOwners(options: TourSweepOptions = {}): Promise<TourSweepResult> {
  const root = options.root ?? stateRoot(), result: TourSweepResult = { checked: 0, removed: 0, unknown: 0, failed: 0 };
  const warn = options.warning ?? warning;
  let sessions: readonly string[], owners: ReadonlyMap<string, TourOwnerState> = new Map();
  let roots: readonly TourOwnerRoot[];
  try { roots = captureTourOwnerRoots(options.sessionRoots); } catch { result.failed++; warn(); return result; }
  try {
    const collected = options.candidates ? { sessions: await options.candidates(), failed: false } : await candidates(root);
    sessions = [...new Set(collected.sessions)].filter(isTourSession);
    if (collected.failed) result.failed++;
  } catch { result.failed++; warn(); return result; }
  const unmarked = sessions.filter(id => tourSessionDeletionStatus(root, id) === "not-deleted");
  try { if (unmarked.length) owners = await (options.owners?.(unmarked, roots) ?? tourOwnerStates(unmarked, roots, root)); }
  catch { result.failed++; }
  const absence = options.absence, now = options.now ?? Date.now, rootsKey = JSON.stringify(roots);
  if (absence) for (const id of absence.seen.keys()) if (!sessions.includes(id)) absence.seen.delete(id);
  const cleanup = options.cleanup ?? (async (id: string) => { const { removeSessionTours } = await import("./lifecycle"); await removeSessionTours(id); });
  for (const session of sessions) {
    result.checked++;
    const deletion = tourSessionDeletionStatus(root, session);
    const status = deletion === "deleted" ? "missing" : deletion === "unknown" ? "unknown" : (owners.get(session) ?? "unknown");
    if (status === "present") { absence?.seen.delete(session); continue; }
    if (status === "unknown") { absence?.seen.delete(session); result.unknown++; continue; }
    try {
      const marker = tourSessionDeletionStatus(root, session);
      if (marker === "unknown") { absence?.seen.delete(session); result.unknown++; continue; }
      if (marker === "not-deleted") {
        const current = await (options.owners?.([session], roots) ?? tourOwnerStates([session], roots, root));
        if (current.get(session) === "present") { absence?.seen.delete(session); continue; }
        if (current.get(session) !== "missing") { absence?.seen.delete(session); result.unknown++; continue; }
      }
      if (marker !== "deleted" && JSON.stringify(captureTourOwnerRoots(options.sessionRoots)) !== rootsKey) { absence?.seen.delete(session); result.unknown++; continue; }
      if (marker !== "deleted" && absence) {
        // Absence alone: a second sighting at least a minute later, over the same folders, confirms it.
        const first = absence.seen.get(session), at = now();
        if (!first || first.roots !== rootsKey) { absence.seen.set(session, { at, roots: rootsKey }); result.unknown++; continue; }
        if (at - first.at < absence.minMs) { result.unknown++; continue; }
      }
      await cleanup(session); result.removed++;
      if (marker !== "deleted") { absence?.seen.delete(session); (options.removedAbsent ?? removedAbsent)(); }
    } catch { absence?.seen.delete(session); result.failed++; }
  }
  if (result.failed || result.unknown) warn();
  return result;
}
export interface TourSweepControl {
  /** The startup pass. */
  first: Promise<TourSweepResult>;
  run(): Promise<TourSweepResult>;
  /** Cancels the timer and resolves once a pass already running has finished; starts none. */
  stop(): Promise<void>;
}
/** One startup pass and one inexpensive, non-overlapping retry per minute; interval never holds shutdown.
    The pending warning is said once, and again only after a clean pass. */
export function startTourSweep(options: TourSweepOptions = {}): TourSweepControl {
  let stopped = false, inFlight: Promise<TourSweepResult> | undefined, warned = false;
  const warn = options.warning ?? warning;
  const absence: TourAbsenceLedger = options.absence ?? { seen: new Map(), minMs: options.absenceMs ?? 60_000 };
  const once = { ...options, absence, warning: () => { if (!warned) { warned = true; warn(); } } };
  const run = (): Promise<TourSweepResult> => {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve({ checked: 0, removed: 0, unknown: 0, failed: 0 });
    const work = sweepMissingTourOwners(once).then(result => { if (!result.failed && !result.unknown) warned = false; return result; })
      .finally(() => { if (inFlight === work) inFlight = undefined; });
    inFlight = work; return work;
  };
  const schedule = options.schedule ?? ((tick: () => void, ms: number) => { const timer = setInterval(tick, ms); timer.unref(); return () => clearInterval(timer); });
  const cancel = schedule(() => { if (!stopped) void run(); }, options.intervalMs ?? 60_000);
  const first = run(); first.catch(() => {}); // Startup never fails on cleanup; the next tick retries.
  return { first, run, async stop() { stopped = true; cancel(); await inFlight?.catch(() => {}); } };
}
