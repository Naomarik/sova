import type { ProjectSkillRow, ProjectSkillState } from "../../shared/project-skills";

/**
 * The words of a project's skill defaults: the project page's Skills card and the new chat's setup
 * card. Pure, so the card and its tests share them.
 */

export const SKILLS_CARD_HINT = "New chats start with these. Open chats keep their skills.";
export const SKILLS_CARD_NONE = "No skills found for this project. A chat here would be offered none.";

export const STATE_WORD: Record<ProjectSkillState, string> = { approved: "Approved", disallowed: "Disallowed", waiting: "Waiting" };
export const STATE_CHIP: Record<ProjectSkillState, string> = { approved: "chip-success", disallowed: "chip-error", waiting: "chip-warn" };

/** Where a skill comes from, in words. */
export function sourceLabel(s: ProjectSkillRow["source"]): string {
  switch (s.kind) {
    case "project":
      return s.folder ? `Project · ${s.folder}` : "Project";
    case "subfolder":
      return s.folder ? `Subfolder · ${s.folder}` : "Subfolder";
    case "user":
      return "Your skills";
    case "claude":
      return "Claude folder";
  }
}

/** A description cut to one short line. */
export function shortDescription(d: string | undefined, max = 140): string {
  const t = (d ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The new chat's notice: how many skills wait for a decision, or null when none. */
export function waitingNotice(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 skill to approve for this project." : `${n} skills to approve for this project.`;
}

/** The names of a setup's skills that wait for the project's decision, in the setup's order. */
export function waitingSkills(skills: readonly { name: string; project?: ProjectSkillState }[]): string[] {
  return skills.filter((k) => k.project === "waiting").map((k) => k.name);
}

/** Approve All's one change: every waiting name approved, nothing else. */
export function approveAllChange(names: readonly string[]): Record<string, "approved"> {
  return Object.fromEntries(names.map((n) => [n, "approved" as const]));
}

export const APPROVE_ALL = "Approve All";

/** The setup card's line under a waiting skill's name. */
export const WAITING_LINE = "Waiting for your decision · on until you disallow it";
/** The setup card's line under a skill the project keeps off. */
export const OFF_FOR_PROJECT = "Off for this project";
/** …and the same skill switched back on for this one chat. */
export const ON_FOR_THIS_CHAT = "Off for this project · on for this chat";

export const approveLabel = (name: string) => `Approve ${name}`;
export const disallowLabel = (name: string) => `Disallow ${name}`;
