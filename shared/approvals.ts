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
// PUT /api/projects/:pid/context-files { files: Record<key, ApprovalState>, group?: string | true } | { undo } -> ContextFilesView
// GET /api/projects/:pid/skills -> ProjectSkillsView (shared/project-skills.ts)
// PUT /api/projects/:pid/skills { skills: Record<key | name, ApprovalState>, group?: string | true } | { undo } -> ProjectSkillsView
// GET /api/folder-approvals?cwd=<absolute folder> -> FolderApprovalsView (a project's folder, or one a recorded chat runs in; else 404)
// PUT /api/folder-approvals { cwd, files?: Record<key, ApprovalState>, skills?: Record<key, ApprovalState>, group?: string | true } | { cwd, undo } -> FolderApprovalsView
//
// A group switch's save says so with `group: "<group id>"` (the switch's own id, 1-100 of A-Za-z0-9:_./-; `true`
// names the group by what it saves: "context", "skills" or "both") beside its changes: an item already approved is left
// as it is (a Changed one is never approved unseen, even when it is the only key named), and when it changed anything
// its answer carries `undo`, a token for that group's latest save in the folder. Any other save (a row's switch, Accept
// Change, New items left off after a first message) never takes or drops a token. The same PUT with `{ undo: <token> }`
// (and `cwd` on the folder route) in place of the changes puts back each record that save wrote, exactly as it was
// before (an approval with its old fingerprint), where the record is still what the save wrote: `undone` restored,
// `kept` left as they were. A token that isn't its group's latest save in the folder (a newer save of that group, a
// restart, used already): 409 `{ error, code: "undo-gone" }`; another group's save never retires it.
// Every save and Undo answers once the folder's chats not yet started have been rebuilt with it.
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
  /** Approved, but the file no longer matches what was approved: still on, marked "Changed since you approved".
      A skill's fingerprint covers its whole folder, so an edited or added file beside its SKILL.md counts. */
  changed?: true;
  /** A skill folder not fully fingerprinted: too large (past about 2000 files or 20 MB: its fingerprint is of the
      listing, paths, sizes and times), or a part of it can't be covered (a link to a folder, a dangling link, an
      unreadable folder or file). */
  fingerprintPartial?: true;
  /** ≈ tokens a new chat carries for it: a context file's whole text; a skill's listing, its name and description
      as pi offers it (the skill's file loads only when it is used). Absent when the file can't be read, or from an
      older server. */
  tokens?: number;
  /** Skills only: ≈ tokens of the whole SKILL.md, what using it loads. */
  fileTokens?: number;
  /** Skills only: only `/skill:name` runs it (disable-model-invocation), so it is never listed to the model and
      `tokens` is its whole file. Listed apart ("Slash commands"); absent from an older server. */
  manualOnly?: true;
}

export type ContextFileRow = ApprovalRow;

export interface ApprovalCounts {
  approved: number;
  disallowed: number;
  waiting: number;
  /** Of the approved ones, how many changed since. */
  changed: number;
}

/** What a save's or an Undo's answer adds to its view (PUT only; a GET never carries them). */
export interface ApprovalSaveAnswer {
  /** A group save that changed something: the token its Undo names. */
  undo?: string;
  /** An Undo: how many keys were put back, and how many were left because they changed since. */
  undone?: number;
  kept?: number;
}

/** The refusal code of an Undo whose token is no longer the folder's latest group save. */
export const UNDO_GONE_CODE = "undo-gone";

export interface ContextFilesView extends ApprovalSaveAnswer {
  files: ContextFileRow[];
  counts: ApprovalCounts;
  /** The Sova-wide setting asks first (allowWithoutAsking is off). */
  asking: boolean;
  /** False when the walk stopped at its cap or a checkout couldn't be read: the list may miss some. */
  complete: boolean;
}

export interface FolderApprovalsView extends ApprovalSaveAnswer {
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
  /** A skill folder not fully fingerprinted (ApprovalRow.fingerprintPartial). */
  fingerprintPartial?: true;
}
