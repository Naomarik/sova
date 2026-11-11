import type { PiResourceDiagnostic, PiSkill } from "./harness/pi/extension-types";
import { stateViewOf } from "./harness/pi/state-view-of";
import { LOADOUT } from "./harness/state-kinds";

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
  /** Context files left out of the prompt, by absolute path as pi's loader lists them. */
  offContext: string[];
  /** Skills left out of the skills offered, by name. Once the chat's first message is on its branch
      this is the chat's whole off list, fixed (writeLoadoutStamp writes it then). Before it, the
      chat's own flips: these off, beside the ones its project disallows. */
  offSkills: string[];
  /** Before the first message only: skills its project disallows that this chat keeps on. Never
      read once a message is sent. */
  onSkills?: string[];
  /** MCP servers this chat turns off, or on against their New Chats switch, by name: only the flips. */
  offMcp?: string[];
  onMcp?: string[];
}

/** The largest off set the route accepts, per kind; far above any real loadout. */
export const LOADOUT_MAX = 500;

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 4096) ? [...new Set(v as string[])] : null;

/** The entry's data, strictly: anything else is not an entry (null). */
export function normalizeLoadout(v: unknown): LoadoutEntryData | null {
  if (!v || typeof v !== "object") return null;
  const d = v as { v?: unknown; offContext?: unknown; offSkills?: unknown; onSkills?: unknown; offMcp?: unknown; onMcp?: unknown };
  if (d.v !== 1) return null;
  const offContext = strings(d.offContext);
  const offSkills = strings(d.offSkills);
  if (!offContext || !offSkills) return null;
  if (offContext.length > LOADOUT_MAX || offSkills.length > LOADOUT_MAX) return null;
  if (!offContext.every((p) => p.startsWith("/"))) return null;
  const offMcp = d.offMcp === undefined ? [] : strings(d.offMcp);
  const onMcp = d.onMcp === undefined ? [] : strings(d.onMcp);
  if (!offMcp || !onMcp || offMcp.length > LOADOUT_MAX || onMcp.length > LOADOUT_MAX) return null;
  const onSkills = d.onSkills === undefined ? [] : strings(d.onSkills);
  if (!onSkills || onSkills.length > LOADOUT_MAX) return null;
  return { v: 1, offContext, offSkills, ...(onSkills.length ? { onSkills } : {}), ...(offMcp.length ? { offMcp } : {}), ...(onMcp.length ? { onMcp } : {}) };
}

/** The newest well-formed `sova-loadout` entry on a branch (null: none, everything on). The entries are pi's
    or the reader's (any mix), read through the state view. */
export function loadoutOnBranch(branch: readonly unknown[]): LoadoutEntryData | null {
  return stateViewOf(branch).latest(LOADOUT)?.data ?? null;
}

/** Whether a chat's entry keeps skill `name` out: the one reading of an off skill, for the loader's
    list, a subfolder's skills and a typed `/skill:name` alike. No entry: every skill on. */
export const isSkillOff = (d: Pick<LoadoutEntryData, "offSkills"> | null | undefined, name: string): boolean => !!d && d.offSkills.includes(name);

/**
 * What a chat before its first message is built with: its own entry laid over its project's
 * disallowed skills (`projectOff`). A disallowed skill is off unless the chat switched it on; the
 * chat's own offs stay off. The answer's offSkills is the whole off list and it has no onSkills, so
 * isSkillOff reads it as is. Never for a chat whose first message is sent: its entry is then fixed.
 */
export function pristineLoadout(d: LoadoutEntryData | null, projectOff: readonly string[]): LoadoutEntryData | null {
  if (!projectOff.length) return d ? withoutOn(d) : null;
  const on = new Set(d?.onSkills ?? []);
  const offSkills = [...new Set([...(d?.offSkills ?? []), ...projectOff.filter((n) => !on.has(n))])];
  return { ...(d ? withoutOn(d) : { v: 1 as const, offContext: [] }), offSkills };
}
const withoutOn = ({ onSkills: _on, ...rest }: LoadoutEntryData): LoadoutEntryData => rest;

/**
 * The entry a setup card's whole off set is saved as (POST /api/sessions/loadout), before the first
 * message: only the chat's flips against its project's disallowed skills, so a later project
 * decision still reaches the chat until it starts. The card sends only names it lists (`listed`): a
 * disallowed name it doesn't list was never switched on by it, so it keeps the project's state.
 */
