import type { ApprovalFolder } from "../../shared/approvals";
import type { SessionSetupFile } from "../../shared/protocol";
import type { Approval } from "./approvals";

/** A new chat's setup row that can be decided: a context file or a skill. */
export interface Row {
  kind: "context" | "skill";
  f: SessionSetupFile;
}

/** Its decision; "changed" when approved and changed since. A row with no decision data reads as allowed. */
export const rowApproval = (f: SessionSetupFile): Approval => (f.approval?.changed ? "changed" : (f.approval?.state ?? "approved"));

/** The line under the list: where the switches are kept, and what a new item starts as. */
export function keptLine(folder: ApprovalFolder["kind"], asking: boolean | undefined): string {
  const where = folder === "project" ? "Kept for this project on this computer." : "Kept for this folder on this computer.";
  return asking === undefined ? where : `${where} New items start ${asking ? "off" : "on"}.`;
}

/** Manual-only skills, listed apart: never in the prompt, they load only when typed. */
export const slashHeading = (n: number): string => `Slash commands · ${n}`;
export const SLASH_NOTE = "Not in the prompt. They load only when you type the command.";

/** The MCP Servers switches stay this chat's own: the one line that says so. */
export const MCP_THIS_CHAT = "This chat only.";
