import type { HEntry, HookCtx, StateView } from "../shared/harness";
import type { PiExtensionAPI } from "./harness/pi/extension-types";
import { parseParentScope } from "../pi-config/extensions/sandbox/policy.ts";
import { sharedFolderOf } from "../pi-config/extensions/sandbox/shared-folder.ts";
import { confinementOf } from "./background-jobs-request";
import { SANDBOX, WORKTREES } from "./harness/state-kinds";
import { registerNoteHooks } from "./project-services/note";

/**
 * The sandbox note: what a confined agent is told about where it may write, as one hidden message at a
 * turn's start (registerNoteHooks: again only when its text changes, and after a compaction), never in
 * the system prompt. Only an agent whose tools are confined gets one: a write-only worktree worker, or
 * a chat or worker whose sandbox is On. Off and Subagents only get nothing.
 */

export const SANDBOX_NOTE_MESSAGE = "sova-sandbox-note";

/** What the note is rendered from. `folders`: the writable roots, the shared folder not among them. */
export interface SandboxNoteFacts {
  folders: readonly string[];
  /** The chat's shared folder, or null where it has none. */
  shared: string | null;
  /** The chat is offered project_verbs. */
  verbs: boolean;
  platform: string;
}

/** The note's text. Linux gives a confined agent a private /tmp; macOS keeps it read-only. */
export function sandboxNote(f: SandboxNoteFacts): string {
  const where = f.folders.length ? `${f.folders.join(", ")} and $TMPDIR` : "$TMPDIR";
  const tmp = f.platform === "darwin" ? "/tmp is read-only and ~/.cache is private to you" : "/tmp and ~/.cache are private to you";
  const leave = f.shared ? `: leave files for other chats in ${f.shared}` : "";
  const parts = [`Sandbox: you can write only in ${where}.`, `${tmp}${leave}.`];
  if (f.verbs) parts.push("Set up, serve and test through project_verbs.");
  return parts.join(" ");
}

/** Who the agent is, for its note: a worker's launch flags and environment (its own), else nothing. */
export interface SandboxNoteOwner {
  workerFlags?: Record<string, string | true> | null;
  env?: Record<string, string | undefined> | null;
}

/**
 * The writable roots of a confined agent, or null when its tools aren't confined. A worker's come from
 * its parent scope (`--sandbox-parent`); a chat with the sandbox On writes in its folder and its tracked
 * worktrees, nowhere at the read-only level. `shared` is left out: the note names it on its own.
 */
export function confinedFolders(o: SandboxNoteOwner & { cwd: string; branch: readonly HEntry[]; state: StateView }, shared: string | null): string[] | null {
  const c = confinementOf({ workerFlags: o.workerFlags ?? null, branch: o.branch });
  if (c.kind === "none") return null;
  const bare = (p: string) => p.replace(/\/+$/, "");
  // The shared folder and anything in it (a member's own note folder) go by the shared folder's name alone.
  const inShared = (r: string) => shared !== null && (r === bare(shared) || r.startsWith(`${bare(shared)}/`));
  const drop = (roots: readonly string[]) => [...new Set(roots.map(bare))].filter((r) => !inShared(r));
  if (c.kind === "write-only") return drop(c.parent.writable);
  const flag = o.workerFlags?.["sandbox-parent"];
  if (flag !== undefined) {
    const p = parseParentScope(flag);
    return p.ok ? drop(p.value.level === "read-only" ? [] : p.value.writable) : [];
  }
  if (o.state.latest(SANDBOX)?.data?.level === "read-only") return [];
  return drop([o.cwd, ...(o.state.latest(WORKTREES)?.data.trees ?? []).filter((t) => t.status === "active").map((t) => t.path)]);
}

export interface SandboxNoteDeps {
  verbsOffered(ctx: HookCtx): Promise<boolean>;
  /** The chat's shared folder (default: sharedFolderOf, a worker's inherited one, else its own chat's). */
  shared?: (o: { sessionId: string; workerFlags?: Record<string, string | true> | null; env?: Record<string, string | undefined> }) => string | undefined;
  platform?: string;
}

/** The agent's note now, or null when its tools aren't confined (or it couldn't be read). */
export async function currentSandboxNote(owner: SandboxNoteOwner, ctx: HookCtx, deps: SandboxNoteDeps): Promise<string | null> {
  try {
    const shared = (deps.shared ?? sharedFolderOf)({ sessionId: ctx.sessionId, workerFlags: owner.workerFlags ?? null, ...(owner.env ? { env: owner.env } : {}) }) ?? null;
    const folders = confinedFolders({ ...owner, cwd: ctx.cwd, branch: ctx.branch(), state: ctx.state() }, shared);
    if (!folders) return null;
    return sandboxNote({ folders, shared, verbs: await deps.verbsOffered(ctx).catch(() => false), platform: deps.platform ?? process.platform });
  } catch {
    return null;
  }
}

/** The note's delivery in a chat or worker: the same hooks as the instance note, under its own type. */
export function registerSandboxNote(pi: PiExtensionAPI, owner: SandboxNoteOwner, deps: SandboxNoteDeps): void {
  registerNoteHooks(pi, (ctx) => currentSandboxNote(owner, ctx, deps), SANDBOX_NOTE_MESSAGE);
}

/** `ext` with the sandbox note's hooks registered beside its own. */
export function withSandboxNote<E extends { factory: (pi: PiExtensionAPI) => void }>(ext: E, owner: SandboxNoteOwner, deps: SandboxNoteDeps): E {
  return { ...ext, factory: (pi: PiExtensionAPI) => {
    ext.factory(pi);
    registerSandboxNote(pi, owner, deps);
  } };
}
