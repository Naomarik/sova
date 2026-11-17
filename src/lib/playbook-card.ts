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
  type PlaybookMemberView,
  type PlaybookModelPick,
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

/**
 * How the chat conducting a run stands, in Sova's own reading of that chat (the session list's):
 * its turn or its helpers working, what its last turn left for you, or nothing going on. The run
 * itself records nothing after Start, so this is all the page says of a run in progress.
 */
export interface RunChatNow {
  /** The chat's own turn is running. */
  working: boolean;
  helpersWorking: number;
  /** Why the chat needs you, in the session list's words; null when it doesn't. */
  needsYou: string | null;
  /** Its last turn said the work is done. */
  done: boolean;
}

export interface RunStatus {
  label: string;
  tone: ChipTone;
  live?: boolean;
  /** One sentence under the card's head, for a started run. */
  detail?: string;
  /** The run waits for the person's answer: the card offers Continue and Stop Here. */
  answer?: boolean;
}

const helpersWorkingWords = (n: number): string => `${n} ${n === 1 ? "helper" : "helpers"} working`;

/**
 * A run's state, dot and word, on its strip and its card. A draft: ready, or what blocks Start.
 * A started run: how its conducting chat stands (`now`); with no reading of that chat (the card is
 * in another chat), only that it started. A question the chat is blocked on wins over work, as in
 * the session list; a chat with nothing going on waits for your answer unless its last turn said
 * it was done.
 */
export function runStatus(view: PlaybookRunView, now: RunChatNow | null): RunStatus {
  if (view.state === "starting") return { label: "Starting", tone: "accent" };
  if (view.state !== "started") return cardChip(view);
  if (!now) return { label: "Started", tone: "accent" };
  if (now.working) return { label: "Running", tone: "accent", live: true, detail: now.helpersWorking > 0 ? `This chat is working, with ${helpersWorkingWords(now.helpersWorking)}.` : "This chat is working." };
  if (now.helpersWorking > 0) return { label: "Running", tone: "accent", live: true, detail: `${helpersWorkingWords(now.helpersWorking)}; this chat picks up when they report.` };
  if (now.needsYou) return { label: "Needs you", tone: "warn", detail: now.needsYou, answer: true };
  if (now.done) return { label: "Done", tone: "success", detail: "This chat's last turn said the work is done." };
  return { label: "Idle", tone: undefined, detail: "This chat's turn ended and no helper is working. The run goes on when you answer.", answer: true };
}

/** The two answers Start's message tells the conductor to wait for at a stop: the button's words and
    the message it sends. */
export const RUN_ANSWERS = [
  { label: "Continue", text: "Continue" },
  { label: "Stop Here", text: "Stop here" },
] as const;

/** What a run's strip above the message box is called aloud: "A/B cycle: Needs you. Open its card." */
export function controlLabel(title: string, status: Pick<RunStatus, "label">): string {
  return `${title}: ${status.label}. Open its card.`;
}

/** A model pick as the card says it: "GLM 5.3 · zai · low" (name, provider, effort). */
export function pickLine(p: PlaybookModelPick | null | undefined, provider = true): string {
  if (!p) return "No model";
  const slash = p.model.indexOf("/");
  const prov = provider && slash > 0 ? providerName(p.model.slice(0, slash)) : null;
  return [modelLabel(p.model) ?? p.model, prov, p.effort].filter(Boolean).join(" · ");
}

/** A required member's resolved model line, or why it has none. */
export function memberModelLine(member: Pick<PlaybookMemberView, "resolved" | "only">): string {
  const r = member.resolved;
  if (r) return [r.modelLabel || modelLabel(r.model) || r.model, providerName(r.provider), r.effort].filter(Boolean).join(" · ");
  return member.only ? "None of its models can run" : "No model";
}

