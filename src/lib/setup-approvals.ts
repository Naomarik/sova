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

/** A disallowed row's line: off for the folder, or switched back on for this one chat. */
export function offWords(folder: ApprovalFolder, off: boolean): string {
  const where = folder.kind === "project" ? "this project" : "this folder";
  return off ? `Off for ${where}` : `Off for ${where} · on for this chat`;
}
