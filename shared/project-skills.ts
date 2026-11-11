// A project's skill decisions for new chats, kept on this computer (the Sova state root); keys and the
// rules: shared/approvals.ts.
//
// GET /api/projects/:pid/skills -> ProjectSkillsView
//   Every skill a chat in the project could be offered (the project folder, folders inside it, the
//   user's skills, the Claude folder), each with the project's state for it. A decision on an item
//   no longer found drops off the view and the store (only after a complete scan).
// PUT /api/projects/:pid/skills  { skills: Record<key | name, "approved" | "disallowed" | "waiting"> } -> ProjectSkillsView
//   Only the items given change; saved at once. A bare name means the first row of that name.

import type { ApprovalCounts, ApprovalRow, ApprovalState } from "./approvals";

export type ProjectSkillState = ApprovalState;

export interface ProjectSkillRow extends ApprovalRow {
  description?: string;
}

export interface ProjectSkillsView {
  skills: ProjectSkillRow[];
  counts: ApprovalCounts;
  asking: boolean;
  complete: boolean;
}
