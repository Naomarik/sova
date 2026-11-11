// Context files and skills approval, kept on this computer (the Sova state root): one list per computer,
// for every registered project and every other folder a chat runs in.
//
// Keys. A folder: `p:<project id>` (its root, its worktrees and the folders inside them share it) or
// `d:<real path>` for a folder that isn't a project. An item (a context file or a skill's SKILL.md): its path
// relative to the checkout it is in, POSIX (`AGENTS.md`, `sub/AGENTS.md`, `.agents/skills/x/SKILL.md`), so the
// main checkout and its worktrees share one decision; outside every checkout (the user's own files and skills,
// the Claude folder, instruction files above the project) its real absolute path. A skill is told by its
// place, never by its name alone: a skill that moves asks again.
//
// GET /api/projects/:pid/context-files -> ContextFilesView
// PUT /api/projects/:pid/context-files { files: Record<key, ApprovalState> } -> ContextFilesView
// GET /api/projects/:pid/skills -> ProjectSkillsView (shared/project-skills.ts)
// PUT /api/projects/:pid/skills { skills: Record<key | name, ApprovalState> } -> ProjectSkillsView
// GET /api/folder-approvals?cwd=<absolute folder> -> FolderApprovalsView (a project's folder, or one a recorded chat runs in; else 404)
// PUT /api/folder-approvals { cwd, files?: Record<key, ApprovalState>, skills?: Record<key, ApprovalState> } -> FolderApprovalsView
// GET /api/settings/context-approval -> ContextApprovalSetting
// PUT /api/settings/context-approval ContextApprovalSetting -> ContextApprovalSetting
//
// Anyone may disallow, and turn asking on. Approving, Re-approving, turning a disallowed item back on and
// turning asking off again take the operator's own page (this computer's or another of theirs): 403
// `{ error, yourClick: true }` otherwise. 400 a bad body, 404 an unknown project or an item not found.

/** Approved: on. Disallowed: off. Waiting: no decision yet (on without asking, off while asking). */
export type ApprovalState = "approved" | "disallowed" | "waiting";

/** Where an item comes from: the project (its root), a folder inside it, a folder above it, the user's own, the Claude folder. */
export type ApprovalSource = "project" | "subfolder" | "above" | "user" | "claude";
export type ApprovalGroup = ApprovalSource;

/** The folder a list belongs to: a registered project, or a folder that isn't one. */
export type ApprovalFolder = { kind: "project"; id: string; name: string } | { kind: "folder"; path: string; name: string };

export interface ApprovalRow {
  /** The item's key (what a PUT names). */
  key: string;
  /** Its file, absolute (this computer's copy that was found first). */
  path: string;
  /** Display name: a context file's file name, a skill's name. */
  name: string;
  /** `folder`: relative to the project's root (a subfolder's, or a worktree's own). */
  source: { kind: ApprovalSource; folder?: string };
  state: ApprovalState;
  /** Approved, but the file no longer matches what was approved: still on, marked "Changed since you approved". */
  changed?: true;
}

export type ContextFileRow = ApprovalRow;

export interface ApprovalCounts {
  approved: number;
  disallowed: number;
  waiting: number;
  /** Of the approved ones, how many changed since. */
  changed: number;
}

export interface ContextFilesView {
  files: ContextFileRow[];
  counts: ApprovalCounts;
  /** The Sova-wide setting asks first (allowWithoutAsking is off). */
  asking: boolean;
  /** False when the walk stopped at its cap or a checkout couldn't be read: the list may miss some. */
  complete: boolean;
}

export interface FolderApprovalsView {
  folder: { key: string; kind: "project" | "folder"; projectId?: string; name: string; root: string };
  asking: boolean;
  files: ContextFileRow[];
  skills: import("./project-skills").ProjectSkillRow[];
  /** Both lists together ("3 to approve for this project" is counts.waiting). */
  counts: ApprovalCounts;
  complete: boolean;
}

export interface ContextApprovalSetting {
  /** On (the default): everything not disallowed loads without asking. Off: undecided items wait for a decision. */
  allowWithoutAsking: boolean;
}

/** A new chat's setup card row's decision (GET /api/sessions/context): `key` is what the folder's PUT names. */
export interface SetupApproval {
  key: string;
  state: ApprovalState;
  group: ApprovalSource;
  /** Approved, but changed since: still on. */
  changed?: true;
}