/** Why this model, beside it: the resolver's reason when it isn't the first pick. */
export function memberWhy(member: Pick<PlaybookMemberView, "resolved" | "only">): string {
  const r = member.resolved;
  const only = member.only ? "Only these models" : null;
  if (!r) return only ?? "";
  const why = r.reason ?? (r.source === "card" ? "Your pick for this run" : r.source === "list" ? "First choice" : r.source === "profile" ? "Your profile" : "This chat's model");
  return [why, only].filter(Boolean).join(" · ");
}

/** "Runner × 3": a member that runs several times says how many. */
export function memberTitle(member: Pick<PlaybookMemberView, "label" | "count">): string {
  return member.count > 1 ? `${member.label} × ${member.count}` : member.label;
}

/** The rest of a member's list after its resolved pick, for the hover title ("Then: Fable 5.2 · high"). */
export function chainRest(member: Pick<PlaybookMemberView, "resolved" | "chain">): string | null {
  const r = member.resolved;
  const rest = member.chain.filter((p) => !r || p.model !== r.model);
  return rest.length ? `Then: ${rest.map((p) => pickLine(p, false)).join(", ")}` : null;
}

/** "3", "3 and 4", "3, 4, and 5". */
const listed = (items: readonly (string | number)[]): string =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;

/**
 * Who runs, folded: "Who runs · 2 teams · 5 required members". The counts are the server's (a member
 * run three times counts once, one turned off doesn't count); a team may have a goal and no required
 * member. Members that are on with no model that can run are said here too, since they keep Start off
 * and the section is folded.
 *
 * A run started before teams had goals had no required members, only the roles it listed, in the
 * groups it made: "Who runs · 8 groups · 12 roles · started before teams". The count is of rows, so a
 * role run three times is one role, never "helpers".
 */
export function whoSummary(who: PlaybookRunView["who"], cantRun = 0, legacy = false): string {
  if (who.teams === 0) return "Who runs · the main chat alone";
  if (legacy) {
    const groups = `${who.teams} ${who.teams === 1 ? "group" : "groups"}`;
    const roles = who.members === 0 ? "no roles" : `${who.members} ${who.members === 1 ? "role" : "roles"}`;
    return `Who runs · ${groups} · ${roles} · started before teams`;
  }
  const teams = `${who.teams} ${who.teams === 1 ? "team" : "teams"}`;
  const members = who.members === 0 ? "no required members" : `${who.members} required ${who.members === 1 ? "member" : "members"}`;
  return `Who runs · ${teams} · ${members}${cantRun > 0 ? ` · ${cantRun} can't run` : ""}`;
}

/** The members that keep Start off: on, and none of their models can run. */
export function cantRunCount(teams: readonly Pick<PlaybookTeamView, "members">[]): number {
  return teams.reduce((n, t) => n + t.members.filter((m) => m.on && !m.runnable).length, 0);
}

/** Over a team's goal: its short name and the steps it works in, by their numbers on the card
    ("Grading team · steps 4, 7, and 8"); a team no step names says only its name. In a run started
    before teams had goals the block's heading is already the team's old name, so only its steps are said
    ("Steps 1 and 3"), or nothing. */
export function teamEyebrow(team: Pick<PlaybookTeamView, "label" | "steps">, steps: readonly Pick<PlaybookStepView, "id">[], legacy = false): string {
  const numbers = team.steps.map((id) => steps.findIndex((s) => s.id === id) + 1).filter((n) => n > 0);
  const where = numbers.length === 0 ? null : `${numbers.length === 1 ? "step" : "steps"} ${listed(numbers)}`;
  if (legacy) return where ? where.replace(/^s/, "S") : "";
  return [`${team.label} team`, where].filter(Boolean).join(" · ");
}

/** Under a team's members: it isn't limited to them. A team with none says so first. A run started
    before teams had goals listed every helper it ran, so its blocks have no such line. */
export function teamAddsLine(team: Pick<PlaybookTeamView, "members">, legacy = false): string | null {
  if (legacy) return null;
  return team.members.length === 0 ? "No required members: the team adds whoever it needs." : "The team adds anyone else it needs.";
}

/** The first line of Who runs in a run started before teams had goals. */
export const LEGACY_WHO_NOTE = "Started before teams had goals: these are the helpers it ran with, grouped as that run grouped them.";

