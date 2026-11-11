import type { ApprovalCounts, ApprovalState, ContextFilesView } from "../../shared/approvals";
import type { ProjectSkillsView } from "../../shared/project-skills";
import { checkoutsOf, folderQuickScan, parseItemChanges, projectFolder, projectForCwd, viewOfScan, type FolderScan, type ScanDeps } from "../approvals";
import { OrgError } from "../org-error";

export { checkoutsOf, projectForCwd };

/**
 * A project's Context Files and Skills cards, the project layer over the approval list (server/approvals.ts):
 * every context file and skill a chat in the project could load (pi's own places for each checkout, with the
 * Claude folders, the user's own and those above the project, and the folders inside it), each with the
 * decision kept on this computer. A chat's list is fixed at its first message; these only reach chats not yet
 * started.
 */

/** A project's scan (both lists). */
export function projectScan(pid: string, deps: ScanDeps = {}): Promise<FolderScan> {
  return folderQuickScan(projectFolder(pid), deps);
}

export function skillsViewOfScan(scan: FolderScan): ProjectSkillsView {
  const v = viewOfScan(scan);
  return { skills: v.skills, counts: v.skillCounts, asking: v.asking, complete: v.complete };
}

export function contextViewOfScan(scan: FolderScan): ContextFilesView {
  const v = viewOfScan(scan);
  return { files: v.files, counts: v.fileCounts, asking: v.asking, complete: v.complete };
}

/** GET /api/projects/:pid/skills: the card's rows. A decision on an item no longer found drops off (complete scans only). */
export async function projectSkillsView(pid: string, deps: ScanDeps = {}): Promise<ProjectSkillsView> {
  return skillsViewOfScan(await projectScan(pid, deps));
}

/** GET /api/projects/:pid/context-files. */
export async function projectContextView(pid: string, deps: ScanDeps = {}): Promise<ContextFilesView> {
  return contextViewOfScan(await projectScan(pid, deps));
}

/** A Skills PUT body: `{skills: {<key or name>: state}}`, at least one. */
export function parseSkillChanges(body: unknown): Record<string, ApprovalState> {
  const out = parseItemChanges((body as { skills?: unknown } | null)?.skills, "skills", "skills");
  if (!Object.keys(out).length) throw parseErr("skills");
  return out;
}

/** A Context Files PUT body: `{files: {<key>: state}}`, at least one. */
export function parseContextChanges(body: unknown): Record<string, ApprovalState> {
  const out = parseItemChanges((body as { files?: unknown } | null)?.files, "context", "files");
  if (!Object.keys(out).length) throw parseErr("files");
  return out;
}

const parseErr = (what: string) => new OrgError(`Expected { ${what}: { <key>: "approved" | "disallowed" | "waiting" } }`);

/** The All settings row's words for a list: "2 disallowed · 1 waiting" (asking), "2 disallowed" (not asking),
    "1 changed" when one changed since approved, or "No preference" with no decision at all. */
export function skillsRowState(counts: ApprovalCounts, asking = false): string {
  if (!counts.approved && !counts.disallowed) return asking && counts.waiting ? `${counts.waiting} waiting` : "No preference";
  const parts = [counts.disallowed ? `${counts.disallowed} disallowed` : "", asking && counts.waiting ? `${counts.waiting} waiting` : "", counts.changed ? `${counts.changed} changed` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${counts.approved} approved`;
}
