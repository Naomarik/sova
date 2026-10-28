/**
 * The five data cards Sova draws itself (§chat.transcript-cards/data-cards): question, checklist,
 * status, table and buttons. Their shapes, the checks a card's data passes before it is raised or
 * drawn, and the height each reserves before it draws (§chat.transcript-cards/toolkit). Pure and
 * DOM-free: the server checks raised data with it, the page checks stored data with it before a card
 * draws, and both answer the same first broken field by its path.
 *
 * Every shape is strict: an unknown key is refused, so data that a later shape would read
 * differently never half-draws. Text is plain, with inline code and bold runs drawn as on an
 * alignment card; one-line fields refuse a line break.
 */

export const DATA_CARDS = ["question", "checklist", "status", "table", "buttons"] as const;
export type DataCardKind = (typeof DATA_CARDS)[number];

/** A card's data, as JSON, is at most this many bytes. */
export const CARD_DATA_MAX_BYTES = 64 * 1024;

export const LIMITS = {
  title: 120,
  ask: 2000,
  context: 1000,
  optionLabel: 120,
  tradeoff: 300,
  why: 300,
  optionsMin: 2,
  optionsMax: 8,
  checklistItemsMax: 50,
  checklistText: 300,
  statusLine: 300,
  statusDetail: 1000,
  columnsMax: 12,
  columnHead: 60,
  rowsMax: 200,
  /** Rows a table shows before Show All {n} Rows. */
  rowsShown: 10,
  cell: 500,
  buttonsMax: 4,
  buttonLabel: 32,
  about: 160,
  note: 300,
  send: 500,
  confirm: 300,
  command: 80,
} as const;