/** A step says who works in it: the main chat alone, or its teams by name ("Run and Grading teams").
    A team named exactly as the step (an older run made one team per step) is "Its own team": the
    step's title isn't said twice. */
export function stepRunsLine(step: Pick<PlaybookStepView, "teams" | "title">, teams: readonly Pick<PlaybookTeamView, "id" | "label">[]): string {
  const names = step.teams.map((id) => teams.find((t) => t.id === id)?.label).filter((l): l is string => !!l);
  if (names.length === 0) return "The main chat";
  if (names.length === 1 && names[0] === step.title) return "Its own team";
  return `${listed(names)} ${names.length === 1 ? "team" : "teams"}`;
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
  return `Steps ${listed(numbers)} repeat`;
}

/** Flow, folded: "Flow · 10 steps · steps 5, 6, and 7 repeat"; a playbook that declares states says so. */
export function flowSummary(view: Pick<PlaybookRunView, "flow" | "steps" | "cycle">): string {
  if (view.flow?.kind === "state") return "Flow · states and the moves between them";
  const n = view.steps.length;
  const numbers = (view.cycle?.steps ?? []).map((id) => view.steps.findIndex((s) => s.id === id) + 1).filter((i) => i > 0);
  const repeats = numbers.length ? cycleStepsLine(numbers).replace(/^S/, "s") : null;
  return ["Flow", `${n} ${n === 1 ? "step" : "steps"}`, repeats].filter(Boolean).join(" · ");
}

/** Under the drawing: what it is drawn from. Before Start it follows the card; after, it is the plan
    as Start froze it, and the drawing's own caption says the run's step isn't tracked. */
export function flowNote(state: PlaybookRunView["state"]): string {
  return state === "draft"
    ? "Drawn from this card: change a stop or the cycle's settings and the drawing follows."
    : "The plan as it was at Start. Progress comes in the chat's messages.";
}

/** "Starts with 9 helpers, each team's coordinator and monitor included; a chat runs up to 24 at once."
    The coordinator and monitor have no rows of their own, so the line says they are counted; a team may
    add more, so the number is where the run starts, not its most. */
export function helpersLine(h: PlaybookRunView["helpers"]): string {
  return `Starts with ${h.total} ${h.total === 1 ? "helper" : "helpers"}, each team's coordinator and monitor included; a chat runs up to ${h.limit} at once.`;
}

/** "14:06" today, else "Mar 4, 14:06": a 24-hour clock, as logs and records read. */
export function shortClock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** A closed card's one line: what it needs, the plan's size, or when and where it started. */
export function foldedLine(view: PlaybookRunView, here?: string, clock: (iso: string) => string = shortClock): string {
  const st = view.started;
  if (view.state === "started" && st) {
    const where = st.chat.path === here ? "in this chat" : st.chat.title ? `in ${st.chat.title}` : "in another chat";
    return `Revision ${st.revision}, started ${clock(st.at)} ${where}`;
  }
  if (view.state === "starting") return "Starting…";
  const teams = view.who.teams === 0 ? "The main chat alone" : `${view.who.teams} ${view.who.teams === 1 ? "team" : "teams"}`;
  return view.startBlocked ?? `${teams} · ${stepsSummary(view.steps).replace(/^Steps · /, "").replace(/^(\d+)/, "$1 steps")}`;
}

/** The strip's line under the run's name: how its conducting chat stands, when the page reads that
    chat; else the folded line (what Start needs, the plan's size, or when and where it started). */
