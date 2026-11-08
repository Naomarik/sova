import { codingModeWords, type CodingModeSwitch, type ProjectCodingMode } from "../shared/project-overseer";
import { MINOR_MODES, parseModePatch, readMode } from "./mode-state";
import { MINOR_SURFACES } from "../pi-config/extensions/mode/minor.ts";
import { defaultModeOf } from "../pi-config/extensions/mode/state.ts";
import { MEMORY_CODING_REFUSAL } from "../shared/memory";
import { createNotNamed, type CreateNamer } from "../shared/profiles";
import type { SubagentProfilesInfo } from "../shared/subagent-profiles";
import { requireSubagentProfile, subagentProfilesInfo } from "./subagent-profiles";
import { codingDefaultProfile, namedCodingProfile, type CodingTakes } from "./coding-default-profile";

/**
 * The mode a project's coding sessions run in (§app.project-overseer/coding-mode). A project has no
 * mode of its own:
 *
 * - Unnamed, a coding session starts in this computer's default mode (mode.json, read at start time,
 *   `hostDefaultMode`) with no subagent profile picked, and is pinned there.
 * - Both Overseers may name any mode but Create, any minor modes (spec among them) and any subagent profile, on a
 *   start or on a running session: there is no other ceiling. Only unknown names and Create are refused
 *   (`codingModeChoice`, `codingModeSwitch`; a profile is checked against this computer's library by the caller).
 * - A verb playbook's run gets align on beside its base (playbookRunMode), because the operator
 *   answers its questions; nobody else answers them, an Overseer never.
 */

/** The minor modes a coding session can have: every one but the web-only ones (memory, §chat.memory/where). */
const CODING_MINOR_MODES = MINOR_MODES.filter((m) => MINOR_SURFACES[m] !== "web");

/** The names a request carries, checked with the copy's own sentences. */
function checkNames(mode: unknown, minors: unknown, by: CreateNamer): { mode?: ProjectCodingMode["mode"]; minorModes?: string[] } | { error: string } {
  const out: { mode?: ProjectCodingMode["mode"]; minorModes?: string[] } = {};
  if (mode !== undefined) {
    if (mode === "create") return { error: createNotNamed(by) };
    if (mode !== "normal" && mode !== "delegate") return { error: `Unknown mode ${String(mode)}: use normal or delegate.` };
    out.mode = mode;
  }
  if (minors !== undefined) {
    if (!Array.isArray(minors)) return { error: 'minor_modes must be a list, e.g. ["spec"].' };
    if (minors.includes("memory")) return { error: `${MEMORY_CODING_REFUSAL}.` };
    const unknown = minors.find((m) => typeof m !== "string" || !(CODING_MINOR_MODES as readonly string[]).includes(m));
    if (unknown !== undefined) return { error: `Unknown minor mode ${String(unknown)}: use ${CODING_MINOR_MODES.slice(0, -1).join(", ")} or ${CODING_MINOR_MODES[CODING_MINOR_MODES.length - 1]}.` };
    const p = parseModePatch({ minorModes: minors });
    out.minorModes = "error" in p ? [] : (p.minorModes ?? []);
  }
  return out;
}

/** This computer's default mode now (mode.json, the default every new session starts from), less memory
    (coding sessions never get it, §chat.memory/where). */
export function hostDefaultMode(file?: string): ProjectCodingMode {
  const s = file ? readMode(file) : readMode();
  return { mode: defaultModeOf(s), minorModes: s.minorModes.filter((m) => m !== "memory") };
}

/** An Overseer's request (the tools' `mode` / `minor_modes` / `subagent_profile`), validated by name only. */
export interface ModeRequest {
  mode?: unknown;
  minor_modes?: unknown;
  subagent_profile?: unknown;
  /** A profile of this computer's (sova_list_profiles): its models, helpers and, on a start, its modes. */
  profile?: unknown;
  /** Who asks, for the words of a refusal; absent: a project overseer. */
  by?: CreateNamer;
}

const named = (v: unknown) => v !== undefined && v !== null && v !== "";

