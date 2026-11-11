import { dirname, join, relative, resolve, sep } from "node:path";
import { OPEN_RULE, type FolderRule } from "../../shared/folder-rule";
import type { ApprovalLookup } from "../approvals-lookup";
import { checkoutOf } from "../approvals-lookup";
import { askingFirst } from "../context-approval-setting";
import { real } from "../mcp/folder";

/**
 * A folder's decisions as a chat in `cwd` reads them (shared/folder-rule.ts): every decided key as an
 * absolute path in the chat's own checkout, so its build matches pi's paths directly. A key relative to
 * a checkout names the same file in every checkout of the folder (main and worktrees share it); one
 * outside them is the path itself. Each path is listed as pi would write it from the chat's cwd as
 * typed, and by its real path, when the two differ (a cwd reached through a symbolic link).
 */
export function folderRuleOf(l: ApprovalLookup, cwd: string): FolderRule {
  const typed = resolve(cwd);
  const checkout = checkoutOf(l.checkouts, real(typed));
  // The typed cwd's folders by their real paths, deepest first: pi names files from the typed cwd.
  const pairs: [string, string][] = [];
  for (let dir = typed; ; dir = dirname(dir)) {
    const r = real(dir);
    if (r !== dir) pairs.push([r, dir]);
    if (dir === dirname(dir)) break;
  }
  const forms = (abs: string): string[] => {
    for (const [r, t] of pairs) {
      const rel = relative(r, abs);
      if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep))) return [abs, join(t, rel)];
    }
    return [abs];
  };
  const pathsOf = (keys: Record<string, { state: "approved" | "disallowed" }>, state: "approved" | "disallowed") =>
    [...new Set(Object.entries(keys).flatMap(([key, d]) => (d.state !== state ? [] : key.startsWith("/") ? forms(key) : checkout ? forms(join(checkout, key)) : [])))];
  return {
    asking: l.asking,
    context: { approved: pathsOf(l.context, "approved"), disallowed: pathsOf(l.context, "disallowed") },
    skills: { approved: pathsOf(l.skills, "approved"), disallowed: pathsOf(l.skills, "disallowed") },
  };
}

/** The rule when a folder's list can't be read: nothing decided, in the Sova-wide setting's mode (asking
    when even that can't be read). It fails closed: with asking on everything stays off, never on. */
export function fallbackRule(): FolderRule {
  let asking = true;
  try {
    asking = askingFirst();
  } catch {
    asking = true;
  }
  return { ...OPEN_RULE, asking };
}

/** The rule for a new chat in `cwd`, read now (fallbackRule when the list can't be read). */
export async function folderRuleForCwd(cwd: string): Promise<FolderRule> {
  try {
    const approvals = await import("../approvals");
    return folderRuleOf(await approvals.approvalLookupForCwd(cwd), cwd);
  } catch (err) {
    console.warn(`[approvals] the list for ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackRule();
  }
}

/** The rule for a new chat of session file `path` (its header's folder); fallbackRule when it can't be read. */
export async function folderRuleForSession(path: string): Promise<FolderRule> {
  try {
    const cwd = await (await import("../git-summary")).readStoredCwd(path);
    return cwd ? await folderRuleForCwd(cwd) : fallbackRule();
  } catch {
    return fallbackRule();
  }
}
