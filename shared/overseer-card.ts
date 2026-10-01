/**
 * The Overseer's decision cards (§app.overseer/confirm): the card shape, the `sova_card` tool's
 * operations (validated and applied atomically), the fold of the tool results' snapshots along a
 * branch, and every text the model or a renderer reads (the tool's echo, the hidden open-cards note,
 * the change line, the message a click composes and its exact match). A clone of the align minor
 * mode's model (pi-config/extensions/mode/align.ts): its patterns, not its types.
 *
 * Pure TS, no DOM and no node: the server (the tool, the note, the people-facing gate) and the
 * client (the card, the chip) import it, so both sides read one shape. Nothing here throws on odd
 * stored data; the tool's input errors throw CardError with a sentence the model can act on. What
 * needs the host (resolving item ids and link targets) is done by the caller first and handed in
 * as `CardPrepared`.
 */
import type { SovaConfirmItem } from "./protocol";
import { type CardOptionLater, type CardOptionRule, GRANT_DEFAULT_MS, GRANT_MAX_AHEAD_MS, GRANTABLE_ACTS, type GrantableAct } from "./overseer-grants";

/** The tool's name, in the loadout and on every tool result. */
export const CARD_TOOL = "sova_card";
/** The tool it replaced: its results are never folded, and render read-only. */
export const LEGACY_CONFIRM_TOOL = "sova_confirm";
/** customType of the hidden note on each user prompt listing the open cards. */
export const CARDS_NOTE_MESSAGE = "overseer-cards";
/** Version of the tool result's `details`. */
export const CARD_DETAILS_VERSION = 1;
/** Answer options (lettered) and link options (not) a card may carry. */
export const CARD_ANSWERS_MAX = 4;
export const CARD_LINKS_MAX = 4;
/** Per-item choices: 2 to 4 per list, the card's (every row without its own) or a row's own. */
export const CARD_CHOICES_MIN = 2;
export const CARD_CHOICES_MAX = 4;

// ── The card ─────────────────────────────────────────────────────────────────

/**
 * One option. With `href` it is a link (resolved by the server when the card was raised: `#/…`,
 * `settings:<tab>`, or an `https` URL): it never answers the card and carries no letter. Otherwise
 * an answer option, lettered in order among the answer options. New optional fields (a timer `at`,
 * a proposed rule) are additive: the normalizer keeps only what it knows, and the op table names
 * each accepted input field.
 */
export interface CardOption {
  label: string;
  reply?: string;
  tone?: "danger";
  href?: string;
  /** Its click approves any act on the card's sessions until the deadline (§app.overseer/approvals). */
  later?: CardOptionLater;
  /** Its click adopts this standing rule (§app.overseer/approvals). */
  rule?: CardOptionRule;
}

export type CardAnswerBy = "user" | "accepted-recommendation";

/** An item's recorded answer: a choice by letter (its label as text), or the user's words. */
export interface CardItemDecision {
  choice?: string;
  text: string;
  by: CardAnswerBy;
  /** ISO timestamp. */
  at: string;
}

/** A card row: the resolved item snapshot, its number (1..N in display order, never renumbered),
    its own choices when they differ from the card's (`choices`, lettered per row), the choice it
    starts on (`default`, also the recommendation for it) and its answer once recorded. */
export type CardItem = SovaConfirmItem & { n: number; choices?: { label: string }[]; default?: string; decided?: CardItemDecision };

/** The card's answer: the user's words, the option letter when it was one. */
export interface CardAnswer {
  text: string;
  option?: string;
  by: CardAnswerBy;
  at: string;
}

export interface CardRecommendation {
  /** An answer option's letter. */
  option?: string;
  why: string;
}

export type CardPhase = "open" | "answered" | "superseded" | "dropped";

export interface OverseerCard {
  /** `c_N`. */
  id: string;
  title: string;
  detail?: string;
  options: CardOption[];
  items: CardItem[];
  choices?: { label: string }[];
  recommendation?: CardRecommendation;
  /** The global Overseer's card listing a person, a project or a gathering session: only a click
      approves what it gates (§app.overseer/org-people-facing). */
  clickOnly?: true;
  /** The card this one replaced. */
  replaces?: string;
  phase: CardPhase;
  answer?: CardAnswer;
  /** phase superseded: the card that replaced it. */
  supersededBy?: string;
  /** phase dropped: why. */
  droppedWhy?: string;
  /** 1 at create, +1 per changing call. */
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export type CardChange =
  | { kind: "created"; replaces?: string }
  /** A card-level answer (`option` when it was one), or items decided (`items`); `complete`: it is now answered. */
  | { kind: "answered"; option?: string; items?: number[]; complete?: true }
  | { kind: "accepted"; option?: string; items?: number[]; complete?: true }
  | { kind: "reopened" }
  | { kind: "dropped" }
  /** On the replaced card's snapshot (`closed`). */
  | { kind: "superseded"; by: string };

/**
 * The tool result's `details`: the authoritative record. `card` is the touched card's full snapshot
 * after the call (absent for a read-only call); `closed` the card a create replaced, as it is now.
 */
export interface CardDetails {
  v: 1;
  card?: OverseerCard;
  closed?: OverseerCard;
  changes: CardChange[];
  /** changeLine(changes): "answered b"; "" when nothing changed. */
  line: string;
}

/** A letter for index i: "a" for the first. Past z, its number. */
export const cardLetter = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : String(i + 1));

/** The answer options with their letters, in order; link options are left out. */
export function answerOptions(card: Pick<OverseerCard, "options">): { option: CardOption; letter: string }[] {
  return card.options.filter((o) => !o.href).map((option, i) => ({ option, letter: cardLetter(i) }));
}
export const linkOptions = (card: Pick<OverseerCard, "options">): CardOption[] => card.options.filter((o) => !!o.href);
export const optionByLetter = (card: Pick<OverseerCard, "options">, letter: string): CardOption | undefined => answerOptions(card).find((o) => o.letter === letter)?.option;
/** A row's choices: its own, else the card's; undefined when it has none. */
export const choicesOf = (card: Pick<OverseerCard, "choices">, item: Pick<CardItem, "choices">): { label: string }[] | undefined => item.choices ?? card.choices;
/** A row's choice by letter: letters are per row, so "a" is the first of that row's own list. */
export const choiceByLetter = (card: Pick<OverseerCard, "choices">, item: Pick<CardItem, "choices">, letter: string): { label: string } | undefined =>
  choicesOf(card, item)?.find((_, i) => cardLetter(i) === letter);
/** Whether any row takes a choice (the card's Apply). */
export const hasChoices = (card: Pick<OverseerCard, "choices" | "items">): boolean => card.choices !== undefined || card.items.some((it) => it.choices !== undefined);
/** The text an answer option sends: its reply, else its label. */
export const optionReply = (o: CardOption): string => o.reply?.trim() || o.label;
export const isOpenCard = (card: OverseerCard): boolean => card.phase === "open";
export const openCardsOf = (cards: readonly OverseerCard[]): OverseerCard[] => cards.filter(isOpenCard);

