// A chat's project minor modes as the mode menu sees them (§chat.mode-menu/project-modes): the modes its
// checkout offers now (pi-config's discovery, node builtins only), the ones it has on (its mode entry's
// `projectModes`) with the version it turned on (its snapshots), and which turn-ons need the user's approval.
// Pure apart from the discovery read; no pi.
import { discoverProjectModes } from "../pi-config/extensions/mode/project-discovery.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isProjectModeId, PROJECT_MODE_ENTRY, type ProjectModeListing, type ProjectModeRef, type ProjectModeSnapshot } from "../shared/project-modes";
import type { ChatProjectModes, ProjectMinorHook, ProjectMinorInfo, ProjectModeApproval } from "../shared/protocol";
import { approvalRootFor, isPersonalDir, isPersonalId, replacesProjectMode, type MergedModeListing } from "./modes/personal";
import { listingFor as registryListingFor } from "./modes/registry";

/** Whether the user (or the Overseer) approved exactly this tool set of this mode in this checkout. */
export type ApprovedFn = (root: string, id: string, toolsHash: string) => boolean;

const NO_LISTING: ProjectModeListing = { root: null, name: "", modes: [], problems: [] };

/**
 * The project modes `cwd`'s checkout offers now; none for a remote cwd (`remote`) or a relative one. With
 * `personal` (the chat runs on Sova's modes, §chat.mode-menu/sova-runs-modes), the user's own modes are merged in,
 * yours winning on an id (§chat.mode-menu/personal-modes); without it, the listing is exactly the project's.
 */
export function listingFor(cwd: string | undefined, remote: boolean, personal = false): ProjectModeListing | MergedModeListing {
  if (!cwd || remote) return NO_LISTING;
  if (!personal) return discoverProjectModes(cwd);
  // The engine's own merge (registry.ts), so the menu and the chat read one listing. A chat with no checkout
  // offers no project modes, so none of yours either.
  const merged = registryListingFor(cwd);
  return merged.root !== null ? merged : discoverProjectModes(cwd);
}

const toolsOf = (s: Pick<ProjectModeSnapshot, "tools">) => s.tools.map((t) => ({ name: t.name, description: t.description, command: [...t.command] }));

/** What the menu needs beyond `approved` to show a mode's commands and hooks (§chat.mode-menu/project-mode-hooks). */
export interface ActionsInfo {
  /** Whether YOU approved this exact version (hooks need it; an Overseer approval doesn't count). */
  approvedByUser?: ApprovedFn;
  /** Per mode id, the note of hooks over their budget now. */
  hookNotes?: ReadonlyMap<string, string>;
}

/** A version's commands and hooks, and whether its hooks wait for your approval: each key only when it applies. */
const NO_ACTIONS: Partial<ProjectMinorInfo> = Object.freeze({});

function actionsOf(mode: Pick<ProjectModeSnapshot, "id" | "commands" | "hooks" | "toolsHash">, root: string | null, approved: ApprovedFn, extra: ActionsInfo | undefined): Partial<ProjectMinorInfo> {
  // Today's modes (neither key) take nothing here: the menu's read costs what it did.
  if (!mode.commands?.length && !mode.hooks?.length) return NO_ACTIONS;
  const hooks: ProjectMinorHook[] = (mode.hooks ?? []).map((h) => ({ on: h.on, command: [...h.command] }));
  const waiting =
    hooks.length > 0 && root !== null && extra?.approvedByUser !== undefined && approved(root, mode.id, mode.toolsHash) && !extra.approvedByUser(root, mode.id, mode.toolsHash);
  const note = hooks.length > 0 ? extra?.hookNotes?.get(mode.id) : undefined;
  return {
    ...(mode.commands?.length ? { commands: toolsOf({ tools: mode.commands }) } : {}),
    ...(hooks.length > 0 ? { hooks } : {}),
    ...(waiting ? { hooksNeedApproval: true as const } : {}),
    ...(note ? { hookNote: note } : {}),
  };
}

