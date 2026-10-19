import { codingModeWords, type CodingModeSwitch, type ProjectCodingMode } from "../shared/project-overseer";
import { MINOR_MODES, parseModePatch, readMode } from "./mode-state";
import { MINOR_SURFACES } from "../pi-config/extensions/mode/minor.ts";
import { MEMORY_CODING_REFUSAL } from "../shared/memory";
import type { SubagentProfilesInfo } from "../shared/subagent-profiles";
import { requireSubagentProfile, subagentProfilesInfo } from "./subagent-profiles";

/**
 * The mode a project's coding sessions run in (§app.project-overseer/coding-mode). A project has no
 * mode of its own:
 *
 * - Unnamed, a coding session starts in this computer's default mode (mode.json, read at start time,
 *   `hostDefaultMode`) with no subagent profile picked, and is pinned there.
 * - Spec is always on (§app.project-overseer/coding-mode): every start adds it to the default's minor
 *   modes, and a set of minor modes that leaves it out is refused, from an Overseer or the mode menu.
 * - Both Overseers may name any mode, any minor modes (spec among them) and any subagent profile, on a
 *   start or on a running session: there is no other ceiling. Only unknown names are refused
 *   (`codingModeChoice`, `codingModeSwitch`; a profile is checked against this computer's library by the caller).
 * - A verb playbook's run gets align on beside its base (playbookRunMode), because the operator
 *   answers its questions; nobody else answers them, an Overseer never.
 */

/** The minor modes a coding session can have: every one but the web-only ones (memory, §chat.memory/where). */
const CODING_MINOR_MODES = MINOR_MODES.filter((m) => MINOR_SURFACES[m] !== "web");

/** An Overseer's minor modes that leave spec out of a coding session. */
export const SPEC_ALWAYS_ON = "Spec is always on for coding sessions; it can't be turned off. Name spec among minor_modes.";
/** The mode menu's switch of a project coding session that leaves spec out (409). */
export const SPEC_ALWAYS_ON_MENU = "Spec is always on for coding sessions; it can't be turned off.";

/** A minor-mode set with spec in it (normalized order, never twice). */
export function withSpec(minorModes: readonly string[]): string[] {
  if (minorModes.includes("spec")) return [...minorModes];
  const p = parseModePatch({ minorModes: [...minorModes, "spec"] });
  return "error" in p ? [...minorModes, "spec"] : (p.minorModes ?? [...minorModes, "spec"]);
}

/** Why the mode menu's switch of a project coding session is refused (it leaves spec out), or null.
    A switch that names no minor modes keeps the session's own, spec among them. */
export function codingSpecRefusal(minorModes: readonly string[] | undefined): string | null {
  return minorModes !== undefined && !minorModes.includes("spec") ? SPEC_ALWAYS_ON_MENU : null;
}

/** The names a request carries, checked with the copy's own sentences. */
function checkNames(mode: unknown, minors: unknown): { mode?: ProjectCodingMode["mode"]; minorModes?: string[] } | { error: string } {
  const out: { mode?: ProjectCodingMode["mode"]; minorModes?: string[] } = {};
  if (mode !== undefined) {
    if (mode !== "normal" && mode !== "delegate") return { error: `Unknown mode ${String(mode)}: use normal or delegate.` };
    out.mode = mode;
  }
  if (minors !== undefined) {
    if (!Array.isArray(minors)) return { error: 'minor_modes must be a list, e.g. ["spec"].' };
    if (minors.includes("memory")) return { error: `${MEMORY_CODING_REFUSAL}.` };
    const unknown = minors.find((m) => typeof m !== "string" || !(CODING_MINOR_MODES as readonly string[]).includes(m));
    if (unknown !== undefined) return { error: `Unknown minor mode ${String(unknown)}: use ${CODING_MINOR_MODES.slice(0, -1).join(", ")} or ${CODING_MINOR_MODES[CODING_MINOR_MODES.length - 1]}.` };
    if (!minors.includes("spec")) return { error: SPEC_ALWAYS_ON };
    const p = parseModePatch({ minorModes: minors });
    out.minorModes = "error" in p ? [] : (p.minorModes ?? []);
  }
  return out;
}

/** This computer's default mode now (mode.json, the default every new session starts from), less memory
    (coding sessions never get it, §chat.memory/where), with spec always on. */
export function hostDefaultMode(file?: string): ProjectCodingMode {
  const s = file ? readMode(file) : readMode();
  return { mode: s.mode, minorModes: withSpec(s.minorModes.filter((m) => m !== "memory")) };
}

/** An Overseer's request (the tools' `mode` / `minor_modes` / `subagent_profile`), validated by name only. */
export interface ModeRequest {
  mode?: unknown;
  minor_modes?: unknown;
  subagent_profile?: unknown;
}

const named = (v: unknown) => v !== undefined && v !== null && v !== "";

/** The profile a request names, or a sentence when it is not a string; the library check is the caller's. */
function profileOf(req: ModeRequest): { subagentProfile?: string } | { error: string } {
  if (!named(req.subagent_profile)) return {};
  if (typeof req.subagent_profile !== "string") return { error: "subagent_profile must be a profile id (or off)." };
  return { subagentProfile: req.subagent_profile.trim() };
}

