// A chat's project minor modes as the mode menu sees them (§chat.mode-menu/project-modes): the modes its
// checkout offers now (pi-config's discovery, node builtins only), the ones it has on (its mode entry's
// `projectModes`) with the version it turned on (its snapshots), and which turn-ons need the user's approval.
// Pure apart from the discovery read; no pi.
import { discoverProjectModes } from "../pi-config/extensions/mode/project-discovery.ts";
import { isProjectModeId, type ProjectModeListing, type ProjectModeRef, type ProjectModeSnapshot } from "../shared/project-modes";
import type { ChatProjectModes, ProjectMinorInfo, ProjectModeApproval } from "../shared/protocol";

/** Whether the user (or the Overseer) approved exactly this tool set of this mode in this checkout. */
export type ApprovedFn = (root: string, id: string, toolsHash: string) => boolean;

const NO_LISTING: ProjectModeListing = { root: null, name: "", modes: [], problems: [] };

/** The project modes `cwd`'s checkout offers now; none for a remote cwd (`remote`) or a relative one. */
export function listingFor(cwd: string | undefined, remote: boolean): ProjectModeListing {
  if (!cwd || remote) return NO_LISTING;
  return discoverProjectModes(cwd);
}

const toolsOf = (s: Pick<ProjectModeSnapshot, "tools">) => s.tools.map((t) => ({ name: t.name, description: t.description, command: [...t.command] }));

function infoOf(mode: ProjectModeSnapshot, root: string | null, approved: ApprovedFn): ProjectMinorInfo {
  const needs = mode.toolsHash !== "" && !(root !== null && approved(root, mode.id, mode.toolsHash));
  return {
    id: mode.id,
    description: mode.description,
    workers: mode.workers,
    tools: toolsOf(mode),
    dir: mode.dir,
    ...(needs ? { needsApproval: true as const } : {}),
    ...(mode.toolsHash !== "" ? { toolsHash: mode.toolsHash } : {}),
  };
}

/**
 * The menu's view of a chat's project modes. `on` is the chat's on set (turn-on order), `snapshots` the
 * versions it keeps (newest per id). A mode on whose folder is gone is `removed`; one on whose files differ
 * from what it turned on is `changed`; a broken folder carries `problem`. A mode that is on shows the version
 * the chat runs (its snapshot's words and tools), never the files. `snapshots` is keyed by snapshot sha.
 * Each field is absent when it would be empty (nothing on, no rows), so a chat with no project modes gets {}.
 */
export function projectModesInfo(
  listing: ProjectModeListing,
  on: readonly ProjectModeRef[],
  snapshots: ReadonlyMap<string, ProjectModeSnapshot>,
  approved: ApprovedFn,
): ChatProjectModes {
  if (listing.modes.length === 0 && listing.problems.length === 0 && on.length === 0) return {};
  const onById = new Map(on.map((r) => [r.id, r]));
  const minors: ProjectMinorInfo[] = [];
  const seen = new Set<string>();
  for (const mode of listing.modes) {
    seen.add(mode.id);
    const info = infoOf(mode, listing.root, approved);
    const ref = onById.get(mode.id);
    const kept = ref ? snapshots.get(ref.sha) : undefined;
    if (kept) Object.assign(info, { description: kept.description, workers: kept.workers, tools: toolsOf(kept), dir: kept.dir });
    if (ref && (ref.sha !== mode.sha || (kept && kept.toolsHash !== mode.toolsHash))) info.changed = true;
    minors.push(info);
  }
  for (const p of listing.problems) {
    seen.add(p.id);
    const ref = onById.get(p.id);
    const kept = ref ? snapshots.get(ref.sha) : undefined;
    minors.push({
      id: p.id,
      description: kept?.description ?? "",
      workers: kept?.workers ?? false,
      tools: kept ? toolsOf(kept) : [],
      dir: kept?.dir ?? p.path,
      problem: `${p.path}: ${p.error}`,
      ...(kept ? { changed: true as const } : {}),
    });
  }
  for (const ref of on) {
    if (seen.has(ref.id)) continue;
    const kept = snapshots.get(ref.sha);
    minors.push({
      id: ref.id,
      description: kept?.description ?? "",
      workers: kept?.workers ?? false,
      tools: kept ? toolsOf(kept) : [],
      dir: kept?.dir ?? "",
      removed: true,
    });
  }
  // Absent rather than empty, so a chat with no project modes sends the frame it always did.
  return {
    ...(on.length > 0 ? { projectModes: on.map((r) => r.id) } : {}),
    ...(minors.length > 0 && listing.root !== null ? { project: { root: listing.root, name: listing.name } } : {}),
    ...(minors.length > 0 ? { projectMinors: minors } : {}),
  };
}