export const STATUS_TONES = ["ok", "warn", "error", "info", "muted"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export interface QuestionOption {
  label: string;
  tradeoff?: string;
}
export interface QuestionCard {
  title: string;
  ask: string;
  context?: string;
  options: QuestionOption[];
  /** Names one option by its letter (a, b, c…), with why. */
  recommendation?: { option: string; why: string };
}
export interface ChecklistCard {
  title: string;
  items: { text: string; done: boolean }[];
}
export interface StatusCard {
  title: string;
  tone: StatusTone;
  line: string;
  detail?: string;
}
export interface TableCard {
  title?: string;
  columns: string[];
  rows: string[][];
}
/** What a button does: answer the card with itself, send a text as the user, or run one catalogue command. */
export type ButtonDoes = { kind: "answer" } | { kind: "send"; text: string } | { kind: "run"; command: string; params?: Record<string, unknown> };
export interface CardButton {
  label: string;
  about?: string;
  does: ButtonDoes;
  /** Asked first, as an offer card's confirm. */
  confirm?: string;
}
export interface ButtonsCard {
  title: string;
  note?: string;
  buttons: CardButton[];
}
export interface DataCardMap {
  question: QuestionCard;
  checklist: ChecklistCard;
  status: StatusCard;
  table: TableCard;
  buttons: ButtonsCard;
}

/** The first field that broke a rule: its path (`options[2].label`) and the rule, in words. */
export interface CardDataError {
  path: string;
  why: string;
}
export type CardDataCheck<K extends DataCardKind = DataCardKind> = { ok: true; data: DataCardMap[K] } | { ok: false; error: CardDataError };

/** "options[2].label is longer than 120 characters" (the path alone when it is the whole card: "data"). */
export const cardDataErrorText = (e: CardDataError): string => `${e.path} ${e.why}`;

/** The letter of option `i`, "a" for the first, as on an alignment card. */
export const optionLetter = (i: number): string => String.fromCharCode(97 + i);
/** The option a letter names, by index, or undefined. */
export const letterIndex = (letter: string, count: number): number | undefined => {
  const i = /^[a-z]$/.test(letter) ? letter.charCodeAt(0) - 97 : -1;
  return i >= 0 && i < count ? i : undefined;
};

class Broke extends Error {
  constructor(readonly at: CardDataError) {
    super(cardDataErrorText(at));
  }
}
const fail = (path: string, why: string): never => {
  throw new Broke({ path, why });
};
const join = (path: string, key: string | number): string => (typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`);
const named = (path: string): string => path || "data";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function object(v: unknown, path: string, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!isObject(v)) fail(named(path), "is not an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(join(path, k), "is not a field this card has");
  for (const k of required) if (o[k] === undefined) fail(join(path, k), "is missing");
  return o;
}

function text(v: unknown, path: string, max: number, opts: { oneLine?: boolean; optional?: boolean } = {}): string | undefined {
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== "string") return fail(path, "is not text");
  if (v.trim() === "") return fail(path, "is empty");
  if ([...v].length > max) return fail(path, `is longer than ${max} characters`);
  if (opts.oneLine && /[\r\n]/.test(v)) return fail(path, "is more than one line");
  return v;
}

function list(v: unknown, path: string, min: number, max: number, what: string): unknown[] {
  if (!Array.isArray(v)) return fail(path, "is not a list");
  if (v.length < min) return fail(path, min === 1 ? `has no ${what}` : `has fewer than ${min} ${what}`);
  if (v.length > max) return fail(path, `has more than ${max} ${what}`);
  return v;
}

function question(v: unknown): QuestionCard {
  const o = object(v, "", ["title", "ask", "context", "options", "recommendation"], ["title", "ask", "options"]);
  const options = list(o.options, "options", LIMITS.optionsMin, LIMITS.optionsMax, "options").map((raw, i): QuestionOption => {
    const p = join("options", i);
    const opt = object(raw, p, ["label", "tradeoff"], ["label"]);
    const tradeoff = text(opt.tradeoff, join(p, "tradeoff"), LIMITS.tradeoff, { optional: true });
    return { label: text(opt.label, join(p, "label"), LIMITS.optionLabel, { oneLine: true })!, ...(tradeoff !== undefined ? { tradeoff } : {}) };
  });
  const labels = new Set<string>();
  options.forEach((opt, i) => {
    const key = opt.label.trim().toLowerCase();
    if (labels.has(key)) fail(join(join("options", i), "label"), "repeats another option's label");
    labels.add(key);
  });
  let recommendation: QuestionCard["recommendation"];
  if (o.recommendation !== undefined) {
    const r = object(o.recommendation, "recommendation", ["option", "why"], ["option", "why"]);
    if (typeof r.option !== "string" || letterIndex(r.option, options.length) === undefined)
      fail("recommendation.option", `is not the letter of an option (a to ${optionLetter(options.length - 1)})`);
    recommendation = { option: r.option as string, why: text(r.why, "recommendation.why", LIMITS.why)! };
  }
  const context = text(o.context, "context", LIMITS.context, { optional: true });
  return {
    title: text(o.title, "title", LIMITS.title, { oneLine: true })!,
    ask: text(o.ask, "ask", LIMITS.ask)!,
    ...(context !== undefined ? { context } : {}),
    options,
    ...(recommendation ? { recommendation } : {}),
  };
}

function checklist(v: unknown): ChecklistCard {
  const o = object(v, "", ["title", "items"], ["title", "items"]);
  const items = list(o.items, "items", 1, LIMITS.checklistItemsMax, "items").map((raw, i) => {
    const p = join("items", i);
    const it = object(raw, p, ["text", "done"], ["text", "done"]);
    if (typeof it.done !== "boolean") fail(join(p, "done"), "is not true or false");
    return { text: text(it.text, join(p, "text"), LIMITS.checklistText, { oneLine: true })!, done: it.done as boolean };
  });
  return { title: text(o.title, "title", LIMITS.title, { oneLine: true })!, items };
}

function status(v: unknown): StatusCard {
  const o = object(v, "", ["title", "tone", "line", "detail"], ["title", "tone", "line"]);
  if (!STATUS_TONES.includes(o.tone as StatusTone)) fail("tone", `is not one of ${STATUS_TONES.join(", ")}`);
  const detail = text(o.detail, "detail", LIMITS.statusDetail, { optional: true });
  return {
    title: text(o.title, "title", LIMITS.title, { oneLine: true })!,
    tone: o.tone as StatusTone,
    line: text(o.line, "line", LIMITS.statusLine, { oneLine: true })!,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function table(v: unknown): TableCard {
  const o = object(v, "", ["title", "columns", "rows"], ["columns", "rows"]);
  const columns = list(o.columns, "columns", 1, LIMITS.columnsMax, "columns").map((c, i) => text(c, join("columns", i), LIMITS.columnHead, { oneLine: true })!);
  const rows = list(o.rows, "rows", 0, LIMITS.rowsMax, "rows").map((raw, r) => {
    const p = join("rows", r);
    const cells = list(raw, p, columns.length, columns.length, "cells");
    return cells.map((c, i) => {
      if (typeof c !== "string") return fail(join(p, i), "is not text");
      if ([...c].length > LIMITS.cell) return fail(join(p, i), `is longer than ${LIMITS.cell} characters`);
      return c;
    });
  });
  const title = text(o.title, "title", LIMITS.title, { oneLine: true, optional: true });
  return { ...(title !== undefined ? { title } : {}), columns, rows };
}

/** A catalogue command id: dotted lowercase words (`session.send`, `ext.tickets.create`). */
const COMMAND_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

function buttons(v: unknown): ButtonsCard {
  const o = object(v, "", ["title", "note", "buttons"], ["title", "buttons"]);
  const bs = list(o.buttons, "buttons", 1, LIMITS.buttonsMax, "buttons").map((raw, i): CardButton => {
    const p = join("buttons", i);
    const b = object(raw, p, ["label", "about", "does", "confirm"], ["label", "does"]);
    const dp = join(p, "does");
    const d = object(b.does, dp, ["kind", "text", "command", "params"], ["kind"]);
    let does: ButtonDoes;
    if (d.kind === "answer") {
      if (d.text !== undefined || d.command !== undefined || d.params !== undefined) fail(dp, "answers the card, so it takes nothing else");
      does = { kind: "answer" };
    } else if (d.kind === "send") {
      if (d.command !== undefined || d.params !== undefined) fail(dp, "sends a text, so it takes no command");
      does = { kind: "send", text: text(d.text, join(dp, "text"), LIMITS.send)! };
    } else if (d.kind === "run") {
      if (d.text !== undefined) fail(join(dp, "text"), "is not a field a run has");
      const command = text(d.command, join(dp, "command"), LIMITS.command, { oneLine: true })!;
      if (!COMMAND_ID.test(command)) fail(join(dp, "command"), "is not a command id");
      if (d.params !== undefined && !isObject(d.params)) fail(join(dp, "params"), "is not an object");
      does = { kind: "run", command, ...(d.params !== undefined ? { params: d.params as Record<string, unknown> } : {}) };
    } else return fail(join(dp, "kind"), "is not one of answer, send, run");
    const about = text(b.about, join(p, "about"), LIMITS.about, { oneLine: true, optional: true });
    const confirm = text(b.confirm, join(p, "confirm"), LIMITS.confirm, { optional: true });
    return { label: text(b.label, join(p, "label"), LIMITS.buttonLabel, { oneLine: true })!, ...(about !== undefined ? { about } : {}), does, ...(confirm !== undefined ? { confirm } : {}) };
  });
  const labels = new Set<string>();
  bs.forEach((b, i) => {
    const key = b.label.trim().toLowerCase();
    if (labels.has(key)) fail(join(join("buttons", i), "label"), "repeats another button's label");
    labels.add(key);
  });
  const note = text(o.note, "note", LIMITS.note, { optional: true });
  return { title: text(o.title, "title", LIMITS.title, { oneLine: true })!, ...(note !== undefined ? { note } : {}), buttons: bs };
}

const CHECKS: { [K in DataCardKind]: (v: unknown) => DataCardMap[K] } = { question, checklist, status, table, buttons };

/** The byte length of `data` as JSON (UTF-8), or undefined when it isn't JSON at all. */
export function cardDataBytes(data: unknown): number | undefined {
  try {
    const json = JSON.stringify(data);
    return json === undefined ? undefined : new TextEncoder().encode(json).length;
  } catch {
    return undefined;
  }
}

/**
 * Checks `data` against data card `kind`'s shape: the data rebuilt from the fields it may have
 * (nothing else carried along), or the first field that broke a rule.
 */
export function checkCardData<K extends DataCardKind>(kind: K, data: unknown): CardDataCheck<K> {
  if (!DATA_CARDS.includes(kind)) return { ok: false, error: { path: "draws", why: `is not one of ${DATA_CARDS.join(", ")}` } };
  const bytes = cardDataBytes(data);
  if (bytes === undefined) return { ok: false, error: { path: "data", why: "is not JSON" } };
  if (bytes > CARD_DATA_MAX_BYTES) return { ok: false, error: { path: "data", why: `is larger than ${CARD_DATA_MAX_BYTES / 1024} KB` } };
  try {
    return { ok: true, data: CHECKS[kind](data) as DataCardMap[K] };
  } catch (e) {
    if (e instanceof Broke) return { ok: false, error: e.at };
    throw e;
  }
}

/** The text of a refused raise: "Nothing was raised: options[2].label is longer than 120 characters." */
export const notRaisedText = (e: CardDataError): string => `Nothing was raised: ${cardDataErrorText(e)}.`;

/**
 * The px a data card reserves before it draws (§chat.transcript-cards/toolkit), from its checked
 * data at a content width of `width` px: its chrome plus a line per wrapped line of text. An
 * estimate, never a measure: a card that has drawn keeps its real height.
 */
export function dataCardHeight<K extends DataCardKind>(kind: K, data: DataCardMap[K], width = 640): number {
  const perLine = Math.max(20, Math.floor(width / 8));
  const lines = (s: string | undefined) => (s ? s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / perLine)), 0) : 0);
  const LINE = 22;
  const HEAD = 52;
  switch (kind) {
    case "question": {
      const q = data as QuestionCard;
      const opts = q.options.reduce((n, o) => n + 12 + LINE * (lines(o.label) + lines(o.tradeoff)), 0);
      return HEAD + LINE * (lines(q.ask) + lines(q.context)) + opts + (q.recommendation ? 12 + LINE * (1 + lines(q.recommendation.why)) : 0) + 16;
    }
    case "checklist":
      return HEAD + (data as ChecklistCard).items.reduce((n, it) => n + 8 + LINE * lines(it.text), 0) + 16;
    case "status": {
      const s = data as StatusCard;
      return HEAD + LINE * (lines(s.line) + lines(s.detail)) + 16;
    }
    case "table": {
      const t = data as TableCard;
      const shown = Math.min(t.rows.length, LIMITS.rowsShown);
      return (t.title ? HEAD : 16) + 36 * (1 + shown) + (t.rows.length > LIMITS.rowsShown ? 52 : 0) + 16;
    }
    case "buttons": {
      const b = data as ButtonsCard;
      return HEAD + LINE * lines(b.note) + 56;
    }
  }
  return HEAD;
}
