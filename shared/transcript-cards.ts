/**
 * Transcript cards a project declares (§chat/transcript-cards): the `card.json` declaration and its
 * strict check (§chat.transcript-cards/files), a session's snapshot of the types it may raise, the
 * card as the wire carries it, the `card` tool's words (§chat.transcript-cards/card-tool) and the
 * line a gathered answer sends (§chat.transcript-cards/answering). Pure and DOM-free: the server and
 * the page both read it.
 */

import { checkCardData, DATA_CARDS, notRaisedText, optionLetter, type ButtonsCard, type ChecklistCard, type DataCardKind, type QuestionCard } from "./view-cards.ts";

export const CARD_TOOL = "card";
/** A project's card folders, under its checkout. */
export const CARDS_DIR = ".sova/cards";
export const CARD_FILE = "card.json";
export const VIEW_FILE = "view.tsx";
/** The toolkit version this Sova runs (§chat.transcript-cards/versions). */
export const TOOLKIT_VERSION = 1;
export const CARD_TYPES_MAX = 16;
export const CARD_FILE_MAX_BYTES = 64 * 1024;
export const WHEN_MAX = 200;
export const KEY_MAX = 64;
export const TITLE_MAX = 120;
/** The hidden note an at-once answer reaches the agent with (§chat.transcript-cards/answering). */
export const CARD_NOTE_MESSAGE = "sova-card-note";
export const CARD_DETAILS_VERSION = 1;

/** A type's name after its owner: lowercase letters, digits and hyphens, starting with a letter, at most 32. */
export const CARD_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** A card's id in its session. */
export const CARD_ID_RE = /^cd_[1-9][0-9]{0,8}$/;

export type CardAnswerMode = "none" | "at-once" | "gather";
export type CardPlacement = "anchored" | "follow";
export const ANSWER_MODES: readonly CardAnswerMode[] = ["none", "at-once", "gather"];
export const PLACEMENTS: readonly CardPlacement[] = ["anchored", "follow"];

/** One card type, as a session's snapshot holds it. */
export interface CardDecl {
  /** The namespaced name: `project.<name>` (an extension's `<id>.<name>` in a later phase). */
  type: string;
  title: string;
  /** When the agent may raise it; absent: raised only from outside. */
  when?: string;
  draws: DataCardKind | "view";
  answer: CardAnswerMode;
  placement: CardPlacement;
  /** A view's reserved height in px. */
  height?: number;
  /** A view's declared data shape (a JSON Schema subset). */
  data?: unknown;
}