// ── Errors and input validation ──────────────────────────────────────────────

/** A call the model can fix: the message says what was wrong and where. */
export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number): string => {
  const t = oneLine(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
function need(ok: boolean, message: string): asserts ok {
  if (!ok) throw new CardError(message);
}

/** Field names models reach for, and the ones meant, in order of preference. */
const MEANT: Record<string, readonly string[]> = {
  id: ["card"],
  question: ["title"],
  answer: ["text"],
  decision: ["text"],
  choice: ["option"],
  why: ["reason"],
  reason: ["why"],
  url: ["link"],
  href: ["link"],
  note: ["detail"],
  ids: ["items"],
  terminate: [],
};

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue;
    const meant = MEANT[key]?.find((k) => allowed.includes(k));
    need(allowed.includes(key), `${where}: unknown field "${key}"${meant ? ` (did you mean "${meant}"?)` : ""} (allowed: ${allowed.join(", ")})`);
  }
}

function text(value: unknown, where: string): string {
  need(typeof value === "string" && value.trim() !== "", `${where} must be a non-empty string`);
  return (value as string).trim();
}

export const CARD_OPS = ["create", "answer", "accept", "reopen", "drop", "get"] as const;
export type CardOpName = (typeof CARD_OPS)[number];

/**
 * Each op's fields: `required` must be present, `optional` may be; nothing else is taken. The tool's
 * JSON schema is built per op from the same table (server/overseer-card-tool.ts), so the schema and
 * this check can't disagree.
 */
export const CARD_OP_FIELDS: Record<CardOpName, { required: readonly string[]; optional: readonly string[] }> = {
  // `options` may be left out when every item takes a choice (the card's Apply is then its answer).
  create: { required: ["title"], optional: ["options", "detail", "items", "choices", "recommendation", "replaces"] },
  answer: { required: ["text"], optional: ["option", "items"] },
  accept: { required: [], optional: ["items"] },
  reopen: { required: [], optional: [] },
  drop: { required: ["reason"], optional: [] },
  get: { required: [], optional: [] },
};

/** Fields an option takes as input; `link` is resolved by the host into `href`; `at`/`until` make
    an approval for later, `rule` a standing rule (the global Overseer's cards only). */
export const OPTION_INPUT_KEYS = ["label", "reply", "tone", "link", "at", "until", "rule"] as const;

/** Op names models reach for, and what to use instead. */
const OP_MEANT: Record<string, string> = {
  resolve: 'use {op: "answer", text, option?} with the user\'s words, or {op: "drop", reason}',
  close: 'use {op: "drop", reason} for a card that no longer applies, or answer/accept for one the user answered',
  replace: 'use {op: "create", ..., replaces: "c_3"}',
  update: 'cards are not edited: create a new one with replaces: "c_N"',
  edit: 'cards are not edited: create a new one with replaces: "c_N"',
  decide: 'use {op: "answer", text, option?, items?}',
  confirm: 'use {op: "create", title, options, ...}',
};

const CARD_ID = /^c_([1-9]\d*)$/;

