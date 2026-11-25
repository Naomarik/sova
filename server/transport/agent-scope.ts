// Where the Transport agent's tools may reach (§app.transport/agent "Confined"): Sova's own sandbox, given a scope
// the way a sandboxed parent hands one to its workers (the sandbox extension's `--sandbox-parent`). It writes only
// in the project's folder, the chat's worktrees and the tool folders installs fill in the user's home; the caches
// installs use (~/.cache, ~/.npm, ~/.m2) and mise's and pnpm's state stay the sandbox's own private copies, as for
// every confined chat. Hidden from it besides the policy's own list: this device's host values (host.json), the
// transport records that carry the source's, the chat homes and the other projects registered here.
// Node builtins only: server/chat-manager.ts reads the launch flags from here.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The scope, in the sandbox extension's ParentScope shape (pi-config/extensions/sandbox/policy.ts). */
export interface AgentScope {
  version: 1;
  level: "workspace-write";
  workspaceRoot: string;
  writable: string[];
  hidden?: string[];
  /** The sites its network reaches, once you allowed a download list (§app.transport/agent "Downloads, on your click"):
      what it reached before plus exactly the hosts allowed. Absent: the policy's own allowlist. */
  proxyAllow?: string[];
}

/** The tool folders under the user's home an install fills (version managers, toolchains, user programs, git deps),
    writable when they exist. The caches and mise's and pnpm's state are the sandbox's private copies already. */
export const TOOL_DIRS = [".local/share/mise", ".local/bin", ".gitlibs", ".cargo", ".rustup", "go", ".bun", ".deno", ".volta", ".asdf"] as const;
/** Made when missing, so a first install has somewhere to go: mise's installs and the user's own bin folder. */
export const MADE_TOOL_DIRS = [".local/share/mise", ".local/bin"] as const;

const within = (child: string, parent: string): boolean => {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
};

/**
 * The agent's scope. Writable: `folder` (the project's), each of `trees` (the chat's worktrees here) that exists,
 * and each tool folder of TOOL_DIRS under `home` that exists. Hidden: each of `hidden` that exists and neither holds
 * nor lies inside a writable root (a project registered at a folder above this one stays readable). Pure but for
 * `exists`.
 */
export function agentScope(input: { folder: string; trees?: readonly string[]; home: string; hidden?: readonly string[]; exists?: (p: string) => boolean }): AgentScope {
  const exists = input.exists ?? existsSync;
  const folder = resolve(input.folder);
  const writable = [...new Set([folder, ...(input.trees ?? []).map((t) => resolve(t)).filter(exists), ...TOOL_DIRS.map((d) => join(input.home, d)).filter(exists)])];
  const hidden = [...new Set((input.hidden ?? []).filter(Boolean).map((h) => resolve(h)))].filter((h) => exists(h) && !writable.some((w) => within(w, h) || within(h, w)));
  return { version: 1, level: "workspace-write", workspaceRoot: folder, writable, ...(hidden.length ? { hidden } : {}) };
}

/** `<stateRoot>/transport-agent.json`: the agents' records (server/transport/agent.ts keeps them). */
export const preparedFile = (root: string) => join(root, "transport-agent.json");

/** The transport whose agent chat `sessionId` is, or null: not a Transport agent's chat here. */
export function agentTidOf(root: string, sessionId: string): string | null {
  try {
    const tid = (JSON.parse(readFileSync(preparedFile(root), "utf8")) as { agents?: Record<string, { tid?: unknown }> }).agents?.[sessionId]?.tid;
    return typeof tid === "string" ? tid : null;
  } catch {
    return null;
  }
}

/** The open flags of a Transport agent's chat (server/chat-manager.ts): its sandbox On with its scope, which the
    chat can't lower. A chat recorded as an agent whose scope can't be read is held at the read-only level with its
    folder never writable: it never runs unconfined. Null: not a Transport agent's chat. */
export function agentLaunchFlags(root: string, sessionId: string): { sandboxOn: true; extra: Record<string, string> } | { sandboxOn: true; sandboxReadOnly: true; cwdNotWritable: true } | null {
  let rec: { scope?: AgentScope } | undefined;
  try {
    rec = (JSON.parse(readFileSync(preparedFile(root), "utf8")) as { agents?: Record<string, { scope?: AgentScope }> }).agents?.[sessionId];
  } catch {
    return null;
  }
  if (!rec) return null;
  const s = rec.scope;
  if (!s || s.version !== 1 || !Array.isArray(s.writable) || typeof s.workspaceRoot !== "string") return { sandboxOn: true, sandboxReadOnly: true, cwdNotWritable: true };
  return { sandboxOn: true, extra: { "sandbox-parent": JSON.stringify(s) } };
}
