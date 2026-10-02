import { join } from "node:path";
import type { ProjectSummary } from "../../shared/projects";
import { actOrThrow, engineDir, envelopeFor, hostOf, isOrgHostOpen, onOrgChange, onOrgHostOpened, openEngineIds, openOrgHost, type OrgHostApi } from "../org-engine";
import type { Envelope, EnvelopeCard } from "../org-envelope";
import type { StampWho } from "../org-stamp";
import { OrgError } from "../org-error";
import { canonicalPath, setProjectSessionRoots } from "../paths";
import { stateRoot } from "../state-root";
import { pausedSinceOf, reservedRoots, spaceOf } from "./contributions";
import { addRegistryEntry, mintProjectId, prepareRegistration, readRegistry, removeRegistryEntry, RegistryError } from "./registry";
import { buildSid, projectSid, runtimeSid, watchSid } from "./sids";

/**
 * Where each project lives (design §2 "Engines"): the engine that holds its `project/<p>` session. A
 * standalone project has its own engine, keyed by its id, with the workspace layout under
 * `<stateRoot>/projects/<pid>/` (server/projects/registry.ts lists them); a project another layer placed
 * lives in that layer's engine. Which engine is found by looking, never from the id: every open engine's
 * `project` sessions are its projects.
 */

export { buildSid, projectSid, runtimeSid, watchSid };

/** Where each project was last found (checked again on every read). */
const where = new Map<string, string>();

function indexEngine(engine: string, host: Pick<OrgHostApi, "sessions">): void {
  for (const s of host.sessions("project")) {
    const id = s.data.id;
    if (typeof id === "string" && id) where.set(id, engine);
  }
}
onOrgHostOpened((host, engine) => indexEngine(engine, host));
onOrgChange((engine, change) => {
  if (change.sessions.some((sid) => sid.startsWith("project/")) && isOrgHostOpen(engine)) indexEngine(engine, hostOf(engine));
});

const holds = (engine: string, projectId: string): boolean => isOrgHostOpen(engine) && !!hostOf(engine).data(projectSid(projectId));

/** The engine that holds the project on this host, or null. */
export function engineOf(projectId: string): string | null {
  const hit = where.get(projectId);
  if (hit && holds(hit, projectId)) return hit;
  where.delete(projectId);
  for (const engine of openEngineIds())
    if (holds(engine, projectId)) {
      where.set(projectId, engine);
      return engine;
    }
  return null;
}

/** The engine that holds the project, or a 404. */
export function engineOrThrow(projectId: string): string {
  const engine = engineOf(projectId);
  if (!engine) throw new OrgError("Unknown project", 404);
  return engine;
}

/** The open engine of the project, or a 404. */
export const projectHost = (projectId: string): OrgHostApi => hostOf(engineOrThrow(projectId));

/** The project's workspace-layout directory (its `projects/<pid>/`, `sessions/` and portable statecharts are under it). */
export const projectDir = (projectId: string): string => engineDir(engineOrThrow(projectId));

/** Whether the project has an engine of its own (no other layer holds it). */
export const isStandalone = (projectId: string): boolean => engineOf(projectId) === projectId;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isoOf = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === "string" ? v : "");

function summaryOf(engine: string, d: Record<string, unknown>, configuration: readonly string[]): ProjectSummary {
  const id = String(d.id);
  const archived = d.archived;
  return {
    id,
    name: String(d.name ?? ""),
    root: String(d.root ?? ""),
    origin: typeof d.origin === "string" && d.origin ? d.origin : "manual",
    ...(typeof d.remote === "string" && d.remote ? { remote: d.remote } : {}),
    createdAt: isoOf(d.createdAt),
    ...(configuration.includes("archived") && isObj(archived) ? { archived: { at: isoOf(archived.at), ...(archived.via === "overseer" ? { via: "overseer" as const } : {}) } } : {}),
    space: spaceOf(engine, id),
  };
}

/** The project as its statechart holds it, or a 404. */
export function readProject(projectId: string): ProjectSummary {
  const engine = engineOrThrow(projectId);
  const host = hostOf(engine);
  const sid = projectSid(projectId);
  return summaryOf(engine, host.data(sid) ?? {}, host.configuration(sid) ?? []);
}

