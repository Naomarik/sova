// A linked session's sandbox as the server must honour it when it moves files for that session
// (§mesh.links/offers, §mesh.links/transfer): with the sandbox on, the server packs only what the
// session's own tools could read and extracts only where they could write. Off, nothing but Sova's
// own state and the archive's shape are checked. The policy is the sandbox extension's, resolved by its own
// session-policy.ts from what the session's branch says (the `sandbox` entry, the tracked
// worktrees), so the server and the extension never disagree. With the sandbox on and the policy
// unresolvable, everything is refused (fail closed, as the tools do).
//
// Also the receiver's pre-scan (Q6): every member of a downloaded archive checked before `tar -x`
// runs, whatever the sandbox (GNU tar writes through a link already on disk in a member's parent
// path, so a link one offer left could carry the next offer's files anywhere). Known limit: a sandboxed agent could plant a symlink in dest between the scan and the
// extraction; closing that is confined extraction, later.
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { canonicalize, hiddenBelow, isWithin, readDenial, type ResolvedPolicy, writeDenial } from "../pi-config/extensions/sandbox/policy.ts";
import { resolveSessionPolicy } from "../pi-config/extensions/sandbox/session-policy.ts";
import { restoreActive } from "../pi-config/extensions/sandbox/state.ts";
import type { TarMember } from "./mesh/tar-list";
import { worktreesOf } from "./worktrees-state";

type Entry = { type: string; customType?: string; data?: unknown };

/** A session's sandbox now: off, on with its resolved policy, or on and unresolvable (every check refuses). */
export type LinkSandbox = { on: false } | { on: true; policy: ResolvedPolicy } | { on: true; error: string };

/** What the server knows of a session, for linkSandboxOf (server/index.ts wires it). */
export interface LinkSandboxSource {
  /** The session's cwd, or null when there is no such session on this host. */
  cwd(sessionId: string): Promise<string | null>;
  /** Its active branch: the held runtime's, else read from the file. */
  branch(sessionId: string): Promise<readonly unknown[]>;
  agentDir(): string;
  home?(): string;
}

/**
 * The sandbox of the session `sessionId` whose active branch is `branch`: on or off by its newest
 * `sandbox` entry, its writable roots including the active tracked worktrees.
 */
