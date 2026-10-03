import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { disposeHeldChat, heldChats, isSessionBusy } from "./chat-manager";
import { workingSubagents } from "./live";
import { closeOrgHost, hostOf, isOrgHostOpen, type OrgHostApi } from "./org-engine";
import { OrgError } from "./org-error";
import { replayJournals, scanSnapshots } from "./org-host/store";
import { orgDir, orgOfProject, placeProject, readIndex, readOrg } from "./orgs";
import { canonicalPath } from "./paths";
import { readBuilds } from "./build-loadout";
import { adoptOverseerFiles, syncWatchSettings } from "./project-overseer";
import { projectOverseerPaths, readPoState } from "./project-overseer-store";
import { watchFactsChanged } from "./projects/contributions";
import { markImporting, projectsDir, readRegistry, registryEntry, removeRegistryEntry, type RegistryEntry } from "./projects/registry";
import { engineOf, openProjectEngine, readProject } from "./projects/spaces";
import { pathOfId } from "./session-prompt";
import { listSessions } from "./sessions-index";
import { readSessionTitles } from "./session-titles";
import { stateRoot } from "./state-root";
import { commitPaths } from "./workspace-git";

/**
 * Import a standalone project into an organization (§app.projects/import): the org layer's move of a project
 * whose engine is its own into the org's live engine. Nothing is rewritten: project-layer statechart ids and
 * data carry no org, so the files are copied byte for byte to the same relative paths (log segments renamed
 * `<yyyy-mm>.imported-<pid>.jsonl`), the org's engine adopts the copied sessions, and the org places the project.
 * The registry's `importing` mark is the one switch of authority: before it nothing changed; after it the move
 * only goes forward, and a start that finds the mark finishes it (`rollForwardCopies` before the orgs open,
 * `finishImports` after).
 */

/** Tests (the kill tests' child): called at each step, so a step can be cut off where it stands. */
export interface ImportHooks {
  afterMark?: () => void;
  /** After each file copied (its index in the plan). */
  copied?: (n: number) => void;
  afterAdopt?: () => void;
  beforePlace?: () => void;
}
let hooks: ImportHooks = {};
export function setImportHooksForTest(h: ImportHooks): void {
  hooks = h;
}

// ---- the plan: every file, from where to where ---------------------------------------------------------------

interface Copy {
  from: string;
  to: string;
  /** A statechart snapshot (adopted by sid). */
  sid?: string;
}

const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.isFile() ? [join(dir, d.name)] : []));
};
/** A torn write (an engine's `.tmp-<pid>`, our own `.import-tmp`) is no file to move. */
const isTemp = (f: string) => f.includes(".tmp-") || f.endsWith(".import-tmp") || f.endsWith(".tmp");

/** A log segment `<yyyy-mm>.jsonl` as it lands beside the org's: `<yyyy-mm>.imported-<pid>.jsonl`. */
export const importedSegmentName = (name: string, pid: string): string => name.replace(/\.jsonl$/, `.imported-${pid}.jsonl`);

/** A statecharts tree (portable or host-local) copied as is, its log segments renamed and its journal left. */
function chartsPlan(from: string, to: string, pid: string): Copy[] {
  const sids = new Map(scanSnapshots(from).map((s) => [s.file, s.sid]));
  const out: Copy[] = [];
  for (const file of walk(from)) {
    if (isTemp(file)) continue;
    const rel = relative(from, file);
    const [top] = rel.split("/");
    if (top === "journal") continue;
    if (top === "log") {
      if (rel.endsWith(".jsonl")) out.push({ from: file, to: join(to, "log", importedSegmentName(rel.slice(4), pid)) });
      continue;
    }
    const sid = sids.get(file);
    out.push({ from: file, to: join(to, rel), ...(sid ? { sid } : {}) });
  }
  return out;
}

function planOf(pid: string, projectDir: string, orgId: string, ws: string): Copy[] {
  const same = (from: string, to: string): Copy[] => walk(from).filter((f) => !isTemp(f)).map((f) => ({ from: f, to: join(to, relative(from, f)) }));
  return [
    ...chartsPlan(join(projectDir, "statecharts"), join(ws, "statecharts"), pid),
    ...chartsPlan(join(stateRoot(), "statecharts", pid), join(stateRoot(), "statecharts", orgId), pid),
    ...same(join(projectDir, "projects", pid), join(ws, "projects", pid)),
    ...same(join(projectDir, "sessions"), join(ws, "sessions")),
  ];
}

