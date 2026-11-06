import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adoptedService, CONTRACT_FILE, parseDefinition } from "../../shared/project-contract";
import type { ProjectGlance, ProjectGlanceList, ProjectGlanceQueue, ProjectGlanceRelease, ProjectSummary } from "../../shared/projects";
import type { ReleaseRecord } from "../../shared/release";

/**
 * The project cards' runtime figures (§app.projects/home-glance): for every listed project at once, Ready to merge and
 * what is in line or landing from the merge queue's newest kept view (a served project's first view read once, in the
 * background, then kept), its release from the releaser's kept records,
 * Running slots from the copies' records and the copy limit, and the memory its chats and running copies use now.
 * It gathers what Sova keeps: past that one first view of a served project it builds no queue view, makes no queue for a
 * project the queue doesn't serve, runs no git, spawns nothing and probes no service. `buildGlance` is pure over its deps; `readGlance` wires the server's and shares one answer for 10 s.
 */

/** One copy's record, as the registry keeps it (only what the glance reads). */
export interface GlanceInstance {
  id: string;
  project: string;
  slot: number;
  createdBy: string;
  desired: Record<string, "running" | "stopped">;
}

export interface GlanceDeps {
  projects: readonly Pick<ProjectSummary, "id" | "root" | "archived">[];
  /** The same folder, whatever its spelling (a symlink, a trailing slash). */
  sameRoot(a: string, b: string): boolean;
  /** The queue's state for a project: served with its kept view's cut, its first view being read, or unserved. */
  queueOf(root: string): { state: "served"; cut: ProjectGlanceQueue } | { state: "reading" | "unserved" };
  /** The releaser's kept records of a root: undefined when it keeps none. */
  releaseOf(root: string): { open: ReleaseRecord | null; last: ReleaseRecord | null } | undefined;
  /** The project's own file at its root (the unit its main checkout adopts, and for which service), or null: none. */
  definitionOf(root: string): { adoptedUnit: string | null; adoptedService: string | null } | null;
  /** The copy limit in force (§app.project-services/instances). */
  capOf(root: string): number;
  instances: readonly GlanceInstance[];
  shared: readonly { id: string; project: string; desired: Record<string, "running" | "stopped"> }[];
  /** A Sova service's unit name (without `.service`). */
  unitOf(scopeId: string, service: string): string;
  /** A unit's processes (its whole name), [] when it runs none. */
  unitPids(unit: string): number[];
  /** One process's own memory now, null when gone. */
  ownMemory(pid: number): number | null;
  /** The resource monitor's newest sample's sessions (each with its workers and tools), or [] before its first. */
  monitorSessions: readonly { sessionPath?: string; privBytes?: number }[];
  /** The project a listed session belongs to, by its file. */
  projectOfSession(path: string): string | null;
  hostTotalBytes: number | null;
  now: Date;
}

/** Counts as one of the copy limit's running copies: not the main checkout's, not conformance's, a service wanted running. */
const countsAsRunning = (i: GlanceInstance): boolean => i.slot !== 0 && !i.createdBy.startsWith("conform:") && Object.values(i.desired).some((d) => d === "running");

const unsettled = (s: { state: string }): boolean => s.state === "waiting" || s.state === "running" || s.state === "failed" || s.state === "held";

/** The release a card shows: the open one, else the newest one while its after-publish (or after-withdraw) steps still
 *  have work, as the Releases tab picks it; null otherwise. Each step cut to its id, label, phase and state. */
export function releaseGlanceOf(kept: { open: ReleaseRecord | null; last: ReleaseRecord | null } | undefined): ProjectGlanceRelease | null {
  if (!kept) return null;
  let r = kept.open;
  if (!r && kept.last) {
    const phase = kept.last.state === "published" ? "after" : kept.last.state === "withdrawn" ? "withdraw" : null;
    if (phase && kept.last.steps.some((s) => s.phase === phase && unsettled(s))) r = kept.last;
  }
  if (!r) return null;
  return { id: r.id, state: r.state, version: r.version, tag: r.tag, steps: r.steps.map((s) => ({ id: s.id, label: s.label, phase: s.phase, state: s.state })) };
}

