// Bare "/new" in the composer: a fresh session in the chat's folder, and the
// chat it was typed in goes to the Archive. Kept free of the api module so it's testable.

import type { CodingStartResult } from "../../shared/project-overseer";
import type { ProjectSummary } from "../../shared/projects";
import { hiddenFolder } from "./hidden-folders";
import { isRemoteCwd, type RemotePlace, remoteRecents, splitRemoteCwd } from "./remote-session";

type Located = { cwd: string; overseer?: true };

/** How many recent folders a list offers: the dialog's own list and the picker's Recent view. */
export const MAX_RECENT = 20;

/**
 * The path a folder is judged by: for a remote session's placeholder cwd
 * (`<home>/.pi/agent/sova/targets/<target>/<remote path>`) it is the path ON the target. The
 * placeholder is hidden itself (`.pi`), so judging it directly would hide every remote folder.
 */
const offeredPath = (cwd: string): string => splitRemoteCwd(cwd)?.remoteCwd ?? cwd;

/** True when the dialog offers this folder at all: hidden ones need Show hidden folders. */
export const offersCwd = (cwd: string, showHidden: boolean): boolean => showHidden || !hiddenFolder(offeredPath(cwd));

/** The one line under a recent list that dropped rows, e.g. "3 hidden folders are not listed." */
export function hiddenRecentNote(count: number): string {
  return count === 1 ? "1 hidden folder is not listed." : `${count} hidden folders are not listed.`;
}

/** The folder "/new" starts in: the chat's own, else the most recently active session's. The
    Overseer's folder is its state, not a project, so an Overseer file never supplies one: from its
    page, the most recent other session's folder is used. A folder `offers` refuses — a hidden one
    while Show hidden folders is off — is passed over, and the next session's is tried. */
export function newSessionCwd(
  current: Located | null | undefined,
  sessions: readonly (Located & { lastActiveAt: string })[],
  offers: (cwd: string) => boolean = () => true,
  /** The root of the project whose page is open (§app/new-session-dialog, Prefill): the dialog opens on it. */
  projectRoot: string | null = null,
): string | null {
  if (current?.cwd && !current.overseer && offers(current.cwd)) return current.cwd;
  if (projectRoot && offers(projectRoot)) return projectRoot;
  const latest = sessions
    .filter((s) => !s.overseer && !!s.cwd && offers(s.cwd))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];
  return latest?.cwd || null;
}

/** The recent local folders a list shows: the remote placeholders out, the hidden ones out while
    Show hidden folders is off, in the order given (newest first), at most MAX_RECENT. */
export function recentFolders(cwds: readonly string[], showHidden: boolean): string[] {
  return cwds.filter((c) => !isRemoteCwd(c) && offersCwd(c, showHidden)).slice(0, MAX_RECENT);
}

/** The same for the Remote tab's recents, judged by each folder's path on its target. */
export function recentRemoteFolders(cwds: readonly string[], showHidden: boolean): RemotePlace[] {
  return remoteRecents(cwds)
    .filter((p) => showHidden || !hiddenFolder(p.remoteCwd))
    .slice(0, MAX_RECENT);
}

export type NewSessionOutcome<S> =
  | { ok: true; session: S; archiveError: string | null }
  | { ok: false; error: string };

/**
 * Creates first, archives the source only once that worked: a failed create leaves the chat the
 * user is in exactly as it was. A failed archive doesn't undo the new session. A null source is
 * one the caller keeps open: nothing is archived.
 */
export async function createThenArchive<S>(
  cwd: string,
  source: string | null,
  api: { create(cwd: string): Promise<S>; archive(path: string): Promise<unknown> },
): Promise<NewSessionOutcome<S>> {
  let session: S;
  try {
    session = await api.create(cwd);
  } catch (err) {
    return { ok: false, error: (err as Error).message || "The session couldn't be created." };
  }
  if (source === null) return { ok: true, session, archiveError: null };
  try {
    await api.archive(source);
    return { ok: true, session, archiveError: null };
  } catch (err) {
    return { ok: true, session, archiveError: (err as Error).message || "Unknown error." };
  }
}

/**
 * Prunes a just-archived session from the rows this tab created (App's `created`): archiving takes
 * the session off the server's list — a message-less one is deleted outright — so the row frozen at
 * creation would outlive it in the sidebar. Unarchiving leaves the set alone. True when one went.
 */
export function dropArchived(created: { delete(path: string): boolean }, path: string, archived: boolean): boolean {
  return archived ? created.delete(path) : false;
}

/** A row of New Session's Project tab: a project on this host, and where it lives. */
export interface ProjectChoice {
  id: string;
  name: string;
  root: string;
  /** Its organization's name, or "Standalone". */
  place: string;
}