/** The next `c_N` on this branch: one past the highest seen. */
export function nextCardId(cards: readonly OverseerCard[]): string {
  let max = 0;
  for (const c of cards) {
    const m = CARD_ID.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c_${max + 1}`;
}

/** The call's shape and each op's fields; the first problem throws. Exported: the tool checks the
    shape before it resolves a create's items and links. */
export function checkCardCall(input: unknown): (Record<string, unknown> & { op: CardOpName })[] {
  if (Array.isArray(input) || (isRecord(input) && typeof input.op === "string" && input.ops === undefined)) {
    throw new CardError('wrap ops in {ops: [...]}: sova_card takes {card?, ops: [{op: ...}, ...]}');
  }
  need(isRecord(input), "sova_card takes {card?, ops: [...]}");
  const params = input as Record<string, unknown>;
  onlyKeys(params, ["card", "ops"], "sova_card");
  need(Array.isArray(params.ops) && params.ops.length > 0, "ops must be a non-empty array of operations");
  const ops = (params.ops as unknown[]).map((op, i) => {
    need(isRecord(op), `ops[${i}] must be an object with an "op" field`);
    const o = op as Record<string, unknown>;
    if (typeof o.op === "string" && !(CARD_OPS as readonly string[]).includes(o.op) && OP_MEANT[o.op] !== undefined) {
      throw new CardError(`ops[${i}].op "${o.op}" is not an op: ${OP_MEANT[o.op]}`);
    }
    need(typeof o.op === "string" && (CARD_OPS as readonly string[]).includes(o.op), `ops[${i}].op must be one of ${CARD_OPS.join(", ")}`);
    const where = `ops[${i}] (${o.op})`;
    const fields = CARD_OP_FIELDS[o.op as CardOpName];
    onlyKeys(o, ["op", ...fields.required, ...fields.optional], where);
    for (const key of fields.required) need(o[key] !== undefined, `${where}: ${key} is required`);
    return { ...o } as Record<string, unknown> & { op: CardOpName };
  });
  const creates = ops.filter((o) => o.op === "create").length;
  need(creates === 0 || ops.length === 1, "create stands alone in its call");
  // The new card gets the next id, so a `card` on a create can only mean the card it replaces.
  if (creates && params.card !== undefined) {
    const named = text(params.card, "card");
    const replaces = ops[0]!.replaces;
    need(replaces === undefined || replaces === named, `create takes card only as the card it replaces, but card is ${named} and replaces is ${String(replaces)}: give one of them`);
    ops[0]!.replaces = named;
  }
  return ops;
}

/** What the host resolved for a create before it is applied. */
export interface CardPrepared {
  /** The resolved items (each may carry the `default` letter its entry gave, and its own `choices`
      as the model wrote them, checked here), in any order. */
  items: (SovaConfirmItem & { default?: string; choices?: unknown })[];
  /** Per option index: its link's resolved href, for an option that gave `link`. */
  hrefs: (string | undefined)[];
  clickOnly?: boolean;
}

export interface CardEnv {
  /** ISO timestamp stamped on answers, drops and the card. */
  now: string;
  /** A create's resolved items and links; required when the call creates. */
  prepared?: CardPrepared;
  /** Who answers, in the echo's words. */
  audience?: "user" | "operator";
  /** Options may approve for later or propose a rule (the global Overseer). */
  grants?: boolean;
}

export interface CardOutcome {
  details: CardDetails;
  /** The tool result's text: the compact echo. */
  text: string;
}

/** The display order: ideas, todos, projects, people, then sessions (the card's row order). */
const KIND_ORDER: Record<SovaConfirmItem["kind"], number> = { idea: 0, todo: 1, project: 2, person: 3, session: 4 };
export function displayOrder<T extends SovaConfirmItem>(items: readonly T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => KIND_ORDER[a.it.kind] - KIND_ORDER[b.it.kind] || a.i - b.i).map((x) => x.it);
}

/** An https URL a link option may open: no credentials, a host. */
export function safeHttpsUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/** Whether a stored href is one a link option may carry. */
export function isCardHref(href: string): boolean {
  if (href.startsWith("#/")) return true;
  if (/^settings:[a-z]+(?:\/[a-z-]+)?$/.test(href)) return true;
  return safeHttpsUrl(href) === href;
}

function createCard(id: string, o: Record<string, unknown>, env: CardEnv): OverseerCard {
  const where = "ops[0] (create)";
  const prepared = env.prepared ?? { items: [], hrefs: [] };
  need(o.options === undefined || Array.isArray(o.options), `${where}: options must be an array of {label, reply?, tone?, link?}`);
  const options: CardOption[] = ((o.options as unknown[] | undefined) ?? []).map((raw, i) => {
    const w = `${where}: options[${i}]`;
    need(isRecord(raw), `${w} must be an object {label, reply?, tone?, link?}`);
    const v = raw as Record<string, unknown>;
    onlyKeys(v, OPTION_INPUT_KEYS, w);
    const opt: CardOption = { label: cut(text(v.label, `${w}.label`), 40) };
    if (v.tone !== undefined) {
      need(v.tone === "default" || v.tone === "danger", `${w}.tone must be "default" or "danger"`);
      if (v.tone === "danger") opt.tone = "danger";
    }
    if (v.link !== undefined) {
      need(v.reply === undefined, `${w}: a link option sends nothing, so it takes no reply`);
      const href = prepared.hrefs[i];
      need(typeof href === "string" && isCardHref(href), `${w}.link could not be resolved`);
      opt.href = href;
    } else if (v.reply !== undefined) {
      opt.reply = text(v.reply, `${w}.reply`);
    }
    if (v.at !== undefined || v.until !== undefined || v.rule !== undefined) {
      need(env.grants === true, `${w}: at, until and rule are the Overseer's own; this card can't approve ahead of time`);
      need(v.link === undefined, `${w}: a link option answers nothing, so it can't approve or adopt anything`);
      need(v.rule === undefined || (v.at === undefined && v.until === undefined), `${w}: give at (an approval for later) or rule (a standing rule), not both`);
    }
    if (v.at !== undefined || v.until !== undefined) {
      need(v.at !== undefined, `${w}: until needs at (when you mean to act)`);
      const now = Date.parse(env.now);
      const at = Date.parse(text(v.at, `${w}.at`));
      need(Number.isFinite(at), `${w}.at must be an ISO time with its offset, e.g. "2026-09-30T18:00:00+03:00"`);
      const until = v.until === undefined ? at + GRANT_DEFAULT_MS : Date.parse(text(v.until, `${w}.until`));
      need(Number.isFinite(until), `${w}.until must be an ISO time with its offset`);
      need(until > now && at < until, `${w}: the approval must end after at and in the future`);
      need(until - now <= GRANT_MAX_AHEAD_MS && at - now <= GRANT_MAX_AHEAD_MS, `${w}: an approval reaches at most 7 days ahead`);
      opt.later = { at: new Date(at).toISOString(), ...(v.until !== undefined ? { until: new Date(until).toISOString() } : {}) };
    }
    if (v.rule !== undefined) {
      need(isRecord(v.rule), `${w}.rule must be an object {text, acts?, any_session?}`);
      const r = v.rule as Record<string, unknown>;
      onlyKeys(r, ["text", "acts", "any_session"], `${w}.rule`);
      const rule: CardOptionRule = { text: cut(text(r.text, `${w}.rule.text`), 200) };
      if (r.acts !== undefined) {
        need(Array.isArray(r.acts) && r.acts.length > 0, `${w}.rule.acts must be a non-empty list of ${GRANTABLE_ACTS.join(", ")}`);
        for (const a of r.acts as unknown[]) need((GRANTABLE_ACTS as readonly unknown[]).includes(a), `${w}.rule.acts: "${String(a)}" is not one of ${GRANTABLE_ACTS.join(", ")}`);
        rule.acts = [...new Set(r.acts as GrantableAct[])];
      }
      if (r.any_session !== undefined) {
        need(typeof r.any_session === "boolean", `${w}.rule.any_session must be true or false`);
        if (r.any_session) rule.anySession = true;
      }
      opt.rule = rule;
    }
    return opt;
  });
  const listsSessions = prepared.items.some((it) => it.kind === "session");
  for (const [i, opt] of options.entries()) {
    need(!opt.later || listsSessions, `${where}: options[${i}] approves acts on the card's sessions, so list them in items.sessions`);
    need(!opt.rule || opt.rule.anySession || listsSessions, `${where}: options[${i}].rule covers the card's sessions: list them in items.sessions, or set any_session`);
  }
  const answers = options.filter((x) => !x.href).length;
  const links = options.length - answers;
  need(answers <= CARD_ANSWERS_MAX, `${where}: at most ${CARD_ANSWERS_MAX} answer options (this has ${answers}); split the question`);
  need(links <= CARD_LINKS_MAX, `${where}: at most ${CARD_LINKS_MAX} link options (this has ${links})`);

  /** A list of 2 to 4 distinct short labels: the card's `choices`, or an item's own. */
  const choiceList = (raw: unknown, w: string): { label: string }[] => {
    need(Array.isArray(raw), `${w} must be an array of ${CARD_CHOICES_MIN} to ${CARD_CHOICES_MAX} short labels`);
    const list = (raw as unknown[]).map((c, i) => ({ label: cut(text(isRecord(c) ? c.label : c, `${w}[${i}]`), 30) }));
    need(list.length >= CARD_CHOICES_MIN && list.length <= CARD_CHOICES_MAX, `${w} takes ${CARD_CHOICES_MIN} to ${CARD_CHOICES_MAX} labels (this has ${list.length})`);
    const labels = list.map((c) => c.label.toLowerCase());
    need(new Set(labels).size === labels.length, `${w}: each choice needs its own label`);
    return list;
  };
  let choices: { label: string }[] | undefined;
  if (o.choices !== undefined) {
    choices = choiceList(o.choices, `${where}: choices`);
    need(prepared.items.length > 0, `${where}: choices are per item, so the card needs items`);
  }

  const items: CardItem[] = displayOrder(prepared.items).map((it, i) => {
    const { default: def, choices: own, ...rest } = it;
    const item: CardItem = { ...(rest as SovaConfirmItem), n: i + 1 };
    if (own !== undefined) item.choices = choiceList(own, `${where}: ${it.id}'s choices`);
    const row = choicesOf({ choices }, item);
    if (def !== undefined) {
      need(row !== undefined, `${where}: ${it.id} has a default, but neither it nor the card has choices`);
      need(row!.some((_, k) => cardLetter(k) === def), `${where}: ${it.id}'s default "${def}" is not one of its choice letters (${row!.map((_, k) => `${cardLetter(k)}. ${row![k]!.label}`).join(", ")})`);
      item.default = def;
    }
    return item;
  });
  need(
    answers > 0 || (items.length > 0 && items.every((it) => choicesOf({ choices }, it) !== undefined)),
    `${where}: give at least one answer option (an option without link), or choices for every item (the card's, or each item's own)`,
  );

  const card: OverseerCard = {
    id,
    title: cut(text(o.title, `${where}: title`), 200),
    options,
    items,
    phase: "open",
    rev: 1,
    createdAt: env.now,
    updatedAt: env.now,
  };
  if (o.detail !== undefined) card.detail = cut(text(o.detail, `${where}: detail`), 600);
  if (choices) card.choices = choices;
  if (o.recommendation !== undefined) {
    need(isRecord(o.recommendation), `${where}: recommendation must be an object {option?, why}`);
    const r = o.recommendation as Record<string, unknown>;
    onlyKeys(r, ["option", "why"], `${where}: recommendation`);
    const rec: CardRecommendation = { why: cut(text(r.why, `${where}: recommendation.why`), 300) };
    if (r.option !== undefined) {
      const letter = text(r.option, `${where}: recommendation.option`).toLowerCase();
      need(optionByLetter(card, letter) !== undefined, `${where}: recommendation.option "${letter}" is not an answer option's letter (${answerOptions(card).map((x) => x.letter).join(", ") || "none"})`);
      rec.option = letter;
    }
    card.recommendation = rec;
  }
  if (prepared.clickOnly) card.clickOnly = true;
  return card;
}

