// Which Sova this is (§chat.worktrees/retirement): whether it may retire anything, and what a test copy may remove.
// A leaf: the screens read it through the retirement view with no git, and no setting turns anything on.
import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { agentRoot } from "./state-root";

/**
 * - `real`: on the user's own agent dir, from a checkout of its own or an installed copy.
 * - `install`: an install on a `PI_CODING_AGENT_DIR` of its own, with nothing that says it's a test. It sees all of its
 *   own chats, but which repositories others use it can't say, so it retires nothing, and it says so.
 * - `test`: a hermetic or other test copy. It sees only its own chats and shares git's list with the real repository.
 * - `unknown`: couldn't tell. Treated as a test copy everywhere.
 */
export type ServerKind = "real" | "install" | "test" | "unknown";

export interface WhichFacts {
  agentDir?: string;
  home?: string;
  tmp?: string;
  /** The folder this code runs from. Absent with explicit facts: none. */
  codeRoot?: string;
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

const CODE_ROOT = resolve(import.meta.dirname, "..");

/** A linked worktree's `.git` is a file: code running from one is someone's work in progress, never the real server. */
function runsFromLinkedWorktree(codeRoot: string | undefined): boolean {
  if (!codeRoot) return false;
  try {
    return lstatSync(join(codeRoot, ".git")).isFile();
  } catch {
    return false;
  }
}

export function serverKind(env: NodeJS.ProcessEnv = process.env, o: WhichFacts = {}): ServerKind {
  let agentDir: string;
  let home: string;
  let tmp: string;
  try {
    agentDir = o.agentDir ?? agentRoot();
    home = o.home ?? homedir();
    tmp = o.tmp ?? tmpdir();
  } catch {
    return "unknown";
  }
  if (!agentDir || !home) return "unknown";
  const dir = realOr(agentDir);
  const flagged =
    env.SOVA_GIT_MAINTENANCE?.trim().toLowerCase() === "off" ||
    !!env.SOVA_TEST_HOME ||
    !!env.SOVA_TEST_DATA ||
    !!env.HERMETIC_AGENT_DIR ||
    runsFromLinkedWorktree(o.codeRoot ?? (o.agentDir ? undefined : CODE_ROOT));
  if (flagged) return "test";
  if (dir === realOr(join(home, ".pi", "agent"))) return "real";
  if (basename(dir) === ".agent" || (tmp && inside(dir, realOr(tmp)))) return "test";
  return "install";
}

type WakeListener = (reason: string) => void;
const wakeListeners = new Set<WakeListener>();
/** A process Sova started ended, a chat's or a test copy's: what may have held a folder is gone (§chat.worktrees/retirement). → unsubscribe. */
export function onProcessEnded(fn: WakeListener): () => void {
  wakeListeners.add(fn);
  return () => wakeListeners.delete(fn);
}
export function processEnded(reason: string): void {
  for (const fn of wakeListeners) fn(reason);
}

export type Gate = { on: true } | { on: false; why: string; offFor: "install" | "test" | "setting" | "unknown" };

/**
 * Whether this process may retire anything. Fails closed: only the real server may. `SOVA_RETIRE=off` turns it off
 * there too; nothing turns it on anywhere else.
 */
export function retirementAllowed(env: NodeJS.ProcessEnv = process.env, o: WhichFacts = {}): Gate {
  if (env.SOVA_RETIRE?.trim().toLowerCase() === "off") return { on: false, offFor: "setting", why: "Automatic cleanup is turned off here (SOVA_RETIRE=off)." };
  switch (serverKind(env, o)) {
    case "real":
      return { on: true };
    case "install":
      return { on: false, offFor: "install", why: "Automatic cleanup is off for this install, because it runs on an agent directory of its own." };
    case "test":
      return { on: false, offFor: "test", why: "This is a test copy of Sova, so it retires nothing." };
    default:
      return { on: false, offFor: "unknown", why: "Sova couldn't tell which install this is, so it retires nothing." };
  }
}

/** The folders that are a test copy's own test data: its agent dir, and the throwaway root a test runner or a test server names. */
export function ownTestRoots(env: NodeJS.ProcessEnv = process.env, o: WhichFacts = {}): string[] {
  const roots: string[] = [];
  try {
    const dir = o.agentDir ?? agentRoot();
    if (dir) roots.push(dir);
  } catch {
    // can't tell: fewer roots, so more is refused
  }
  for (const r of [env.SOVA_TEST_DATA, env.SOVA_TEST_HOME]) if (r) roots.push(r);
  // Never a root a real thing lives under: `/`, or a folder holding this very code (so a home, or a projects folder).
  const code = realOr(o.codeRoot ?? CODE_ROOT);
  return [...new Set(roots.map(realOr))].filter((r) => r !== dirname(r) && !inside(code, r));
}

export const TEST_COPY_KEEPS = "this is a test copy of Sova, and that worktree isn't in its own test data";
export const TEST_COPY_CANT_TELL = "this is a test copy of Sova, and it can't tell that worktree is in its own test data";

/**
 * Why `sova_archive` may not remove this worktree on this server, or null. Only a test copy, or a server that can't
 * tell what it is, refuses: for it, the worktree and its repository must both be in its own test data. `commonDir`
 * null means git couldn't say, which refuses.
 */
export function archiveRemovalRefusal(path: string, commonDir: string | null, env: NodeJS.ProcessEnv = process.env, o: WhichFacts = {}): string | null {
  const kind = serverKind(env, o);
  if (kind === "real" || kind === "install") return null;
  const roots = ownTestRoots(env, o);
  if (!roots.length || !commonDir) return TEST_COPY_CANT_TELL;
  const within = (p: string): boolean => roots.some((r) => inside(realOr(p), r));
  return within(path) && within(commonDir) ? null : TEST_COPY_KEEPS;
}

/**
 * Whether a worktree's row offers Remove (§chat.worktrees/pane): only on an install where retirement is off because
 * it runs on an agent directory of its own, and only with nothing left. Everywhere else the service takes those by itself.
 */
export function removeOffered(left: "nothing" | "drafts" | undefined, gate: Gate = retirementAllowed()): boolean {
  return left === "nothing" && !gate.on && gate.offFor === "install";
}