/** What a switch to the on set `wanted` asks for, checked before anything is applied. */
export type ProjectSwitchCheck =
  | { error: string }
  | { needsApproval: ProjectMinorInfo[]; stale: string[] }
  | { ok: true; ids: string[]; record: { id: string; hash: string }[] };

/**
 * Check a switch of a chat's project modes to `wanted` (its whole on set). Modes staying on and modes turned
 * off are never checked (off is always allowed, removed ones too). A mode turned on must be offered here and
 * not broken; one with tools needs its exact tool set (toolsHash) approved already, or approved now: by the
 * Overseer (`overseer`, q7), or by an `approve` entry carrying the hash the user saw. `record` lists the
 * approvals to store BEFORE the switch is applied (the chat's turn-on asks the store).
 */
export function checkProjectSwitch(
  listing: ProjectModeListing,
  currentOn: readonly string[],
  wanted: readonly string[],
  approve: readonly ProjectModeApproval[],
  overseer: boolean,
  approved: ApprovedFn,
): ProjectSwitchCheck {
  const ids = [...new Set(wanted)];
  const needs: ProjectMinorInfo[] = [];
  const record: { id: string; hash: string }[] = [];
  const stale: string[] = [];
  for (const id of ids) {
    if (currentOn.includes(id)) continue;
    const problem = listing.problems.find((p) => p.id === id);
    if (problem) return { error: `Project mode "${id}" can't be turned on: ${problem.error} (${problem.path})` };
    const mode = listing.modes.find((m) => m.id === id);
    if (!mode) return { error: `No project mode "${id}" in this chat's project` };
    if (mode.toolsHash === "" || approved(listing.root!, id, mode.toolsHash)) continue;
    if (overseer || approve.some((a) => a.id === id && a.hash === mode.toolsHash)) record.push({ id, hash: mode.toolsHash });
    else {
      if (approve.some((a) => a.id === id)) stale.push(id);
      needs.push(infoOf(mode, listing.root, approved));
    }
  }
  if (needs.length > 0) return { needsApproval: needs, stale };
  return { ok: true, ids, record };
}

/** Validate a body's `projectModes` (ids only; whether they exist is the chat's to check). */
/** The 409's sentence: tools changed since the user looked (an approve with an old hash), else not approved yet. */
export function approvalNeededText(check: { needsApproval: ProjectMinorInfo[]; stale: string[] }): string {
  const fresh = check.needsApproval.map((m) => m.id).filter((id) => !check.stale.includes(id));
  const parts: string[] = [];
  if (check.stale.length > 0) parts.push(`The tools of ${check.stale.join(", ")} changed since you looked; check them again.`);
  if (fresh.length > 0) parts.push(`Approve the tools of ${fresh.join(", ")} to turn ${fresh.length === 1 ? "it" : "them"} on.`);
  return parts.join(" ");
}

export function parseProjectModes(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value)) return { error: "projectModes must be an array" };
  const bad = value.filter((v) => !isProjectModeId(v));
  if (bad.length > 0) return { error: `Not a project mode name: ${bad.map(String).join(", ")}` };
  return [...new Set(value as string[])];
}

/** Validate a body's `approve`: [{ id, hash }]. */
export function parseApprovals(value: unknown): ProjectModeApproval[] | { error: string } {
  if (!Array.isArray(value)) return { error: "approve must be an array of { id, hash }" };
  const out: ProjectModeApproval[] = [];
  for (const a of value) {
    const r = a as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || !isProjectModeId(r.id) || typeof r.hash !== "string" || !/^[0-9a-f]{64}$/.test(r.hash))
      return { error: "approve must be an array of { id, hash } (hash: the mode's toolsHash)" };
    out.push({ id: r.id, hash: r.hash });
  }
  return out;
}