export function sandboxOf(session: { sessionId: string; cwd: string }, branch: readonly unknown[], opts: { agentDir: string; home?: string }): LinkSandbox {
  let on = false;
  try {
    on = restoreActive(branch as Entry[])?.on === true;
  } catch {
    on = false;
  }
  if (!on) return { on: false };
  try {
    const trees = (worktreesOf(branch)?.trees ?? []).filter((t) => t.status === "active").map((t) => t.path);
    const r = resolveSessionPolicy({ agentDir: opts.agentDir, cwd: session.cwd, sessionId: session.sessionId, worktreeRoots: trees, home: opts.home ?? homedir() });
    return r.ok ? { on: true, policy: r.value } : { on: true, error: r.error };
  } catch (err) {
    return { on: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A session on this host by id; a session it can't read is treated as sandboxed and unresolvable. */
export async function linkSandboxOf(sessionId: string, src: LinkSandboxSource): Promise<LinkSandbox> {
  try {
    const cwd = await src.cwd(sessionId);
    if (cwd === null) return { on: true, error: `no session ${sessionId} on this host` };
    return sandboxOf({ sessionId, cwd }, await src.branch(sessionId), { agentDir: src.agentDir(), ...(src.home ? { home: src.home() } : {}) });
  } catch (err) {
    return { on: true, error: err instanceof Error ? err.message : String(err) };
  }
}

const unresolvedWhy = (error: string) => `the session's sandbox is on but its policy can't be resolved (${error})`;

/** The protected roots, canonical. */
const protectedOf = (roots: readonly string[]): string[] => [...new Set(roots.map(canonicalize))];

/** The pre-scan's refusal, naming the first offending path. */
export interface PrescanDenial {
  reason: "not-writable" | "protected" | "bad-dest";
  path: string;
  message: string;
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pre-scan: every member of the archive (in order) before extraction into the canonical
 * `dest`. Refused: an absolute name or a `..`; a member whose parent is neither dest nor a directory
 * member seen earlier (tar would follow a symlink already there); a hard link to anything but an
 * earlier member; a member in a protected root, also once its parent's links on disk are resolved
 * (one planted earlier, or dest itself swapped for one); with the sandbox on, a member its tools
 * couldn't write. Null when every member passes. Throws what the reader throws (a corrupt archive).
 */
export async function prescan(
  members: AsyncIterable<TarMember>,
  o: { dest: string; roots?: readonly string[]; sandbox: LinkSandbox; protectedRoots: readonly string[] },
): Promise<PrescanDenial | null> {
  const { dest, sandbox: sb, protectedRoots } = o;
  if (sb.on && "error" in sb) return { reason: "not-writable", path: dest, message: `Nothing was extracted: ${unresolvedWhy(sb.error)}.` };
  const prot = protectedOf(protectedRoots);
  const dirs = new Set<string>();
  const seen = new Set<string>();
  // Each parent directory as the disk resolves it now, once per scan.
  const real = new Map<string, string>();
  for await (const m of members) {
    const name = clean(m.name);
    if (name === null) return { reason: "not-writable", path: m.name, message: `The archive names ${JSON.stringify(m.name)}, outside the destination; nothing was extracted.` };
    if (name === "") continue; // "./" itself: dest
    const abs = join(dest, name);
    const slash = name.lastIndexOf("/");
    const parent = slash < 0 ? "" : name.slice(0, slash);
    if (parent && !dirs.has(parent))
      return { reason: "not-writable", path: abs, message: `${abs} would be written through a path the archive didn't create as a directory; nothing was extracted.` };
    if (m.type === "hardlink") {
      const target = m.linkname === undefined ? null : clean(m.linkname);
      if (target === null || !seen.has(target) || dirs.has(target))
        return { reason: "not-writable", path: abs, message: `${abs} is a hard link to something outside the archive; nothing was extracted.` };
    }
    const p = prot.find((r) => isWithin(abs, r));
    if (p) return { reason: "protected", path: abs, message: `${abs} is inside Sova's own state, which a transfer never writes; nothing was extracted.` };
    let up = real.get(parent);
    if (up === undefined) real.set(parent, (up = canonicalize(parent ? join(dest, parent) : dest)));
    const at = join(up, basename(abs));
    const q = prot.find((r) => isWithin(at, r));
    if (q) return { reason: "protected", path: abs, message: `${abs} would be written into Sova's own state (${q}) through a link on disk; nothing was extracted.` };
    if (sb.on && "policy" in sb) {
      const why = writeDenial(sb.policy, abs, { creating: m.type === "dir" && !exists(abs) });
      if (why) return { reason: "not-writable", path: abs, message: `${abs} is not writable for this session in its sandbox (${why}); nothing was extracted.` };
    }
    seen.add(name);
    if (m.type === "dir") dirs.add(name);
    else dirs.delete(name);
  }
  return null;
}

/** A member name without "./" and trailing "/", or null when it is absolute or climbs with "..". */
function clean(raw: string): string | null {
  if (!raw || raw.includes("\0") || isAbsolute(raw)) return null;
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

/**
 * The sandbox checks the transfer core runs (links-transfer.ts), each a refusal sentence or
 * undefined. Off: everything is allowed. On and unresolvable: everything is refused.
 */
export interface TransferSandbox {
  read(sb: LinkSandbox, canonical: string): string | undefined;
  write(sb: LinkSandbox, canonical: string, opts?: { creating?: boolean }): string | undefined;
  hiddenBelow(sb: LinkSandbox, root: string): string[];
  prescan: typeof prescan;
}

export const linkSandbox: TransferSandbox = {
  read: (sb, canonical) => (!sb.on ? undefined : "error" in sb ? unresolvedWhy(sb.error) : readDenial(sb.policy, canonical)),
  write: (sb, canonical, opts) => (!sb.on ? undefined : "error" in sb ? unresolvedWhy(sb.error) : writeDenial(sb.policy, canonical, opts)),
  // Unresolvable: `read` already refuses the root itself, so nothing below it is reached.
  hiddenBelow: (sb, root) => (sb.on && "policy" in sb ? hiddenBelow(sb.policy, root) : []),
  prescan,
};
