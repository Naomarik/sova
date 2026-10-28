import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildRequest, findCommand } from "../shared/commands-catalog";
import type { SessionSummary } from "../shared/protocol";
import { checkCardData, type ButtonsCard, type DataCardKind } from "../shared/view-cards";
import {
  answerOf,
  CARD_FILE,
  CARD_FILE_MAX_BYTES,
  CARD_ID_RE,
  CARD_NAME_RE,
  CARD_TYPES_MAX,
  CARDS_DIR,
  KEY_MAX,
  normalizeCardInfo,
  normalizeCardSnapshot,
  notRaisedText,
  parseCardFile,
  VIEW_FILE,
  type CardAnswer,
  type CardDecl,
  type CardFolder,
  type CardInfo,
  type CardRaiser,
  type CardSnapshot,
  type SessionCardsAnswer,
} from "../shared/transcript-cards";
import type { HEntry } from "../shared/harness";
import { checkoutRootOf } from "../pi-config/extensions/mode/project-discovery.ts";
import { sessionsChanged } from "./list-generation";
import { projectRootOf } from "./project-root";
import { stateRoot } from "./state-root";

/**
 * Transcript cards (§chat/transcript-cards), the server's side: a project's card folders
 * (§chat.transcript-cards/files), each session's snapshot of the types it may raise and its raised
 * cards with their answers, in `<state root>/session-cards/<session id>.json`, never in the
 * session's file; trust in `<state root>/card-trust.json` (§chat.transcript-cards/trust). Raising
 * (§chat.transcript-cards/card-tool, /raise-command) and answering (/answering) check every rule
 * here; the rest of the server (summaries, the routes a button runs) is reached through `deps`, so
 * this module imports no chat machinery and tests swap any part.
 */

export class CardRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 409,
    /** A press that needs its owner trusted first (§chat.transcript-cards/trust). */
    readonly needsTrust?: { owner: string; name: string },
  ) {
    super(message);
  }
}

export interface CardDeps {
  summary(path: string): Promise<SessionSummary | null>;
  /** The head of a session file: its id, cwd, the fork's parent path, and whether it holds a user message yet. */
  head(path: string): Promise<{ id?: string; cwd?: string; parent?: string; started?: boolean } | null>;
  /** The last entry of the session's branch that draws a row, by id (an outside card's place). */
  lastEntry(path: string): Promise<string | null>;
  /** An in-process request to the app, as the browser makes it. */
  request(path: string, init?: RequestInit): Promise<Response>;
  now(): Date;
}

const ROW_KINDS = new Set<HEntry["kind"]>(["user", "assistant", "tool-result", "shell", "note", "compaction", "summary"]);

const defaults: CardDeps = {
  async summary(path) {
    return (await import("./sessions-index")).getSessionSummary(path);
  },
  async head(path) {
    const h = await (await import("./sessions-index")).readHead(path).catch(() => null);
    const header = (h?.header ?? null) as { id?: unknown; cwd?: unknown; parentSession?: unknown } | null;
    if (!header) return null;
    return {
      ...(typeof header.id === "string" ? { id: header.id } : {}),
      ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
      ...(typeof header.parentSession === "string" ? { parent: header.parentSession } : {}),
      started: h?.input === true,
    };
  },
  async lastEntry(path) {
    const branch = await (await import("./harness/pi/reader")).readTailBranch(path, 512 * 1024).catch(() => [] as HEntry[]);
    for (let i = branch.length - 1; i >= 0; i--) {
      const h = branch[i]!;
      if (h.id && ROW_KINDS.has(h.kind) && !(h.kind === "note" && !h.display)) return h.id;
    }
    return null;
  },
  async request(path, init) {
    if (!dispatch) throw new Error("The server's routes are not wired yet.");
    return dispatch(path, init);
  },
  now: () => new Date(),
};

let dispatch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
/** index.ts hands over Hono's in-process dispatch, so a button's request is the browser's own (every guard applies). */
export function setCardsDispatch(fn: (path: string, init?: RequestInit) => Response | Promise<Response>): void {
  dispatch = async (path, init) => fn(path, init);
}

let deps: CardDeps = defaults;
/** Tests: swap parts of what the cards read. */
export function setCardDeps(over: Partial<CardDeps> | null): void {
  deps = over ? { ...defaults, ...over } : defaults;
}

