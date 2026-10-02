// Registered projects as the pages read them (§app/projects). Pure: no Solid, no DOM.
//
// A project is the same whether an organization places it or not. Its `space` (a label the layer
// that holds it contributes) says which; the page composes an org's sections only for `org`.

import type { ProjectSummary } from "../../shared/projects";

export interface Placement {
  orgId: string;
  orgName: string;
}

/** The organization that places the project, or null: a standalone project. */
export const placementOf = (p: Pick<ProjectSummary, "space">): Placement | null => (p.space.kind === "org" ? { orgId: p.space.orgId, orgName: p.space.orgName } : null);

/** The Projects page's list: live projects by name, then the archived ones by name. */
export function sortProjects(list: readonly ProjectSummary[]): { live: ProjectSummary[]; archived: ProjectSummary[] } {
  const byName = (a: ProjectSummary, b: ProjectSummary) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  return { live: list.filter((p) => !p.archived).sort(byName), archived: list.filter((p) => !!p.archived).sort(byName) };
}

/** A GitHub address as typed: `owner/repo`, an https URL or an ssh address. The server clones by argv, never a shell. */
export function cloneUrl(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t)) return `https://github.com/${t.replace(/\.git$/, "")}.git`;
  if (/^(https:\/\/|git@|ssh:\/\/|file:\/\/)\S+$/.test(t)) return t;
  return null;
}

/** The folder a clone lands in when none is named: the repository's own name. */
export function cloneFolder(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

/** The registered project a folder is in (its root, or a folder inside it), the deepest root first; null when none. */
export function projectAt<P extends Pick<ProjectSummary, "root">>(cwd: string, projects: readonly P[]): P | null {
  const inside = projects.filter((p) => cwd === p.root || cwd.startsWith(p.root.endsWith("/") ? p.root : `${p.root}/`));
  return inside.sort((a, b) => b.root.length - a.root.length)[0] ?? null;
}
