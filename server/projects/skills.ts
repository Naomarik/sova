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

/** The All settings row's words for a list, as its switches read: "4 of 6 on · 2 new". On is what new chats load:
    while new items start off (`asking`) only what was turned on (a changed item stays on), else everything but
    what was turned off. While new items start off, "· N new" counts items nobody has set and "· N changed" the
    ones changed since they were turned on, each only when there are some: "4 of 6 on · 2 new · 1 changed". */
export function skillsRowState(counts: ApprovalCounts, asking = false): string {
  const total = counts.approved + counts.disallowed + counts.waiting;
  const on = asking ? counts.approved : counts.approved + counts.waiting;
  const fresh = asking ? counts.waiting : 0;
  const changed = asking ? counts.changed : 0;
  return `${on} of ${total} on${fresh ? ` · ${fresh} new` : ""}${changed ? ` · ${changed} changed` : ""}`;
}