// ---- a project's card folders (§chat.transcript-cards/files) ------------------------------------

/** The checkout a session's cards come from: its own (a worktree's branch has its own), as project modes find it. */
export const cardsCheckoutOf = (cwd: string | undefined): string | null => (cwd ? checkoutRootOf(cwd) : null);

/** Every folder under `<checkout>/.sova/cards/`, each its type or what is wrong; past 16 types, the rest are broken. */
export function readCardFolders(checkout: string): CardFolder[] {
  const dir = join(checkout, CARDS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: CardFolder[] = [];
  let valid = 0;
  for (const name of names) {
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const bad = (error: string): CardFolder => ({ name, path, ok: false, error });
    if (!CARD_NAME_RE.test(name)) {
      out.push(bad("The folder's name isn't lowercase letters, digits and hyphens starting with a letter, at most 32 characters."));
      continue;
    }
    let text: string;
    try {
      const buf = readFileSync(join(path, CARD_FILE));
      if (buf.length > CARD_FILE_MAX_BYTES) {
        out.push(bad(`${CARD_FILE} is over ${CARD_FILE_MAX_BYTES / 1024} KB.`));
        continue;
      }
      text = buf.toString("utf8");
    } catch {
      out.push(bad(`${CARD_FILE} is missing.`));
      continue;
    }
    const parsed = parseCardFile(name, text, existsSync(join(path, VIEW_FILE)));
    if (!parsed.ok) {
      out.push(bad(parsed.error));
      continue;
    }
    if (++valid > CARD_TYPES_MAX) {
      out.push(bad(`Past the first ${CARD_TYPES_MAX} card types; this one doesn't count.`));
      continue;
    }
    out.push({ name, path, ok: true, decl: parsed.decl });
  }
  return out;
}

/**
 * The types a checkout's folders declare, as a snapshot takes them. Views draw in a sealed box,
 * which this Sova doesn't build yet: only data cards are taken.
 */
export const snapshotTypes = (checkout: string | null): CardDecl[] =>
  checkout ? readCardFolders(checkout).flatMap((f) => (f.ok && f.decl.draws !== "view" ? [f.decl] : [])) : [];

// ---- the store ----------------------------------------------------------------------------------

interface SessionRecord {
  v: 1;
  sessionId: string;
  path: string;
  /** The snapshot, taken at the first build; null: none. */
  snapshot: CardSnapshot | null;
  taken: boolean;
  takenAt: string;
  n: number;
  cards: CardInfo[];
  /** The project root the snapshot's project types belong to (trust is by it). */
  root?: string;
}

export const cardsDir = () => join(stateRoot(), "session-cards");
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const recordFile = (sessionId: string) => join(cardsDir(), `${sessionId}.json`);
const records = new Map<string, { dir: string; rec: SessionRecord | null }>();

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

function readRecord(sessionId: string): SessionRecord | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const dir = cardsDir();
  const hit = records.get(sessionId);
  if (hit && hit.dir === dir) return hit.rec;
  let rec: SessionRecord | null = null;
  try {
    const raw = JSON.parse(readFileSync(recordFile(sessionId), "utf8")) as Record<string, unknown>;
    if (raw?.v === 1 && raw.sessionId === sessionId) {
      const cards = (Array.isArray(raw.cards) ? raw.cards : []).map(normalizeCardInfo).filter((c): c is CardInfo => !!c);
      rec = {
        v: 1,
        sessionId,
        path: typeof raw.path === "string" ? raw.path : "",
        snapshot: normalizeCardSnapshot(raw.snapshot),
        taken: raw.taken === true,
        takenAt: typeof raw.takenAt === "string" ? raw.takenAt : "",
        n: typeof raw.n === "number" ? raw.n : cards.length,
        cards,
        ...(typeof raw.root === "string" ? { root: raw.root } : {}),
      };
    }
  } catch {
    // missing or unreadable: none
  }
  records.set(sessionId, { dir, rec });
  return rec;
}

function saveRecord(rec: SessionRecord): void {
  writeAtomic(recordFile(rec.sessionId), rec);
  records.set(rec.sessionId, { dir: cardsDir(), rec });
  if (openIndex && openIndex.dir === cardsDir()) {
    const open = openOf(rec);
    if (open.length) openIndex.open.set(rec.sessionId, open);
    else openIndex.open.delete(rec.sessionId);
  }
  sessionsChanged();
}