/**
 * The switch a request asks of a running session: only what it names (the session keeps the rest),
 * or a refusal sentence. Null when it names nothing. Checked before anything is sent or any cap taken.
 */
export function codingModeSwitch(req: ModeRequest): { mode: CodingModeSwitch | null } | { error: string } {
  const p = checkNames(named(req.mode) ? req.mode : undefined, req.minor_modes !== undefined && req.minor_modes !== null ? req.minor_modes : undefined);
  if ("error" in p) return p;
  const prof = profileOf(req);
  if ("error" in prof) return prof;
  const out: CodingModeSwitch = { ...p, ...prof };
  return { mode: Object.keys(out).length ? out : null };
}

/**
 * The mode a session started for `req` gets over `base` (this computer's default): what the request
 * names replaces that part (`minor_modes` is the whole set on), the rest is the base's; or a refusal
 * sentence. Checked before anything is created or any cap is taken.
 */
export function codingModeChoice(req: ModeRequest, base: ProjectCodingMode): { mode: ProjectCodingMode } | { error: string } {
  const s = codingModeSwitch(req);
  if ("error" in s) return s;
  const asked = s.mode ?? {};
  return {
    mode: {
      mode: asked.mode ?? base.mode,
      minorModes: asked.minorModes ?? [...base.minorModes],
      ...(asked.subagentProfile !== undefined ? { subagentProfile: asked.subagentProfile } : base.subagentProfile !== undefined ? { subagentProfile: base.subagentProfile } : {}),
    },
  };
}

/** Why an Overseer may not name this subagent profile (unknown here), or null. */
export function profileRefusal(id: string | undefined): string | null {
  if (id === undefined) return null;
  try {
    requireSubagentProfile(id);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.startsWith("Unknown subagent profile") ? `${msg}. sova_list_subagent_profiles lists them.` : msg;
  }
}

/** A subagent profile's name: the one named (an id or off), else this computer's default; null when unknown. Pure. */
export function profileName(info: Pick<SubagentProfilesInfo, "profiles" | "current">, id?: string): string | null {
  if (id === undefined) return info.current.id ? info.current.name : null;
  return info.profiles.find((p) => p.id === id)?.name ?? id;
}

/** ", subagent profile {name}" for a start's result ("" when no profile can be named). */
export function profileWords(id?: string): string {
  let name: string | null = null;
  try {
    name = profileName(subagentProfilesInfo(), id);
  } catch {
    name = id ?? null;
  }
  return name ? `, subagent profile ${name}` : "";
}

/** The request checked whole for a start over this computer's default: names, then the profile against this
    computer's library. What sova_create_session and the Overseer's `code` both refuse with. */
export function checkedCodingModeChoice(req: ModeRequest, base: ProjectCodingMode = hostDefaultMode()): { mode: ProjectCodingMode } | { error: string } {
  const c = codingModeChoice(req, base);
  if ("error" in c) return c;
  const bad = profileRefusal(c.mode.subagentProfile);
  return bad ? { error: bad } : c;
}

/** An Overseer's switch that would turn align off on a session waiting on the operator's alignment answers. */
export const ALIGN_STAYS = "It waits on the operator's alignment answers; align stays on until they answer.";

/**
 * Whether an Overseer's mode switch must be refused (§app.project-overseer/coding-mode): the session waits on the
 * operator's alignment answers (its summary's `align`, set only while it waits) and the minor modes it asks for — the
 * whole set — leave align out. Turning align off would drop the questions from Needs you without an answer. A switch
 * that names no minor modes keeps the session's own, so it keeps align. Pure.
 */
export function alignDropRefusal(waiting: boolean, minorModes: unknown): string | null {
  if (!waiting || !Array.isArray(minorModes)) return null;
  return minorModes.includes("align") ? null : ALIGN_STAYS;
}

/** The session kinds a verb playbook runs in (§app.project-runtime/verb-playbooks): the operator answers their
    questions, so they start with align on, and an Overseer never messages one that waits on them. */
export const PLAYBOOK_RUN_KINDS: readonly string[] = ["onboard", "deploy-setup"];

/** A verb playbook run's mode: its base, with align on beside it (normalized order, never twice). */
export function playbookRunMode(base: ProjectCodingMode): ProjectCodingMode {
  const rest = base.subagentProfile !== undefined ? { subagentProfile: base.subagentProfile } : {};
  if (base.minorModes.includes("align")) return { mode: base.mode, minorModes: [...base.minorModes], ...rest };
  const p = parseModePatch({ minorModes: [...base.minorModes, "align"] });
  return { mode: base.mode, minorModes: "error" in p ? [...base.minorModes, "align"] : (p.minorModes ?? []), ...rest };
}

export const sameCodingMode = (a: ProjectCodingMode, b: ProjectCodingMode): boolean =>
  a.mode === b.mode && a.minorModes.length === b.minorModes.length && a.minorModes.every((m, i) => b.minorModes[i] === m) && a.subagentProfile === b.subagentProfile;

/** A mode as people read it: `normal · spec · visuals`. */
export const describeCodingMode = (m: Pick<ProjectCodingMode, "mode" | "minorModes">): string => codingModeWords(m);