export function flipsAgainstProject(data: LoadoutEntryData, projectOff: readonly string[], listed: ReadonlySet<string>): LoadoutEntryData {
  const project = new Set(projectOff);
  const wanted = new Set(data.offSkills);
  const offSkills = data.offSkills.filter((n) => !project.has(n));
  const onSkills = projectOff.filter((n) => listed.has(n) && !wanted.has(n));
  return { ...withoutOn(data), offSkills, ...(onSkills.length ? { onSkills } : {}) };
}

/**
 * The entry written with a chat's first message (its skills fixed from then on): the off list it
 * was built with as its offSkills, and as onSkills the project's disallowed names it keeps on, so
 * the entry reads the same before the message (pristineLoadout) and after it (isSkillOff).
 */
export function loadoutStamp(built: LoadoutEntryData | null, projectOff: readonly string[]): LoadoutEntryData {
  const base = built ? withoutOn(built) : { v: 1 as const, offContext: [], offSkills: [] };
  const off = new Set(base.offSkills);
  const onSkills = projectOff.filter((n) => !off.has(n));
  return { ...base, ...(onSkills.length ? { onSkills } : {}) };
}

/** Whether an entry leaves anything out at all. */
export const leavesOut = (d: LoadoutEntryData | null | undefined): d is LoadoutEntryData =>
  !!d && (d.offContext.length > 0 || d.offSkills.length > 0 || !!d.offMcp?.length || !!d.onMcp?.length);

/**
 * What a runtime was built with: the entry, and the loader's UNFILTERED lists as the overrides last
 * saw them, so the card can still list (and switch back on) a row that is off. pi calls the skills
 * override again whenever an extension adds skill paths, each time with the whole set.
 */
export interface LoadoutState {
  /** The entry as this runtime applies it: before the first message, laid over the project's
      disallowed skills (pristineLoadout). */
  data: LoadoutEntryData | null;
  /** The project's disallowed skills this build read (before the first message only; else empty). */
  projectOff?: string[];
  baseContext?: string[];
  baseSkills?: { name: string; filePath: string; description?: string; manualOnly?: boolean }[];
}

/** The two loader overrides for an entry, recording each base list into `state`. Undefined when the
    entry leaves nothing out: the runtime is then built exactly as before this feature. */
export function loadoutOverrides(state: LoadoutState) {
  const d = state.data;
  if (!leavesOut(d)) return undefined;
  const offContext = new Set(d.offContext);
  return {
    agentsFilesOverride: (base: { agentsFiles: { path: string; content: string }[] }) => {
      state.baseContext = base.agentsFiles.map((f) => f.path);
      return { agentsFiles: base.agentsFiles.filter((f) => !offContext.has(f.path)) };
    },
    skillsOverride: (base: { skills: PiSkill[]; diagnostics: PiResourceDiagnostic[] }) => {
      state.baseSkills = base.skills.map((s) => ({ name: s.name, filePath: s.filePath, ...(s.description !== undefined ? { description: s.description } : {}), ...(s.disableModelInvocation ? { manualOnly: true } : {}) }));
      return { skills: base.skills.filter((s) => !isSkillOff(d, s.name)), diagnostics: base.diagnostics };
    },
  };
}

/** The skills override alone, for a worker given its parent's off list (WorkerSpec.offSkills). */
export function skillsOffOverride(offSkills: readonly string[]) {
  const d = { offSkills: [...offSkills] };
  return {
    skillsOverride: (base: { skills: PiSkill[]; diagnostics: PiResourceDiagnostic[] }) => ({ skills: base.skills.filter((s) => !isSkillOff(d, s.name)), diagnostics: base.diagnostics }),
  };
}

const sameNames = (a: readonly string[] = [], b: readonly string[] = []) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");
/** Whether two entries say the same thing (order aside). */
export const sameLoadout = (a: LoadoutEntryData, b: LoadoutEntryData): boolean =>
  sameNames(a.offContext, b.offContext) && sameNames(a.offSkills, b.offSkills) && sameNames(a.onSkills, b.onSkills) && sameNames(a.offMcp, b.offMcp) && sameNames(a.onMcp, b.onMcp);