/** A card folder as read: its type, or what is wrong with it. */
export type CardFolder = { name: string; path: string; ok: true; decl: CardDecl } | { name: string; path: string; ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const CARD_KEYS = ["version", "toolkit", "title", "when", "draws", "data", "answer", "placement", "height"];

/**
 * A folder's `card.json`, checked strictly (§chat.transcript-cards/files): its declaration as
 * `project.<name>`, or the first thing wrong with it. `hasView`: whether `view.tsx` is beside it.
 */
export function parseCardFile(name: string, text: string, hasView: boolean): { ok: true; decl: CardDecl } | { ok: false; error: string } {
  if (!CARD_NAME_RE.test(name)) return { ok: false, error: "The folder's name isn't lowercase letters, digits and hyphens starting with a letter, at most 32 characters." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${CARD_FILE} isn't JSON.` };
  }
  if (!isObject(raw)) return { ok: false, error: `${CARD_FILE} isn't a JSON object.` };
  for (const k of Object.keys(raw)) if (!CARD_KEYS.includes(k)) return { ok: false, error: `"${k}" is not a key ${CARD_FILE} has.` };
  if (raw.version !== 1) return { ok: false, error: "version must be 1." };
  if (raw.toolkit !== TOOLKIT_VERSION) return { ok: false, error: `toolkit must be ${TOOLKIT_VERSION}, the toolkit this Sova runs.` };
  if (typeof raw.title !== "string" || !raw.title.trim() || [...raw.title].length > TITLE_MAX || /[\r\n]/.test(raw.title)) return { ok: false, error: `title must be one line of 1 to ${TITLE_MAX} characters.` };
  if (raw.when !== undefined && (typeof raw.when !== "string" || !raw.when.trim() || [...raw.when].length > WHEN_MAX)) return { ok: false, error: `when must be text of 1 to ${WHEN_MAX} characters.` };
  const draws = raw.draws;
  if (draws !== "view" && !DATA_CARDS.includes(draws as DataCardKind)) return { ok: false, error: `draws must be one of ${DATA_CARDS.join(", ")} or view.` };
  const answer = raw.answer ?? "none";
  if (!ANSWER_MODES.includes(answer as CardAnswerMode)) return { ok: false, error: `answer must be one of ${ANSWER_MODES.join(", ")}.` };
  const placement = raw.placement ?? "anchored";
  if (!PLACEMENTS.includes(placement as CardPlacement)) return { ok: false, error: `placement must be one of ${PLACEMENTS.join(", ")}.` };
  if (draws === "view") {
    if (!hasView) return { ok: false, error: `draws view, but ${VIEW_FILE} is missing.` };
    if (!isObject(raw.data)) return { ok: false, error: "A view needs data, the shape its data must have." };
    if (raw.height !== undefined && (typeof raw.height !== "number" || !Number.isInteger(raw.height) || raw.height < 32 || raw.height > 1200)) return { ok: false, error: "height must be a whole number of px from 32 to 1200." };
  } else {
    if (raw.data !== undefined) return { ok: false, error: `data is only for a view: a ${draws} card's shape is Sova's.` };
    if (raw.height !== undefined) return { ok: false, error: `height is only for a view: Sova sizes a ${draws} card.` };
    if ((draws === "question" || draws === "buttons") && answer === "none") return { ok: false, error: `A ${draws} card is answered: answer must be at-once or gather.` };
    if ((draws === "status" || draws === "table") && answer !== "none") return { ok: false, error: `A ${draws} card takes no answer.` };
  }
  return {
    ok: true,
    decl: {
      type: `project.${name}`,
      title: raw.title.trim(),
      ...(typeof raw.when === "string" ? { when: raw.when.trim() } : {}),
      draws: draws as CardDecl["draws"],
      answer: answer as CardAnswerMode,
      placement: placement as CardPlacement,
      ...(typeof raw.height === "number" ? { height: raw.height } : {}),
      ...(draws === "view" ? { data: raw.data } : {}),
    },
  };
}

// ---- the snapshot (§chat.transcript-cards/files, "Fixed per chat") ------------------------------

export interface CardSnapshot {
  v: 1;
  types: CardDecl[];
}

function declOf(v: unknown): CardDecl | null {
  if (!isObject(v) || typeof v.type !== "string" || typeof v.title !== "string") return null;
  if (!(v.draws === "view" || DATA_CARDS.includes(v.draws as DataCardKind))) return null;
  if (!ANSWER_MODES.includes(v.answer as CardAnswerMode) || !PLACEMENTS.includes(v.placement as CardPlacement)) return null;
  return {
    type: v.type,
    title: v.title,
    ...(typeof v.when === "string" ? { when: v.when } : {}),
    draws: v.draws as CardDecl["draws"],
    answer: v.answer as CardAnswerMode,
    placement: v.placement as CardPlacement,
    ...(typeof v.height === "number" ? { height: v.height } : {}),
    ...(v.data !== undefined ? { data: v.data } : {}),
  };
}

/** A stored snapshot read back; anything that isn't one reads as none. */
export function normalizeCardSnapshot(v: unknown): CardSnapshot | null {
  if (!isObject(v) || v.v !== 1 || !Array.isArray(v.types)) return null;
  const types = v.types.map(declOf).filter((d): d is CardDecl => !!d);
  return { v: 1, types };
}

/** The types the agent may raise: those with a `when`. */
export const agentTypes = (s: CardSnapshot | null): CardDecl[] => (s?.types ?? []).filter((t) => t.when && t.draws !== "view");

// ---- the card on the wire -----------------------------------------------------------------------

/** Who raised a card (§chat.transcript-cards/raise-command, "The card says who raised it"). */
export type CardRaiser = { kind: "agent" } | { kind: "script" } | { kind: "chat"; title: string } | { kind: "extension"; title: string };

/** An answer's value: a question's option, a button, or a checklist's ticks. */
export type CardAnswerValue = { option: number } | { button: number } | { items: boolean[] };

export interface CardAnswer {
  value: CardAnswerValue;
  /** The answer in words: "b: Parquet", "Deploy", "3 of 4 done". */
  text: string;
  /** Who gave it: "you", or the caller that answered through the catalogue. */
  by: string;
  at: string;
  /** How it was given: pressed at once, or gathered and sent with a message. */
  via: "at-once" | "send";
  /** A button that sent or ran something: how that went. */
  outcome?: { state: "done" | "failed"; text: string };
}

export type CardState = "open" | "answered" | "done" | "superseded";

/** A raised card as the page reads it. */
export interface CardInfo {
  id: string;
  type: string;
  /** The type's title. */
  title: string;
  draws: DataCardKind;
  answerMode: CardAnswerMode;
  placement: CardPlacement;
  key?: string;
  /** A follow card's revision number, from 1. */
  revision?: number;
  data: unknown;
  at: string;
  by: CardRaiser;
  /** The tool call that raised it (an agent's). */
  toolCallId?: string;
  /** An outside card's place: the transcript's last entry when it was raised (null: before every entry). */
  after?: string | null;
  state: CardState;
  answer?: CardAnswer;
}

/** The `card` tool's result details. */
export interface CardDetails {
  v: 1;
  card: CardInfo;
}

const RAISER_KINDS = ["agent", "script", "chat", "extension"];
const STATES: readonly CardState[] = ["open", "answered", "done", "superseded"];

/** A card read from anywhere (a stored record, a tool result, a response): checked, or null. Its data is checked when it draws. */
export function normalizeCardInfo(v: unknown): CardInfo | null {
  if (!isObject(v)) return null;
  if (typeof v.id !== "string" || !CARD_ID_RE.test(v.id) || typeof v.type !== "string" || typeof v.title !== "string") return null;
  if (!DATA_CARDS.includes(v.draws as DataCardKind) || !ANSWER_MODES.includes(v.answerMode as CardAnswerMode) || !PLACEMENTS.includes(v.placement as CardPlacement)) return null;
  if (typeof v.at !== "string" || !STATES.includes(v.state as CardState)) return null;
  const by = v.by;
  if (!isObject(by) || !RAISER_KINDS.includes(by.kind as string)) return null;
  if ((by.kind === "chat" || by.kind === "extension") && typeof by.title !== "string") return null;
  let answer: CardAnswer | undefined;
  if (isObject(v.answer)) {
    const a = v.answer;
    const val = a.value;
    const okVal = isObject(val) && (Number.isInteger(val.option) || Number.isInteger(val.button) || (Array.isArray(val.items) && val.items.every((x) => typeof x === "boolean")));
    if (okVal && typeof a.text === "string" && typeof a.by === "string" && typeof a.at === "string" && (a.via === "at-once" || a.via === "send")) {
      const o = a.outcome;
      answer = {
        value: val as CardAnswerValue,
        text: a.text,
        by: a.by,
        at: a.at,
        via: a.via,
        ...(isObject(o) && (o.state === "done" || o.state === "failed") && typeof o.text === "string" ? { outcome: { state: o.state, text: o.text } } : {}),
      };
    }
  }
  return {
    id: v.id,
    type: v.type,
    title: v.title,
    draws: v.draws as DataCardKind,
    answerMode: v.answerMode as CardAnswerMode,
    placement: v.placement as CardPlacement,
    ...(typeof v.key === "string" ? { key: v.key } : {}),
    ...(typeof v.revision === "number" ? { revision: v.revision } : {}),
    data: v.data,
    at: v.at,
    by: by.kind === "chat" || by.kind === "extension" ? { kind: by.kind, title: by.title as string } : { kind: by.kind as "agent" | "script" },
    ...(typeof v.toolCallId === "string" ? { toolCallId: v.toolCallId } : {}),
    ...(v.after === null || typeof v.after === "string" ? { after: v.after as string | null } : {}),
    state: v.state as CardState,
    ...(answer ? { answer } : {}),
  };
}

/** A `card` tool result's details, checked, or undefined. */
export function normalizeCardDetails(v: unknown): CardInfo | undefined {
  if (!isObject(v) || v.v !== CARD_DETAILS_VERSION) return undefined;
  return normalizeCardInfo(v.card) ?? undefined;
}

/** "From a script", "From {chat title}", "From {extension title}"; an agent's card says nothing. */
export const raiserText = (by: CardRaiser): string | null => (by.kind === "agent" ? null : by.kind === "script" ? "From a script" : `From ${by.title}`);

/** GET /api/session-cards: a session's cards, and the types its snapshot holds. */
export interface SessionCardsAnswer {
  cards: CardInfo[];
  types: CardDecl[];
  /** Whether the session's project's cards are trusted to act (§chat.transcript-cards/trust), and its name. */
  trust?: { owner: string; name: string; trusted: boolean };
}

/** One folder under a project's `.sova/cards/`, as its Settings tab lists it: `path` is the folder's, from the checkout. */
export type ProjectCardFolder = { name: string; path: string; ok: true; type: string; title: string } | { name: string; path: string; ok: false; error: string };

/** GET /api/projects/:pid/cards: the project's card folders on its main checkout, read now, and whether its cards are trusted. */
export interface ProjectCardsAnswer {
  folders: ProjectCardFolder[];
  trust: { owner: string; name: string; trusted: boolean };
}

// ---- answers ------------------------------------------------------------------------------------

/**
 * An answer's value checked against the card's data, in words; or why it doesn't fit. A question
 * takes an option, a buttons card a button, a checklist the ticks of every item.
 */
export function answerOf(card: Pick<CardInfo, "draws" | "data">, value: unknown): { ok: true; value: CardAnswerValue; text: string } | { ok: false; error: string } {
  const checked = checkCardData(card.draws, card.data);
  if (!checked.ok) return { ok: false, error: `The card's data doesn't fit its type: ${checked.error.path} ${checked.error.why}.` };
  if (!isObject(value)) return { ok: false, error: "answer must be an object: {option}, {button} or {items}." };
  if (card.draws === "question") {
    const q = checked.data as QuestionCard;
    const i = value.option;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= q.options.length) return { ok: false, error: `answer.option must be an option's number, from 0 to ${q.options.length - 1}.` };
    return { ok: true, value: { option: i }, text: `${optionLetter(i)}: ${q.options[i]!.label}` };
  }
  if (card.draws === "buttons") {
    const b = checked.data as ButtonsCard;
    const i = value.button;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= b.buttons.length) return { ok: false, error: `answer.button must be a button's number, from 0 to ${b.buttons.length - 1}.` };
    return { ok: true, value: { button: i }, text: b.buttons[i]!.label };
  }
  if (card.draws === "checklist") {
    const c = checked.data as ChecklistCard;
    const items = value.items;
    if (!Array.isArray(items) || items.length !== c.items.length || !items.every((x) => typeof x === "boolean"))
      return { ok: false, error: `answer.items must list true or false for each of the ${c.items.length} items.` };
    const done = items.filter(Boolean).length;
    return { ok: true, value: { items: items as boolean[] }, text: `${done} of ${items.length} done` };
  }
  return { ok: false, error: `A ${card.draws} card takes no answer.` };
}

