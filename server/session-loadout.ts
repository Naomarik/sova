import type { PiResourceDiagnostic, PiSkill } from "./harness/pi/extension-types";
import { stateViewOf } from "./harness/pi/state-view-of";
import { LOADOUT } from "./harness/state-kinds";
import type { FolderRule } from "../shared/folder-rule";

/**
 * A session's own context files and skills (§chat.transcript/setup-card-toggles): the hidden
 * `sova-loadout` entry, its fold, and the pi loader overrides a runtime is built with. The entry
 * keeps EXCLUSIONS only (absolute context file paths, skill names), never any text, so the newest
 * one on the branch says what this session leaves out and everything else stays as pi finds it.
 *
 * Read by chat-manager's createRuntime (every build, so a pick and a restart both reopen with it)
 * and by session-setup (which rows the card draws off). This module must not import chat-manager.
 */

export const LOADOUT_ENTRY = "sova-loadout";

export interface LoadoutEntryData {
  v: 1;
  /** Context files left out of the prompt, by absolute path as pi's loader lists them. Before the first
      message: the chat's own flips off. Default mode once started: the whole off list, fixed. */
  offContext: string[];
  /** Skills left out, by SKILL.md path (an absolute path), or by name in an entry from before skills were told
      apart by place. Before the first message: the chat's own flips off. Default mode once started: the
      whole off list, fixed (writeLoadoutStamp writes it then). */
  offSkills: string[];
  /** Before the first message: skills its folder keeps off (disallowed, or Waiting while asking) that this chat
      keeps on, by SKILL.md path: the chat's own flips on (never one of `offSkills`, flipsAgainstProject). */
  onSkills?: string[];
  /** Context files its folder keeps off that this chat keeps on, by absolute path: flips on, like onSkills. */
  onContext?: string[];
  /** The chat decides in asking mode (§ the Sova-wide "Allow context files and skills without asking"
      switch was off when it started): only what `onlyContext` and `onlySkills` name loads, so anything
      appearing later stays off. Absent: the off lists alone (a chat from before this, or the default mode). */
  asking?: true;
  /** Asking only: every context file this chat may load, by absolute path. */
  onlyContext?: string[];
  /** Asking only: every skill this chat may load, by SKILL.md path. */
  onlySkills?: string[];
  /** MCP servers this chat turns off, or on against their New Chats switch, by name: only the flips. */
  offMcp?: string[];
  onMcp?: string[];
}

/** The largest off set the route accepts, per kind; far above any real loadout. */
export const LOADOUT_MAX = 500;
/** The largest allowlist an entry keeps, per kind (a folder's whole approved set). */
export const LOADOUT_ONLY_MAX = 5000;

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 4096) ? [...new Set(v as string[])] : null;
const optStrings = (v: unknown, max: number): string[] | null => {
  const out = v === undefined ? [] : strings(v);
  return out && out.length <= max ? out : null;
};

/** The entry's data, strictly: anything else is not an entry (null). */
export function normalizeLoadout(v: unknown): LoadoutEntryData | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (d.v !== 1) return null;
  const offContext = strings(d.offContext);
  const offSkills = strings(d.offSkills);
  if (!offContext || !offSkills) return null;
  if (offContext.length > LOADOUT_MAX || offSkills.length > LOADOUT_MAX) return null;
  if (!offContext.every((p) => p.startsWith("/"))) return null;
  const offMcp = optStrings(d.offMcp, LOADOUT_MAX);
  const onMcp = optStrings(d.onMcp, LOADOUT_MAX);
  const onSkills = optStrings(d.onSkills, LOADOUT_MAX);
  const onContext = optStrings(d.onContext, LOADOUT_MAX);
  if (!offMcp || !onMcp || !onSkills || !onContext || !onContext.every((p) => p.startsWith("/"))) return null;
  if (d.asking !== undefined && d.asking !== true) return null;
  const asking = d.asking === true;
  const onlyContext = optStrings(d.onlyContext, LOADOUT_ONLY_MAX);
  const onlySkills = optStrings(d.onlySkills, LOADOUT_ONLY_MAX);
  if (!onlyContext || !onlySkills || !onlyContext.every((p) => p.startsWith("/"))) return null;
  if (!asking && (onlyContext.length || onlySkills.length)) return null;
  return {
    v: 1,
    offContext,
    offSkills,
    ...(onSkills.length ? { onSkills } : {}),
    ...(onContext.length ? { onContext } : {}),
    ...(asking ? { asking: true as const, onlyContext, onlySkills } : {}),
    ...(offMcp.length ? { offMcp } : {}),
    ...(onMcp.length ? { onMcp } : {}),
  };
}

