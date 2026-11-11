// A project's skill defaults for new chats, kept on this computer (the Sova state root).
//
// GET /api/projects/:pid/skills -> ProjectSkillsView
//   Every skill a chat in the project could be offered (the project folder, folders inside it, the
//   user's skills, the Claude folder), each with the project's state for it. A name decided on that
//   is no longer found drops off the view and the store.
// PUT /api/projects/:pid/skills  { skills: Record<name, "approved" | "disallowed"> } -> ProjectSkillsView
//   Only the names given change; saved at once. 400 a bad body, 404 an unknown project.

/** Approved: on. Disallowed: off. Waiting: no decision yet, and on until disallowed. */
export type ProjectSkillState = "approved" | "disallowed" | "waiting";

export interface ProjectSkillRow {
  name: string;
  description?: string;
  /** Its SKILL.md. */
  path: string;
  /** Where it comes from. `folder`: relative to the project root (a subfolder's, or the project's own when not the root). */
  source: { kind: "project" | "subfolder" | "user" | "claude"; folder?: string };
  state: ProjectSkillState;
}

export interface ProjectSkillsView {
  skills: ProjectSkillRow[];
  counts: { approved: number; disallowed: number; waiting: number };
}