/** The card a call names: `card`, else the only open one. */
function targetCard(cards: readonly OverseerCard[], params: Record<string, unknown>, onlyGets: boolean): OverseerCard | undefined {
  const open = openCardsOf(cards);
  if (params.card !== undefined) {
    const id = text(params.card, "card");
    const found = cards.find((c) => c.id === id);
    need(found !== undefined, `No card ${id} in this conversation${cards.length ? ` (there are ${cards.map((c) => c.id).join(", ")})` : ""}`);
    return structuredClone(found!);
  }
  if (open.length === 1) return structuredClone(open[0]!);
  if (onlyGets) return undefined;
  need(open.length > 0, "No open card to change: name one with card");
  throw new CardError(`Name the card: card is required while several are open (${open.map((c) => `${c.id} "${c.title}"`).join(", ")})`);
}

function itemNumber(card: OverseerCard, key: string, where: string): CardItem {
  need(/^[1-9]\d*$/.test(key), `${where}: "${key}" is not an item number (items are numbered 1..${card.items.length})`);
  const item = card.items.find((it) => it.n === Number(key));
  need(item !== undefined, `${where}: ${card.id} has no item ${key} (it has ${card.items.length ? `1..${card.items.length}` : "none"})`);
  return item!;
}

/** Answered once every item is decided (a card without items never completes this way). */
function completeByItems(card: OverseerCard): boolean {
  return card.items.length > 0 && card.items.every((it) => it.decided !== undefined);
}

/**
 * Apply one tool call to the branch's cards, atomically: every op is validated before anything is
 * kept, and the first problem throws CardError. Pure.
 */
