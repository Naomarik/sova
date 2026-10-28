/**
 * Session offers (§chat/offers): a project's named button cards its agent may show. The offers file's
 * shape and its strict parse, the snapshot a session's tool is built from, the tool's words, the
 * card as the wire carries it, and the fills of a title or a button's text.
 *
 * Called "session offers" in code and on the wire: "offers" already names what an extension offers
 * (shared/extension-offers.ts) and baton offers. The screen says Offers.
 *
 * Pure TS, no DOM and no node: the server (the tool, the routes) and the client (the card, the
 * project list) import it.
 */
import { findCommand } from "./commands-catalog.ts";

/** The tool's name, in the loadout and on every tool result. */
export const OFFER_TOOL = "offer";
/** The file, relative to the project root (the main checkout). */
export const OFFERS_FILE = ".sova/offers.json";
/** customType of the hidden note that tells the agent a run button's outcome. */
export const OFFER_NOTE_MESSAGE = "sova-offer-note";
/** Version of the tool result's `details`. */
export const OFFER_DETAILS_VERSION = 1;

export const OFFERS_MAX = 8;
export const BUTTONS_MAX = 4;
export const NAME_MAX = 32;
export const WHEN_MAX = 200;
export const WHY_MAX = 200;
export const TITLE_MAX = 120;
export const LABEL_MAX = 32;
export const ABOUT_MAX = 160;
export const SEND_MAX = 500;
export const NOTE_MAX = 300;
export const CONFIRM_MAX = 300;
/** Rows (§chat.offers/card, Rows): at most this many on one card, whatever the file's `max`. */
export const ROWS_MAX = 10;
export const ROW_LABEL_MAX = 80;
export const ROW_VALUE_MAX = 120;
export const ROW_KEY_RE = /^[a-z][a-z0-9-]{0,23}$/;
/** The `all` button's confirm may name the rows it answers. */
export const ALL_FILLS = ["branch", "base", "commit", "project", "rows"] as const;
export const FILE_MAX_BYTES = 64 * 1024;
/** "Rarely used": shown at least this often, used under RARE_SHARE of those. */
export const RARE_MIN_SHOWN = 5;
export const RARE_SHARE = 0.2;

export const CONDITIONS = ["branch-ready", "waiting-for-ok", "tree-clean", "no-open-alignment", "has-merge-captain", "ready-to-land", "specs-promoted", "specs-left"] as const;
export type OfferCondition = (typeof CONDITIONS)[number];
export const REPEATS = ["once-per-commit", "once-per-reply", "once-per-session"] as const;
export type OfferRepeat = (typeof REPEATS)[number];
export const SHOWN_BY = ["agent", "another-chat"] as const;
export type OfferShownBy = (typeof SHOWN_BY)[number];

/**
 * The catalogue actions a run button may name (§chat.offers/buttons): each one acts on the session's
 * own branch, and every parameter comes from Sova's facts about the session. An id must also be in
 * the catalogue (shared/commands-catalog.ts) to count.
 */
export const RUN_ALLOWED = ["project.worktree.merge"] as const;
export type RunId = (typeof RUN_ALLOWED)[number];

/** Placeholders a title may use, and those a send text may use. */
/** `{commit}` in a title is the moment's commit shortened to TITLE_COMMIT_LEN characters. */
export const TITLE_FILLS = ["branch", "base", "commit", "project"] as const;
export const TITLE_COMMIT_LEN = 7;
export const SEND_FILLS = ["branch", "base", "commit", "project", "drafts"] as const;
/** What a button's landing key records (§chat.offers/buttons): the user's go-ahead for this commit, or Not Yet. */
export const LANDING_RECORDS = ["go-ahead", "go-ahead-without-specs", "not-yet"] as const;
export type LandingRecord = (typeof LANDING_RECORDS)[number];
/** The retired merge guard's top-level switch: a leftover one is accepted and does nothing (§chat.offers/file). */
export const RETIRED_FILE_KEYS = ["mainMerges"] as const;

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface OfferButtonDef {
  label: string;
  about: string;
  send?: string;
  run?: RunId;
  /** With send, on an another-chat offer: the text goes to the session that showed it. */
  to?: "shower";
  /** The button shows only when these hold too. */
  onlyIf?: OfferCondition[];
  /** The card asks this first (`{drafts}` and the send fills filled in). */
  confirm?: string;
  /** With send: what the click records once its send went through. */
  landing?: LandingRecord;
}