/** The newest well-formed `sova-loadout` entry on a branch (null: none, everything on). The entries are pi's
    or the reader's (any mix), read through the state view. */
export function loadoutOnBranch(branch: readonly unknown[]): LoadoutEntryData | null {
  return stateViewOf(branch).latest(LOADOUT)?.data ?? null;
}

type Readable = Pick<LoadoutEntryData, "offSkills"> & Partial<Pick<LoadoutEntryData, "onSkills" | "asking" | "onlySkills" | "offContext" | "onContext" | "onlyContext">>;

/** Whether a chat's entry keeps a skill out: the one reading of an off skill, for the loader's list, a
    subfolder's skills and a typed `/skill:name` alike, by its SKILL.md: one of the same name from another
    place is another skill. A flip on stays on; then the off list (a name there is an entry from before
    skills were told apart by place); then, asking, only the allowlist loads. No entry: every skill on. */
export function isSkillOff(d: Readable | null | undefined, skill: { name: string; filePath: string }): boolean {
  if (!d) return false;
  if (skill.filePath && d.onSkills?.includes(skill.filePath)) return false;
  if (d.offSkills.includes(skill.filePath) || d.offSkills.includes(skill.name)) return true;
  return !!d.asking && !(skill.filePath && d.onlySkills?.includes(skill.filePath));
}

/** Whether a chat's entry keeps a context file (absolute path) out: the one reading, for the prompt's files
    and a subfolder's alike. */
export function isContextOff(d: Readable | null | undefined, path: string): boolean {
  if (!d) return false;
  if (d.onContext?.includes(path)) return false;
  if (d.offContext?.includes(path)) return true;
  return !!d.asking && !d.onlyContext?.includes(path);
}

/**
 * What a chat before its first message is built with: its own flips (`d`) laid over its folder's
 * decisions (`rule`, absolute paths in its checkout). Default mode: disallowed items off, the rest on.
 * Asking: approved items on, the rest off. A flip of the chat's own wins either way. Never for a chat
 * whose first message is sent: its entry is then fixed.
 */
export function pristineLoadout(d: LoadoutEntryData | null, rule: FolderRule | null): LoadoutEntryData | null {
  const own: LoadoutEntryData = d ? { ...d } : { v: 1, offContext: [], offSkills: [] };
  delete own.asking;
  delete own.onlyContext;
  delete own.onlySkills;
  if (!rule) return d ? own : null;
  const onContext = new Set(own.onContext ?? []);
  if (rule.asking) {
    return { ...own, asking: true, onlyContext: [...new Set([...rule.context.approved, ...onContext])], onlySkills: [...new Set([...rule.skills.approved, ...(own.onSkills ?? []).filter((p) => p.startsWith("/"))])] };
  }
  if (!rule.context.disallowed.length && !rule.skills.disallowed.length) return d ? own : null;
  return {
    ...own,
    offContext: [...new Set([...own.offContext, ...rule.context.disallowed.filter((p) => !onContext.has(p))])],
    offSkills: [...new Set([...own.offSkills, ...rule.skills.disallowed])],
  };
}

/**
 * The entry a setup card's whole off set is saved as (POST /api/sessions/loadout), before the first
 * message: only the chat's flips against its folder, so a later decision still reaches the chat until it
 * starts. Everything by path (a skill by its SKILL.md). `kept`: what the folder keeps off for this chat now
 * (pristineLoadout with no flips), of what the card lists (`listed`); a row it doesn't list was never
 * switched by it, so it keeps the folder's state.
 */
export function flipsAgainstProject(
  data: LoadoutEntryData,
  kept: { context: readonly string[]; skills: readonly string[] },
  listed: { context: ReadonlySet<string>; skills: ReadonlySet<string> },
): LoadoutEntryData {
  const keptContext = new Set(kept.context);
  const keptSkills = new Set(kept.skills);
  const wantedContext = new Set(data.offContext);
  const wantedSkills = new Set(data.offSkills);
  const offContext = data.offContext.filter((p) => !keptContext.has(p));
  const offSkills = data.offSkills.filter((n) => !keptSkills.has(n));
  const onContext = kept.context.filter((p) => listed.context.has(p) && !wantedContext.has(p));
  const onSkills = kept.skills.filter((n) => listed.skills.has(n) && !wantedSkills.has(n));
  const { onSkills: _s, onContext: _c, asking: _a, onlyContext: _oc, onlySkills: _os, ...rest } = data;
  return { ...rest, offContext, offSkills, ...(onSkills.length ? { onSkills } : {}), ...(onContext.length ? { onContext } : {}) };
}