/** Tests: forget what was read. */
export function resetCardsForTest(): void {
  records.clear();
  openIndex = null;
  inflight.clear();
}

const freshRecord = (sessionId: string, path: string): SessionRecord => ({ v: 1, sessionId, path, snapshot: null, taken: false, takenAt: "", n: 0, cards: [] });

// ---- the snapshot (§chat.transcript-cards/files, "Fixed per chat") ------------------------------

const inflight = new Map<string, Promise<CardSnapshot | null>>();

/**
 * The card types a session may raise, recorded the first time its tools are built and read from
 * that record ever after (a reopen, a reload, a restart's reconnect, a resumed Claude Code chat); a
 * fork starts with its parent's; a session that already holds a user message and has none records none.
 */
export function cardSnapshotFor(sessionId: string, path: string, cwd?: string): Promise<CardSnapshot | null> {
  if (!SESSION_ID_RE.test(sessionId)) return Promise.resolve(null);
  const rec = readRecord(sessionId);
  if (rec?.taken) return Promise.resolve(rec.snapshot);
  let p = inflight.get(sessionId);
  if (!p) {
    p = takeSnapshot(sessionId, path, cwd).finally(() => inflight.delete(sessionId));
    inflight.set(sessionId, p);
  }
  return p;
}

async function takeSnapshot(sessionId: string, path: string, cwd?: string): Promise<CardSnapshot | null> {
  const head = await deps.head(path).catch(() => null);
  let snapshot: CardSnapshot | null = null;
  let root: string | undefined;
  let inherited = false;
  if (head?.parent) {
    const parentId = (await deps.head(head.parent).catch(() => null))?.id;
    const parent = parentId ? readRecord(parentId) : null;
    if (parent?.taken) {
      snapshot = parent.snapshot;
      root = parent.root;
      inherited = true;
    }
  }
  // A session that talked before its types were snapshotted keeps what it had: none. Reading the
  // folders now would change its tools at its next reload (a Claude Code chat restarts on that).
  if (!inherited && !head?.started) {
    const at = cwd ?? head?.cwd;
    const types = snapshotTypes(cardsCheckoutOf(at));
    if (types.length) {
      snapshot = { v: 1, types };
      root = (await projectRootOf(at).catch(() => null)) ?? cardsCheckoutOf(at) ?? undefined;
    }
  }
  const again = readRecord(sessionId);
  if (again?.taken) return again.snapshot;
  saveRecord({ ...(again ?? freshRecord(sessionId, path)), snapshot, taken: true, takenAt: deps.now().toISOString(), ...(root ? { root } : {}) });
  return snapshot;
}

/** The snapshot a session's record holds, read without taking one (undefined: none recorded yet). */
export function recordedCardSnapshot(sessionId: string): CardSnapshot | null | undefined {
  const rec = readRecord(sessionId);
  return rec?.taken ? rec.snapshot : undefined;
}

// ---- trust (§chat.transcript-cards/trust) -------------------------------------------------------

export const cardTrustFile = () => join(stateRoot(), "card-trust.json");

function readTrust(file = cardTrustFile()): Record<string, { at: string }> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; trusted?: unknown };
    if (raw?.version !== 1 || !raw.trusted || typeof raw.trusted !== "object") return {};
    const out: Record<string, { at: string }> = {};
    for (const [k, v] of Object.entries(raw.trusted as Record<string, unknown>)) if (v && typeof v === "object") out[k] = { at: String((v as { at?: unknown }).at ?? "") };
    return out;
  } catch {
    return {};
  }
}

/** The trust key of a project's cards: its project root, so every branch and worktree of it. */
export const projectOwner = (root: string): string => `project:${root}`;

export const cardsTrusted = (owner: string, file = cardTrustFile()): boolean => !!readTrust(file)[owner];