/** Every listed project's figures. Pure over `d`. */
export function buildGlance(d: GlanceDeps): ProjectGlanceList {
  const listed = d.projects.filter((p) => !p.archived);
  // Chats: the monitor's newest sample, each session charged to the project that lists it.
  const chats = new Map<string, number>();
  for (const s of d.monitorSessions) {
    if (!s.sessionPath || !s.privBytes) continue;
    const pid = d.projectOfSession(s.sessionPath);
    if (pid) chats.set(pid, (chats.get(pid) ?? 0) + s.privBytes);
  }
  const glances = listed.map((p): ProjectGlance => {
    const def = d.definitionOf(p.root);
    const mine = d.instances.filter((i) => d.sameRoot(i.project, p.root));
    // Copies: each running unit's own processes, each process counted once.
    const units: string[] = [];
    for (const i of mine)
      for (const [svc, want] of Object.entries(i.desired)) {
        if (want !== "running") continue;
        units.push(i.slot === 0 && def?.adoptedUnit && svc === def.adoptedService ? def.adoptedUnit : `${d.unitOf(i.id, svc)}.service`);
      }
    for (const sh of d.shared.filter((x) => d.sameRoot(x.project, p.root)))
      for (const [svc, want] of Object.entries(sh.desired)) if (want === "running") units.push(`${d.unitOf(sh.id, svc)}.service`);
    const seen = new Set<number>();
    let copiesBytes = 0;
    for (const u of new Set(units))
      for (const pid of d.unitPids(u)) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        copiesBytes += d.ownMemory(pid) ?? 0;
      }
    const q = d.queueOf(p.root);
    return {
      projectId: p.id,
      merge: q.state,
      queue: q.state === "served" ? q.cut : null,
      slots: def ? { running: mine.filter(countsAsRunning).length, cap: d.capOf(p.root) } : null,
      memory: { chatsBytes: chats.get(p.id) ?? 0, copiesBytes },
      release: releaseGlanceOf(d.releaseOf(p.root)),
    };
  });
  return { glances, hostTotalBytes: d.hostTotalBytes, at: d.now.toISOString() };
}

/** A project's file at its root: whether there is one, and the unit its main checkout adopts (and which service). */
export function definitionAtRoot(root: string): { adoptedUnit: string | null; adoptedService: string | null } | null {
  const file = join(root, CONTRACT_FILE);
  if (!existsSync(file)) return null;
  try {
    const def = parseDefinition(readFileSync(file, "utf8"));
    const a = adoptedService(def);
    return { adoptedUnit: a?.adopt?.unit ?? null, adoptedService: a?.name ?? null };
  } catch {
    // A file that doesn't parse is still the project's file: its copies are counted, nothing adopted.
    return { adoptedUnit: null, adoptedService: null };
  }
}

/** One answer shared by every overview open at once, for up to GLANCE_REUSE_MS. */
export const GLANCE_REUSE_MS = 10_000;
let cached: { at: number; answer: Promise<ProjectGlanceList> } | null = null;

/** Tests only: forget the shared answer. */
export function resetGlanceForTest(): void {
  cached = null;
}

/** The server's glance (GET /api/projects/glance): built from what the server keeps, reused for 10 s. */
export function readGlance(now = Date.now()): Promise<ProjectGlanceList> {
  if (cached && now - cached.at < GLANCE_REUSE_MS && now >= cached.at) return cached.answer;
  const answer = gatherGlance();
  cached = { at: now, answer };
  answer.catch(() => {
    if (cached?.answer === answer) cached = null;
  });
  return answer;
}

async function gatherGlance(): Promise<ProjectGlanceList> {
  const [{ listProjects }, { queueGlanceState }, { keptReleases }, { readRegistry, stateHash }, { copyLimitOf }, { machineCopyLimit }, drivers, { resourceMonitor }, { lastListedRows }, { canonicalPath }, os] = await Promise.all([
    import("./spaces"),
    import("../merge-queue/wire"),
    import("../project-services/release-wire"),
    import("../project-services/store"),
    import("../../shared/project-slots"),
    import("../project-services/copy-limit"),
    import("../project-services/drivers"),
    import("../resource-monitor"),
    import("../sessions-index"),
    import("../paths"),
    import("node:os"),
  ]);
  const reg = readRegistry();
  const snap = resourceMonitor()?.snapshot() ?? null;
  const rows = lastListedRows();
  const canon = new Map<string, string>();
  const c = (p: string) => {
    let v = canon.get(p);
    if (v === undefined) {
      v = canonicalPath(p);
      canon.set(p, v);
    }
    return v;
  };
  const manager = drivers.userManagerCgroup();
  return buildGlance({
    projects: listProjects(),
    sameRoot: (a, b) => c(a) === c(b),
    queueOf: (root) => queueGlanceState(root),
    releaseOf: (root) => keptReleases(root),
    definitionOf: (root) => definitionAtRoot(root),
    capOf: (root) => copyLimitOf(c(root), { machine: machineCopyLimit(c(root)) }).cap,
    instances: reg.instances,
    shared: reg.shared,
    unitOf: (scopeId, service) => `sova-svc-${stateHash()}-${scopeId}-${service}`,
    // Linux with a user manager: the unit's own cgroup.procs. Elsewhere copies' processes aren't read (nothing is spawned).
    unitPids: (unit) => drivers.unitCgroupPids(unit, manager) ?? [],
    ownMemory: (pid) => drivers.ownMemoryOfPid(pid),
    monitorSessions: snap?.sessions ?? [],
    projectOfSession: (path) => rows.get(path)?.project?.projectId ?? null,
    hostTotalBytes: snap?.host.memTotalBytes || os.totalmem() || null,
    now: new Date(),
  });
}