export function applyCardCall(cards: readonly OverseerCard[], input: unknown, env: CardEnv): CardOutcome {
  const ops = checkCardCall(input);
  const params = input as Record<string, unknown>;
  const onlyGets = ops.every((o) => o.op === "get");
  const changes: CardChange[] = [];
  let card: OverseerCard | undefined;
  let closed: OverseerCard | undefined;
  const creates = ops[0]!.op === "create";

  if (creates) {
    const o = ops[0]!;
    card = createCard(nextCardId(cards), o, env);
    if (o.replaces !== undefined) {
      const id = text(o.replaces, "ops[0] (create): replaces");
      const old = cards.find((c) => c.id === id);
      need(old !== undefined, `ops[0] (create): replaces names no card ${id}`);
      need(old!.phase === "open", `ops[0] (create): ${id} is ${old!.phase}, not open; only an open card is replaced`);
      closed = { ...structuredClone(old!), phase: "superseded", supersededBy: card.id, rev: old!.rev + 1, updatedAt: env.now };
      card.replaces = id;
    }
    changes.push(closed ? { kind: "created", replaces: closed.id } : { kind: "created" });
  } else {
    card = targetCard(cards, params, onlyGets);
  }

  for (let i = creates ? 1 : 0; i < ops.length; i++) {
    const o = ops[i]!;
    const where = `ops[${i}] (${o.op})`;
    if (o.op === "get") continue;
    const c = card!;
    switch (o.op) {
      case "answer": {
        need(c.phase === "open", `${where}: ${c.id} is ${c.phase}${c.phase === "superseded" ? ` by ${c.supersededBy}` : ""}; ${c.phase === "superseded" ? "answer that card instead" : "reopen it first to record a new answer"}`);
        const words = oneLine(text(o.text, `${where}: text`));
        need(!(o.option !== undefined && o.items !== undefined), `${where}: give option or items, not both`);
        if (o.option !== undefined) {
          const letter = text(o.option, `${where}: option`).toLowerCase();
          const hit = optionByLetter(c, letter);
          need(
            hit !== undefined,
            `${where}: "${letter}" is not one of ${c.id}'s answer options (${answerOptions(c).map((x) => `${x.letter}. ${x.option.label}`).join(" · ") || "none"}); a link option is never an answer`,
          );
          c.phase = "answered";
          c.answer = { text: words, option: letter, by: "user", at: env.now };
          changes.push({ kind: "answered", option: letter, complete: true });
        } else if (o.items !== undefined) {
          need(isRecord(o.items) && Object.keys(o.items as object).length > 0, `${where}: items maps item numbers to a choice letter or the user's words, e.g. {"1": "a", "3": "keep it for now"}`);
          const decided: number[] = [];
          for (const [key, value] of Object.entries(o.items as Record<string, unknown>)) {
            const item = itemNumber(c, key, where);
            const said = oneLine(text(value, `${where}: items["${key}"]`));
            const row = choicesOf(c, item);
            const letter = /^[a-z]$/i.test(said);
            const choice = letter ? choiceByLetter(c, item, said.toLowerCase()) : undefined;
            need(!(row === undefined && letter), `${where}: items["${key}"] is "${said}", but item ${key} of ${c.id} has no choices; give the user's words`);
            need(!(row !== undefined && letter && choice === undefined), `${where}: items["${key}"]: "${said}" is not one of item ${key}'s choice letters (${row?.map((x, k) => `${cardLetter(k)}. ${x.label}`).join(", ")})`);
            item.decided = choice ? { choice: said.toLowerCase(), text: choice.label, by: "user", at: env.now } : { text: said, by: "user", at: env.now };
            decided.push(item.n);
          }
          decided.sort((a, b) => a - b);
          const complete = completeByItems(c);
          if (complete) {
            c.phase = "answered";
            c.answer = { text: words, by: "user", at: env.now };
          }
          changes.push({ kind: "answered", items: decided, ...(complete ? { complete: true as const } : {}) });
        } else {
          c.phase = "answered";
          c.answer = { text: words, by: "user", at: env.now };
          changes.push({ kind: "answered", complete: true });
        }
        break;
      }
      case "accept": {
        need(c.phase === "open", `${where}: ${c.id} is ${c.phase}; reopen it first`);
        if (o.items !== undefined) {
          need(Array.isArray(o.items) && o.items.length > 0, `${where}: items is a list of item numbers, e.g. [1, 3]`);
          const nums = (o.items as unknown[]).map((v) => itemNumber(c, String(v), where));
          const dup = nums.find((it, k) => nums.indexOf(it) !== k);
          need(dup === undefined, `${where}: item ${dup?.n} is named twice`);
          for (const it of nums) need(it.default !== undefined, `${where}: item ${it.n} has no default to accept; record the user's words with answer`);
          for (const it of nums) it.decided = { choice: it.default!, text: choiceByLetter(c, it, it.default!)!.label, by: "accepted-recommendation", at: env.now };
          const complete = completeByItems(c);
          if (complete) {
            c.phase = "answered";
            c.answer = { text: "Your recommendation", by: "accepted-recommendation", at: env.now };
          }
          changes.push({ kind: "accepted", items: nums.map((it) => it.n).sort((a, b) => a - b), ...(complete ? { complete: true as const } : {}) });
        } else if (c.recommendation?.option) {
          const opt = optionByLetter(c, c.recommendation.option)!;
          c.phase = "answered";
          c.answer = { text: opt.label, option: c.recommendation.option, by: "accepted-recommendation", at: env.now };
          changes.push({ kind: "accepted", option: c.recommendation.option, complete: true });
        } else {
          const open = c.items.filter((it) => it.decided === undefined && it.default !== undefined);
          need(open.length > 0, `${where}: ${c.id} recommends no option and no undecided item has a default; record the user's words with answer`);
          for (const it of open) it.decided = { choice: it.default!, text: choiceByLetter(c, it, it.default!)!.label, by: "accepted-recommendation", at: env.now };
          const complete = completeByItems(c);
          if (complete) {
            c.phase = "answered";
            c.answer = { text: "Your recommendation", by: "accepted-recommendation", at: env.now };
          }
          changes.push({ kind: "accepted", items: open.map((it) => it.n), ...(complete ? { complete: true as const } : {}) });
        }
        break;
      }
      case "reopen":
        need(c.phase === "answered" || c.phase === "dropped", `${where}: ${c.id} is ${c.phase}${c.phase === "superseded" ? `; ${c.supersededBy} replaced it` : ""}`);
        c.phase = "open";
        delete c.answer;
        delete c.droppedWhy;
        for (const it of c.items) delete it.decided;
        changes.push({ kind: "reopened" });
        break;
      case "drop":
        need(c.phase === "open", `${where}: ${c.id} is already ${c.phase}`);
        c.phase = "dropped";
        c.droppedWhy = cut(text(o.reason, `${where}: reason`), 300);
        changes.push({ kind: "dropped" });
        break;
    }
  }

  const changed = changes.length > 0;
  if (card && changed && !creates) {
    card.rev += 1;
    card.updatedAt = env.now;
  }
  let after: OverseerCard[] = [...cards];
  if (closed) after = upsert(after, closed);
  if (card && changed) after = upsert(after, card);
  const details: CardDetails = { v: 1, changes, line: changeLine(changes) };
  if (card && changed) details.card = card;
  if (closed) details.closed = closed;
  const who = env.audience ?? "user";
  const lines: string[] = [];
  if (card) {
    lines.push(...cardLines(card, changed ? details.line : ""));
    if (closed) lines.push(`${closed.id} is now superseded by ${card.id}.`);
  } else lines.push(...(openCardsOf(after).length ? openCardsOf(after).flatMap((c) => cardLines(c, "")) : ["No open cards in this conversation."]));
  const others = card ? openCardsOf(after).filter((c) => c.id !== card!.id) : [];
  if (others.length) lines.push(`Other open cards: ${others.map((c) => `${c.id} "${c.title}"`).join(" · ")}`);
  if (creates) {
    const clicks = [answerOptions(card!).length ? `"${card!.id} b: …"` : "", hasChoices(card!) ? `"${card!.id}: 1a …, 2b …" (each letter its own row's)` : ""].filter(Boolean).join(" or ");
    lines.push(
      `Shown to the ${who} under your reply. It stays open until you record it: when the ${who} answers (a click reads ${clicks}; typed text may name the card, an item number or an option letter), call sova_card answer with their words, or accept for "your recommendation", in the run you act on it.`,
    );
  }
  return { details, text: lines.join("\n") };
}

/** The cards with `card` replaced (or added), moved to the end: the fold's touch order. */
function upsert(cards: readonly OverseerCard[], card: OverseerCard): OverseerCard[] {
  return [...cards.filter((c) => c.id !== card.id), card];
}

// ── Fold ─────────────────────────────────────────────────────────────────────

/** The sova_card result of a session entry, when it is one: its details, normalized, else undefined. */
export function cardResultOf(entry: unknown): CardDetails | undefined {
  if (!isRecord(entry) || entry.type !== "message") return undefined;
  const m = entry.message;
  if (!isRecord(m) || m.role !== "toolResult" || m.toolName !== CARD_TOOL || m.isError === true) return undefined;
  return normalizeCardDetails(m.details);
}

/** Cards from a run of details in order: each card's newest snapshot, in the order last touched. */
export function foldCardDetails(details: Iterable<CardDetails | undefined>): OverseerCard[] {
  const cards = new Map<string, OverseerCard>();
  const put = (c: OverseerCard) => {
    cards.delete(c.id);
    cards.set(c.id, c);
  };
  for (const d of details) {
    if (!d) continue;
    if (d.closed) put(d.closed);
    if (d.card) put(d.card);
  }
  return [...cards.values()];
}

/**
 * The cards of a branch (root first): each card's newest valid snapshot. A failed call (an error
 * result), malformed details and a legacy `sova_confirm` result are never state. Never throws.
 */
export function foldCards(entries: readonly unknown[]): OverseerCard[] {
  if (!Array.isArray(entries)) return [];
  return foldCardDetails(entries.map(cardResultOf));
}

// Stored-shape checks: tolerant callers (the fold, the client) get undefined for anything off.

const str = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const LETTER = /^[a-z]$/;
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

function normAll<T>(v: unknown, one: (x: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v) {
    const ok = one(x);
    if (ok === undefined) return undefined;
    out.push(ok);
  }
  return out;
}