const sameBytes = (a: string, b: string): boolean => {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/** The first destination that holds other bytes (a collision), or null. */
const collisionOf = (plan: Copy[]): Copy | null => plan.find((c) => existsSync(c.to) && !sameBytes(c.from, c.to)) ?? null;

/**
 * Copy the plan byte for byte, each file through a temp name and a rename (a cut-off copy leaves no half file
 * under its real name). `forward` (after the mark, again): a destination that exists is the org's now (copied
 * before, maybe stepped since) and is kept; else one with other bytes stops the copy.
 */
function copyPlan(plan: Copy[], forward: boolean): void {
  plan.forEach((c, i) => {
    const tmp = `${c.to}.import-tmp`;
    rmSync(tmp, { force: true });
    if (existsSync(c.to)) {
      if (!forward && !sameBytes(c.from, c.to)) throw new OrgError(`${c.to} already exists with other content.`, 409);
    } else {
      mkdirSync(dirname(c.to), { recursive: true });
      copyFileSync(c.from, tmp);
      renameSync(tmp, c.to);
    }
    hooks.copied?.(i);
  });
}

// ---- quiet ---------------------------------------------------------------------------------------------------

/** What the project's files are being written by: each a phrase for "{project} isn't quiet: {what}." */
interface Activity {
  overseerPath: string | null;
  builds: { title: string; path?: string }[];
}

async function activityOf(pid: string): Promise<Activity> {
  const st = readPoState(projectOverseerPaths(pid));
  const titles = readSessionTitles();
  return {
    overseerPath: st ? await pathOfId(st.current) : null,
    builds: readBuilds(pid).map((b) => ({ title: titles[b.sessionId] || b.title || b.sessionId, path: b.path })),
  };
}

/** What keeps the project from being quiet, read from its engine (open or just closed) and its chats. */
function busyOf(host: OrgHostApi, a: Activity): string[] {
  const out: string[] = [];
  if (a.overseerPath && isSessionBusy(a.overseerPath)) out.push("its overseer is working");
  const coding = a.builds.filter((b) => b.path && (isSessionBusy(b.path) || workingSubagents(b.path) > 0)).map((b) => b.title);
  if (coding.length) out.push(`${coding.length === 1 ? "a coding session is" : `${coding.length} coding sessions are`} working (${coding.join(", ")})`);
  if (host.holds().length) out.push("a held act waits");
  const sessions = host.sessions(undefined, { warmOnly: true });
  if (sessions.some((s) => Object.keys((s.data["sova/pending"] as object | undefined) ?? {}).length)) out.push("an effect is in progress");
  const invoking = sessions.some((s) => (host.statechartInfo(s.statechart)?.invocations ?? []).some((inv) => s.configuration.includes(inv.state)));
  if (invoking) out.push("a run is in progress");
  return out;
}

const notQuiet = (name: string, what: string[]) => new OrgError(`${name} isn't quiet: ${what.join("; ")}. Try again when it is.`, 409);

// ---- the import ------------------------------------------------------------------------------------------

export const confirmSentence = (project: string, org: string) =>
  `Importing ${project} commits its history (overseer conversations, builds, costs) to ${org}'s workspace repo. It can't be undone.`;

/**
 * Import `projectId` (standalone here) into `orgId` (attached here). Without `confirm` nothing changes: the
 * confirm sentence comes back as a 409 with `code: "confirm"`. Every refusal before the mark changes nothing.
 */
export async function importProject(orgId: string, projectId: unknown, confirm: boolean): Promise<void> {
  const org = readOrg(orgId);
  orgDir(orgId);
  const orgHost = hostOf(orgId);
  if (typeof projectId !== "string" || !projectId) throw new OrgError("projectId is required");
  const entry = registryEntry(projectId);
  if (!entry) {
    const placedIn = engineOf(projectId) ? orgOfProject(projectId) : null;
    if (placedIn) throw new OrgError(`${readProject(projectId).name} is already in ${readOrg(placedIn).name}.`, 409);
    throw new OrgError("Unknown project", 404);
  }
  if (entry.importing) throw new OrgError(`${projectId} is already being imported.`, 409);
  if (engineOf(projectId) !== projectId) throw new OrgError("That project's engine is not open on this host.", 409);
  const name = readProject(projectId).name;
  const ws = orgDir(orgId);
  const busy = busyOf(hostOf(projectId), await activityOf(projectId));
  if (busy.length) throw notQuiet(name, busy);
  const clash = collisionOf(planOf(projectId, entry.dir, orgId, ws));
  if (clash) throw new OrgError(`${name} can't be imported: ${relative(ws, clash.to).startsWith("..") ? clash.to : relative(ws, clash.to)} already exists in ${org.name} with other content.`, 409);
  if (!confirm) throw new OrgError(confirmSentence(name, org.name), 409, "confirm");

  // The mark, then the fence: the engine closes (its timers stop), and what it left is checked again.
  const at = new Date().toISOString();
  const activity = await activityOf(projectId);
  const own = hostOf(projectId);
  markImporting(projectId, { org: orgId, at });
  hooks.afterMark?.();
  await closeOrgHost(projectId);
  const still = busyOf(own, activity);
  if (still.length) {
    try {
      await openProjectEngine(projectId, entry.dir);
    } finally {
      markImporting(projectId, null);
    }
    throw notQuiet(name, still);
  }
  await disposeChats(entry.dir);

  try {
    const plan = planOf(projectId, entry.dir, orgId, ws);
    copyPlan(plan, false);
    await orgHost.adopt(plan.flatMap((c) => (c.sid ? [c.sid] : [])));
    hooks.afterAdopt?.();
  } catch (err) {
    // After the mark nothing rolls back: the next start finishes it from the files.
    throw new OrgError(`The import of ${name} stopped: ${err instanceof Error ? err.message : String(err)} It finishes at the next server start.`, 409);
  }
  hooks.beforePlace?.();
  await placeProject(orgId, projectId, "import");
  await finishOne({ ...entry, importing: { org: orgId, at } }, name);
}

/** Close every held chat of the project's conversations (their files move): viewers reopen at the new path. */
async function disposeChats(projectDir: string): Promise<void> {
  const dir = canonicalPath(join(projectDir, "sessions"));
  for (const chat of heldChats()) if (dirname(chat.path) === dir) await disposeHeldChat(chat.path, "This project moved into an organization. Opening it there.");
}

/** Steps 8–9: the conversations' host-local view, the workspace commit, the standalone dir set aside, the entry dropped. */
async function finishOne(entry: RegistryEntry, name: string): Promise<void> {
  const orgId = entry.importing!.org;
  const ws = orgDir(orgId);
  adoptOverseerFiles(ws, [{ id: entry.id, name }]);
  await watchFactsChanged(orgId).catch((err) => console.warn(`[import] ${entry.id}: watch facts: ${err instanceof Error ? err.message : String(err)}`));
  await syncWatchSettings(entry.id).catch(() => {});
  await commitPaths(ws, ["statecharts", join("projects", entry.id), "sessions"], `Imported project ${name}`).catch((err) =>
    console.warn(`[import] ${entry.id}: workspace commit: ${err instanceof Error ? err.message : String(err)}`),
  );
  // the entry first: a cut-off here leaves only a stray dir, never a second claim on the project
  removeRegistryEntry(entry.id);
  const aside = join(projectsDir(), ".imported", `${entry.id}-${entry.importing!.at.replace(/[:.]/g, "-")}`);
  mkdirSync(dirname(aside), { recursive: true });
  if (existsSync(entry.dir)) renameSync(entry.dir, aside);
  const local = join(stateRoot(), "statecharts", entry.id);
  if (existsSync(local)) {
    mkdirSync(aside, { recursive: true });
    renameSync(local, join(aside, "host-local"));
  }
  // the session list's id → path cache drops the old paths
  await listSessions().catch(() => {});
}

// ---- a start that finds a mark ---------------------------------------------------------------------------

const marked = (): RegistryEntry[] => readRegistry().filter((e) => e.importing);

/** Before the orgs open: every marked project's copy again (what was copied is kept), so the org's open loads it. */
export function rollForwardCopies(): void {
  const orgs = new Map(readIndex().orgs.map((o) => [o.id, o.dir]));
  for (const e of marked()) {
    const ws = orgs.get(e.importing!.org);
    if (!ws) {
      console.warn(`[import] ${e.id}: its organization ${e.importing!.org} is not attached here; the import waits.`);
      continue;
    }
    try {
      // a commit the engine had journalled before its close is applied to the project's own files first
      replayJournals(join(stateRoot(), "statecharts", e.id, "journal"), true);
      copyPlan(planOf(e.id, e.dir, e.importing!.org, ws), true);
    } catch (err) {
      console.warn(`[import] ${e.id}: copy not finished: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** After the orgs opened (each placed what its engine holds): the rest of every marked import. */
export async function finishImports(): Promise<void> {
  for (const e of marked()) {
    const orgId = e.importing!.org;
    if (!isOrgHostOpen(orgId) || !engineOf(e.id) || engineOf(e.id) !== orgId) {
      console.warn(`[import] ${e.id}: not in ${orgId}'s engine yet; the import waits for the next start.`);
      continue;
    }
    try {
      await placeProject(orgId, e.id, "import");
      await finishOne(e, readProject(e.id).name);
    } catch (err) {
      console.warn(`[import] ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