/** Every project on this host (every open engine's), oldest first. */
export function listProjects(): ProjectSummary[] {
  const out: ProjectSummary[] = [];
  for (const engine of openEngineIds()) for (const s of hostOf(engine).sessions("project")) if (typeof s.data.id === "string") out.push(summaryOf(engine, s.data, s.configuration));
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The engine's projects (an engine may hold several). */
export function projectsOfEngine(engine: string): ProjectSummary[] {
  if (!isOrgHostOpen(engine)) return [];
  return hostOf(engine)
    .sessions("project")
    .filter((s) => typeof s.data.id === "string")
    .map((s) => summaryOf(engine, s.data, s.configuration));
}

// ---- acts on a project -------------------------------------------------------------------------------

/** The envelope for an act of `who` on the project, from its engine's statecharts as they stand now. */
export const projectEnvelope = (projectId: string, who: StampWho): Envelope => envelopeFor(engineOrThrow(projectId), projectId, who);

/** Who an operator's act is: from the page, or the global Overseer for them (`via`, its conversation, its card). */
export type OperatorBy = { kind: "operator"; via?: "overseer"; overseerId?: string; card?: EnvelopeCard };
const OPERATOR_BY: OperatorBy = { kind: "operator" };

/** The operator's envelope for an act on the project. */
export function operatorEnvelopeOf(projectId: string, by: OperatorBy = OPERATOR_BY, extra: Record<string, unknown> = {}): Envelope {
  return { ...projectEnvelope(projectId, { by: "operator", attended: true, ...(by.via ? { via: by.via } : {}), ...(by.overseerId ? { overseerId: by.overseerId } : {}), ...(by.card ? { card: by.card } : {}) }), ...extra };
}

/** Whether the project is archived (false for an unknown one). */
export function projectArchived(projectId: string): boolean {
  const engine = engineOf(projectId);
  return !!engine && !!hostOf(engine).configuration(projectSid(projectId))?.includes("archived");
}

/** "{project} is archived. Unarchive it first.": every new start in an archived project. */
export const archivedRefusal = (name: string) => `${name} is archived. Unarchive it first.`;
/** Its overseer's: Run Now, a message to it, its start. */
export const archivedOverseerRefusal = (name: string) => `${name} is archived. Unarchive it to use its overseer.`;

/** Refuse a new start in an archived project (409). */
export function assertNotArchived(projectId: string): void {
  const p = readProject(projectId);
  if (p.archived) throw new OrgError(archivedRefusal(p.name), 409);
}

const NAME_MAX = 80;

/** Why a name can't be a project's, or null. */
function nameProblem(v: unknown): string | null {
  return typeof v === "string" && v.trim() && v.trim().length <= NAME_MAX ? null : `name must be 1–${NAME_MAX} characters`;
}

/**
 * Rename the project or move its root (`project/edit`): every part checked before anything is written, a
 * root normalized to its checkout root and refused like a registration's (reserved, or another project's).
 */
export async function editProject(projectId: string, patch: { name?: unknown; root?: unknown }, by: OperatorBy = OPERATOR_BY): Promise<ProjectSummary> {
  const before = readProject(projectId);
  const edit: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const why = nameProblem(patch.name);
    if (why) throw new OrgError(why);
    edit.name = (patch.name as string).trim();
  }
  if (patch.root !== undefined) {
    const prepared = await prepareRegistration(patch.root, { rootsInUse: () => listProjects().filter((p) => p.id !== projectId), reservedRoots });
    if (prepared.root !== before.root) edit.root = prepared.root;
  }
  if (Object.keys(edit).length) await actOrThrow(engineOrThrow(projectId), projectSid(projectId), "project/edit", edit, operatorEnvelopeOf(projectId, by));
  return readProject(projectId);
}

/** What must be stopped before a project is archived, as the archive act's `blockers` stamp: other layers'
    phrases ("2 gathering sessions open (A, B)"), its coding sessions' titles, whether its overseer works. */
export interface ArchiveBlockers {
  phrases: string[];
  coding: string[];
  overseerWorking: boolean;
}

/**
 * Archive or unarchive a project (§app.organizations/archive): the project statechart refuses an archive while
 * anything is open ("Stop these first: …", from `blockers`, which the caller reads); the same state again writes nothing.
 */
export async function setProjectArchived(projectId: string, archived: boolean, by: OperatorBy = OPERATOR_BY, blockers?: ArchiveBlockers, extra: Record<string, unknown> = {}): Promise<ProjectSummary> {
  readProject(projectId);
  await actOrThrow(
    engineOrThrow(projectId),
    projectSid(projectId),
    archived ? "project/archive" : "project/unarchive",
    archived ? { blockers: blockers ?? { phrases: [], coding: [], overseerWorking: false } } : {},
    operatorEnvelopeOf(projectId, by, extra),
  );
  return readProject(projectId);
}