function normBy(v: unknown): CardAnswerBy | undefined {
  return v === "user" || v === "accepted-recommendation" ? v : undefined;
}

/** A stored choice list (the card's, or an item's own): 2 to 4 labels. */
function normChoices(v: unknown): { label: string }[] | undefined {
  const choices = normAll(v, (c) => (isRecord(c) && nonEmpty(c.label) ? { label: c.label } : undefined));
  return choices && choices.length >= CARD_CHOICES_MIN && choices.length <= CARD_CHOICES_MAX ? choices : undefined;
}

/** A stored item snapshot, strict per kind. */
export function normalizeCardItem(v: unknown): CardItem | undefined {
  if (!isRecord(v) || !nonEmpty(v.id) || !count(v.n) || v.n < 1) return undefined;
  const note = v.note === undefined ? {} : nonEmpty(v.note) ? { note: v.note } : null;
  if (note === null) return undefined;
  let base: SovaConfirmItem;
  switch (v.kind) {
    case "session": {
      if (!nonEmpty(v.title)) return undefined;
      base = {
        kind: "session",
        id: v.id,
        title: v.title,
        ...(nonEmpty(v.project) ? { project: v.project } : {}),
        ...(str(v.lastActiveAt) && Number.isFinite(Date.parse(v.lastActiveAt)) ? { lastActiveAt: v.lastActiveAt } : {}),
        ...(nonEmpty(v.summary) ? { summary: v.summary } : {}),
        ...(count(v.workers) && v.workers > 0 ? { workers: v.workers } : {}),
        ...note,
      };
      break;
    }
    case "idea":
      if (!str(v.title)) return undefined;
      base = { kind: "idea", id: v.id, title: v.title, ...note };
      break;
    case "todo":
      if (!nonEmpty(v.text)) return undefined;
      base = { kind: "todo", id: v.id, text: v.text, ...note };
      break;
    case "project":
      if (!nonEmpty(v.orgId) || !nonEmpty(v.name) || !nonEmpty(v.orgName)) return undefined;
      base = { kind: "project", id: v.id, orgId: v.orgId, name: v.name, orgName: v.orgName, ...note };
      break;
    case "person":
      if (!nonEmpty(v.orgId) || !nonEmpty(v.name) || !nonEmpty(v.orgName)) return undefined;
      if (v.status !== "active" && v.status !== "proposed" && v.status !== "left") return undefined;
      base = { kind: "person", id: v.id, orgId: v.orgId, name: v.name, orgName: v.orgName, status: v.status, ...note };
      break;
    default:
      return undefined;
  }
  const item: CardItem = { ...base, n: v.n };
  if (v.choices !== undefined) {
    const choices = normChoices(v.choices);
    if (!choices) return undefined;
    item.choices = choices;
  }
  if (v.default !== undefined) {
    if (!str(v.default) || !LETTER.test(v.default)) return undefined;
    item.default = v.default;
  }
  if (v.decided !== undefined) {
    const d = v.decided;
    if (!isRecord(d) || !nonEmpty(d.text) || !normBy(d.by) || !str(d.at)) return undefined;
    if (d.choice !== undefined && (!str(d.choice) || !LETTER.test(d.choice))) return undefined;
    item.decided = { ...(d.choice !== undefined ? { choice: d.choice as string } : {}), text: d.text, by: normBy(d.by)!, at: d.at };
  }
  return item;
}

function normOption(v: unknown): CardOption | undefined {
  if (!isRecord(v) || !nonEmpty(v.label)) return undefined;
  const o: CardOption = { label: v.label };
  if (v.reply !== undefined) {
    if (!nonEmpty(v.reply)) return undefined;
    o.reply = v.reply;
  }
  if (v.tone !== undefined && v.tone !== "danger") return undefined;
  if (v.tone === "danger") o.tone = "danger";
  if (v.href !== undefined) {
    if (!str(v.href) || !isCardHref(v.href) || o.reply !== undefined) return undefined;
    o.href = v.href;
  }
  if (v.later !== undefined) {
    const l = v.later;
    if (o.href !== undefined || !isRecord(l) || !isIso(l.at) || (l.until !== undefined && !isIso(l.until))) return undefined;
    o.later = { at: l.at as string, ...(l.until !== undefined ? { until: l.until as string } : {}) };
  }
  if (v.rule !== undefined) {
    const r = v.rule;
    if (o.href !== undefined || o.later !== undefined || !isRecord(r) || !nonEmpty(r.text)) return undefined;
    if (r.acts !== undefined && (!Array.isArray(r.acts) || !r.acts.length || !r.acts.every((a) => (GRANTABLE_ACTS as readonly unknown[]).includes(a)))) return undefined;
    if (r.anySession !== undefined && r.anySession !== true) return undefined;
    o.rule = { text: r.text, ...(r.acts !== undefined ? { acts: [...(r.acts as GrantableAct[])] } : {}), ...(r.anySession ? { anySession: true as const } : {}) };
  }
  return o;
}

/** A stored card, checked field by field; a fresh object, or undefined when anything is off. */
export function normalizeCard(v: unknown): OverseerCard | undefined {
  try {
    if (!isRecord(v) || !str(v.id) || !CARD_ID.test(v.id) || !nonEmpty(v.title)) return undefined;
    const options = normAll(v.options, normOption);
    const items = normAll(v.items, normalizeCardItem);
    if (!options || !items) return undefined;
    if (v.phase !== "open" && v.phase !== "answered" && v.phase !== "superseded" && v.phase !== "dropped") return undefined;
    if (!count(v.rev) || v.rev < 1 || !str(v.createdAt) || !str(v.updatedAt)) return undefined;
    const card: OverseerCard = { id: v.id, title: v.title, options, items, phase: v.phase, rev: v.rev, createdAt: v.createdAt, updatedAt: v.updatedAt };
    if (v.detail !== undefined) {
      if (!nonEmpty(v.detail)) return undefined;
      card.detail = v.detail;
    }
    if (v.choices !== undefined) {
      const choices = normChoices(v.choices);
      if (!choices) return undefined;
      card.choices = choices;
    }
    // Items are numbered 1..N in order, and defaults and decided choices name real choices of their own row.
    if (items.some((it, i) => it.n !== i + 1)) return undefined;
    const names = (it: CardItem, l: string | undefined) => l === undefined || choiceByLetter(card, it, l) !== undefined;
    if (items.some((it) => !names(it, it.default) || !names(it, it.decided?.choice))) return undefined;
    if (v.recommendation !== undefined) {
      const r = v.recommendation;
      if (!isRecord(r) || !nonEmpty(r.why)) return undefined;
      card.recommendation = { why: r.why };
      if (r.option !== undefined) {
        if (!str(r.option) || optionByLetter(card, r.option) === undefined) return undefined;
        card.recommendation.option = r.option;
      }
    }
    if (v.clickOnly !== undefined) {
      if (v.clickOnly !== true) return undefined;
      card.clickOnly = true;
    }
    if (v.replaces !== undefined) {
      if (!str(v.replaces) || !CARD_ID.test(v.replaces)) return undefined;
      card.replaces = v.replaces;
    }
    if (v.answer !== undefined) {
      const a = v.answer;
      if (!isRecord(a) || !nonEmpty(a.text) || !normBy(a.by) || !str(a.at)) return undefined;
      card.answer = { text: a.text, by: normBy(a.by)!, at: a.at };
      if (a.option !== undefined) {
        if (!str(a.option) || optionByLetter(card, a.option) === undefined) return undefined;
        card.answer.option = a.option;
      }
    }
    // Each state carries exactly what says why it is in it.
    if ((v.phase === "answered") !== (card.answer !== undefined)) return undefined;
    if ((v.phase === "superseded") !== (v.supersededBy !== undefined)) return undefined;
    if ((v.phase === "dropped") !== (v.droppedWhy !== undefined)) return undefined;
    if (v.supersededBy !== undefined) {
      if (!str(v.supersededBy) || !CARD_ID.test(v.supersededBy)) return undefined;
      card.supersededBy = v.supersededBy;
    }
    if (v.droppedWhy !== undefined) {
      if (!nonEmpty(v.droppedWhy)) return undefined;
      card.droppedWhy = v.droppedWhy;
    }
    return card;
  } catch {
    return undefined;
  }
}

