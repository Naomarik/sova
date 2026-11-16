/**
 * The playbook card's words and pure rules: what each row says, the folded line, the state chip.
 * The card draws a run's view as the server computed it (models resolved, team rows, the reason
 * Start is off) and never resolves anything itself. DOM- and Solid-free, so it tests in-process.
 */
import {
  PLAYBOOK_CHOICE_ORIGIN_WORDS,
  type PlaybookCardEdits,
  type PlaybookChoiceOrigin,
  type PlaybookChoiceView,
  type PlaybookCycleView,
  type PlaybookModelPick,
  type PlaybookRoleView,
  type PlaybookRunView,
  type PlaybookStepView,
  type PlaybookTeamView,
} from "../../shared/playbook-run";
import type { ModelPick } from "../../shared/powers";
import type { PlaybookInfo, SlashCommand } from "../../shared/protocol";
import type { ThinkingLevel } from "../../shared/profiles";
import { providerName } from "./cost-history";
import { modelLabel } from "./format";

/** Where a choice's value came from, as the card's right-hand column says it (al_2 a6). */
export const ORIGIN_LABEL: Record<PlaybookChoiceOrigin, string> = PLAYBOOK_CHOICE_ORIGIN_WORDS;

const SOURCE_WORD: Record<PlaybookRunView["playbook"]["source"], string> = {
  sova: "Sova",
  user: "Yours",
  project: "This project",
};

/** The eyebrow over the title: "Playbook · Sova", with "changed since your last run" when it was. */
export function cardEyebrow(view: PlaybookRunView): string {
  return ["Playbook", SOURCE_WORD[view.playbook.source], view.changedSinceLast ? "changed since your last run" : null].filter(Boolean).join(" · ");
}

export type ChipTone = "success" | "warn" | "accent" | undefined;

/** The card's state, dot and word: ready, what blocks Start, or the run it became. */
export function cardChip(view: PlaybookRunView): { label: string; tone: ChipTone; live?: boolean } {
  if (view.state === "started") return { label: "Started", tone: "accent" };
  if (view.startBlocked) return { label: "Can't start yet", tone: "warn" };
  return { label: "Ready to start", tone: "success" };
}

/** A model pick as the card says it: "GLM 5.3 · zai · low" (name, provider, effort). */
export function pickLine(p: PlaybookModelPick | null | undefined, provider = true): string {
  if (!p) return "No model";
  const slash = p.model.indexOf("/");
  const prov = provider && slash > 0 ? providerName(p.model.slice(0, slash)) : null;
  return [modelLabel(p.model) ?? p.model, prov, p.effort].filter(Boolean).join(" · ");
}

/** The role's resolved model line, or why it has none. */
export function roleModelLine(role: PlaybookRoleView): string {
  const r = role.resolved;
  if (r) return [r.modelLabel || modelLabel(r.model) || r.model, providerName(r.provider), r.effort].filter(Boolean).join(" · ");
  return role.only ? "None of its models can run" : "No model";
}

/** Why this model, for the right-hand column: the resolver's reason when it isn't the first pick. */
export function roleWhy(role: PlaybookRoleView): string {
  const r = role.resolved;
  const only = role.only ? "Only these models" : null;
  if (!r) return only ?? "";
  const why = r.reason ?? (r.source === "card" ? "Your pick for this run" : r.source === "list" ? "First choice" : r.source === "profile" ? "Your profile" : "This chat's model");
  return [why, only].filter(Boolean).join(" · ");
}

/** "Runner × 3" with its "per" words when it has them: "Runner × 3, one per test model". */
export function roleTitle(role: PlaybookRoleView): string {
  return role.count > 1 ? `${role.label} × ${role.count}` : role.label;
}

/** The rest of a role's list after its resolved pick, for the hover title ("Then: Fable 5.2 · high"). */
export function chainRest(role: PlaybookRoleView): string | null {
  const r = role.resolved;
  const rest = role.chain.filter((p) => !r || p.model !== r.model);
  return rest.length ? `Then: ${rest.map((p) => pickLine(p, false)).join(", ")}` : null;
}

/** A step says plainly who runs it (al_2 f19): the main chat, a team with its coordinator and
    monitor, or separate helpers by name. */