/** An offer's rows (§chat.offers/file): each row repeats its buttons for one item. */
export interface OfferRowsDef {
  max: number;
  /** One button that answers every open row at once, after its confirm ({rows} filled in). */
  all?: { label: string; about: string; confirm: string };
}

export interface OfferDef {
  when: string;
  why?: string;
  title: string;
  onlyIf: OfferCondition[];
  repeat: OfferRepeat;
  shownBy: OfferShownBy;
  disabled: boolean;
  buttons: OfferButtonDef[];
  rows?: OfferRowsDef;
}

export type ParsedOffer = { name: string; ok: true; def: OfferDef } | { name: string; ok: false; error: string };

export type ParsedOffersFile = { state: "missing" } | { state: "broken"; error: string } | { state: "ok"; offers: ParsedOffer[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The keys the offers file, an offer and a button may hold (the parse refuses any other; the settings reference covers each). */
export const OFFERS_FILE_KEYS = ["version", "offers"] as const;
export const OFFER_KEYS = ["when", "why", "title", "onlyIf", "repeat", "shownBy", "disabled", "buttons", "rows"] as const;
export const ROWS_KEYS = ["max", "all"] as const;
export const ALL_KEYS = ["label", "about", "confirm"] as const;
export const BUTTON_KEYS = ["label", "about", "send", "run", "to", "onlyIf", "confirm", "landing"] as const;

class OfferError extends Error {}
const fail = (message: string): never => {
  throw new OfferError(message);
};

function keysOnly(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where} has an unknown key "${k}"`);
}

function text(o: Record<string, unknown>, key: string, max: number, where: string, required: true): string;
function text(o: Record<string, unknown>, key: string, max: number, where: string, required: false): string | undefined;
function text(o: Record<string, unknown>, key: string, max: number, where: string, required: boolean): string | undefined {
  const v = o[key];
  if (v === undefined) return required ? fail(`${where} needs "${key}"`) : undefined;
  if (typeof v !== "string" || !v.trim()) return fail(`${where}: "${key}" must be a non-empty string`);
  if (v.length > max) fail(`${where}: "${key}" is ${v.length} characters (at most ${max})`);
  return v;
}

/** The `{name}` placeholders in `s`. */
export const fillsIn = (s: string): string[] => [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);

function checkFills(s: string, allowed: readonly string[], where: string, rows = false): void {
  for (const f of fillsIn(s)) {
    if (f.startsWith("row.")) {
      if (!rows) fail(`${where} uses {${f}}; only an offer with "rows" fills in {row.<key>}`);
      if (!ROW_KEY_RE.test(f.slice(4))) fail(`${where} uses {${f}}; a row key is lowercase letters, digits and hyphens, starting with a letter, at most 24 characters`);
      continue;
    }
    if (!allowed.includes(f)) fail(`${where} uses {${f}}; only ${allowed.map((a) => `{${a}}`).join(", ")}${rows ? " and {row.<key>}" : ""} are filled in`);
  }
}

/** The `{row.<key>}` keys an offer's buttons use, in the order first met. */
export function rowKeysOf(def: Pick<OfferDef, "buttons">): string[] {
  const keys: string[] = [];
  for (const b of def.buttons)
    for (const t of [b.send, b.confirm]) for (const f of t ? fillsIn(t) : []) if (f.startsWith("row.") && !keys.includes(f.slice(4))) keys.push(f.slice(4));
  return keys;
}

/** `{row.<key>}` placeholders filled from one row's values (the rest is fillText's). */
export const fillRow = (template: string, values: Record<string, string>): string => template.replace(/\{row\.([a-z][a-z0-9-]*)\}/g, (m, k: string) => values[k] ?? m);

/** Whether a run id is one a button may name: on the run list and in the catalogue. */
export const runAllowed = (id: string): id is RunId => (RUN_ALLOWED as readonly string[]).includes(id) && !!findCommand(id);

function parseButton(raw: unknown, i: number, shownBy: OfferShownBy, rows: boolean): OfferButtonDef {
  const where = `buttons[${i}]`;
  if (!isObj(raw)) return fail(`${where} must be an object`);
  keysOnly(raw, BUTTON_KEYS, where);
  const label = text(raw, "label", LABEL_MAX, where, true);
  const about = text(raw, "about", ABOUT_MAX, where, true);
  if (/\n/.test(about)) fail(`${where}: "about" is one line`);
  const hasSend = raw.send !== undefined;
  const hasRun = raw.run !== undefined;
  if (hasSend === hasRun) fail(`${where} needs exactly one of "send" or "run"`);
  const out: OfferButtonDef = { label, about };
  if (hasSend) {
    out.send = text(raw, "send", SEND_MAX, where, true);
    checkFills(out.send, SEND_FILLS, `${where}.send`, rows);
  } else {
    const run = raw.run;
    if (typeof run !== "string") return fail(`${where}: "run" must be a catalogue id`);
    if (!findCommand(run)) fail(`${where}: "${run}" is no Sova catalogue action`);
    if (!runAllowed(run)) fail(`${where}: "${run}" is not one a button may run (only ${RUN_ALLOWED.join(", ")})`);
    out.run = run as RunId;
  }
  if (raw.to !== undefined) {
    if (raw.to !== "shower") fail(`${where}: "to" can only be "shower"`);
    if (!hasSend) fail(`${where}: "to" goes with "send" only`);
    if (shownBy !== "another-chat") fail(`${where}: "to": "shower" needs "shownBy": "another-chat"`);
    out.to = "shower";
  }
  if (raw.onlyIf !== undefined) out.onlyIf = conditionsOf(raw.onlyIf, `${where}.onlyIf`);
  if (raw.confirm !== undefined) {
    out.confirm = text(raw, "confirm", CONFIRM_MAX, where, true);
    checkFills(out.confirm, SEND_FILLS, `${where}.confirm`, rows);
  }
  if (raw.landing !== undefined) {
    if (typeof raw.landing !== "string" || !(LANDING_RECORDS as readonly string[]).includes(raw.landing)) fail(`${where}: "landing" is one of ${LANDING_RECORDS.join(", ")}`);
    if (!hasSend) fail(`${where}: "landing" goes with "send" only`);
    out.landing = raw.landing as LandingRecord;
  }
  return out;
}

function conditionsOf(raw: unknown, where: string): OfferCondition[] {
  if (!Array.isArray(raw)) fail(`${where} must be a list of conditions`);
  for (const c of raw as unknown[]) if (typeof c !== "string" || !(CONDITIONS as readonly string[]).includes(c)) fail(`unknown condition ${JSON.stringify(c)} (known: ${CONDITIONS.join(", ")})`);
  return [...new Set(raw as OfferCondition[])];
}

function parseOffer(raw: unknown): OfferDef {
  if (!isObj(raw)) return fail("an offer must be an object");
  keysOnly(raw, OFFER_KEYS, "the offer");
  const when = text(raw, "when", WHEN_MAX, "the offer", true);
  const why = text(raw, "why", WHY_MAX, "the offer", false);
  const title = text(raw, "title", TITLE_MAX, "the offer", true);
  checkFills(title, TITLE_FILLS, "title");
  let onlyIf: OfferCondition[] = [];
  if (raw.onlyIf !== undefined) onlyIf = conditionsOf(raw.onlyIf, '"onlyIf"');
  const repeat = raw.repeat ?? "once-per-commit";
  if (typeof repeat !== "string" || !(REPEATS as readonly string[]).includes(repeat)) fail(`"repeat" is one of ${REPEATS.join(", ")}`);
  const shownBy = raw.shownBy ?? "agent";
  if (typeof shownBy !== "string" || !(SHOWN_BY as readonly string[]).includes(shownBy)) fail(`"shownBy" is one of ${SHOWN_BY.join(", ")}`);
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") fail('"disabled" is true or false');
  if (!Array.isArray(raw.buttons) || raw.buttons.length < 1) fail('"buttons" must list 1 to 4 buttons');
  const list = raw.buttons as unknown[];
  if (list.length > BUTTONS_MAX) fail(`"buttons" lists ${list.length} (at most ${BUTTONS_MAX})`);
  const rows = raw.rows === undefined ? undefined : parseRows(raw.rows);
  const buttons = list.map((b, i) => parseButton(b, i, shownBy as OfferShownBy, !!rows));
  const labels = new Set<string>();
  for (const b of buttons) {
    const k = b.label.trim().toLowerCase();
    if (k === "not now") fail('"Not Now" is Sova\'s own link on every card; pick another label');
    if (labels.has(k)) fail(`two buttons are labelled "${b.label}"`);
    labels.add(k);
  }
  if (rows && buttons.some((b) => b.run)) fail('"rows" goes with send buttons only');
  if (rows?.all) {
    const k = rows.all.label.trim().toLowerCase();
    if (k === "not now" || labels.has(k)) fail(`"rows.all" is labelled "${rows.all.label}", which another button or Not Now already is`);
  }
  return { when, ...(why ? { why } : {}), title, onlyIf, repeat: repeat as OfferRepeat, shownBy: shownBy as OfferShownBy, disabled: raw.disabled === true, buttons, ...(rows ? { rows } : {}) };
}

function parseRows(raw: unknown): OfferRowsDef {
  if (!isObj(raw)) return fail('"rows" must be an object: {"max": 1 to 10, "all"?: {label, about, confirm}}');
  keysOnly(raw, ROWS_KEYS, '"rows"');
  if (typeof raw.max !== "number" || !Number.isInteger(raw.max) || raw.max < 1 || raw.max > ROWS_MAX) fail(`"rows.max" must be a whole number from 1 to ${ROWS_MAX}`);
  const out: OfferRowsDef = { max: raw.max as number };
  if (raw.all !== undefined) {
    if (!isObj(raw.all)) return fail('"rows.all" must be an object: {label, about, confirm}');
    keysOnly(raw.all, ALL_KEYS, '"rows.all"');
    const label = text(raw.all, "label", LABEL_MAX, '"rows.all"', true);
    const about = text(raw.all, "about", ABOUT_MAX, '"rows.all"', true);
    if (/\n/.test(about)) fail('"rows.all": "about" is one line');
    const confirm = text(raw.all, "confirm", CONFIRM_MAX, '"rows.all"', true);
    checkFills(confirm, ALL_FILLS, '"rows.all".confirm');
    out.all = { label, about, confirm };
  }
  return out;
}

/** A row as whoever shows a rows card supplies it (§chat.offers/card, Rows). */
export interface OfferRowInput {
  label: string;
  values: Record<string, string>;
}

/**
 * Rows supplied for an offer, checked strictly against the file (§chat.offers/card, Rows): 1 to the offer's max
 * (never over ROWS_MAX), each a one-line label of at most ROW_LABEL_MAX and values for exactly the keys the
 * buttons use, each one line of at most ROW_VALUE_MAX. → the rows, or the reason they're refused.
 */
export function checkRows(def: OfferDef, raw: unknown): { ok: true; rows: OfferRowInput[] } | { ok: false; error: string } {
  if (!def.rows) return raw === undefined ? { ok: true, rows: [] } : { ok: false, error: "This offer takes no rows." };
  if (!Array.isArray(raw) || raw.length < 1) return { ok: false, error: "This offer's card lists rows: give 1 or more." };
  const max = Math.min(def.rows.max, ROWS_MAX);
  if (raw.length > max) return { ok: false, error: `${raw.length} rows (at most ${max}).` };
  const keys = rowKeysOf(def);
  const rows: OfferRowInput[] = [];
  for (const [i, r] of raw.entries()) {
    const where = `rows[${i}]`;
    if (!isObj(r)) return { ok: false, error: `${where} must be {label, values}.` };
    const extra = Object.keys(r).find((k) => k !== "label" && k !== "values");
    if (extra) return { ok: false, error: `${where} has an unknown key "${extra}".` };
    if (typeof r.label !== "string" || !r.label.trim()) return { ok: false, error: `${where} needs a label.` };
    if (r.label.length > ROW_LABEL_MAX || /\n/.test(r.label)) return { ok: false, error: `${where}: the label is one line of at most ${ROW_LABEL_MAX} characters.` };
    const v = r.values ?? {};
    if (!isObj(v)) return { ok: false, error: `${where}: values must be an object.` };
    const values: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!keys.includes(k)) return { ok: false, error: `${where}: {row.${k}} is in none of this offer's buttons (${keys.length ? keys.map((x) => `{row.${x}}`).join(", ") : "none"}).` };
      if (typeof x !== "string" || !x.trim() || x.length > ROW_VALUE_MAX || /\n/.test(x)) return { ok: false, error: `${where}: ${k} must be one line of 1 to ${ROW_VALUE_MAX} characters.` };
      values[k] = x;
    }
    const missing = keys.find((k) => values[k] === undefined);
    if (missing) return { ok: false, error: `${where} needs a value for {row.${missing}}.` };
    rows.push({ label: r.label.trim(), values });
  }
  return { ok: true, rows };
}

