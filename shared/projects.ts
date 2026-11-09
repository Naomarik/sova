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
 * GET   /api/projects/glance             -> ProjectGlanceList (the overview cards' runtime figures, §app.projects/home-glance)
 *
 * A project's icon (§app.projects/icon), kept on this host only:
 * GET    /api/projects/:pid/icon?v=<v>    -> image/png | 404 (letters in use)
 * GET    /api/projects/:pid/icon/info     -> ProjectIconInfo (rescans the folder)
 * PUT    /api/projects/:pid/icon {png: base64 square PNG} -> ProjectIconInfo
 * PATCH  /api/projects/:pid/icon {letters: boolean} -> ProjectIconInfo
 * DELETE /api/projects/:pid/icon          -> ProjectIconInfo (removes the upload)
 */

/** The picture a project shows instead of its letters: fetched as `GET /api/projects/:pid/icon?v=<v>`. */
export interface ProjectIconRef {
  kind: "image";
  /** Uploaded by the operator, or found in the project's folder. */
  source: "upload" | "found";
  /** Changes whenever the picture does (the URL's cache key). */
  v: string;
}

/** What the Settings tab's Icon card shows. */
export interface ProjectIconInfo {
  /** What is drawn now. */
  use: "upload" | "found" | "letters";
  /** Letters chosen over a picture. */
  letters: boolean;
  uploaded?: { v: string; at: string };
  /** The first square PNG app icon in the folder, relative to its root. */
  found?: { path: string; v: string; w: number; h: number };
}

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
  /** A picture in use (absent: letters). Only on this host's own summaries; a peer's project is drawn as letters. */
  icon?: ProjectIconRef;
}

export interface ProjectList {
  projects: ProjectSummary[];
}

/** A merge run's step as a project card's Landing row reads it (MergeRun's RunStep, cut to what the meter needs). */
export interface GlanceRunStep {
  id: string;
  kind: string;
  label: string;
  result: "passed" | "running" | "failed" | "pending" | "skipped";
  startedAt?: string;
}

/** What the merge queue's newest kept view of a project says (never a fresh read). */
export interface ProjectGlanceQueue {
  /** The branches its `Ready to land, not approved` list holds. */
  ready: number;
  /** Approved entries waiting or being checked. */
  inLine: number;
  /** Approved entries waiting, not checked yet. */
  waiting: number;
  /** The queue's target branch ("master", "main"). */
  target: string;
  /** The branch being checked now, with its run's steps and the estimate. */
  landing?: {
    branch: string;
    startedAt: string;
    /** How long its run takes, estimated (ms), or null. */
    takesMs: number | null;
    steps: GlanceRunStep[];
    checks: { id: string; label: string   /** Worktrees retirement took and holds here (§chat.worktrees/retirement). Absent at 0. */
  retired?: number;
  held?: number;
}[];
    /** It is the release's own entry. */
    release?: true;
  };
  /** A release holds the queue: its name, and how many landings wait on it. */
  frozen?: { tag: string | null; version: string | null; waiting: number };
  /** When the queue built that view. */
  at: string;
}

/** A project's release still moving: the open record, or a published or withdrawn one with steps to finish. */
export interface ProjectGlanceRelease {
  id: string;
  state: "preparing" | "checking" | "ready" | "publishing" | "published" | "abandoned" | "withdrawn";
  version: string | null;
  tag: string | null;
  steps: { id: string; label: string; phase: "prepare" | "sova" | "check" | "after" | "withdraw"; state: "waiting" | "running" | "done" | "failed" | "skipped" | "held" }[];
}

/** One project card's runtime figures (§app.projects/home-glance). */
export interface ProjectGlance {
  projectId: string;
  /** Whether the merge queue serves the project: `served` (its kept view is `queue`), `reading` (it serves it, its
   *  first view is being read: the card reads "…"), `unserved` (the card reads "—"). */
  merge: "served" | "reading" | "unserved";
  /** The kept view's cut while `merge` is `served`; null otherwise. */
  queue: ProjectGlanceQueue | null;
  /** null: the project has no project file (no copies). `running` excludes the main checkout's and conformance's. */
  slots: { running: number; cap: number } | null;
  /** Own memory now (bytes): its chats' (with their workers and tools) and its running copies' (the main checkout's included). */
  memory: { chatsBytes: number; copiesBytes: number };
  release: ProjectGlanceRelease | null;
}

export interface ProjectGlanceList {
  glances: ProjectGlance[];
  /** This machine's total memory (bytes): the Memory in use bar's scale; null when unknown. */
  hostTotalBytes: number | null;
  at: string;
}

export interface ProjectRegistered {
  project: ProjectSummary;
  /** The folder asked for, when the project's root is its checkout root instead. */
  normalizedFrom?: string;
}

/** What a project's or org's Claude login resolves to (§app.claude-logins/project-login). */
export interface ClaudeLoginResolved {
  /** A login id of the host that runs the project ("default": its own login). */
  login: string;
  /** Whose setting it is: the project's own, or its organization's for its projects. */
  source: "project" | "org";
  /** The project's or the organization's name. */
  name: string;
}

/** A login the card offers (on the host that holds the project or organization). */
export interface ClaudeLoginOption {
  id: string;
  /** Its email, else its label, else its id; "This computer's own login" for `default`. */
  name: string;
}

/** `GET`/`PUT /api/projects/:pid/claude-login`. */
export interface ProjectClaudeLogin {
  /** A login id, "none" (this computer's order) or "org" (same as its organization; only while placed). */
  setting: string;
  /** Placed in an organization: "Same as organization" is offered. */
  placed: boolean;
  /** While placed: the organization's login for its projects (null: none). */
  orgLogin?: string | null;
  resolved: ClaudeLoginResolved | null;
  /** The logins it may be given (the routes add them). */
  options?: ClaudeLoginOption[];
}

/** `GET`/`PUT /api/orgs/:id/claude-login`. */
export interface OrgClaudeLogin {
  /** A login id, or "none". */
  setting: string;
  options?: ClaudeLoginOption[];
}