export function stepRunsLine(step: PlaybookStepView, roles: readonly PlaybookRoleView[], teams: readonly PlaybookTeamView[]): string {
  if (step.runs === "team") {
    const team = teams.find((t) => t.id === step.team);
    return `A team${team ? `, ${team.label},` : ""} with its coordinator and monitor`;
  }
  if (step.runs === "helpers") {
    const names = step.roles.map((id) => roles.find((r) => r.id === id)).filter((r): r is PlaybookRoleView => !!r && !r.main && r.on);
    return names.length ? `Separate helpers: ${names.map(roleTitle).join(", ")}` : "Separate helpers";
  }
  return "The main chat";
}

/** How many times the run stops for you, as the steps stand now. */
export function stopCount(steps: readonly PlaybookStepView[]): number {
  return steps.filter((s) => s.stop === "always" || (s.stop === "optional" && s.stopOn)).length;
}

/** "Steps · 5 · stops for you 3 times". */
export function stepsSummary(steps: readonly PlaybookStepView[]): string {
  const n = stopCount(steps);
  return `Steps · ${steps.length} · ${n === 0 ? "never stops for you" : n === 1 ? "stops for you once" : `stops for you ${n} times`}`;
}

/** "Up to 5 cycles; asks you after every 2 cycles." */
export function cycleLine(c: PlaybookCycleView): string {
  const every = c.askEvery <= 1 ? "after each cycle" : `after every ${c.askEvery} cycles`;
  return `Up to ${c.max} ${c.max === 1 ? "cycle" : "cycles"}; asks you ${every}.`;
}

/** "Step 3 repeats" or "Steps 3, 4 and 5 repeat": the cycle's steps by their numbers on the card. */
export function cycleStepsLine(numbers: readonly number[]): string {
  if (numbers.length === 1) return `Step ${numbers[0]} repeats`;
  const list = numbers.length === 2 ? numbers.join(" and ") : `${numbers.slice(0, -1).join(", ")}, and ${numbers[numbers.length - 1]}`;
  return `Steps ${list} repeat`;
}

/** "9 helpers at once, of 24." The coordinator and monitor of each team count. */
export function helpersLine(h: PlaybookRunView["helpers"]): string {
  return `${h.total} ${h.total === 1 ? "helper" : "helpers"} at once, of ${h.limit}.`;
}

/** "14:06" today, else "Mar 4, 14:06": a 24-hour clock, as logs and records read. */
export function shortClock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** The folded card's one line after its title: where it is, or what it needs. */
export function foldedLine(view: PlaybookRunView, here?: string, clock: (iso: string) => string = shortClock): string {
  const st = view.started;
  if (view.state === "started" && st) {
    const where = st.chat.path === here ? "in this chat" : st.chat.title ? `in ${st.chat.title}` : "in another chat";
    return `Revision ${st.revision}, started ${clock(st.at)} ${where}`;
  }
  if (view.state === "starting") return "Starting…";
  return view.startBlocked ?? `${view.roles.filter((r) => r.on).length} roles · ${stepsSummary(view.steps).replace(/^Steps · /, "").replace(/^(\d+)/, "$1 steps")}`;
}

/** Choices asked every run or once show on the card; optional ones go under More Options. */
export function splitChoices(choices: readonly PlaybookChoiceView[]): { shown: PlaybookChoiceView[]; more: PlaybookChoiceView[] } {
  const shown: PlaybookChoiceView[] = [];
  const more: PlaybookChoiceView[] = [];
  for (const c of choices) (c.ask === "optional" && !(c.required && isEmpty(c.value)) ? more : shown).push(c);
  return { shown, more };
}