function infoOf(mode: ProjectModeSnapshot, listing: ProjectModeListing, approved: ApprovedFn, extra?: ActionsInfo): ProjectMinorInfo {
  // A personal mode's approvals are kept for the user's folder, a project mode's for its checkout.
  const root = approvalRootFor(listing, mode.id);
  const needs = mode.toolsHash !== "" && !(root !== null && approved(root, mode.id, mode.toolsHash));
  const info: ProjectMinorInfo = {
    ...personalMarks(listing, mode.id, mode.dir),
    id: mode.id,
    description: mode.description,
    workers: mode.workers,
    tools: toolsOf(mode),
    dir: mode.dir,
    ...(needs ? { needsApproval: true as const } : {}),
    ...(mode.toolsHash !== "" ? { toolsHash: mode.toolsHash } : {}),
  };
  return mode.commands?.length || mode.hooks?.length ? Object.assign(info, actionsOf(mode, root, approved, extra)) : info;
}

/** `personal` (and `replaces`) for a mode from the user's own folder: by the listing, else by its saved copy's folder. */
function personalMarks(listing: ProjectModeListing, id: string, dir: string | undefined): Partial<ProjectMinorInfo> {
  if (isPersonalId(listing, id)) return { personal: true, ...(replacesProjectMode(listing, id) ? { replaces: true as const } : {}) };
  return dir && isPersonalDir(dir) ? { personal: true } : {};
}

/** Drop the actions keys an info got from the folder's version (a kept copy then sets its own). */
function withoutActions(info: ProjectMinorInfo): ProjectMinorInfo {
  const { commands: _c, hooks: _h, hooksNeedApproval: _w, hookNote: _n, ...rest } = info;
  return rest;
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
  extra?: ActionsInfo,
): ChatProjectModes {
  if (listing.modes.length === 0 && listing.problems.length === 0 && on.length === 0) return {};
  const onById = new Map(on.map((r) => [r.id, r]));
  const minors: ProjectMinorInfo[] = [];
  const seen = new Set<string>();
  for (const mode of listing.modes) {
    seen.add(mode.id);
    let info = infoOf(mode, listing, approved, extra);
    const ref = onById.get(mode.id);
    const kept = ref ? snapshots.get(ref.sha) : undefined;
    // A mode on shows the version the chat runs: its words, tools, commands and hooks.
    if (kept) {
      if (info.commands || info.hooks || kept.commands?.length || kept.hooks?.length) info = Object.assign(withoutActions(info), actionsOf(kept, approvalRootFor(listing, mode.id), approved, extra));
      Object.assign(info, { description: kept.description, workers: kept.workers, tools: toolsOf(kept), dir: kept.dir });
    }
    if (ref && (ref.sha !== mode.sha || (kept && kept.toolsHash !== mode.toolsHash))) info.changed = true;
    minors.push(info);
  }
  for (const p of listing.problems) {
    seen.add(p.id);
    const ref = onById.get(p.id);
    const kept = ref ? snapshots.get(ref.sha) : undefined;
    minors.push({
      ...personalMarks(listing, p.id, kept?.dir),
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
    const marks = personalMarks(listing, ref.id, kept?.dir);
    // One of yours on while this chat isn't offered personal modes (Sova doesn't run its modes): it stays on from
    // its copy and turns off like any row; it was removed only when its folder is gone.
    const stillThere = marks.personal === true && kept !== undefined && existsSync(join(kept.dir, PROJECT_MODE_ENTRY));
    minors.push({
      ...marks,
      id: ref.id,
      description: kept?.description ?? "",
      workers: kept?.workers ?? false,
      tools: kept ? toolsOf(kept) : [],
      dir: kept?.dir ?? "",
      ...(stillThere ? {} : { removed: true as const }),
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
  | { ok: true; ids: string[]; record: { id: string; hash: string; root: string }[] };

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
  const record: { id: string; hash: string; root: string }[] = [];
  const stale: string[] = [];
  for (const id of ids) {
    if (currentOn.includes(id)) continue;
    const problem = listing.problems.find((p) => p.id === id);
    if (problem) return { error: `Project mode "${id}" can't be turned on: ${problem.error} (${problem.path})` };
    const mode = listing.modes.find((m) => m.id === id);
    if (!mode) return { error: `No project mode "${id}" in this chat's project` };
    const root = approvalRootFor(listing, id)!;
    if (mode.toolsHash === "" || approved(root, id, mode.toolsHash)) continue;
    if (overseer || approve.some((a) => a.id === id && a.hash === mode.toolsHash)) record.push({ id, hash: mode.toolsHash, root });
    else {
      if (approve.some((a) => a.id === id)) stale.push(id);
      needs.push(infoOf(mode, listing, approved));
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