/** The profile a request names, or a sentence when it is not a string; the library check is the caller's. */
function profileOf(req: ModeRequest): { subagentProfile?: string; profile?: string } | { error: string } {
  if (named(req.profile)) {
    if (typeof req.profile !== "string" || !req.profile.trim()) return { error: "profile must be a profile id (or off)." };
    // A profile brings its own helpers: naming both would leave one of them unused.
    if (named(req.subagent_profile)) return { error: "Give profile or subagent_profile, not both: a profile brings its own helpers." };
    return { profile: req.profile.trim() };
  }
  if (!named(req.subagent_profile)) return {};
  if (typeof req.subagent_profile !== "string") return { error: "subagent_profile must be a profile id (or off)." };
  return { subagentProfile: req.subagent_profile.trim() };
}

/**
 * The switch a request asks of a running session: only what it names (the session keeps the rest),
 * or a refusal sentence. Null when it names nothing. Checked before anything is sent or any cap taken.
 */
export function codingModeSwitch(req: ModeRequest): { mode: CodingModeSwitch | null } | { error: string } {
  const p = checkNames(named(req.mode) ? req.mode : undefined, req.minor_modes !== undefined && req.minor_modes !== null ? req.minor_modes : undefined, req.by ?? "a project overseer");
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
      ...(asked.profile !== undefined ? { profile: asked.profile } : asked.subagentProfile !== undefined ? { subagentProfile: asked.subagentProfile } : base.subagentProfile !== undefined ? { subagentProfile: base.subagentProfile } : {}),
    },
  };
}

/**
 * A start's mode once its named profile is known (§app.project-overseer/coding-mode): what the call names stays
 * (`mode`, `minor_modes`), what it doesn't comes from the profile where it sets it, the rest from the base. Pure.
 */
export function withProfileModes(mode: ProjectCodingMode, takes: Pick<CodingTakes, "mode" | "minorModes">, req: Pick<ModeRequest, "mode" | "minor_modes">): ProjectCodingMode {
  const out = { ...mode };
  if (!named(req.mode) && takes.mode) out.mode = takes.mode;
  if ((req.minor_modes === undefined || req.minor_modes === null) && takes.minorModes) {
    const p = parseModePatch({ minorModes: takes.minorModes.filter((m) => (CODING_MINOR_MODES as readonly string[]).includes(m)) });
    out.minorModes = "error" in p ? [] : (p.minorModes ?? []);
  }
  return out;
}

/**
 * A checked mode with its named profile looked up (§app.project-overseer/coding-mode): on a start, the profile's modes
 * fill in what the call didn't name; on a switch only its Models part moves. Unknown or unusable: the refusal.
 */