const nums = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => count(n) && n >= 1);

function normChange(v: unknown): CardChange | undefined {
  if (!isRecord(v) || !str(v.kind)) return undefined;
  switch (v.kind) {
    case "created":
      if (v.replaces !== undefined && (!str(v.replaces) || !CARD_ID.test(v.replaces))) return undefined;
      return v.replaces !== undefined ? { kind: "created", replaces: v.replaces as string } : { kind: "created" };
    case "answered":
    case "accepted": {
      if (v.option !== undefined && (!str(v.option) || !LETTER.test(v.option))) return undefined;
      if (v.items !== undefined && !nums(v.items)) return undefined;
      if (v.complete !== undefined && v.complete !== true) return undefined;
      return {
        kind: v.kind,
        ...(v.option !== undefined ? { option: v.option as string } : {}),
        ...(v.items !== undefined ? { items: [...(v.items as number[])] } : {}),
        ...(v.complete === true ? { complete: true as const } : {}),
      };
    }
    case "reopened":
      return { kind: "reopened" };
    case "dropped":
      return { kind: "dropped" };
    case "superseded":
      return str(v.by) && CARD_ID.test(v.by) ? { kind: "superseded", by: v.by } : undefined;
    default:
      return undefined;
  }
}

/** A tool result's details, checked; a fresh object, or undefined when anything is off. */
export function normalizeCardDetails(v: unknown): CardDetails | undefined {
  try {
    if (!isRecord(v) || v.v !== CARD_DETAILS_VERSION || !str(v.line)) return undefined;
    const changes = normAll(v.changes, normChange);
    if (!changes) return undefined;
    const out: CardDetails = { v: 1, changes, line: v.line };
    if (v.card !== undefined) {
      const card = normalizeCard(v.card);
      if (!card) return undefined;
      out.card = card;
    }
    if (v.closed !== undefined) {
      const closed = normalizeCard(v.closed);
      if (!closed || closed.phase !== "superseded") return undefined;
      out.closed = closed;
    }
    return out;
  } catch {
    return undefined;
  }
}

// ── Text ─────────────────────────────────────────────────────────────────────

const sessionLink = (id: string, title: string) => `[${title.replace(/[[\]]/g, "")}](sova://s/${id})`;

/** One item as the model reads it: its exact id, sessions as links. */
export function itemText(it: SovaConfirmItem): string {
  switch (it.kind) {
    case "session":
      // Summary-first (§app.overseer/session-names): a first-message title rarely names the work.
      return `${sessionLink(it.id, cut(it.summary ?? it.title, 80))} (${it.id})`;
    case "idea":
      return `${it.id} — ${it.title}`;
    case "todo":
      return `${it.id} · ${it.text}`;
    case "project":
      return `project ${it.name} (${it.id}) in ${it.orgName} (${it.orgId})`;
    case "person":
      return `${it.name} (${it.id}, ${it.status}) in ${it.orgName} (${it.orgId})`;
  }
}

/** "a. Archive all · b. Keep"; "" without answer options. */
export function optionsText(card: OverseerCard): string {
  return answerOptions(card)
    .map((x) => `${x.letter}. ${x.option.label}${x.option.reply ? ` ("${oneLine(x.option.reply)}")` : ""}${optionGrantText(x.option)}`)
    .join(" · ");
}

/** What an option's click approves, for the model: "" for a plain answer. */
function optionGrantText(o: CardOption): string {
  if (o.later) return ` [click approves any act on the card's sessions until ${o.later.until ?? new Date(Date.parse(o.later.at) + GRANT_DEFAULT_MS).toISOString()}; act at ${o.later.at}]`;
  if (o.rule) return ` [click adopts a standing rule: "${o.rule.text}" (${o.rule.acts?.join(", ") ?? "any act"} on ${o.rule.anySession ? "any session" : "the card's sessions"})]`;
  return "";
}

const choicesText = (list: readonly { label: string }[]): string => list.map((c, i) => `${cardLetter(i)}. ${c.label}`).join(" · ");

function decisionText(card: OverseerCard, item: CardItem, d: CardItemDecision): string {
  return `${d.choice ? `${d.choice} ${choiceByLetter(card, item, d.choice)?.label ?? d.text}` : `"${d.text}"`}${d.by === "accepted-recommendation" ? " (your recommendation)" : ""}`;
}

/** The phase in words, for the model: "open", "answered: b Archive all", "superseded by c_7", "dropped: …". */
export function phaseText(card: OverseerCard): string {
  switch (card.phase) {
    case "open": {
      const decided = card.items.filter((it) => it.decided).length;
      return decided ? `open (${decided} of ${card.items.length} items decided)` : "open";
    }
    case "answered":
      return `answered: ${card.answer?.option ? `${card.answer.option} ${optionByLetter(card, card.answer.option)?.label ?? ""}`.trim() : `"${card.answer?.text ?? ""}"`}`;
    case "superseded":
      return `superseded by ${card.supersededBy}`;
    case "dropped":
      return `dropped: ${card.droppedWhy}`;
  }
}

