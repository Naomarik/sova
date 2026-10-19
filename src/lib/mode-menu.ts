// The mode menu's footer: the sentence saying what a switch here does,
// and whether this chat's mode is already the one new sessions start from. Pure, so each string can
// be tested against the state it must NOT be said in — a button that offers to save what is already
// saved is the case this exists to rule out.

import type { ModeInfo, ProjectMinorInfo, ProjectMinorTool } from "../../shared/protocol";
import type { SubagentProfilesInfo } from "../../shared/subagent-profiles";

/** A mode as the footer reads it: this chat's, or the default's. The same three fields
    `/mode default` writes, so "already the default" compares exactly what a save would change. */
export interface ShownMode {
  mode: string;
  minorModes: string[];
  strict: boolean;
  /** This chat's project minor modes. Never part of the default: no save writes them, so nothing
      here compares or names them. */
  projectModes?: string[];
}

/** The footer's sentence, after the `strict:` chip: a switch is this chat's own — nothing else
    follows it — and new sessions start from the default, which the button below it sets. */
export const FOOT_NOTE = "A switch here is this chat's own. New sessions start from the default.";

/** The button, in each of its three states: it can be pressed, it was already done, or it is
    working. */
export const SAVE_LABEL = "Save as default";
export const SAVED_LABEL = "Already the default";
export const SAVING_LABEL = "Saving…";

/** "delegate · strict · align" — a mode the way the extension's own "Default mode saved" toast
    writes it (activeSummary in pi-config/extensions/mode/index.ts): strict is named only when on. */
export function modeSummary(m: ShownMode): string {
  return [m.mode, ...(m.strict ? ["strict"] : []), ...m.minorModes].join(" · ");
}

/**
 * Whether this chat's mode already IS the default: the same major, the same strict flag, and the
 * same minors in the same order — the three fields a save writes, so a chat with strict on is not
 * "already the default" against a file with strict off. Minors are compared in order: both sides
 * come through the extension's own normalizeState (state.ts), so the order is canonical and two
 * equal sets written in a different order are not the same mode to anyone else either.
 * Unknown on either side (the file not read yet, this chat's mode not arrived yet) is NOT "already
 * the default": the button stays pressable, and the press is what would find out.
 */
export function isDefaultMode(def: Pick<ModeInfo, "mode" | "minorModes" | "strict"> | null, current: ShownMode | null): boolean {
  if (!def || !current) return false;
  return (
    def.mode === current.mode &&
    def.strict === current.strict &&
    def.minorModes.length === current.minorModes.length &&
    def.minorModes.every((m, i) => m === current.minorModes[i])
  );
}

/** The button's label for its state. */
export function saveLabel(state: "idle" | "saving" | "done"): string {
  return state === "saving" ? SAVING_LABEL : state === "done" ? SAVED_LABEL : SAVE_LABEL;
}

/** The button's `title`: what the press will make (or has made) true, with the mode it names. A
    description, never the accessible name — the visible label is the name (WCAG 2.5.3), so a
    voice-control user can say what they see. */
export function saveTitle(shown: ShownMode | null, already: boolean): string {
  if (!shown) return already ? "New sessions already start from the default mode." : "Make this chat's mode the default for new sessions.";
  return already ? `New sessions already start from ${modeSummary(shown)}.` : `New sessions will start from ${modeSummary(shown)}.`;
}

// ── The subagent profile in the menu ────────────────────────────────────────

/** The save makes the default the mode AND the profile together, so "already" covers both:
    this chat's pick against this device's `default` (its own file, never synced). */
export function isDefaultAll(
  def: Pick<ModeInfo, "mode" | "minorModes" | "strict"> | null,
  current: ShownMode | null,
  profiles: Pick<SubagentProfilesInfo, "current" | "default"> | null,
): boolean {
  if (!profiles) return false; // not read yet: unknown is never "already the default"
  return isDefaultMode(def, current) && profiles.current.id !== null && profiles.current.id === profiles.default;
}