/** When the project's overseer was paused on this host (ISO), or null: not paused. */
export function overseerPausedSince(projectId: string): string | null {
  const engine = engineOf(projectId);
  if (!engine || !hostOf(engine).configuration(watchSid(projectId))?.includes("paused")) return null;
  return pausedSinceOf(engine, projectId) ?? new Date(0).toISOString();
}

/** The operator set the project overseer's level on this host (`resumeAt`, the level they chose): a pause ends (any level). */
export async function resumeOverseer(projectId: string, resumeAt?: string): Promise<void> {
  const engine = engineOf(projectId);
  if (!engine || !hostOf(engine).configuration(watchSid(projectId))) return;
  await hostOf(engine).act(watchSid(projectId), "operator/level-set", resumeAt ? { resumeAt } : {}, operatorEnvelopeOf(projectId));
}

// ---- standalone engines --------------------------------------------------------------------------

/** The modules whose handlers a project's engine needs, loaded before it opens (they import this module). */
async function loadHandlers(): Promise<void> {
  await import("../build-loadout"); // the build statecharts' effects
  await import("../project-overseer-store"); // the settings every act is stamped with
  await import("../project-overseer"); // the look, the preview effect
  await import("./runtime"); // the software registry's effects and its start for existing projects
}

/** Open a standalone project's engine (once). */
export async function openProjectEngine(projectId: string, dir: string): Promise<OrgHostApi> {
  await loadHandlers();
  return openOrgHost({ orgId: projectId, workspaceDir: dir, stateDir: stateRoot() });
}

/** Open every registered project's engine (server start). One that fails is logged; its reads say it is unknown. */
export async function openRegisteredProjects(): Promise<void> {
  for (const e of readRegistry()) {
    if (e.importing) continue;
    try {
      await openProjectEngine(e.id, e.dir);
    } catch (err) {
      console.warn(`[projects] ${e.id}: not opened: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Every registered project's `sessions/` dir: its overseer conversations are session files like any other. */
setProjectSessionRoots(() => readRegistry().filter((e) => !e.importing).map((e) => canonicalPath(join(e.dir, "sessions"))));

// ---- registration ----------------------------------------------------------------------------------

export interface RegisterInput {
  name?: unknown;
  /** "folder", "session", "clone". */
  origin: string;
  remote?: string;
}

/** Every id a new project must not take: registered ones and every open engine's. */
const idsInUse = (): string[] => [...readRegistry().map((e) => e.id), ...listProjects().map((p) => p.id)];

/**
 * Register `rawRoot` as a project (§app/projects): normalized to its checkout root, refused when it is
 * already a project here or a reserved root. `engine` "standalone": its own engine, made here; else the
 * open engine that will hold it. Starts `project/<p>`, which starts its watch.
 */
export async function registerProjectIn(engine: string, rawRoot: unknown, input: RegisterInput): Promise<{ project: ProjectSummary; normalizedFrom?: string }> {
  const prepared = await prepareRegistration(rawRoot, { rootsInUse: () => listProjects(), reservedRoots });
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : prepared.name;
  const data = (id: string) => ({ id, name, root: prepared.root, origin: input.origin, ...(input.remote ? { remote: input.remote } : {}), createdAt: Date.now() });
  let id: string;
  if (engine === "standalone") {
    const entry = addRegistryEntry(idsInUse());
    id = entry.id;
    try {
      const host = await openProjectEngine(id, entry.dir);
      await start(host, id, data(id));
    } catch (err) {
      removeRegistryEntry(id, { removeEmptyDir: true });
      throw err;
    }
  } else {
    if (!isOrgHostOpen(engine)) throw new RegistryError("That engine is not open on this host.", 409);
    id = mintProjectId(idsInUse());
    await start(hostOf(engine), id, data(id));
  }
  where.set(id, engine === "standalone" ? id : engine);
  return { project: readProject(id), ...(prepared.normalizedFrom ? { normalizedFrom: prepared.normalizedFrom } : {}) };
}

async function start(host: OrgHostApi, id: string, data: Record<string, unknown>): Promise<void> {
  const r = await host.start(projectSid(id), "project", data, { by: "operator" });
  const refused = (r as { refusal?: { sentence?: string } } | undefined)?.refusal;
  if (refused) throw new RegistryError(refused.sentence ?? "The project could not be started.", 409);
}

/** Tests only. */
export function resetSpacesForTest(): void {
  where.clear();
}