/** The Project tab's rows: every project that isn't archived, by name (case-insensitive). */
export function projectChoices(projects: readonly ProjectSummary[]): ProjectChoice[] {
  return projects
    .filter((p) => !p.archived)
    .map((p) => ({ id: p.id, name: p.name, root: p.root, place: p.space.kind === "org" ? p.space.orgName : "Standalone" }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.root.localeCompare(b.root));
}

/** `cwd` is `root` or inside it. */
const under = (root: string, cwd: string) => {
  const r = root.replace(/\/+$/, "") || "/";
  return cwd === r || cwd.startsWith(r === "/" ? r : `${r}/`);
};

/** The project the open session's folder is in (its root, or inside it; the deepest root wins), or null. */
export function projectAt(choices: readonly ProjectChoice[], cwd: string): string | null {
  if (!cwd) return null;
  let best: ProjectChoice | null = null;
  for (const c of choices) if (under(c.root, cwd) && (!best || c.root.length > best.root.length)) best = c;
  return best?.id ?? null;
}

/**
 * The project whose folder New Session's folder tab holds: its root, a folder inside
 * it, or inside one of its worktrees as Sova names them (`<root's parent>/.worktrees/<root's name>-…`); the deepest
 * root wins. The server checks the folder again when it starts there.
 */
export function folderProject(choices: readonly ProjectChoice[], cwd: string): ProjectChoice | null {
  if (!cwd.startsWith("/")) return null;
  let best: { c: ProjectChoice; len: number } | null = null;
  for (const c of choices) {
    const root = c.root.replace(/\/+$/, "");
    const cut = root.lastIndexOf("/");
    const tree = root ? `${root.slice(0, cut)}/.worktrees/${root.slice(cut + 1)}-` : null;
    const len = under(root, cwd) ? root.length : tree && cwd.startsWith(tree) && cwd.length > tree.length ? tree.length : 0;
    if (len && (!best || len > best.len)) best = { c, len };
  }
  return best?.c ?? null;
}

/** What the folder tab's Create Session does: a folder in a project starts that project's coding session there (on this
    host only: projects are this host's); any other folder, or another Host, a plain session. */
export type FolderStart = { kind: "project"; project: ProjectChoice; cwd: string } | { kind: "plain"; cwd: string };
export function folderStart(choices: readonly ProjectChoice[], cwd: string, host: string | null): FolderStart {
  const project = host === null ? folderProject(choices, cwd) : null;
  return project ? { kind: "project", project, cwd } : { kind: "plain", cwd };
}

/** The line under the Folder field while it holds a project's folder. */
export const folderProjectHint = (name: string): string => `This folder is in ${name}: the session starts as one of its coding sessions.`;

/** Where New Session starts pi: a project's root, a folder here, or a folder on a target. */
export type NewSessionWhere = "project" | "local" | "remote";
/** The tabs, in this order (the dialog still opens on This Computer, or Remote for a remote prefill). */
export const NEW_SESSION_TABS: readonly { id: NewSessionWhere; label: string; icon: "branch" | "folder" | "terminal" }[] = [
  { id: "project", label: "Project", icon: "branch" },
  { id: "local", label: "This Computer", icon: "folder" },
  { id: "remote", label: "Remote", icon: "terminal" },
];
/** The tabs offered for a Host (null: the one serving the page). Projects are this host's: another has no Project tab. */
export const tabsForHost = (host: string | null) => (host === null ? NEW_SESSION_TABS : NEW_SESSION_TABS.filter((t) => t.id !== "project"));
/** The tab shown after choosing a Host: Project moves to This Computer when it isn't offered there. */
export const whereForHost = (where: NewSessionWhere, host: string | null): NewSessionWhere =>
  tabsForHost(host).some((t) => t.id === where) ? where : "local";
/** What the Project tab posts: no title, model, thinking, mode or prompt; the conversation names its worktree later. */
export const PROJECT_TAB_START = { worktree: "later" } as const;

/** The Project tab's toast: its session starts in the project root. */
export const PROJECT_STARTED = "Coding session started in the project root.";
/** The folder tab's, for a folder in a project: the root says the Project tab's words. */
export const folderStartedToast = (name: string, at: string, root: boolean): string => (root ? PROJECT_STARTED : `Coding session of ${name} started in ${at}.`);

/**
 * The Project tab's Create Session. Only the start may fail (the caller shows it, and nothing was started). Once it has
 * answered the session exists, so nothing after it throws: a summary that can't be read opens the session by its path
 * instead, and a retry never starts a second one.
 */
export async function startInProject<S>(
  projectId: string,
  api: { start(projectId: string, input: typeof PROJECT_TAB_START & { cwd?: string }): Promise<Pick<CodingStartResult, "path" | "sessionId" | "modeNotSet">>; summary(id: string): Promise<S> },
  ui: { toast(text: string): void; created(s: S): void; open(href: string): void },
  /** The folder tab's start: the folder it starts in, and its toast. */
  at?: { cwd: string; started: string },
): Promise<void> {
  const r = await api.start(projectId, at ? { ...PROJECT_TAB_START, cwd: at.cwd } : { ...PROJECT_TAB_START });
  ui.toast(r.modeNotSet ?? at?.started ?? PROJECT_STARTED);
  const s = await api.summary(r.sessionId).catch(() => null);
  if (s) ui.created(s);
  else ui.open(`#/s/${encodeURIComponent(r.path)}`);
}
