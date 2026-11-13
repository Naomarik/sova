import { createHash } from "node:crypto";
import { dirname, relative, sep } from "node:path";
import type { ApprovalSource, ApprovalState } from "../shared/approvals";
import type { Decision } from "./project-skills-store";

/**
 * What a chat's build needs of the approval list, as plain data (it travels in a chat process's open frame)
 * and pure reads over it: no file system, no pi. server/approvals.ts makes one for a folder.
 * Keys (shared/approvals.ts): a path relative to the deepest checkout that holds it, POSIX, else the path itself.
 */

export interface FolderRef {
  /** `p:<project id>` or `d:<real path>`. */
  key: string;
  kind: "project" | "folder";
  projectId?: string;
  name: string;
  /** The project's root (or the folder's), real. */
  root: string;
}

export interface ApprovalLookup {
  folder: FolderRef;
  /** The Sova-wide setting asks first, read when this was made. */
  asking: boolean;
  /** The folder's checkouts (its root and each worktree), real paths. */
  checkouts: string[];
  context: Record<string, Decision>;
  skills: Record<string, Decision>;
}

export type LookupKind = "context" | "skill";

const posix = (p: string) => p.split(sep).join("/");
const inside = (root: string, p: string) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith("/") && !r.startsWith(sep));
};

/** The checkout that holds `realPath` (the deepest), or null. */
export function checkoutOf(checkouts: readonly string[], realPath: string): string | null {
  let best: string | null = null;
  for (const c of checkouts) if (inside(c, realPath) && (!best || c.length > best.length)) best = c;
  return best;
}

/** An item's key from its real absolute path. */
export function itemKey(l: Pick<ApprovalLookup, "checkouts">, realPath: string): string {
  const c = checkoutOf(l.checkouts, realPath);
  if (c === null) return realPath;
  return posix(relative(c, realPath)) || realPath;
}

const decisionsOf = (l: ApprovalLookup, kind: LookupKind) => (kind === "context" ? l.context : l.skills);

/** The list's decision on an item: approved, disallowed, or waiting (none). */
export function itemState(l: ApprovalLookup, kind: LookupKind, realPath: string): ApprovalState {
  return decisionsOf(l, kind)[itemKey(l, realPath)]?.state ?? "waiting";
}

/** Approved, but its content no longer matches what was approved (still on: "Changed since you approved"). An
    approval with no fingerprint matches nothing. */
export function itemChanged(l: ApprovalLookup, kind: LookupKind, realPath: string, sha256: string): boolean {
  const d = decisionsOf(l, kind)[itemKey(l, realPath)];
  return d?.state === "approved" && d.sha256 !== sha256;
}

/** Whether an item is on in a new chat by the list alone (the chat's own switches aside): never when
    disallowed; when waiting, only without asking. */
export function onByList(l: ApprovalLookup, kind: LookupKind, realPath: string): boolean {
  const s = itemState(l, kind, realPath);
  return s === "approved" || (s === "waiting" && !l.asking);
}

/** sha256 hex of a file's content. */
export function fileSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface GroupPlaces {
  /** The checkout the chat's folder is in (real). */
  checkout: string | null;
  /** pi's settings folder (real), the home folder, the Claude folders. */
  agentDir: string;
  home: string;
  claudeDirs: readonly string[];
}

/** Where an item comes from, by its real path. */
export function groupOf(kind: LookupKind, realPath: string, p: GroupPlaces): ApprovalSource {
  if (p.claudeDirs.some((d) => inside(d, realPath))) return "claude";
  if (p.checkout && inside(p.checkout, realPath)) {
    const rel = posix(relative(p.checkout, realPath));
    if (kind === "skill" && rel.startsWith(".claude/")) return "claude";
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (kind === "context") return dir === "" ? "project" : "subfolder";
    // A skill of the root's own skill folders (`.agents/skills/x/SKILL.md`, `.pi/skills/...`) is the project's.
    return /^(?:\.agents|\.pi|\.claude)\/skills\//.test(rel) || !rel.includes("/") ? "project" : "subfolder";
  }
  if (inside(p.agentDir, realPath)) return "user";
  if (kind === "context" && dirname(realPath) === p.home) return "user";
  if (kind === "skill" && inside(p.home, realPath) && /^\.(?:agents|pi)\//.test(posix(relative(p.home, realPath)))) return "user";
  return kind === "context" ? "above" : "user";
}