/** Trust an owner's cards, or stop trusting them: a trust grant the page alone makes, never a catalogue command. */
export function setCardsTrusted(owner: string, on: boolean, file = cardTrustFile()): void {
  if (!/^project:\//.test(owner)) throw new CardRefusal("owner names a project's cards (project:<root>).", 400);
  const all = readTrust(file);
  if (on) all[owner] = { at: deps.now().toISOString() };
  else delete all[owner];
  writeAtomic(file, { version: 1, trusted: all });
}

const ownerName = (owner: string): string => basename(owner.replace(/^project:/, "")) || owner;

// ---- raising (§chat.transcript-cards/card-tool, /raise-command) ---------------------------------

export interface RaiseInput {
  path: string;
  /** Known to a tool call; else read from the summary. */
  sessionId?: string;
  type: unknown;
  data?: unknown;
  key?: unknown;
  by: CardRaiser;
  toolCallId?: string;
  /** Another revision of an open card's data, or marking it done (session.card.post with `card`). */
  card?: unknown;
  done?: unknown;
}

const NOTHING = "Nothing was raised:";

async function summaryOf(path: string): Promise<SessionSummary> {
  const s = await deps.summary(path);
  if (!s) throw new CardRefusal("No such session.", 404);
  return s;
}

/** Raise a card, give an open one a new revision of its data, or mark it done: every rule checked, the card recorded and returned. */
export async function raiseCard(input: RaiseInput): Promise<CardInfo> {
  const s = await summaryOf(input.path);
  const sessionId = input.sessionId ?? s.id;
  if (s.archived) throw new CardRefusal(`${NOTHING} this session is archived.`);
  if (s.workerSession || s.overseer || s.projectOverseer || s.baton) throw new CardRefusal(`${NOTHING} cards show only in ordinary chats.`);
  if ((s.align?.openQuestions ?? 0) > 0) throw new CardRefusal(`${NOTHING} an alignment question is open.`);
  if (input.card !== undefined) return reviseCard(input, sessionId);
  if (typeof input.type !== "string" || !input.type) throw new CardRefusal(`${NOTHING} type names one of the session's card types.`, 400);
  const snapshot = await cardSnapshotFor(sessionId, input.path, s.cwd);
  const decl = snapshot?.types.find((t) => t.type === input.type);
  if (!decl) throw new CardRefusal(`${NOTHING} "${input.type}" is not a card type this session may raise.`, 400);
  if (input.by.kind === "agent" && !decl.when) throw new CardRefusal(`${NOTHING} "${input.type}" is raised only from outside the chat.`, 400);
  let key: string | undefined;
  if (decl.placement === "follow") {
    if (typeof input.key !== "string" || !input.key.trim()) throw new CardRefusal(`${NOTHING} "${input.type}" follows the chat, so it needs a key.`, 400);
    if ([...input.key].length > KEY_MAX) throw new CardRefusal(`${NOTHING} key is longer than ${KEY_MAX} characters.`, 400);
    key = input.key;
  } else if (input.key !== undefined) throw new CardRefusal(`${NOTHING} "${input.type}" takes no key.`, 400);
  const draws = decl.draws as DataCardKind;
  const checked = checkCardData(draws, input.data);
  if (!checked.ok) throw new CardRefusal(notRaisedText(checked.error), 400);
  const after = input.toolCallId ? undefined : await deps.lastEntry(input.path).catch(() => null);
  const rec = readRecord(sessionId) ?? freshRecord(sessionId, input.path);
  const at = deps.now().toISOString();
  let revision: number | undefined;
  if (key !== undefined) {
    const same = rec.cards.filter((c) => c.type === decl.type && c.key === key);
    revision = same.length + 1;
    // Each revision stands where it was raised; only the newest is the card (§chat.transcript-cards/placement).
    for (const c of same) if (c.state === "open") c.state = "superseded";
  }
  const card: CardInfo = {
    id: `cd_${++rec.n}`,
    type: decl.type,
    title: decl.title,
    draws,
    answerMode: decl.answer,
    placement: decl.placement,
    ...(key !== undefined ? { key, revision } : {}),
    data: checked.data,
    at,
    by: input.by,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : { after: after ?? null }),
    state: decl.answer === "none" ? "done" : "open",
  };
  rec.cards.push(card);
  rec.path = input.path;
  saveRecord(rec);
  return card;
}