/** The announce after the save: both halves named, so it never claims less than it wrote. */
export function savedAnnounce(mode: ShownMode | null, profileName: string | null): string {
  const modeText = mode ? modeSummary(mode) : null;
  const saved = [modeText, profileName ? `Subagents: ${profileName}` : null].filter(Boolean).join(" · ");
  return saved ? `Default saved: ${saved}. New sessions start here.` : "Default saved. New sessions start here.";
}

/** The picker's search: a case-insensitive name match, in list order (the server puts Off first). */
export function filterProfiles<T extends { name: string }>(profiles: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? profiles.filter((p) => p.name.toLowerCase().includes(q)) : [...profiles];
}

/** The line under an empty search result. A live fact, then the absence — and the way out. */
export function noProfileMatch(query: string): string {
  return `No subagent profile matches \u201c${query.trim()}\u201d.`;
}

/** An id and placeholder name for a new profile, skipping ones already taken. */
export function nextSetup(profiles: readonly { id: string; name: string }[]): { id: string; name: string } {
  let n = 1;
  while (profiles.some((p) => p.id === `setup-${n}` || p.name.toLowerCase() === `setup ${n}`)) n++;
  return { id: `setup-${n}`, name: `Setup ${n}` };
}

// ── The project's own minor modes in the menu ───────────────────────────────

/** The group label: "This project · sova". */
export function projectGroupLabel(name: string | undefined): string {
  return name ? `This project · ${name}` : "This project";
}