/** A required choice with nothing in it. */
export function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** A playbook model pick as the model picker holds it (effort is pi's thinking level). */
export function toPick(p: PlaybookModelPick | null | undefined): ModelPick | null {
  return p ? { model: p.model, ...(p.effort ? { thinking: p.effort as ThinkingLevel } : {}) } : null;
}
export function fromPick(p: ModelPick): PlaybookModelPick {
  return { model: p.model, ...(p.thinking ? { effort: p.thinking } : {}) };
}

/** Two batches of card edits not yet saved, as one: the later wins key by key, a role's fields one by
    one. Unlike the store's merge, a cleared pick stays as null: it is an edit still to send. */
export function stackEdits(a: PlaybookCardEdits, b: PlaybookCardEdits): PlaybookCardEdits {
  const out: PlaybookCardEdits = { ...a };
  if (b.choices) out.choices = { ...a.choices, ...b.choices };
  if (b.stops) out.stops = { ...a.stops, ...b.stops };
  if (b.cycle) out.cycle = { ...a.cycle, ...b.cycle };
  if (b.roles) {
    const roles = { ...a.roles };
    for (const [id, r] of Object.entries(b.roles)) roles[id] = { ...roles[id], ...r };
    out.roles = roles;
  }
  return out;
}

/** Whether a batch holds anything to send. */
export function hasEdits(e: PlaybookCardEdits): boolean {
  return !!(
    (e.choices && Object.keys(e.choices).length) ||
    (e.stops && Object.keys(e.stops).length) ||
    (e.cycle && Object.keys(e.cycle).length) ||
    (e.roles && Object.keys(e.roles).length)
  );
}

/** A list or models value as an array; anything else as none. */
export function listValue<T = string>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * The typed command a message is, when it names a playbook that has a card: "/ab-cycle" or
 * "/ab-cycle mode text, three cycles" → its name and the words after it. Only a whole message that
 * starts with the command counts; "/ab-cycle" mid-sentence is plain text.
 */
export function playbookCommandIn(text: string, names: ReadonlySet<string>): { name: string; words: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m || !names.has(m[1]!)) return null;
  return { name: m[1]!, words: (m[2] ?? "").trim() };
}

/** The playbook a "/" row opens the card of, when it is one (the server's row for a listed playbook
    with a description). */
export function commandPlaybook(c: SlashCommand): Pick<PlaybookRunView["playbook"], "source" | "id"> | null {
  return c.playbook ?? null;
}

/** The message as a playbook's command, with the playbook it opens: the first row of that name wins,
    so a chat's own command of the same name (listed before) keeps it. */
export function typedPlaybook(text: string, commands: readonly SlashCommand[]): { playbook: Pick<PlaybookRunView["playbook"], "source" | "id">; words: string } | null {
  const name = /^\/(\S+)/.exec(text.trim())?.[1];
  const row = name ? commands.find((c) => c.name === name) : undefined;
  const playbook = row ? commandPlaybook(row) : null;
  if (!playbook) return null;
  const hit = playbookCommandIn(text, new Set([name!]));
  return hit ? { playbook, words: hit.words } : null;
}

/** A listed playbook with a description that parses: picking it opens its card. */
export function playbookHasCard(p: PlaybookInfo): boolean {
  return !!p.spec;
}
/** Why its description can't make a card: the exact file and fault. */
export function playbookCardError(p: PlaybookInfo): string | null {
  return p.specError ?? null;
}

/** Which shelf wins when two share an id: the project's, then yours, then Sova's (as the server's rows). */
const SHELF_RANK = { project: 0, user: 1, sova: 2 } as const;

/**
 * The "/" rows of the playbooks with a description, as the page builds them from the Playbooks list:
 * a new chat has no runtime yet, so no commands of its own, and a playbook is what you'd start there.
 * A description that can't be read keeps its row: opening it says what is wrong.
 */
export function playbookRows(playbooks: readonly PlaybookInfo[]): SlashCommand[] {
  const best = new Map<string, { row: SlashCommand; rank: number }>();
  for (const p of playbooks) {
    if (!p.spec && !p.specError) continue;
    const rank = SHELF_RANK[p.source];
    const have = best.get(p.id);
    if (have && have.rank <= rank) continue;
    best.set(p.id, { row: { name: p.id, description: p.description || p.title, source: "builtin", playbook: { source: p.source, id: p.id } }, rank });
  }
  return [...best.values()].map((b) => b.row).sort((a, b) => a.name.localeCompare(b.name));
}

/** The chat's commands without any playbook row: for a chat that runs no playbooks, where the server's
    own rows would otherwise go out as plain text. */
export function withoutPlaybookRows(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((c) => !c.playbook);
}

/** The chat's commands with the page's playbook rows under them: a name the chat already has (its own
    command, or the server's row for that playbook) keeps the chat's. */
export function withPlaybookRows(commands: readonly SlashCommand[], rows: readonly SlashCommand[]): SlashCommand[] {
  const have = new Set(commands.map((c) => c.name));
  return [...commands, ...rows.filter((r) => !have.has(r.name))];
}

/** What Start refuses in a chat, the card never offers: no playbook card, "/" row or card pick in the
    Overseer, a project overseer or a baton (hand-off) chat. */
export const NO_PLAYBOOKS_HERE = "This chat runs no playbooks.";
export function playbooksRunHere(chat: { overseer?: boolean; projectOverseer?: boolean; baton?: boolean }): boolean {
  return !chat.overseer && !chat.projectOverseer && !chat.baton;
}