/** A gathered pick's line in the message (§chat.transcript-cards/answering): "cd_4: b: Parquet." */
export const cardPickLine = (id: string, text: string): string => `${id}: ${text}.`;

// ---- the `card` tool's words (§chat.transcript-cards/card-tool) ---------------------------------

const DRAWS_WORDS: Record<DataCardKind, string> = {
  question:
    '{title, ask, context?, options: [{label, tradeoff?}] (2 to 8, lettered a, b, c…), recommendation?: {option: "<letter>", why}}',
  checklist: "{title, items: [{text, done}] (1 to 50)}",
  status: '{title, tone: "ok" | "warn" | "error" | "info" | "muted", line, detail?}',
  table: "{title?, columns: [text] (1 to 12), rows: [[text per column]] (up to 200)}",
  buttons: '{title, note?, buttons: [{label, about?, does: {kind: "answer"} | {kind: "send", text} | {kind: "run", command, params?}, confirm?}] (1 to 4)}',
};

/** The tool's description: built only from each type's `when` and its data shape. */
export function cardToolDescription(s: CardSnapshot): string {
  const lines = [
    "Raise one of this project's transcript cards in this chat, where your call stands. Each type below says when to raise it and the data it takes. The user answers it on the card; the answer reaches you as a note at your next turn, or with their next message. Raising never ends your turn.",
    "Types:",
  ];
  for (const t of agentTypes(s)) {
    const draws = t.draws as DataCardKind;
    lines.push(`- ${t.type} (${t.title}): ${t.when} Data: ${DRAWS_WORDS[draws]}.${t.placement === "follow" ? " Give a key: the same key raises a new revision of that card." : ""}`);
  }
  return lines.join("\n");
}

export function cardToolParameters(s: CardSnapshot): Record<string, unknown> {
  const types = agentTypes(s).map((t) => t.type);
  const follow = agentTypes(s).some((t) => t.placement === "follow");
  return {
    type: "object",
    properties: {
      type: { type: "string", enum: types, description: "The card type to raise." },
      data: { type: "object", description: "The card's data, in its type's shape." },
      ...(follow ? { key: { type: "string", maxLength: KEY_MAX, description: "A follow type's card: the same key raises its next revision. No other type takes one." } } : {}),
    },
    required: ["type", "data"],
    additionalProperties: false,
  };
}

/** A raise refused: "Nothing was raised: …" with the reason (or the data's first broken field). */
export const NOTHING_RAISED = "Nothing was raised";
export { notRaisedText };
