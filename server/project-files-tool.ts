import { execFile } from "node:child_process";
import { appendFileSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ProjectFileRow } from "../shared/project-files";
import { bytesHere, bytesPath, dedupeName, deleteFile, FileRefusal, fileOf, fileRows, sizeWords } from "./project-files";
import { stateRoot } from "./state-root";

/**
 * The project overseer's `sova_files` (§app.project-overseer/files): list the files people sent
 * the project, copy one into a coding session's worktree (`incoming/<name>`), delete one. And the
 * rows the project page's Files card shows (§app.organizations/files-card).
 */

const execFileP = promisify(execFile);

/** Who sent a file and in which gathering: the organization's layer answers (server/baton-files.ts
    registers it); the project layer never reads an org itself. Unregistered: nobody is named. */
export interface FileGatherings {
  sender(sessionId: string, personId: string): string;
  gathering(sessionId: string): { title: string; path?: string } | null;
}
let gatherings: FileGatherings = { sender: () => "Someone", gathering: () => null };
export function setFileGatherings(g: FileGatherings): void {
  gatherings = g;
}

/** The rows of a project's files, named: the sender's roster name, the gathering's title and session file. */
export function namedFileRows(projectId: string): ProjectFileRow[] {
  const rows = fileRows(projectId, (r) => gatherings.sender(r.sessionId, r.personId), (sessionId) => gatherings.gathering(sessionId)?.title ?? null);
  return rows.map((r) => {
    const path = r.gathering ? gatherings.gathering(r.gathering.sessionId)?.path : undefined;
    return path && r.gathering ? { ...r, gathering: { ...r.gathering, path } } : r;
  });
}

/** One row as sova_files lists it. Pure. */
export function fileListLine(r: ProjectFileRow): string {
  const status = r.status === "confirmed" ? "Confirmed" : "Received";
  return `- ${r.id} · ${r.name} · from ${r.sender} · in "${r.gathering?.title ?? "a gathering no longer listed"}" · ${r.at.slice(0, 16).replace("T", " ")} UTC · ${sizeWords(r.size)} · ${r.kind} · ${status}${r.here ? "" : " · not on this host"}`;
}

/** Where a copy may not go, and the sandbox of the session it goes to (index.ts wires it). */
export type CopySandbox = (sessionId: string, canonical: string) => Promise<string | undefined>;
let copySandbox: CopySandbox | null = null;
let protectedRoots: () => string[] = () => [stateRoot()];
/** The server's session sandbox check and its protected roots (Sova's own state, the sessions folder). */
export function setFileCopyGuards(sandbox: CopySandbox, roots: () => string[]): void {
  copySandbox = sandbox;
  protectedRoots = roots;
}

const within = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Add `/incoming/` to the repository's info/exclude once: the copy never counts as uncommitted. */
async function excludeIncoming(worktree: string): Promise<void> {
  const r = await execFileP("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktree });
  const path = resolve(worktree, r.stdout.trim());
  let have = "";
  try {
    have = readFileSync(path, "utf8");
  } catch {
    mkdirSync(join(path, ".."), { recursive: true });
  }
  if (have.split("\n").some((l) => l.trim() === "/incoming/")) return;
  appendFileSync(path, `${have && !have.endsWith("\n") ? "\n" : ""}/incoming/\n`);
}

/**
 * Copy a received file into `worktree/incoming/<name>` (a name taken there becomes `name (2).ext`).
 * Refused when `incoming` is a link or resolves outside the worktree, under a protected root, or
 * where the session's sandbox would refuse the write. Returns the path written, relative to the worktree.
 */
export async function copyIntoWorktree(projectId: string, id: string, sessionId: string, worktree: string): Promise<string> {
  const rec = fileOf(projectId, id);
  if (!rec) throw new FileRefusal(404, "not-found", `No file ${id} in this project: sova_files list shows them.`);
  if (!bytesHere(projectId, rec)) throw new FileRefusal(409, "not-here", `${rec.name} is not on this host: its bytes stayed on the host that took it.`);
  const top = realpathSync(worktree);
  const dir = join(top, "incoming");
  if (existsSync(dir) || lstatExists(dir)) {
    if (lstatSync(dir).isSymbolicLink()) throw new FileRefusal(409, "refused", "incoming in that worktree is a link: nothing was copied.");
    if (!lstatSync(dir).isDirectory()) throw new FileRefusal(409, "refused", "incoming in that worktree is not a folder: nothing was copied.");
  }
  const realDir = existsSync(dir) ? realpathSync(dir) : dir;
  if (!within(top, realDir)) throw new FileRefusal(409, "refused", "incoming resolves outside that worktree: nothing was copied.");
  const target = join(realDir, dedupeName(rec.name, new Set(existsSync(realDir) ? readdirSync(realDir) : [])));
  for (const root of protectedRoots()) {
    let r = root;
    try {
      r = realpathSync(root);
    } catch {
      // absent: its path as given
    }
    if (within(r, target)) throw new FileRefusal(409, "refused", "That place is Sova's own: nothing was copied.");
  }
  if (copySandbox) {
    const why = await copySandbox(sessionId, target);
    if (why) throw new FileRefusal(409, "refused", `That session's sandbox would refuse the write (${why}): nothing was copied.`);
  }
  await excludeIncoming(top);
  mkdirSync(realDir, { recursive: true });
  copyFileSync(bytesPath(projectId, rec), target, constants.COPYFILE_EXCL);
  return relative(top, target);
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export { deleteFile };