/**
 * The offers file, read strictly (§chat.offers/file): the whole file is broken when it is no JSON
 * object with exactly `version: 1` and `offers`; inside, each offer stands or falls on its own, and
 * those after the eighth are broken. `text === null`: no file.
 */
export function parseOffersFile(text: string | null): ParsedOffersFile {
  if (text === null) return { state: "missing" };
  if (text.length > FILE_MAX_BYTES) return { state: "broken", error: `The file is over ${FILE_MAX_BYTES / 1024} KB.` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { state: "broken", error: `The file is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObj(raw)) return { state: "broken", error: "The file must be a JSON object." };
  const extra = Object.keys(raw).filter((k) => !(OFFERS_FILE_KEYS as readonly string[]).includes(k) && !(RETIRED_FILE_KEYS as readonly string[]).includes(k));
  if (extra.length) return { state: "broken", error: `The file has an unknown key "${extra[0]}".` };
  if (raw.version !== 1) return { state: "broken", error: 'The file needs "version": 1.' };
  if (!isObj(raw.offers)) return { state: "broken", error: 'The file needs "offers": an object of named offers.' };
  const offers: ParsedOffer[] = [];
  for (const [name, v] of Object.entries(raw.offers)) {
    if (!NAME_RE.test(name)) {
      offers.push({ name, ok: false, error: `"${name}" is not a name: lowercase letters, digits and hyphens, starting with a letter, at most ${NAME_MAX} characters.` });
      continue;
    }
    if (offers.length >= OFFERS_MAX) {
      offers.push({ name, ok: false, error: `More than ${OFFERS_MAX} offers: only the first ${OFFERS_MAX} count.` });
      continue;
    }
    try {
      offers.push({ name, ok: true, def: parseOffer(v) });
    } catch (err) {
      if (!(err instanceof OfferError)) throw err;
      offers.push({ name, ok: false, error: `${err.message[0]!.toUpperCase()}${err.message.slice(1)}.` });
    }
  }
  return { state: "ok", offers };
}

/** The file's offer named `name`, when it is valid and enabled now. */
export function liveOffer(file: ParsedOffersFile, name: string): OfferDef | undefined {
  if (file.state !== "ok") return undefined;
  const o = file.offers.find((x) => x.name === name);
  return o?.ok && !o.def.disabled ? o.def : undefined;
}

/**
 * What a session's tool is built from (§chat.offers/tool), recorded at its first build: each enabled
 * offer the agent may show, with only the lines the tool's words come from.
 */
export interface OfferSnapshotEntry {
  name: string;
  when: string;
  why?: string;
  abouts: string[];
  /** The offer's rows, when it declares them: what the tool's rows parameter takes. */
  rows?: { max: number; keys: string[] };
}
export interface OfferSnapshot {
  offers: OfferSnapshotEntry[];
}

/** The snapshot of a file as read now; null when the agent may show none of its offers. */
export function snapshotOf(file: ParsedOffersFile): OfferSnapshot | null {
  if (file.state !== "ok") return null;
  const offers = file.offers.flatMap((o) =>
    o.ok && !o.def.disabled && o.def.shownBy === "agent"
      ? [{ name: o.name, when: o.def.when, ...(o.def.why ? { why: o.def.why } : {}), abouts: o.def.buttons.map((b) => b.about), ...(o.def.rows ? { rows: { max: Math.min(o.def.rows.max, ROWS_MAX), keys: rowKeysOf(o.def) } } : {}) }]
      : [],
  );
  return offers.length ? { offers } : null;
}

/** A stored snapshot, read back strictly (a bad one reads as none). */
export function normalizeSnapshot(raw: unknown): OfferSnapshot | null {
  if (!isObj(raw) || !Array.isArray(raw.offers)) return null;
  const offers: OfferSnapshotEntry[] = [];
  for (const o of raw.offers) {
    if (!isObj(o) || typeof o.name !== "string" || !NAME_RE.test(o.name) || typeof o.when !== "string" || !Array.isArray(o.abouts) || !o.abouts.every((a) => typeof a === "string")) return null;
    let rows: OfferSnapshotEntry["rows"];
    if (o.rows !== undefined) {
      const r = o.rows;
      if (!isObj(r) || typeof r.max !== "number" || !Number.isInteger(r.max) || r.max < 1 || r.max > ROWS_MAX || !Array.isArray(r.keys) || !r.keys.every((k) => typeof k === "string" && ROW_KEY_RE.test(k))) return null;
      rows = { max: r.max, keys: r.keys as string[] };
    }
    offers.push({ name: o.name, when: o.when, ...(typeof o.why === "string" ? { why: o.why } : {}), abouts: o.abouts as string[], ...(rows ? { rows } : {}) });
  }
  return offers.length ? { offers } : null;
}

/** The tool's description: made only from each offer's when, why and button about lines. */
export function offerToolDescription(s: OfferSnapshot): string {
  const lines = s.offers.map((o) => {
    const parts = [`- ${o.name}: ${o.when}`];
    if (o.why) parts.push(`  Why: ${o.why}`);
    for (const a of o.abouts) parts.push(`  A button: ${a}`);
    if (o.rows) parts.push(`  Takes rows (1 to ${o.rows.max}, one per item, each {label, values}${o.rows.keys.length ? ` with values for ${o.rows.keys.join(", ")}` : ", values {}"}): each row gets the buttons.`);
    return parts.join("\n");
  });
  return (
    "Show the user one of this project's offers: a card under your reply with the project's own buttons, so they answer with a click. " +
    "Show one only when its moment below has come, at most one per reply, and never while you have an open alignment question. " +
    "The card shows the buttons; don't also ask the same thing in words. You may add a short note (one sentence) under its title. " +
    "Sova may refuse (the offer was removed, its conditions don't hold, it was already shown for this moment, or the user chose Not Now): then carry on without it.\n" +
    `Offers:\n${lines.join("\n")}`
  );
}

export function offerToolParameters(s: OfferSnapshot): Record<string, unknown> {
  // Rows only for a snapshot that names an offer declaring them (§chat.offers/tool): any other's parameters are
  // exactly what they were before rows existed.
  const withRows = s.offers.filter((o) => o.rows);
  const rows = withRows.length
    ? {
        rows: {
          type: "array",
          minItems: 1,
          maxItems: Math.max(...withRows.map((o) => o.rows!.max)),
          description: `Only for ${withRows.map((o) => o.name).join(", ")}: one row per item, each with its own buttons.`,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: ROW_LABEL_MAX, description: "The row's one line." },
              values: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: ROW_VALUE_MAX }, description: "The row's values, by key." },
            },
            required: ["label", "values"],
            additionalProperties: false,
          },
        },
      }
    : {};
  return {
    type: "object",
    properties: {
      offer: { type: "string", enum: s.offers.map((o) => o.name), description: "The offer to show, by name." },
      note: { type: "string", minLength: 1, maxLength: NOTE_MAX, description: "Optional: one short sentence under the card's title." },
      ...rows,
    },
    required: ["offer"],
    additionalProperties: false,
  };
}

/** `{name}` placeholders filled from `facts`; one without a value reads as a plain phrase. */
export function fillText(template: string, facts: Partial<Record<string, string>>): string {
  const fallback: Record<string, string> = { branch: "this branch", base: "its base", commit: "this commit", project: "this project", drafts: "its spec drafts" };
  return template.replace(/\{([a-z]+)\}/g, (m, k: string) => facts[k]?.trim() || fallback[k] || m);
}

// ── The card ─────────────────────────────────────────────────────────────────

export type OfferCardState = "open" | "chosen" | "not-now" | "superseded" | "withdrawn";

export interface OfferCardButton {
  label: string;
  about: string;
  kind: "send" | "run";
  /** The card asks this before the click counts. */
  confirm?: string;
}

export type OfferRowState = "open" | "chosen" | "superseded" | "withdrawn";

/** Where an answer was given, when it wasn't on this card (§chat.offers/landing-rows): a chat's title, or "this chat". */
export interface OfferChoice {
  index: number;
  label: string;
  at: string;
  where?: string;
}

/** One row of a rows card (§chat.offers/card, Rows). */
export interface OfferCardRow {
  /** `r_N`, per card. */
  id: string;
  label: string;
  buttons: OfferCardButton[];
  state: OfferRowState;
  choice?: OfferChoice;
  /** A go-ahead row's landing (§chat.offers/landing-rows): Landing, then Landed. */
  progress?: "landing" | "landed";
  /** The captain's landing rows: the branch, its commit (7 characters), the owner chat, the drafts left. */
  branch?: string;
  commit?: string;
  owner?: { id: string; title: string };
  drafts?: string;
}

export interface OfferCard {
  /** `of_N`, per session. */
  id: string;
  name: string;
  title: string;
  note?: string;
  buttons: OfferCardButton[];
  /** ISO time it was shown. */
  at: string;
  by: "agent" | "another-chat";
  /** The session that showed it, for one from another chat. */
  from?: { id: string; title: string };
  /** The `offer` call it stands at, for one the agent showed. */
  toolCallId?: string;
  state: OfferCardState;
  choice?: OfferChoice;
  /** A rows card's rows. */
  rows?: OfferCardRow[];
  /** The file's all button, while a row it answers is open: its confirm names those rows. */
  all?: { label: string; about: string; confirm: string; rows: string[] };
  /** The captain's landing card: how many queued branches wait for this card to be answered. */
  more?: number;
  /** A run button's outcome. */
  outcome?: { state: "running" | "done" | "failed"; text?: string };
  /** The card that replaced it. */
  supersededBy?: string;
}

/** The tool result's details: the card as it was shown. */
export interface OfferDetails {
  v: typeof OFFER_DETAILS_VERSION;
  card: OfferCard;
}

const CARD_STATES: readonly OfferCardState[] = ["open", "chosen", "not-now", "superseded", "withdrawn"];
const ROW_STATES: readonly OfferRowState[] = ["open", "chosen", "superseded", "withdrawn"];

function choiceOf(raw: unknown): OfferChoice | undefined {
  if (!isObj(raw) || typeof raw.index !== "number" || typeof raw.label !== "string" || typeof raw.at !== "string") return undefined;
  return { index: raw.index, label: raw.label, at: raw.at, ...(typeof raw.where === "string" && raw.where ? { where: raw.where } : {}) };
}

function buttonsOf(raw: unknown): OfferCardButton[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: OfferCardButton[] = [];
  for (const b of raw) {
    if (!isObj(b) || typeof b.label !== "string" || typeof b.about !== "string" || (b.kind !== "send" && b.kind !== "run")) return undefined;
    out.push({ label: b.label, about: b.about, kind: b.kind, ...(typeof b.confirm === "string" && b.confirm ? { confirm: b.confirm } : {}) });
  }
  return out;
}

function rowOf(raw: unknown): OfferCardRow | undefined {
  if (!isObj(raw) || typeof raw.id !== "string" || !/^r_[1-9][0-9]*$/.test(raw.id) || typeof raw.label !== "string") return undefined;
  if (typeof raw.state !== "string" || !(ROW_STATES as readonly string[]).includes(raw.state)) return undefined;
  const buttons = buttonsOf(raw.buttons);
  if (!buttons) return undefined;
  const out: OfferCardRow = { id: raw.id, label: raw.label, buttons, state: raw.state as OfferRowState };
  const choice = choiceOf(raw.choice);
  if (choice) out.choice = choice;
  if (raw.progress === "landing" || raw.progress === "landed") out.progress = raw.progress;
  for (const k of ["branch", "commit", "drafts"] as const) if (typeof raw[k] === "string") out[k] = raw[k] as string;
  if (isObj(raw.owner) && typeof raw.owner.id === "string" && typeof raw.owner.title === "string") out.owner = { id: raw.owner.id, title: raw.owner.title };
  return out;
}

/** A card read back from a result's details or a route's answer; undefined when it isn't one. */
export function normalizeOfferCard(raw: unknown): OfferCard | undefined {
  if (!isObj(raw)) return undefined;
  const { id, name, title, at, by, state } = raw;
  if (typeof id !== "string" || !/^of_[1-9][0-9]*$/.test(id) || typeof name !== "string" || typeof title !== "string" || typeof at !== "string") return undefined;
  if (by !== "agent" && by !== "another-chat") return undefined;
  if (typeof state !== "string" || !(CARD_STATES as readonly string[]).includes(state)) return undefined;
  const buttons = buttonsOf(raw.buttons);
  if (!buttons) return undefined;
  const out: OfferCard = { id, name, title, buttons, at, by, state: state as OfferCardState };
  if (typeof raw.note === "string") out.note = raw.note;
  if (isObj(raw.from) && typeof raw.from.id === "string" && typeof raw.from.title === "string") out.from = { id: raw.from.id, title: raw.from.title };
  if (typeof raw.toolCallId === "string") out.toolCallId = raw.toolCallId;
  const choice = choiceOf(raw.choice);
  if (choice) out.choice = choice;
  if (Array.isArray(raw.rows)) {
    const rows = raw.rows.map(rowOf);
    if (rows.some((r) => !r)) return undefined;
    out.rows = rows as OfferCardRow[];
  }
  if (isObj(raw.all) && typeof raw.all.label === "string" && typeof raw.all.about === "string" && typeof raw.all.confirm === "string" && Array.isArray(raw.all.rows) && raw.all.rows.every((r) => typeof r === "string"))
    out.all = { label: raw.all.label, about: raw.all.about, confirm: raw.all.confirm, rows: raw.all.rows as string[] };
  if (typeof raw.more === "number" && Number.isInteger(raw.more) && raw.more > 0) out.more = raw.more;
  if (isObj(raw.outcome) && (raw.outcome.state === "running" || raw.outcome.state === "done" || raw.outcome.state === "failed"))
    out.outcome = { state: raw.outcome.state, ...(typeof raw.outcome.text === "string" ? { text: raw.outcome.text } : {}) };
  if (typeof raw.supersededBy === "string") out.supersededBy = raw.supersededBy;
  return out;
}

/** A result's details, when they are an offer card's. */
export function normalizeOfferDetails(raw: unknown): OfferCard | undefined {
  if (!isObj(raw) || raw.v !== OFFER_DETAILS_VERSION) return undefined;
  return normalizeOfferCard(raw.card);
}

// ── Wire answers ─────────────────────────────────────────────────────────────

/** GET /api/session-offers?path=: the session's cards, newest last. */
export interface SessionOffersAnswer {
  cards: OfferCard[];
  /** The offers this session hid with Not Now. */
  notNow: string[];
  /** Whether the session's project has an offers file at all (no file: nothing to poll for). */
  hasFile: boolean;
}

export interface ProjectOfferRow {
  name: string;
  state: "ok" | "broken" | "disabled";
  error?: string;
  when?: string;
  why?: string;
  title?: string;
  shownBy?: OfferShownBy;
  onlyIf?: OfferCondition[];
  repeat?: OfferRepeat;
  buttons?: { label: string; about: string; kind: "send" | "run"; run?: string; to?: "shower"; onlyIf?: OfferCondition[]; confirm?: string; landing?: LandingRecord }[];
  rows?: OfferRowsDef;
  shown: number;
  used: number;
  rarelyUsed: boolean;
}

/** GET /api/projects/:pid/offers: the project page's Offers list (§chat.offers/project-list). */
export interface ProjectOffersAnswer {
  root: string;
  file: "missing" | "broken" | "ok";
  error?: string;
  offers: ProjectOfferRow[];
  /** Present when the file has run buttons. */
  runs?: { fingerprint: string; approved: boolean; buttons: { offer: string; label: string; run: string }[] };
}

/** Whether a row reads Rarely used. */
export const rarelyUsed = (shown: number, used: number): boolean => shown >= RARE_MIN_SHOWN && used < shown * RARE_SHARE;

/** The run buttons of a file's valid offers, in file order: what an approval covers. */
export function runButtonsOf(file: ParsedOffersFile): { offer: string; label: string; run: string }[] {
  if (file.state !== "ok") return [];
  return file.offers.flatMap((o) => (o.ok ? o.def.buttons.filter((b) => b.run).map((b) => ({ offer: o.name, label: b.label, run: b.run! })) : []));
}
