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
export const FILE_MAX_BYTES = 64 * 1024;
/** "Rarely used": shown at least this often, used under RARE_SHARE of those. */
export const RARE_MIN_SHOWN = 5;
export const RARE_SHARE = 0.2;

export const CONDITIONS = ["branch-ready", "waiting-for-ok", "tree-clean", "no-open-alignment", "has-merge-captain"] as const;
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
export const TITLE_FILLS = ["branch", "base", "project"] as const;
export const SEND_FILLS = ["branch", "base", "commit", "project"] as const;

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface OfferButtonDef {
  label: string;
  about: string;
  send?: string;
  run?: RunId;
  /** With send, on an another-chat offer: the text goes to the session that showed it. */
  to?: "shower";
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
}

export type ParsedOffer = { name: string; ok: true; def: OfferDef } | { name: string; ok: false; error: string };

export type ParsedOffersFile = { state: "missing" } | { state: "broken"; error: string } | { state: "ok"; offers: ParsedOffer[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The keys the offers file, an offer and a button may hold (the parse refuses any other; the settings reference covers each). */
export const OFFERS_FILE_KEYS = ["version", "offers"] as const;
export const OFFER_KEYS = ["when", "why", "title", "onlyIf", "repeat", "shownBy", "disabled", "buttons"] as const;
export const BUTTON_KEYS = ["label", "about", "send", "run", "to"] as const;

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

function checkFills(s: string, allowed: readonly string[], where: string): void {
  for (const f of fillsIn(s)) if (!allowed.includes(f)) fail(`${where} uses {${f}}; only ${allowed.map((a) => `{${a}}`).join(", ")} are filled in`);
}

/** Whether a run id is one a button may name: on the run list and in the catalogue. */
export const runAllowed = (id: string): id is RunId => (RUN_ALLOWED as readonly string[]).includes(id) && !!findCommand(id);

function parseButton(raw: unknown, i: number, shownBy: OfferShownBy): OfferButtonDef {
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
    checkFills(out.send, SEND_FILLS, `${where}.send`);
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
  return out;
}

function parseOffer(raw: unknown): OfferDef {
  if (!isObj(raw)) return fail("an offer must be an object");
  keysOnly(raw, OFFER_KEYS, "the offer");
  const when = text(raw, "when", WHEN_MAX, "the offer", true);
  const why = text(raw, "why", WHY_MAX, "the offer", false);
  const title = text(raw, "title", TITLE_MAX, "the offer", true);
  checkFills(title, TITLE_FILLS, "title");
  let onlyIf: OfferCondition[] = [];
  if (raw.onlyIf !== undefined) {
    if (!Array.isArray(raw.onlyIf)) fail('"onlyIf" must be a list of conditions');
    for (const c of raw.onlyIf as unknown[]) if (typeof c !== "string" || !(CONDITIONS as readonly string[]).includes(c)) fail(`unknown condition ${JSON.stringify(c)} (known: ${CONDITIONS.join(", ")})`);
    onlyIf = [...new Set(raw.onlyIf as OfferCondition[])];
  }
  const repeat = raw.repeat ?? "once-per-commit";
  if (typeof repeat !== "string" || !(REPEATS as readonly string[]).includes(repeat)) fail(`"repeat" is one of ${REPEATS.join(", ")}`);
  const shownBy = raw.shownBy ?? "agent";
  if (typeof shownBy !== "string" || !(SHOWN_BY as readonly string[]).includes(shownBy)) fail(`"shownBy" is one of ${SHOWN_BY.join(", ")}`);
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") fail('"disabled" is true or false');
  if (!Array.isArray(raw.buttons) || raw.buttons.length < 1) fail('"buttons" must list 1 to 4 buttons');
  const list = raw.buttons as unknown[];
  if (list.length > BUTTONS_MAX) fail(`"buttons" lists ${list.length} (at most ${BUTTONS_MAX})`);
  const buttons = list.map((b, i) => parseButton(b, i, shownBy as OfferShownBy));
  const labels = new Set<string>();
  for (const b of buttons) {
    const k = b.label.trim().toLowerCase();
    if (k === "not now") fail('"Not Now" is Sova\'s own link on every card; pick another label');
    if (labels.has(k)) fail(`two buttons are labelled "${b.label}"`);
    labels.add(k);
  }
  return { when, ...(why ? { why } : {}), title, onlyIf, repeat: repeat as OfferRepeat, shownBy: shownBy as OfferShownBy, disabled: raw.disabled === true, buttons };
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
  const extra = Object.keys(raw).filter((k) => !(OFFERS_FILE_KEYS as readonly string[]).includes(k));
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
}
export interface OfferSnapshot {
  offers: OfferSnapshotEntry[];
}

/** The snapshot of a file as read now; null when the agent may show none of its offers. */
export function snapshotOf(file: ParsedOffersFile): OfferSnapshot | null {
  if (file.state !== "ok") return null;
  const offers = file.offers.flatMap((o) =>
    o.ok && !o.def.disabled && o.def.shownBy === "agent" ? [{ name: o.name, when: o.def.when, ...(o.def.why ? { why: o.def.why } : {}), abouts: o.def.buttons.map((b) => b.about) }] : [],
  );
  return offers.length ? { offers } : null;
}

/** A stored snapshot, read back strictly (a bad one reads as none). */
export function normalizeSnapshot(raw: unknown): OfferSnapshot | null {
  if (!isObj(raw) || !Array.isArray(raw.offers)) return null;
  const offers: OfferSnapshotEntry[] = [];
  for (const o of raw.offers) {
    if (!isObj(o) || typeof o.name !== "string" || !NAME_RE.test(o.name) || typeof o.when !== "string" || !Array.isArray(o.abouts) || !o.abouts.every((a) => typeof a === "string")) return null;
    offers.push({ name: o.name, when: o.when, ...(typeof o.why === "string" ? { why: o.why } : {}), abouts: o.abouts as string[] });
  }
  return offers.length ? { offers } : null;
}

/** The tool's description: made only from each offer's when, why and button about lines. */
export function offerToolDescription(s: OfferSnapshot): string {
  const lines = s.offers.map((o) => {
    const parts = [`- ${o.name}: ${o.when}`];
    if (o.why) parts.push(`  Why: ${o.why}`);
    for (const a of o.abouts) parts.push(`  A button: ${a}`);
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
  return {
    type: "object",
    properties: {
      offer: { type: "string", enum: s.offers.map((o) => o.name), description: "The offer to show, by name." },
      note: { type: "string", minLength: 1, maxLength: NOTE_MAX, description: "Optional: one short sentence under the card's title." },
    },
    required: ["offer"],
    additionalProperties: false,
  };
}

/** `{name}` placeholders filled from `facts`; one without a value reads as a plain phrase. */
export function fillText(template: string, facts: Partial<Record<string, string>>): string {
  const fallback: Record<string, string> = { branch: "this branch", base: "its base", commit: "this commit", project: "this project" };
  return template.replace(/\{([a-z]+)\}/g, (m, k: string) => facts[k]?.trim() || fallback[k] || m);
}

// ── The card ─────────────────────────────────────────────────────────────────

export type OfferCardState = "open" | "chosen" | "not-now" | "superseded" | "withdrawn";

export interface OfferCardButton {
  label: string;
  about: string;
  kind: "send" | "run";
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
  choice?: { index: number; label: string; at: string };
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

/** A card read back from a result's details or a route's answer; undefined when it isn't one. */
export function normalizeOfferCard(raw: unknown): OfferCard | undefined {
  if (!isObj(raw)) return undefined;
  const { id, name, title, at, by, state } = raw;
  if (typeof id !== "string" || !/^of_[1-9][0-9]*$/.test(id) || typeof name !== "string" || typeof title !== "string" || typeof at !== "string") return undefined;
  if (by !== "agent" && by !== "another-chat") return undefined;
  if (typeof state !== "string" || !(CARD_STATES as readonly string[]).includes(state)) return undefined;
  if (!Array.isArray(raw.buttons)) return undefined;
  const buttons: OfferCardButton[] = [];
  for (const b of raw.buttons) {
    if (!isObj(b) || typeof b.label !== "string" || typeof b.about !== "string" || (b.kind !== "send" && b.kind !== "run")) return undefined;
    buttons.push({ label: b.label, about: b.about, kind: b.kind });
  }
  const out: OfferCard = { id, name, title, buttons, at, by, state: state as OfferCardState };
  if (typeof raw.note === "string") out.note = raw.note;
  if (isObj(raw.from) && typeof raw.from.id === "string" && typeof raw.from.title === "string") out.from = { id: raw.from.id, title: raw.from.title };
  if (typeof raw.toolCallId === "string") out.toolCallId = raw.toolCallId;
  if (isObj(raw.choice) && typeof raw.choice.index === "number" && typeof raw.choice.label === "string" && typeof raw.choice.at === "string") out.choice = { index: raw.choice.index, label: raw.choice.label, at: raw.choice.at };
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
  buttons?: { label: string; about: string; kind: "send" | "run"; run?: string; to?: "shower" }[];
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