/**
 * The entry written with a chat's first message (what it loads fixed from then on): the pristine entry it
 * was built with. An asking chat's is made exact: its flips folded into the allowlists (on in, off out) and
 * dropped, and only items that exist now (`exists`) kept, so nothing appearing later loads by itself, not
 * even one of the same name as a skill switched on. Reads the same before the message (pristineLoadout)
 * and after. `skills` is the loader's list (unused but for an older caller).
 */
export function loadoutStamp(
  built: LoadoutEntryData | null,
  _skills: readonly { name: string; filePath: string }[] = [],
  exists: (abs: string) => boolean = () => true,
): LoadoutEntryData {
  const base: LoadoutEntryData = built ? { ...built } : { v: 1, offContext: [], offSkills: [] };
  if (!base.asking) return base;
  const { onSkills, onContext, ...rest } = base;
  const offSkills = new Set(base.offSkills);
  const offContext = new Set(base.offContext);
  const onlySkills = [...new Set([...(base.onlySkills ?? []), ...(onSkills ?? [])])].filter((p) => p.startsWith("/") && !offSkills.has(p) && exists(p));
  const onlyContext = [...new Set([...(base.onlyContext ?? []), ...(onContext ?? [])])].filter((p) => !offContext.has(p) && exists(p));
  return { ...rest, onlyContext, onlySkills };
}

/** Whether an entry leaves anything out at all (an asking entry always may: its allowlist is the rule). */
export const leavesOut = (d: LoadoutEntryData | null | undefined): d is LoadoutEntryData =>
  !!d && (!!d.asking || d.offContext.length > 0 || d.offSkills.length > 0 || !!d.offMcp?.length || !!d.onMcp?.length);

/**
 * What a runtime was built with: the entry, and the loader's UNFILTERED lists as the overrides last
 * saw them, so the card can still list (and switch back on) a row that is off. pi calls the skills
 * override again whenever an extension adds skill paths, each time with the whole set.
 */
export interface LoadoutState {
  /** The entry as this runtime applies it: before the first message, laid over its folder's decisions
      (pristineLoadout). */
  data: LoadoutEntryData | null;
  /** The folder's decisions this build read (before the first message only; else absent). */
  rule?: FolderRule | null;
  baseContext?: string[];
  baseSkills?: { name: string; filePath: string; description?: string; manualOnly?: boolean }[];
}

/** The two loader overrides for an entry, recording each base list into `state` when given. Undefined when
    the entry leaves nothing out: the runtime is then built exactly as before this feature. */
export function loadoutOverrides(state: LoadoutState) {
  const d = state.data;
  if (!leavesOut(d)) return undefined;
  return entryOverrides(d, state);
}

/** The loader overrides that apply one entry (a worker's: its parent's fixed list, WorkerSpec.loadout). */
export function entryOverrides(d: LoadoutEntryData, state?: Pick<LoadoutState, "baseContext" | "baseSkills">) {
  return {
    agentsFilesOverride: (base: { agentsFiles: { path: string; content: string }[] }) => {
      if (state) state.baseContext = base.agentsFiles.map((f) => f.path);
      return { agentsFiles: base.agentsFiles.filter((f) => !isContextOff(d, f.path)) };
    },
    skillsOverride: (base: { skills: PiSkill[]; diagnostics: PiResourceDiagnostic[] }) => {
      if (state) state.baseSkills = base.skills.map((s) => ({ name: s.name, filePath: s.filePath, ...(s.description !== undefined ? { description: s.description } : {}), ...(s.disableModelInvocation ? { manualOnly: true } : {}) }));
      return { skills: base.skills.filter((s) => !isSkillOff(d, s)), diagnostics: base.diagnostics };
    },
  };
}

/** The skills override alone, for a worker given only its parent's off list (WorkerSpec.offSkills, older parents). */
export function skillsOffOverride(offSkills: readonly string[]) {
  const d = { offSkills: [...offSkills] };
  return {
    skillsOverride: (base: { skills: PiSkill[]; diagnostics: PiResourceDiagnostic[] }) => ({ skills: base.skills.filter((s) => !isSkillOff(d, s)), diagnostics: base.diagnostics }),
  };
}

const sameNames = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");
/** Whether two entries say the same thing (order aside). */
export const sameLoadout = (a: LoadoutEntryData, b: LoadoutEntryData): boolean =>
  sameNames(a.offContext, b.offContext) &&
  sameNames(a.offSkills, b.offSkills) &&
  sameNames(a.onSkills, b.onSkills) &&
  sameNames(a.onContext, b.onContext) &&
  !!a.asking === !!b.asking &&
  sameNames(a.onlyContext, b.onlyContext) &&
  sameNames(a.onlySkills, b.onlySkills) &&
  sameNames(a.offMcp, b.offMcp) &&
  sameNames(a.onMcp, b.onMcp);