export async function withNamedProfile<M extends Partial<ProjectCodingMode>>(mode: M, req: Pick<ModeRequest, "mode" | "minor_modes">, cwd: string | null, start: boolean): Promise<{ mode: M; name?: string } | { error: string }> {
  if (mode.profile === undefined) return { mode };
  const r = await namedCodingProfile(mode.profile, cwd, start);
  if ("error" in r) return r;
  const out = start ? (withProfileModes(mode as unknown as ProjectCodingMode, r.takes, req) as unknown as M) : { ...mode };
  return { mode: { ...out, profile: r.takes.id }, name: r.takes.name };
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

/** ", profile {name}" for a start's result: the profile it named, else this computer's default profile, with
    `subagent_profile`'s helpers when it named those instead. */
export function startProfileWords(mode: Pick<ProjectCodingMode, "profile" | "subagentProfile">, named: string | undefined, defaultName: string, helpers?: string | null): string {
  if (mode.profile !== undefined) return `, profile ${named ?? mode.profile}`;
  return `, profile ${defaultName}${mode.subagentProfile !== undefined ? ` with subagent profile ${helpers ?? mode.subagentProfile}` : ""}`;
}

/** This computer's default profile's name, as a coding session started now is on it ("Off" when it can't be read). */
export function defaultProfileName(): string {
  try {
    return codingDefaultProfile().name;
  } catch {
    return "Off";
  }
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

/**
 * What an Overseer's coding session is told when the operator has not yet agreed what to build
 * (§app.project-overseer/confirm-brief): a paragraph of its first prompt, after the brief, as the commit paragraph
 * is. Verbatim: `asksToConfirmBrief` finds it in a build's recorded prompt.
 */
export const CONFIRM_BRIEF_PARAGRAPH = `An Overseer wrote this brief; the operator has not yet said they want it built. Before any plan, investigation or edit, open one small alignment with the align tool and end your turn: one question only, topic "What to build", asking "Is this what you want built?", its context the brief restated in plain words (what will be built and what it won't touch), its recommendation "Yes, as restated". Then wait for the operator's answer. Their yes is the change request: align on the work as for any request. An answer that changes the brief is the decision: record it and build what it says.`;

/** Whether a coding session's first prompt asks it to confirm the brief first (the paragraph Sova adds, verbatim). */
export const asksToConfirmBrief = (prompt: unknown): boolean => typeof prompt === "string" && prompt.includes(CONFIRM_BRIEF_PARAGRAPH);

/**
 * The mode an Overseer's start runs in (§app.project-overseer/confirm-brief): with no `already_agreed`, align on
 * beside what it asked for (as a verb playbook's run, never twice), since the operator answers the
 * confirm question and the Overseer never decides for them; with it, the mode as given. Pure.
 */
export const overseerStartMode = (mode: ProjectCodingMode, alreadyAgreed: boolean): ProjectCodingMode =>
  alreadyAgreed ? mode : playbookRunMode(mode);

/**
 * An Overseer's start's mode and first prompt (§app.project-overseer/confirm-brief): with no `already_agreed`, align
 * turned on (overseerStartMode) and the brief then the confirm paragraph; otherwise the mode and brief as given. Pure.
 */
export function confirmBriefPrompt(prompt: string, mode: ProjectCodingMode, alreadyAgreed: boolean): { prompt: string; mode: ProjectCodingMode; confirm: boolean } {
  const runs = overseerStartMode(mode, alreadyAgreed);
  if (alreadyAgreed || !prompt.trim()) return { prompt, mode: runs, confirm: false };
  return { prompt: `${prompt}\n\n${CONFIRM_BRIEF_PARAGRAPH}`, mode: runs, confirm: true };
}

/** The start's result, which says whether the session asks first (§app.project-overseer/confirm-brief). */
export const confirmBriefWords = (confirm: boolean, alreadyAgreed: boolean): string =>
  confirm ? " It first asks the operator to confirm the brief." : alreadyAgreed ? " Started as already agreed." : "";

/** Both Overseers' `already_agreed` parameter (sova_create_session, sova_project_overseer code). */
export const ALREADY_AGREED_PARAM =
  "true only when the operator has already said, in their own words, that they want exactly this built. Omitted: align is turned on in its mode (whatever minor_modes says) and the session first asks the operator to confirm the brief. Never set it on your own judgement.";

/** `already_agreed` as an Overseer's call gives it: only `true` counts. */
export const alreadyAgreedOf = (v: unknown): boolean => v === true;

/** A verb playbook run's mode: its base, with align on beside it (normalized order, never twice). */
export function playbookRunMode(base: ProjectCodingMode): ProjectCodingMode {
  const rest = { ...(base.subagentProfile !== undefined ? { subagentProfile: base.subagentProfile } : {}), ...(base.profile !== undefined ? { profile: base.profile } : {}) };
  if (base.minorModes.includes("align")) return { mode: base.mode, minorModes: [...base.minorModes], ...rest };
  const p = parseModePatch({ minorModes: [...base.minorModes, "align"] });
  return { mode: base.mode, minorModes: "error" in p ? [...base.minorModes, "align"] : (p.minorModes ?? []), ...rest };
}

export const sameCodingMode = (a: ProjectCodingMode, b: ProjectCodingMode): boolean =>
  a.mode === b.mode && a.minorModes.length === b.minorModes.length && a.minorModes.every((m, i) => b.minorModes[i] === m) && a.subagentProfile === b.subagentProfile && a.profile === b.profile;

/** A mode as people read it: `normal · spec · visuals`. */
export const describeCodingMode = (m: { mode: string; minorModes: string[] }): string => codingModeWords(m);
