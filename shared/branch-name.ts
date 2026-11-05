import type { CustomRule } from "./form-rules";

/**
 * A branch name git would take as a branch of the repository (a cheap `git check-ref-format
 * --branch`). Shared: the server refuses an Updates save naming anything else, and Settings →
 * Updates checks the same before Save. Pure, imports only types.
 */
export function validBranchName(name: string): boolean {
  if (!name || name.length > 200 || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("//") || name.includes("@{") || name === "@") return false;
  return name.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

/** Settings → Updates' Branch box: a name git takes. The server refuses in the same words. */
export const BRANCH_RULE: CustomRule = {
  kind: "custom",
  label: "Branch",
  issue: (name) => (!name ? "Name the branch." : validBranchName(name) ? null : `${name} isn't a branch name git takes.`),
};
