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
  /** Skills left out of the skills offered, by name. */
  offSkills: string[];
}

/** The largest off set the route accepts, per kind; far above any real loadout. */
export const LOADOUT_MAX = 500;

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 4096) ? [...new Set(v as string[])] : null;

/** The entry's data, strictly: anything else is not an entry (null). */
export function normalizeLoadout(v: unknown): LoadoutEntryData | null {
  if (!v || typeof v !== "object") return null;
  const d = v as { v?: unknown; offContext?: unknown; offSkills?: unknown };
  if (d.v !== 1) return null;
  const offContext = strings(d.offContext);
  const offSkills = strings(d.offSkills);
  if (!offContext || !offSkills) return null;
  if (offContext.length > LOADOUT_MAX || offSkills.length > LOADOUT_MAX) return null;
  if (!offContext.every((p) => p.startsWith("/"))) return null;
  return { v: 1, offContext, offSkills };
}

/** The newest well-formed `sova-loadout` entry on a branch (null: none, everything on). The entries are pi's
    or the reader's (any mix), read through the state view. */
export function loadoutOnBranch(branch: readonly unknown[]): LoadoutEntryData | null {
  return stateViewOf(branch).latest(LOADOUT)?.data ?? null;
}

/** Whether an entry leaves anything out at all. */
export const leavesOut = (d: LoadoutEntryData | null | undefined): d is LoadoutEntryData =>
  !!d && (d.offContext.length > 0 || d.offSkills.length > 0);

/**
 * What a runtime was built with: the entry, and the loader's UNFILTERED lists as the overrides last
 * saw them, so the card can still list (and switch back on) a row that is off. pi calls the skills
 * override again whenever an extension adds skill paths, each time with the whole set.
 */
export interface LoadoutState {
  data: LoadoutEntryData | null;
  baseContext?: string[];
  baseSkills?: { name: string; filePath: string; description?: string }[];
}

/** The two loader overrides for an entry, recording each base list into `state`. Undefined when the
    entry leaves nothing out: the runtime is then built exactly as before this feature. */
export function loadoutOverrides(state: LoadoutState) {
  const d = state.data;
  if (!leavesOut(d)) return undefined;
  const offContext = new Set(d.offContext);
  const offSkills = new Set(d.offSkills);
  return {
    agentsFilesOverride: (base: { agentsFiles: { path: string; content: string }[] }) => {
      state.baseContext = base.agentsFiles.map((f) => f.path);
      return { agentsFiles: base.agentsFiles.filter((f) => !offContext.has(f.path)) };
    },
    skillsOverride: (base: { skills: PiSkill[]; diagnostics: PiResourceDiagnostic[] }) => {
      state.baseSkills = base.skills.map((s) => ({ name: s.name, filePath: s.filePath, ...(s.description !== undefined ? { description: s.description } : {}) }));
      return { skills: base.skills.filter((s) => !offSkills.has(s.name)), diagnostics: base.diagnostics };
    },
  };
}