/** session.card.post with `card`: a new revision of an open card's data in place (its answer kept), or done. */
function reviseCard(input: RaiseInput, sessionId: string): CardInfo {
  if (typeof input.card !== "string" || !CARD_ID_RE.test(input.card)) throw new CardRefusal(`${NOTHING} card names a card of the session (cd_N).`, 400);
  const rec = readRecord(sessionId);
  const card = rec?.cards.find((c) => c.id === input.card);
  if (!rec || !card) throw new CardRefusal(`${NOTHING} the session has no card ${input.card}.`, 404);
  if (card.state === "superseded" || card.state === "done") throw new CardRefusal(`${NOTHING} ${card.id} is ${card.state === "done" ? "done" : "replaced by a newer revision"}.`);
  if (input.type !== undefined && input.type !== card.type) throw new CardRefusal(`${NOTHING} ${card.id} is a ${card.type} card.`, 400);
  if (input.data !== undefined) {
    const checked = checkCardData(card.draws, input.data);
    if (!checked.ok) throw new CardRefusal(notRaisedText(checked.error), 400);
    card.data = checked.data;
  }
  if (input.done === true) card.state = "done";
  else if (input.data === undefined) throw new CardRefusal(`${NOTHING} give data for a new revision, or done: true.`, 400);
  saveRecord(rec);
  return card;
}

// ---- answering (§chat.transcript-cards/answering) -----------------------------------------------

export interface AnswerInput {
  path: string;
  card: unknown;
  answer: unknown;
  /** "you" (the page) or the caller's name. */
  by: string;
  /** A gathered pick recorded once its message went out. */
  via: "at-once" | "send";
}

/** Record an answer on an open card; a button that sends or runs does it, once its owner is trusted. */
export async function answerCard(input: AnswerInput): Promise<CardInfo> {
  const s = await summaryOf(input.path);
  if (typeof input.card !== "string" || !CARD_ID_RE.test(input.card)) throw new CardRefusal("card names a card of the session (cd_N).", 400);
  const rec = readRecord(s.id);
  const card = rec?.cards.find((c) => c.id === input.card);
  if (!rec || !card) throw new CardRefusal(`The session has no card ${input.card}.`, 404);
  if (card.answerMode === "none") throw new CardRefusal(`${card.id} takes no answer.`);
  if (card.state !== "open") throw new CardRefusal(card.answer ? `${card.id} is already answered: ${card.answer.text}.` : `${card.id} is ${card.state === "done" ? "done" : "replaced by a newer revision"}.`);
  if (input.via === "at-once" && card.answerMode !== "at-once") throw new CardRefusal(`${card.id} gathers its answer: it goes with the next message.`);
  const a = answerOf(card, input.answer);
  if (!a.ok) throw new CardRefusal(a.error, 400);
  // A button that acts runs only for a trusted owner (a command that only looks always runs).
  const button = card.draws === "buttons" && "button" in a.value && input.via === "at-once" ? (card.data as ButtonsCard).buttons[a.value.button] : undefined;
  const does = button?.does;
  if (does && does.kind !== "answer") {
    const acts = does.kind === "send" || findCommand(does.command)?.effect !== "looks";
    const owner = rec.root ? projectOwner(rec.root) : null;
    if (acts && (!owner || !cardsTrusted(owner)))
      throw new CardRefusal(`This card's project isn't trusted to act for you yet: trust its cards first. Nothing was ${does.kind === "send" ? "sent" : "run"}.`, 409, owner ? { owner, name: ownerName(owner) } : undefined);
  }
  // The first answer claims the card, before anything is awaited.
  const answer: CardAnswer = { value: a.value, text: a.text, by: input.by, at: deps.now().toISOString(), via: input.via };
  card.answer = answer;
  card.state = "answered";
  saveRecord(rec);
  if (does && does.kind !== "answer") {
    const outcome = does.kind === "send" ? await sendAs(input.path, does.text) : await runCommand(does.command, does.params ?? {}, input.path);
    answer.outcome = outcome;
    saveRecord(rec);
  }
  return card;
}