export function stripLine(view: PlaybookRunView, status: Pick<RunStatus, "detail">, here?: string, clock: (iso: string) => string = shortClock): string {
  return (view.state === "started" && status.detail) || foldedLine(view, here, clock);
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

/** A choice whose answer is the person's own words (a text, or a list of lines): the record folds a
    long one to its first 2 lines. A pick, a number, a switch or a set of models is never folded. */
export function isFreeText(c: Pick<PlaybookChoiceView, "type">): boolean {
  return c.type === "text" || c.type === "list";
}

/** The button under a folded answer, and under the same answer shown whole. */
export const answerFoldLabel = (all: boolean): string => (all ? "Show Less" : "Show All");

/** A playbook model pick as the model picker holds it (effort is pi's thinking level). */
export function toPick(p: PlaybookModelPick | null | undefined): ModelPick | null {
  return p ? { model: p.model, ...(p.effort ? { thinking: p.effort as ThinkingLevel } : {}) } : null;
}
export function fromPick(p: ModelPick): PlaybookModelPick {
  return { model: p.model, ...(p.thinking ? { effort: p.thinking } : {}) };
}

/** Two batches of card edits not yet saved, as one: the later wins key by key, a member's and a team's
    fields one by one. Unlike the store's merge, a cleared pick stays as null: it is an edit still to send. */
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
  if (b.teams) {
    const teams = { ...a.teams };
    for (const [id, t] of Object.entries(b.teams)) teams[id] = { ...teams[id], ...t };
    out.teams = teams;
  }
  return out;
}

/** Whether a batch holds anything to send. */
export function hasEdits(e: PlaybookCardEdits): boolean {
  return !!(
    (e.choices && Object.keys(e.choices).length) ||
    (e.stops && Object.keys(e.stops).length) ||
    (e.cycle && Object.keys(e.cycle).length) ||
    (e.roles && Object.keys(e.roles).length) ||
    (e.teams && Object.keys(e.teams).length)
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

/** The run that holds a chat: a chat runs one playbook at most (al_2 q13). */
export interface HeldBy {
  id: string;
  title: string;
}

/** The one run a chat's strip shows: the run it started or conducts, else its draft (the newest
    opened, first in the chat's list). A chat made before the rule may still hold several. */
export function chatCard<R extends Pick<PlaybookRunView, "state">>(runs: readonly R[]): R | null {
  return runs.find((r) => r.state !== "draft") ?? runs[0] ?? null;
}

/** The run that holds this chat, if one does: the server's word (it also knows a run whose card was
    put away), else a started or starting run among the chat's cards. Drafts hold nothing. */
export function chatHolding(runs: readonly Pick<PlaybookRunView, "id" | "state" | "playbook">[], holding?: HeldBy | null): HeldBy | null {
  if (holding) return holding;
  const run = runs.find((r) => r.state !== "draft");
  return run ? { id: run.id, title: run.playbook.title } : null;
}

/** A chat's cards after one was opened: its other drafts gave way to it. Started runs stay. */
export function withoutOtherDrafts<R extends Pick<PlaybookRunView, "id" | "state">>(runs: readonly R[], opened: string): R[] {
  return runs.filter((r) => r.id === opened || r.state !== "draft");
}

/** What a playbook's "/" row says in a chat a run holds, instead of its description. */
export const heldRowNote = (title: string): string => `This chat already runs ${title}. Opens in a new chat.`;
/** The Playbooks list's notice in such a chat. */
export const heldListNote = (title: string): { title: string; body: string } => ({
  title: `This chat already runs ${title}.`,
  body: "A chat runs one playbook. A playbook with a card opens in a new chat.",
});

/** The chat's "/" rows in a chat a run holds: each playbook's row says so and that it opens in a new
    chat; every other row, and the order, are untouched. */
export function heldRows(commands: readonly SlashCommand[], held: HeldBy | null): SlashCommand[] {
  if (!held) return [...commands];
  return commands.map((c) => (c.playbook ? { ...c, description: heldRowNote(held.title) } : c));
}

/** What one pane's cards do with an Open Card (or another way in) for a run: open it among its own
    cards, read the put-away run's record, wait until every pane had its look (a way in that names no
    pane), or leave it to the pane that was clicked. */
export type RevealStep = "open" | "record" | "later" | "skip";
export function revealStep<S>(reveal: { id: string; store?: S | null }, here: S, hasRun: boolean): RevealStep {
  if (reveal.store && reveal.store !== here) return "skip";
  if (hasRun) return "open";
  return reveal.store ? "record" : "later";
}
