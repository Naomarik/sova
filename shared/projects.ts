/**
 * Registered projects (§app/projects), the project layer's wire shapes. A project is a folder or a
 * repository the operator added; it is the same whether an organization places it or not. Where it
 * lives (`space`) is a label the layer that holds it contributes; the project layer never derives it.
 *
 * GET   /api/projects                    -> ProjectList
 * POST  /api/projects {root} | {clone: {repo, parent, folder?}} -> ProjectRegistered (201)
 * GET   /api/projects/:pid               -> ProjectSummary
 * PATCH /api/projects/:pid {name?, root?} -> ProjectSummary
 * POST  /api/projects/:pid/archive | /unarchive -> ProjectSummary
 */

/** Where a project lives: its own engine, or an organization that placed it. */
export type ProjectSpace = { kind: "standalone" } | { kind: "org"; orgId: string; orgName: string };

export interface ProjectSummary {
  /** `prj_` + 8 characters. */
  id: string;
  name: string;
  /** The checkout root (absolute, on this host). */
  root: string;
  /** How it was added: "folder", "session", "clone" (older projects: "manual"). */
  origin: string;
  /** The repository it was cloned from, when it was. */
  remote?: string;
  createdAt: string;
  /** Archived: put away, nothing deleted. `via`: the global Overseer did it for the operator. */
  archived?: { at: string; via?: "overseer" };
  space: ProjectSpace;
}

export interface ProjectList {
  projects: ProjectSummary[];
}

export interface ProjectRegistered {
  project: ProjectSummary;
  /** The folder asked for, when the project's root is its checkout root instead. */
  normalizedFrom?: string;
}