async function sendAs(path: string, text: string): Promise<{ state: "done" | "failed"; text: string }> {
  const req = buildRequest(findCommand("session.send")!, { session: path, text, delivery: "followUp" });
  const res = await deps.request(req.url, { method: req.method, headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
  if (res.ok) {
    await res.body?.cancel();
    return { state: "done", text: "Sent." };
  }
  const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return { state: "failed", text: typeof j?.error === "string" ? j.error : `Sending failed (${res.status}).` };
}

/** A button's command, as the web app would run it: the catalogue entry's own request, answered in the route's words. */
async function runCommand(id: string, params: Record<string, unknown>, path: string): Promise<{ state: "done" | "failed"; text: string }> {
  const entry = findCommand(id);
  if (!entry) return { state: "failed", text: `${id} is no Sova command.` };
  // A session param the button left out is this card's session.
  const values = { ...params };
  if (entry.params.session && values.session === undefined) values.session = path;
  let req: ReturnType<typeof buildRequest>;
  try {
    req = buildRequest(entry, values);
  } catch (err) {
    return { state: "failed", text: err instanceof Error ? err.message : String(err) };
  }
  const res = await deps.request(req.url, { method: req.method, headers: { "content-type": "application/json", "x-sova-command": id }, ...(req.body ? { body: JSON.stringify(req.body) } : {}) });
  const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (res.ok) return { state: "done", text: `${entry.label} done.` };
  return { state: "failed", text: typeof j?.error === "string" ? j.error : `${entry.label} failed (${res.status}).` };
}

// ---- reads --------------------------------------------------------------------------------------

/** A session's cards and the types its snapshot holds (GET /api/session-cards, session.card.get). */
export async function sessionCardsAt(path: string): Promise<SessionCardsAnswer> {
  const s = await summaryOf(path);
  const rec = readRecord(s.id);
  const owner = rec?.root ? projectOwner(rec.root) : null;
  return {
    cards: rec?.cards ?? [],
    types: rec?.snapshot?.types ?? [],
    ...(owner ? { trust: { owner, name: ownerName(owner), trusted: cardsTrusted(owner) } } : {}),
  };
}

/** Whether a session has any card at all (the page's poll stops when none). */
export const hasCards = (sessionId: string): boolean => (readRecord(sessionId)?.cards.length ?? 0) > 0;

// ---- the agent's note and Needs you -------------------------------------------------------------

/**
 * The hidden note at the agent's next turn (§chat.transcript-cards/answering): every answer given
 * at once since `since` (the last note's time on the branch), naming the card, the answer, who gave
 * it and any command's outcome. The same text until a newer answer, so the note hook sends it once.
 */
export function cardNoteFor(sessionId: string, since?: string | null): string | null {
  const rec = readRecord(sessionId);
  const from = since ? Date.parse(since) || 0 : 0;
  const lines: string[] = [];
  for (const c of rec?.cards ?? []) {
    const a = c.answer;
    if (!a || a.via !== "at-once" || Date.parse(a.at) <= from) continue;
    const who = a.by === "you" ? "The user" : a.by;
    const outcome = a.outcome ? ` ${a.outcome.state === "done" ? "It went through" : "It failed"}: ${a.outcome.text}` : "";
    lines.push(`Card ${c.id} (${c.type}, "${c.title}"): ${who} chose ${a.text}.${outcome}`);
  }
  return lines.length ? lines.join("\n") : null;
}

/** An open card's Needs you item: its title and when it was raised. */
export interface OpenCard {
  id: string;
  title: string;
  at: number;
}

/** Every open card waiting on an answer: answerable, open, the newest revision of its key. */
function openOf(rec: SessionRecord): OpenCard[] {
  return rec.cards.filter((c) => c.state === "open" && c.answerMode !== "none").map((c) => ({ id: c.id, title: dataTitle(c) ?? c.title, at: Date.parse(c.at) || 0 }));
}

const dataTitle = (c: CardInfo): string | undefined => {
  const t = (c.data as { title?: unknown } | null)?.title;
  return typeof t === "string" && t.trim() ? t : undefined;
};

let openIndex: { dir: string; open: Map<string, OpenCard[]> } | null = null;

/** A session's open cards (§app.overseer/attention-digest, `card-waiting`), from one index of every record. */
export function openCardsOf(sessionId: string): OpenCard[] {
  const dir = cardsDir();
  if (!openIndex || openIndex.dir !== dir) {
    openIndex = { dir, open: new Map() };
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const rec = readRecord(n.slice(0, -5));
      const open = rec ? openOf(rec) : [];
      if (rec && open.length) openIndex.open.set(rec.sessionId, open);
    }
  }
  return openIndex.open.get(sessionId) ?? [];
}