/** What a project mode's row says and allows, besides its description. */
export interface ProjectRowState {
  /** broken: can't be turned on · removed: on, its folder gone · changed: on, its files edited since ·
      approval: off, turning it on asks first · tools-changed: on, its tools changed since approval · ok. */
  kind: "broken" | "removed" | "changed" | "approval" | "tools-changed" | "hooks" | "ok";
  /** The second line under the description, or null. A word first, so the state never rests on tint. */
  note: string | null;
  /** Whether a press does anything: turning a broken mode on doesn't, turning any mode off always does. */
  canToggle: boolean;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A row's state, from the server's facts about it and whether it is on in this chat. */
export function projectRowState(
  m: Pick<ProjectMinorInfo, "problem" | "removed" | "changed" | "needsApproval" | "tools"> & Partial<Pick<ProjectMinorInfo, "commands" | "hooks" | "hooksNeedApproval" | "hookNote">>,
  on: boolean,
): ProjectRowState {
  if (on) {
    // On: every state still lets the user turn it off, which is how a change or a removal is taken.
    if (m.removed) return { kind: "removed", note: "Removed from the project. This chat keeps it until you turn it off.", canToggle: true };
    if (m.needsApproval) return { kind: "tools-changed", note: "Its tools changed since you approved them, so they won't run. Turn it off and on to approve them again.", canToggle: true };
    if (m.changed) return { kind: "changed", note: "Changed since you turned it on. Turn it off and on to load the changes.", canToggle: true };
    if (m.problem) return { kind: "changed", note: `Its files have a problem now: ${m.problem}. This chat keeps the version it turned on.`, canToggle: true };
    // The Overseer turned it on: its tools and commands run, its hooks wait for you (§chat.mode-menu/project-mode-hooks).
    if (m.hooksNeedApproval) return { kind: "hooks", note: HOOKS_NEED_NOTE, canToggle: true };
    if (m.hookNote) return { kind: "ok", note: m.hookNote, canToggle: true };
    return { kind: "ok", note: null, canToggle: true };
  }
  if (m.problem) return { kind: "broken", note: `Can't turn on: ${m.problem}`, canToggle: false };
  if (m.removed) return { kind: "broken", note: "Removed from the project.", canToggle: false };
  if (m.needsApproval) return { kind: "approval", note: `Asks before turning on: it runs ${runsCount(m)}.`, canToggle: true };
  return { kind: "ok", note: null, canToggle: true };
}

/** The whole ON set after a press on one row: the server takes the set, like minorModes. */
export function nextProjectModes(on: readonly string[], id: string): string[] {
  return on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
}

/** A tool's argv as one line, quoting an argument a shell would split. */
export function commandLine(argv: readonly string[]): string {
  return argv.map((a) => (a === "" || /[\s"'\\$`]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");
}

/** What a mode runs, counted: "2 tools", or with commands and hooks "1 tool, 1 command and 1 hook". */
export function runsCount(m: Pick<ProjectMinorInfo, "tools"> & Partial<Pick<ProjectMinorInfo, "commands" | "hooks">>): string {
  const parts = [
    ...(m.tools.length || (!m.commands?.length && !m.hooks?.length) ? [count(m.tools.length, "tool")] : []),
    ...(m.commands?.length ? [count(m.commands.length, "command")] : []),
    ...(m.hooks?.length ? [count(m.hooks.length, "hook")] : []),
  ];
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** When a hook runs, as its row in the approval says it. */
export function hookWhen(on: string): string {
  return on === "turn.started" ? "When a reply starts" : "After each reply";
}

/** The approval's sentence above the lists: a mode with only tools reads as it always did. */
export function approvalLeadFor(id: string, project: string | undefined, m: Pick<ProjectMinorInfo, "tools"> & Partial<Pick<ProjectMinorInfo, "commands" | "hooks">>): string {
  if (!m.commands?.length && !m.hooks?.length) return approvalLead(id, project, m.tools);
  const lets = [
    ...(m.tools.length ? [`the model run ${m.tools.length === 1 ? "1 tool" : `${m.tools.length} tools`}`] : []),
    ...(m.commands?.length ? [`you and scripts run ${count(m.commands.length, "command")}`] : []),
    ...(m.hooks?.length ? [`${count(m.hooks.length, "hook")} run after things happen in this chat`] : []),
  ];
  const list = lets.length === 1 ? lets[0]! : `${lets.slice(0, -1).join(", ")}${lets.length > 2 ? "," : ""} and ${lets[lets.length - 1]}`;
  return `${id} comes from ${project ?? "this project"}'s files. Turning it on lets ${list}, in this chat's folder.`;
}

/** The foot line: a mode with commands or hooks says approval covers all it runs. */
export function approvalFootFor(m: Partial<Pick<ProjectMinorInfo, "commands" | "hooks">>): string {
  return m.commands?.length || m.hooks?.length ? "Approval covers what it runs and every file in this folder. We ask again when any of them changes." : APPROVAL_FOOT;
}

/** The row's note while the Overseer's approval leaves its hooks waiting. */
export const HOOKS_NEED_NOTE = "Hooks need your approval. Its tools and commands run; its hooks wait for you.";
/** The hooks panel's sentence: what you approve, and why it's asked of you. */
export function hooksLead(id: string): string {
  return `${id}'s hooks run these programs after things happen in this chat, without asking. The Overseer turned it on, and only you can approve its hooks.`;
}
export const APPROVE_HOOKS_LABEL = "Approve Hooks";

/** The approval's sentence above the tool list. */
export function approvalLead(id: string, project: string | undefined, tools: readonly ProjectMinorTool[]): string {
  return `${id} comes from ${project ?? "this project"}'s files. Turning it on lets the model run ${tools.length === 1 ? "this tool" : `these ${tools.length} tools`} in this chat's folder.`;
}
/** What an approval covers: the tools and the whole folder, so any edit there asks again. */
export const APPROVAL_FOOT = "Approval covers its tools and every file in this folder. We ask again when any of them changes.";

/** The programs its tools start by bare name (node, python3, sh): this machine's own, outside the approval. */
export function barePrograms(tools: readonly Pick<ProjectMinorTool, "command">[]): string[] {
  return [...new Set(tools.map((t) => t.command[0] ?? "").filter((c) => c !== "" && !c.includes("/")))];
}

/** The sentence naming those programs, or null when every tool runs a file from the folder. */
export function bareProgramsNote(tools: readonly Pick<ProjectMinorTool, "command">[]): string | null {
  const names = barePrograms(tools);
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")}${names.length > 2 ? "," : ""} and ${names[names.length - 1]}`;
  return names.length === 1
    ? `${list} is this machine's own program, so the approval doesn't cover it.`
    : `${list} are this machine's own programs, so the approval doesn't cover them.`;
}
export const APPROVE_LABEL = "Approve and Turn On";