/** The card as the model reads it: a head line, then options, choices, items and recommendation. */
export function cardLines(card: OverseerCard, line: string): string[] {
  const out = [`${card.id} "${card.title}" · ${phaseText(card)} · v${card.rev}${line ? ` · ${line}` : ""}`];
  if (card.detail) out.push(`  ${card.detail}`);
  const opts = optionsText(card);
  if (opts) out.push(`  options: ${opts}`);
  const links = linkOptions(card);
  if (links.length) out.push(`  links (they open a page, never an answer): ${links.map((o) => `${o.label} → ${o.href}`).join(" · ")}`);
  if (card.choices) out.push(`  per-item choices${card.items.some((it) => it.choices) ? " (items without their own)" : ""}: ${choicesText(card.choices)}`);
  for (const it of card.items) {
    const own = it.choices ? ` [choices ${choicesText(it.choices)}]` : "";
    const def = it.default ? ` [default ${it.default}]` : "";
    const done = it.decided ? ` — decided: ${decisionText(card, it, it.decided)}` : "";
    out.push(`  ${it.n}. ${itemText(it)}${it.note ? ` — ${it.note}` : ""}${own}${def}${done}`);
  }
  if (card.recommendation) {
    const opt = card.recommendation.option ? `${card.recommendation.option} — ${optionByLetter(card, card.recommendation.option)?.label ?? ""}: ` : "";
    out.push(`  rec: ${opt}${card.recommendation.why}`);
  }
  if (card.clickOnly) out.push("  click-only: an act that reaches people runs only in the turn its click opens, never on typed text");
  return out;
}

/**
 * The hidden note on a user prompt: every open card, so an answer by handle lands on the right
 * card. undefined when none is open. `afterCompaction` is the note written once right after a
 * compaction, when the summary may have lost the tool results. `activeAt` (a session id → when it
 * was last active, ISO) marks a card whose listed sessions changed after it was raised as maybe stale.
 */
export function cardsNote(cards: readonly OverseerCard[], afterCompaction = false, activeAt?: (sessionId: string) => string | undefined): string | undefined {
  const open = openCardsOf(cards);
  if (open.length === 0) return undefined;
  const head = afterCompaction
    ? "[cards] The context was just compacted. The open cards in this conversation, exactly as recorded (the summary above may describe them loosely); ids are stable."
    : "[cards] Open cards in this conversation. If the user's message answers any of them (a click reads \"c_4 b: …\" or \"c_4: 1a …, 2b …\", each item's letter one of its own choices; typed text may name a card, an item number or an option letter), record it with sova_card (answer with their words, accept for \"your recommendation\") in the run you act on it, one call per card. Drop a card that no longer applies, or replace it (create with replaces). Name a card by its id, never \"the card above\"; ids are stable.";
  const lines = open.flatMap((c) => {
    const stale = activeAt ? staleSessions(c, activeAt) : [];
    return [...cardLines(c, ""), ...stale.map((s) => `  may be stale: ${s.id} active since ${s.at}`)];
  });
  const anyStale = lines.some((l) => l.startsWith("  may be stale: "));
  return [head, ...(anyStale ? ["A card marked \"may be stale\" lists a session that changed after you raised it: check that session before acting on the card, and drop or replace the card if it no longer applies."] : []), ...lines].join("\n");
}

/** The card's sessions whose activity (`activeAt`) is after the card was raised, with that time. */
export function staleSessions(card: OverseerCard, activeAt: (sessionId: string) => string | undefined): { id: string; at: string }[] {
  const raised = Date.parse(card.createdAt);
  if (!Number.isFinite(raised)) return [];
  const out: { id: string; at: string }[] = [];
  for (const it of card.items) {
    if (it.kind !== "session") continue;
    const at = activeAt(it.id);
    if (at && Date.parse(at) > raised) out.push({ id: it.id, at });
  }
  return out;
}

/** "created" / "answered b" / "1, 3 decided" / "accepted" / "dropped"; "" for no changes. */
export function changeLine(changes: readonly CardChange[]): string {
  return changes
    .map((c) => {
      switch (c.kind) {
        case "created":
          return c.replaces ? `created, replaces ${c.replaces}` : "created";
        case "answered":
        case "accepted": {
          const verb = c.kind === "answered" ? "answered" : "accepted";
          if (c.option) return `${verb} ${c.option}`;
          if (c.items) return `${c.items.join(", ")} ${c.kind === "answered" ? "decided" : "accepted"}${c.complete ? " · answered" : ""}`;
          return verb;
        }
        case "reopened":
          return "reopened";
        case "dropped":
          return "dropped";
        case "superseded":
          return `superseded by ${c.by}`;
      }
    })
    .join(" · ");
}

// ── Clicks: the message a click composes, and its exact match ─────────────────

/** An option's click: "c_4 b: <its reply, else its label>". */
export function optionClick(card: Pick<OverseerCard, "id" | "options">, letter: string): string | null {
  const o = optionByLetter(card, letter);
  return o ? `${card.id} ${letter}: ${oneLine(optionReply(o))}` : null;
}

/** A per-item Apply: "c_4: 1a Archive, 2b Keep", items in number order, each letter and label its
    own row's; null when nothing is picked or a pick isn't one of its row's letters. */
export function itemsClick(card: Pick<OverseerCard, "id" | "choices" | "items">, picks: Readonly<Record<number, string>>): string | null {
  const parts: string[] = [];
  for (const it of card.items) {
    const letter = picks[it.n];
    if (letter === undefined) continue;
    const c = choiceByLetter(card, it, letter);
    if (!c) return null;
    parts.push(`${it.n}${letter} ${c.label}`);
  }
  return parts.length ? `${card.id}: ${parts.join(", ")}` : null;
}

export type CardClick = { card: string; option: string } | { card: string; items: Record<number, string> };

/** The card id a message starts with ("c_4 b: …", "c_4: …"), else null. */
export function clickCardId(text: string): string | null {
  return /^(c_[1-9]\d*)(?::| [a-z]:) /.exec(text)?.[1] ?? null;
}

/**
 * Whether `text` is exactly a message a click on `card` composes: an option click, or a per-item
 * Apply (each token recomposed and compared). null for anything else, typed text that merely looks
 * like one included when it doesn't recompose to the same bytes.
 */
export function matchCardClick(card: OverseerCard, text: string): CardClick | null {
  for (const { letter } of answerOptions(card)) if (optionClick(card, letter) === text) return { card: card.id, option: letter };
  const prefix = `${card.id}: `;
  if (!hasChoices(card) || !text.startsWith(prefix)) return null;
  const picks: Record<number, string> = {};
  for (const token of text.slice(prefix.length).split(/, (?=[1-9]\d*[a-z] )/)) {
    const m = /^([1-9]\d*)([a-z]) /.exec(token);
    if (!m) return null;
    const n = Number(m[1]);
    if (picks[n] !== undefined || !card.items.some((it) => it.n === n)) return null;
    picks[n] = m[2]!;
  }
  return itemsClick(card, picks) === text ? { card: card.id, items: picks } : null;
}

/** The items a click approves: every item for a card-level option, else only those it gave a choice. */
export function clickItems(card: OverseerCard, click: CardClick): CardItem[] {
  if ("option" in click) return card.items;
  return card.items.filter((it) => click.items[it.n] !== undefined);
}
