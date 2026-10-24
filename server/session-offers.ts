import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildRequest, findCommand } from "../shared/commands-catalog";
import type { SessionSignals, SessionSummary } from "../shared/protocol";
import {
  type OfferCard,
  type OfferCondition,
  type OfferDef,
  type OfferRepeat,
  type OfferSnapshot,
  type LandingRecord,
  type ParsedOffersFile,
  type ProjectOffersAnswer,
  type SessionOffersAnswer,
  FILE_MAX_BYTES,
  fillText,
  liveOffer,
  normalizeOfferCard,
  normalizeSnapshot,
  NOTE_MAX,
  OFFER_DETAILS_VERSION,
  OFFERS_FILE,
  parseOffersFile,
  rarelyUsed,
  runButtonsOf,
  snapshotOf,
  TITLE_COMMIT_LEN,
} from "../shared/session-offers";
import { sessionsChanged } from "./list-generation";
import { projectRootOf } from "./project-root";
import { runFingerprint, runsApproved } from "./session-offers-trust";
import { stateRoot } from "./state-root";
import { unpromotedDraftNames } from "./spec-drafts-state";
import { canonical } from "../pi-config/extensions/worktrees/state.ts";
import { LANDING_FILE_NAME, recordGoAhead, recordNotYet } from "../pi-config/extensions/worktrees/landing.ts";

/**
 * Session offers (§chat/offers): the server's side. Each session's record (its tool snapshot, its
 * cards, its Not Now list) lives in `<state root>/session-offers/<session id>.json`, never in the
 * session's file; the per-project counts in `counts.json` beside them. The offers file is read again
 * on every show and click (§chat.offers/file). Everything that needs the rest of the server
 * (summaries, readiness, the routes a button runs) is reached through `deps`, wired lazily, so this
 * module imports no chat or session machinery and tests swap any part.
 */

export class OfferRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

/** A card as stored: the wire card plus what a click needs. */
interface StoredCard extends OfferCard {
  moment: string;
  root: string;
  /** Per button: its send text (filled in when shown), its run id, where a send goes. */
  sends: (string | null)[];
  runs: (string | null)[];
  to: ("shower" | null)[];
  /** The session that showed it (another chat's), by path. */
  fromPath?: string;
  /** Per button: what its click records (§chat.offers/buttons, landing). */
  landing?: (LandingRecord | null)[];
  /** The branch and full head commit the card was shown for. */
  branch?: string;
  head?: string;
}

interface SessionRecord {
  v: 1;
  sessionId: string;
  path: string;
  /** The tool's snapshot, taken at the first build; null = no tool. */
  snapshot: OfferSnapshot | null;
  /** Whether the first build took it (a record a show or Not Now made first has none yet). */
  taken: boolean;
  takenAt: string;
  n: number;
  cards: StoredCard[];
  notNow: string[];
}

export interface OfferDeps {
  summary(path: string): Promise<SessionSummary | null>;
  /** The session's readiness once its turn ends (merge-readiness idleReadinessOf). */
  readiness(s: SessionSummary): Promise<SessionSummary["readiness"]>;
  sessions(): Promise<SessionSummary[]>;
  /** The head of a session file: its id, cwd, the fork's parent path, and whether it holds a user message yet. */
  head(path: string): Promise<{ id?: string; cwd?: string; parent?: string; started?: boolean } | null>;
  /** Path of a session by id. */
  pathOf(id: string): Promise<string | undefined>;
  /** An in-process request to the app, as the browser makes it. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Sova's projects (for a run button's project id). */
  projects(): Promise<{ id: string; root: string }[]>;
  git(args: string[], cwd: string): Promise<{ code: number; stdout: string }>;
  now(): Date;
}

/** A root as projectRootOf gives it (the real path), for comparing a registered project's root. */
export const canonicalRoot = (root: string): string => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

const gitRun = (args: string[], cwd: string): Promise<{ code: number; stdout: string }> =>
  new Promise((done) => {
    execFile("git", args, { cwd, timeout: 5_000, maxBuffer: 256 * 1024 }, (err, stdout) => done({ code: err ? 1 : 0, stdout: String(stdout) }));
  });

const defaults: OfferDeps = {
  async summary(path) {
    return (await import("./sessions-index")).getSessionSummary(path);
  },
  async readiness(s) {
    return (await import("./merge-readiness")).idleReadinessOf(s);
  },
  async sessions() {
    return (await import("./sessions-index")).listSessions();
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
  async pathOf(id) {
    return (await import("./sessions-index")).indexedSessionPaths().get(id);
  },
  async request(path, init) {
    if (!dispatch) throw new Error("The server's routes are not wired yet.");
    return dispatch(path, init);
  },
  async projects() {
    return (await import("./projects/spaces")).listProjects().map((p) => ({ id: p.id, root: canonicalRoot(p.root) }));
  },
  git: gitRun,
  now: () => new Date(),
};

/** index.ts hands over Hono's in-process dispatch at startup, so a button's request is the browser's own
    (every guard applies) and this module never imports the app. */
let dispatch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
export function setOffersDispatch(fn: (path: string, init?: RequestInit) => Response | Promise<Response>): void {
  dispatch = async (path, init) => fn(path, init);
}

let deps: OfferDeps = defaults;
/** Tests: swap parts of what the offers read. */
export function setOfferDeps(over: Partial<OfferDeps> | null): void {
  deps = over ? { ...defaults, ...over } : defaults;
}

const lastOf = <T>(list: readonly T[], ok: (x: T) => boolean): T | undefined => {
  for (let i = list.length - 1; i >= 0; i--) if (ok(list[i]!)) return list[i];
  return undefined;
};

// ---- the store ----------------------------------------------------------------------------------

export const offersDir = () => join(stateRoot(), "session-offers");
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const recordFile = (sessionId: string) => join(offersDir(), `${sessionId}.json`);
const countsFile = () => join(offersDir(), "counts.json");

const records = new Map<string, { dir: string; rec: SessionRecord | null }>();

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(offersDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
}

function readRecord(sessionId: string): SessionRecord | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const dir = offersDir();
  const hit = records.get(sessionId);
  if (hit && hit.dir === dir) return hit.rec;
  let rec: SessionRecord | null = null;
  try {
    const raw = JSON.parse(readFileSync(recordFile(sessionId), "utf8")) as Record<string, unknown>;
    if (raw?.v === 1 && raw.sessionId === sessionId) {
      const cards: StoredCard[] = [];
      for (const c of Array.isArray(raw.cards) ? raw.cards : []) {
        const card = normalizeOfferCard(c);
        const s = c as Record<string, unknown>;
        if (!card || typeof s.moment !== "string" || typeof s.root !== "string" || !Array.isArray(s.sends) || !Array.isArray(s.runs) || !Array.isArray(s.to)) continue;
        cards.push({
          ...card,
          moment: s.moment,
          root: s.root,
          sends: s.sends as (string | null)[],
          runs: s.runs as (string | null)[],
          to: s.to as ("shower" | null)[],
          ...(typeof s.fromPath === "string" ? { fromPath: s.fromPath } : {}),
          ...(Array.isArray(s.landing) ? { landing: s.landing as (LandingRecord | null)[] } : {}),
          ...(typeof s.branch === "string" ? { branch: s.branch } : {}),
          ...(typeof s.head === "string" ? { head: s.head } : {}),
        });
      }
      rec = {
        v: 1,
        sessionId,
        path: typeof raw.path === "string" ? raw.path : "",
        snapshot: normalizeSnapshot(raw.snapshot),
        taken: raw.taken === true,
        takenAt: typeof raw.takenAt === "string" ? raw.takenAt : "",
        n: typeof raw.n === "number" ? raw.n : cards.length,
        cards,
        notNow: Array.isArray(raw.notNow) ? (raw.notNow as unknown[]).filter((x): x is string => typeof x === "string") : [],
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
  records.set(rec.sessionId, { dir: offersDir(), rec });
  if (openIndex && openIndex.dir === offersDir()) {
    const open = lastOf(rec.cards, (c) => c.state === "open");
    if (open) openIndex.open.set(rec.sessionId, { title: open.title, at: Date.parse(open.at), name: open.name, root: open.root });
    else openIndex.open.delete(rec.sessionId);
  }
  sessionsChanged();
}

/** Tests: forget what was read. */
export function resetOffersForTest(): void {
  records.clear();
  openIndex = null;
  inflight.clear();
}

// ---- counts -------------------------------------------------------------------------------------

type Counts = Record<string, Record<string, { shown: number; used: number }>>;
function readCounts(): Counts {
  try {
    const raw = JSON.parse(readFileSync(countsFile(), "utf8")) as { v?: unknown; projects?: unknown };
    return raw?.v === 1 && raw.projects && typeof raw.projects === "object" ? (raw.projects as Counts) : {};
  } catch {
    return {};
  }
}
function bump(root: string, name: string, key: "shown" | "used"): void {
  const all = readCounts();
  const p = (all[root] ??= {});
  const c = (p[name] ??= { shown: 0, used: 0 });
  c[key] = (Number(c[key]) || 0) + 1;
  try {
    writeAtomic(countsFile(), { v: 1, projects: all });
  } catch (err) {
    console.warn(`[offers] counts not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the file -----------------------------------------------------------------------------------

/** A project's offers file, read now (§chat.offers/file). */
export function readOffersFile(root: string): ParsedOffersFile {
  let text: string;
  try {
    const buf = readFileSync(join(root, OFFERS_FILE));
    if (buf.length > FILE_MAX_BYTES) return { state: "broken", error: `The file is over ${FILE_MAX_BYTES / 1024} KB.` };
    text = buf.toString("utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "missing" } : { state: "broken", error: `Sova can't read the file (${code ?? "unknown error"}).` };
  }
  return parseOffersFile(text);
}

// ---- the snapshot (§chat.offers/tool) -----------------------------------------------------------

const inflight = new Map<string, Promise<OfferSnapshot | null>>();

/**
 * The offers a session's tool names, recorded at its first build and read from that record ever
 * after (a reopen, a reload, a server restart's reconnect, a resume); a fork starts with its
 * parent's. Null: no tool.
 */
export function offerSnapshotFor(sessionId: string, path: string, cwd?: string): Promise<OfferSnapshot | null> {
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

async function takeSnapshot(sessionId: string, path: string, cwd?: string): Promise<OfferSnapshot | null> {
  const head = await deps.head(path).catch(() => null);
  let snapshot: OfferSnapshot | null = null;
  let inherited = false;
  if (head?.parent) {
    const parentId = (await deps.head(head.parent).catch(() => null))?.id;
    const parent = parentId ? readRecord(parentId) : null;
    if (parent?.taken) {
      snapshot = parent.snapshot;
      inherited = true;
    }
  }
  // A session that already talked before its tools were snapshotted (it predates offers, or its record
  // was lost) keeps the tools it had: none. Reading the file now would change its tools on its next
  // reload, which restarts a Claude Code chat with lossy history.
  if (!inherited && head?.started) {
    // snapshot stays null
  } else if (!inherited) {
    const root = await projectRootOf(cwd ?? head?.cwd).catch(() => null);
    snapshot = root ? snapshotOf(readOffersFile(root)) : null;
  }
  // Recorded only if no build recorded one meanwhile; a record a show or Not Now made keeps its cards.
  const again = readRecord(sessionId);
  if (again?.taken) return again.snapshot;
  saveRecord({ ...(again ?? { v: 1 as const, sessionId, path, n: 0, cards: [], notNow: [] }), snapshot, taken: true, takenAt: deps.now().toISOString() });
  return snapshot;
}

/** The snapshot a session's record holds, read without taking one (undefined: none recorded yet). */
export function recordedSnapshot(sessionId: string): OfferSnapshot | null | undefined {
  const rec = readRecord(sessionId);
  return rec?.taken ? rec.snapshot : undefined;
}

// ---- facts, conditions and the moment (§chat.offers/conditions) ---------------------------------

interface Facts {
  branch?: string;
  base?: string;
  commit?: string;
  project: string;
  /** The folder's spec drafts not promoted, by name ({drafts}). */
  drafts?: string;
}

async function gitLine(args: string[], cwd: string): Promise<string | undefined> {
  const r = await deps.git(args, cwd).catch(() => ({ code: 1, stdout: "" }));
  const line = r.stdout.trim();
  return r.code === 0 && line ? line : undefined;
}

async function factsOf(cwd: string, root: string): Promise<Facts & { head?: string }> {
  const head = await gitLine(["rev-parse", "HEAD"], cwd);
  const branch = await gitLine(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  let base: string | undefined;
  for (const b of ["master", "main"]) {
    if (await gitLine(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd)) {
      base = b;
      break;
    }
  }
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), ...(base ? { base } : {}), ...(head ? { head, commit: head.slice(0, 12) } : {}), project: basename(root) || root };
}

const CONDITION_WORDS: Record<OfferCondition, string> = {
  "branch-ready": "the branch is ready to merge",
  "waiting-for-ok": "the branch waits for the user's OK",
  "tree-clean": "the folder has no uncommitted changes",
  "no-open-alignment": "no alignment question is open",
  "has-merge-captain": "a Merge Captain session works in this project",
  "ready-to-land": "the branch is ready to land",
  "specs-promoted": "the branch holds no spec draft left unpromoted",
  "specs-left": "the branch holds spec drafts left unpromoted",
};

/** The trees a condition reads: the one the offer is shown for, else every tree of the session. */
type TreesOf = () => Promise<NonNullable<SessionSummary["readiness"]>["trees"]>;

async function conditionHolds(c: OfferCondition, s: SessionSummary, root: string, trees: TreesOf, folder: string): Promise<boolean> {
  switch (c) {
    case "branch-ready":
      return (await trees()).some((t) => t.state === "ready" || t.state === "waiting-approval");
    case "waiting-for-ok":
      return (await trees()).some((t) => t.state === "waiting-approval");
    case "ready-to-land":
      return (await trees()).some((t) => t.landing?.state === "ready" || !!t.landing?.specsWhy);
    case "specs-promoted":
      return !unpromotedDraftNames(folder)?.length;
    case "specs-left":
      return !!unpromotedDraftNames(folder)?.length;
    case "tree-clean": {
      const r = await deps.git(["status", "--porcelain"], s.cwd).catch(() => ({ code: 1, stdout: "x" }));
      return r.code === 0 && r.stdout.trim() === "";
    }
    case "no-open-alignment":
      return !(s.align?.openQuestions ?? 0);
    case "has-merge-captain": {
      for (const o of await deps.sessions()) {
        if (o.id === s.id || o.archived || o.profile?.id !== "merge-captain") continue;
        if ((await projectRootOf(o.cwd).catch(() => null)) === root) return true;
      }
      return false;
    }
  }
}

const MOMENT_WORDS: Record<OfferRepeat, string> = { "once-per-commit": "for this commit", "once-per-reply": "for this reply", "once-per-session": "in this session" };

// ---- showing one --------------------------------------------------------------------------------

export interface ShowInput {
  path: string;
  /** The session's id when the caller knows it (a tool call); else read from the file. */
  sessionId?: string;
  offer: string;
  note?: string;
  by: "agent" | "another-chat";
  toolCallId?: string;
  /** With by another-chat: the session that shows it, by path. */
  from?: string;
  /** The user message the agent's turn answers (once-per-reply). */
  replyId?: string;
  /** The worktree the offer is for (Sova's Landing card on the captain's queue): its branch, commit
      and conditions are read there instead of the session's folder. */
  tree?: string;
}

const projectWords = "Nothing was shown.";

/**
 * Show an offer (§chat.offers/tool, §chat.offers/from-another-chat): every rule checked against the
 * file as it is now; the card recorded and returned, or an OfferRefusal saying why nothing was shown.
 */
export async function showOffer(input: ShowInput): Promise<OfferCard> {
  const s = await deps.summary(input.path);
  if (!s) throw new OfferRefusal("No such session.", 404);
  const sessionId = input.sessionId ?? s.id;
  if (s.archived) throw new OfferRefusal(`This session is archived. ${projectWords}`);
  if (s.workerSession || s.overseer || s.projectOverseer || s.baton) throw new OfferRefusal(`Offers show only in ordinary chats. ${projectWords}`);
  const root = await projectRootOf(s.cwd).catch(() => null);
  if (!root) throw new OfferRefusal(`This session's folder is in no project, so it has no offers. ${projectWords}`);
  const file = readOffersFile(root);
  if (file.state !== "ok") throw new OfferRefusal(file.state === "missing" ? `This project has no ${OFFERS_FILE}. ${projectWords}` : `This project's ${OFFERS_FILE} is broken: ${file.error} ${projectWords}`);
  const def = liveOffer(file, input.offer);
  if (!def) throw new OfferRefusal(`"${input.offer}" is not an offer in this project's ${OFFERS_FILE} now (removed, disabled or broken). ${projectWords}`);
  if (input.by === "agent" && def.shownBy !== "agent") throw new OfferRefusal(`Only another chat shows "${input.offer}". ${projectWords}`);
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : undefined;
  if (note && note.length > NOTE_MAX) throw new OfferRefusal(`The note is ${note.length} characters (at most ${NOTE_MAX}). ${projectWords}`, 400);
  const rec = readRecord(sessionId) ?? { v: 1 as const, sessionId, path: input.path, snapshot: null, taken: false, takenAt: "", n: 0, cards: [], notNow: [] };
  if (rec.notNow.includes(input.offer)) throw new OfferRefusal(`The user chose Not Now on "${input.offer}" in this session. ${projectWords}`);
  if (def.buttons.some((b) => b.run) && !runsApproved(root, file)) throw new OfferRefusal(`"${input.offer}" has run buttons the user hasn't approved: they approve them on the project page's Offers list. ${projectWords}`);
  if ((s.align?.openQuestions ?? 0) > 0) throw new OfferRefusal(`This session has an open alignment question; offers wait until it is answered. ${projectWords}`);
  const fromPath = input.from;
  if (def.buttons.some((b) => b.to === "shower") && !fromPath) throw new OfferRefusal(`"${input.offer}" sends to the chat that shows it: name that chat with from. ${projectWords}`, 400);
  let readiness: Promise<SessionSummary["readiness"]> | undefined;
  const folder = input.tree ?? s.cwd;
  const trees: TreesOf = async () => {
    const all = (await (readiness ??= deps.readiness(s)))?.trees ?? [];
    return input.tree ? all.filter((t) => canonical(t.path) === canonical(input.tree!)) : all;
  };
  for (const c of def.onlyIf) if (!(await conditionHolds(c, s, root, trees, folder))) throw new OfferRefusal(`"${input.offer}" shows only when ${CONDITION_WORDS[c]}, and it doesn't now. ${projectWords}`);
  // A button's own conditions leave it off the card.
  const shown: OfferDef["buttons"] = [];
  for (const b of def.buttons) {
    let ok = true;
    for (const c of b.onlyIf ?? []) if (!(await conditionHolds(c, s, root, trees, folder))) ok = false;
    if (ok) shown.push(b);
  }
  if (!shown.length) throw new OfferRefusal(`None of "${input.offer}"'s buttons fits now. ${projectWords}`);
  const facts = await factsOf(folder, root);
  facts.drafts = unpromotedDraftNames(folder)?.join(", ");
  const moment = momentOf(def.repeat, facts.head, input.replyId ?? `at:${s.lastActiveAt ?? ""}`);
  if (rec.cards.some((c) => c.name === input.offer && c.moment === moment)) throw new OfferRefusal(`"${input.offer}" was already shown ${MOMENT_WORDS[def.repeat]}. ${projectWords}`);
  // One open offer at a time: a new one never replaces it (an open card whose offer left the file is withdrawn, and a
  // once-per-commit card whose branch moved on is superseded: neither is open, so the current one shows at once).
  let open: StoredCard | undefined;
  for (const c of rec.cards) {
    if (c.state !== "open" || !stillOffered(rec, c)) continue;
    if ((await commitMoved(c)) === "moved") {
      supersede(rec, c);
      continue;
    }
    open ??= c;
  }
  if (open) throw new OfferRefusal(`The offer "${open.name}" (${open.title}) is still open in this session; the user answers it first. ${projectWords}`);
  let from: OfferCard["from"];
  if (fromPath) {
    const f = await deps.summary(fromPath);
    if (!f) throw new OfferRefusal("The session in from doesn't exist.", 404);
    from = { id: f.id, title: f.title || "Untitled" };
  }
  const card = makeCard({ ...def, buttons: shown }, input, ++rec.n, facts, moment, root, note, from, fromPath, deps.now().toISOString());
  for (const c of rec.cards) if (c.state === "superseded" && !c.supersededBy) c.supersededBy = card.id;
  rec.cards.push(card);
  rec.path = input.path;
  saveRecord(rec);
  bump(root, input.offer, "shown");
  return wireCard(card);
}

function momentOf(repeat: OfferRepeat, head: string | undefined, reply: string): string {
  if (repeat === "once-per-session") return "session";
  if (repeat === "once-per-commit" && head) return `commit:${head}`;
  return `reply:${reply}`;
}

function makeCard(def: OfferDef, input: ShowInput, n: number, facts: Facts & { head?: string }, moment: string, root: string, note: string | undefined, from: OfferCard["from"], fromPath: string | undefined, at: string): StoredCard {
  const fill = { branch: facts.branch, base: facts.base, commit: facts.commit, project: facts.project, drafts: facts.drafts };
  return {
    id: `of_${n}`,
    name: input.offer,
    // A title names the commit short (§chat.offers/file); a send keeps the moment's longer form.
    title: fillText(def.title, { ...fill, commit: facts.head?.slice(0, TITLE_COMMIT_LEN) }),
    ...(note ? { note } : {}),
    buttons: def.buttons.map((b) => ({ label: b.label, about: b.about, kind: b.run ? ("run" as const) : ("send" as const), ...(b.confirm ? { confirm: fillText(b.confirm, fill) } : {}) })),
    at,
    by: input.by,
    ...(from ? { from } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    state: "open",
    moment,
    root,
    sends: def.buttons.map((b) => (b.send !== undefined ? fillText(b.send, fill) : null)),
    runs: def.buttons.map((b) => b.run ?? null),
    to: def.buttons.map((b) => b.to ?? null),
    ...(fromPath ? { fromPath } : {}),
    ...(def.buttons.some((b) => b.landing) ? { landing: def.buttons.map((b) => b.landing ?? null) } : {}),
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.head ? { head: facts.head } : {}),
  };
}

/** The card as the wire carries it (what a click needs stays here). */
function wireCard(c: StoredCard): OfferCard {
  const { moment: _m, root: _r, sends: _s, runs: _u, to: _t, fromPath: _f, landing: _l, branch: _b, head: _h, ...card } = c;
  return card;
}

// ---- clicks (§chat.offers/card) -----------------------------------------------------------------

/** The commit a once-per-commit card is for (§chat.offers/card), from its moment; undefined for any other card. */
const commitOf = (card: StoredCard): string | undefined => (card.moment.startsWith("commit:") ? card.moment.slice("commit:".length) : undefined);

/**
 * Whether a once-per-commit card's branch has moved on from the commit it was shown for (§chat.offers/card):
 * "moved", "same", "unknown" when the branch's head can't be read now, "untied" for a card tied to no commit
 * and branch. Read from the branch itself in the project's main checkout, so a worktree's own folder never matters.
 */
async function commitMoved(card: StoredCard): Promise<"moved" | "same" | "unknown" | "untied"> {
  const at = commitOf(card);
  if (!at || !card.branch) return "untied";
  const now = await gitLine(["rev-parse", "--verify", "-q", `refs/heads/${card.branch}^{commit}`], card.root);
  if (!now) return "unknown";
  return now === at ? "same" : "moved";
}

/** An open card replaced by a newer commit (§chat.offers/card): it reads "Replaced by a newer commit". */
function supersede(rec: SessionRecord, card: StoredCard): void {
  card.state = "superseded";
  saveRecord(rec);
}

/** Re-check a stored open card against the file now: a card whose offer left the file is withdrawn. */
function stillOffered(rec: SessionRecord, card: StoredCard): { file: ParsedOffersFile; def: OfferDef } | null {
  const file = readOffersFile(card.root);
  const def = liveOffer(file, card.name);
  if (def) return { file, def };
  card.state = "withdrawn";
  saveRecord(rec);
  return null;
}

/**
 * A button's click: the choice recorded and its buttons gone; a send button's text sent as the user
 * (session.send); a run button's catalogue action run, its outcome recorded for the card and the
 * agent's next turn.
 */
export async function chooseOffer(path: string, sessionId: string, cardId: string, index: number): Promise<OfferCard> {
  const rec = readRecord(sessionId);
  const card = rec?.cards.find((c) => c.id === cardId);
  if (!rec || !card) throw new OfferRefusal("No such offer card in this session.", 404);
  if (card.state !== "open") throw new OfferRefusal("This card is no longer open.");
  const button = card.buttons[index];
  if (!Number.isInteger(index) || !button) throw new OfferRefusal("No such button on this card.", 400);
  const live = stillOffered(rec, card);
  if (!live) throw new OfferRefusal(`This offer is no longer in the project's ${OFFERS_FILE}. Nothing was sent.`);
  // A card for one commit is never pressed once its branch moved on (§chat.offers/card): nothing sent, run or recorded.
  const moved = await commitMoved(card);
  if (moved === "moved") {
    supersede(rec, card);
    throw new OfferRefusal(`${card.branch} has a newer commit than this card was shown for, so the card was replaced. Nothing was sent.`);
  }
  if (moved === "unknown") throw new OfferRefusal(`Sova can't read ${card.branch}'s current commit, so it can't tell this card still stands. Nothing was sent.`);
  // Read again after the await: a second click at the same moment finds it claimed.
  if (card.state !== "open") throw new OfferRefusal("This card is no longer open.");
  const run = card.runs[index];
  if (run && !runsApproved(card.root, live.file)) throw new OfferRefusal("This offer's run buttons are not approved now: approve them on the project page's Offers list. Nothing ran.");
  const at = deps.now().toISOString();
  if (!run) {
    const text = card.sends[index] ?? "";
    const target = card.to[index] === "shower" ? card.fromPath : path;
    if (!target) throw new OfferRefusal("The chat this button sends to is not known. Nothing was sent.");
    // Claimed before the send, so a second click at the same time finds it no longer open; reopened if the send fails.
    Object.assign(card, { state: "chosen", choice: { index, label: button.label, at } });
    saveRecord(rec);
    const sent = await send(target, text).catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!sent.ok) {
      card.state = "open";
      delete card.choice;
      saveRecord(rec);
      throw new OfferRefusal(sent.error);
    }
    bump(card.root, card.name, "used");
    recordLanding(card, index, sessionId, at);
    return wireCard(card);
  }
  Object.assign(card, { state: "chosen", choice: { index, label: button.label, at }, outcome: { state: "running" } });
  saveRecord(rec);
  bump(card.root, card.name, "used");
  const outcome = await runButton(run, sessionId, card.root).catch((err) => ({ ok: false, text: err instanceof Error ? err.message : String(err) }));
  card.outcome = { state: outcome.ok ? "done" : "failed", text: outcome.text };
  saveRecord(rec);
  return wireCard(card);
}

/** Sova's own message to a session, as session.send (the specs nudge, §chat.worktrees/ready-to-land). Throws when it isn't sent. */
export async function sendToSession(path: string, text: string): Promise<void> {
  const r = await send(path, text);
  if (!r.ok) throw new Error(r.error);
}

export const landingFileOf = () => join(stateRoot(), LANDING_FILE_NAME);

/** A landing button's record, once its send went through (§chat.offers/buttons): the go-ahead for the card's exact commit, or Not Yet. */
function recordLanding(card: StoredCard, index: number, sessionId: string, at: string): void {
  const what = card.landing?.[index];
  if (!what || !card.branch || !card.head) return;
  try {
    if (what === "not-yet") recordNotYet({ branch: card.branch, commit: card.head, session: sessionId, at }, landingFileOf());
    else recordGoAhead({ branch: card.branch, commit: card.head, session: sessionId, at, by: "land-it", ...(what === "go-ahead-without-specs" ? { withoutSpecs: true as const } : {}) }, landingFileOf());
  } catch (err) {
    console.warn(`[offers] landing record not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function send(path: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const req = buildRequest(findCommand("session.send")!, { session: path, text, delivery: "followUp" });
  const res = await deps.request(req.url, { method: req.method, headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
  if (res.ok) {
    await res.body?.cancel();
    return { ok: true };
  }
  const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return { ok: false, error: typeof j?.error === "string" ? j.error : `Sending failed (${res.status}).` };
}

/** A run button's action, its params only from Sova's facts about the session (§chat.offers/buttons). */
async function runButton(id: string, sessionId: string, root: string): Promise<{ ok: boolean; text: string }> {
  const entry = findCommand(id);
  if (!entry) return { ok: false, text: `${id} is no Sova action.` };
  let values: Record<string, unknown>;
  switch (id) {
    case "project.worktree.merge": {
      const project = (await deps.projects()).find((p) => p.root === root);
      if (!project) return { ok: false, text: "This session's folder is in no Sova project, so Merge Worktree can't run." };
      values = { pid: project.id, "session-id": sessionId };
      break;
    }
    default:
      return { ok: false, text: `${id} is not one a button may run.` };
  }
  const req = buildRequest(entry, values);
  const res = await deps.request(req.url, { method: req.method, headers: { "content-type": "application/json" }, ...(req.body ? { body: JSON.stringify(req.body) } : {}) });
  const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (res.ok) return { ok: true, text: `${entry.label} done.` };
  return { ok: false, text: typeof j?.error === "string" ? j.error : `${entry.label} failed (${res.status}).` };
}

/** Not Now (§chat.offers/card): the offer hidden for the session, its open card set to Not Now. */
export function setNotNow(sessionId: string, path: string, offer: string, on: boolean): string[] {
  const rec = readRecord(sessionId) ?? { v: 1 as const, sessionId, path, snapshot: null, taken: false, takenAt: "", n: 0, cards: [], notNow: [] };
  if (on) {
    if (!rec.notNow.includes(offer)) rec.notNow.push(offer);
    for (const c of rec.cards) if (c.state === "open" && c.name === offer) c.state = "not-now";
  } else rec.notNow = rec.notNow.filter((n) => n !== offer);
  saveRecord(rec);
  return [...rec.notNow];
}

// ---- by path (the routes) ----------------------------------------------------------------------

async function summaryAt(path: string): Promise<SessionSummary> {
  const s = await deps.summary(path);
  if (!s) throw new OfferRefusal("No such session.", 404);
  return s;
}

export async function sessionOffersAt(path: string): Promise<SessionOffersAnswer> {
  const s = await summaryAt(path);
  return sessionOffers(s.id, s.cwd);
}

export async function chooseOfferAt(path: string, cardId: string, index: number): Promise<OfferCard> {
  return chooseOffer(path, (await summaryAt(path)).id, cardId, index);
}

export async function notNowAt(path: string, offer: string, on: boolean): Promise<string[]> {
  return setNotNow((await summaryAt(path)).id, path, offer, on);
}

/** A session named by path or id: its path, or undefined. */
export async function sessionPathOf(ref: string, resolve: (raw: string) => string | null): Promise<string | undefined> {
  return resolve(ref) ?? (await deps.pathOf(ref));
}

// ---- reads --------------------------------------------------------------------------------------

/** A session's cards and Not Now list (GET /api/session-offers). An open card whose offer left the file reads withdrawn. */
export async function sessionOffers(sessionId: string, cwd: string | undefined): Promise<SessionOffersAnswer> {
  const rec = readRecord(sessionId);
  const root = await projectRootOf(cwd).catch(() => null);
  const hasFile = !!root && readOffersFile(root).state !== "missing";
  if (!rec) return { cards: [], notNow: [], hasFile };
  for (const c of rec.cards) {
    if (c.state !== "open") continue;
    if (!liveOffer(readOffersFile(c.root), c.name)) {
      c.state = "withdrawn";
      saveRecord(rec);
    } else if ((await commitMoved(c)) === "moved") supersede(rec, c);
  }
  return { cards: rec.cards.map(wireCard), notNow: [...rec.notNow], hasFile: hasFile || rec.cards.length > 0 };
}

/** The project page's Offers list (§chat.offers/project-list). */
export function projectOffers(root: string): ProjectOffersAnswer {
  const file = readOffersFile(root);
  const counts = readCounts()[root] ?? {};
  const countOf = (name: string) => ({ shown: Number(counts[name]?.shown) || 0, used: Number(counts[name]?.used) || 0 });
  if (file.state !== "ok") return { root, file: file.state, ...(file.state === "broken" ? { error: file.error } : {}), offers: [] };
  const offers = file.offers.map((o) => {
    const c = countOf(o.name);
    const base = { name: o.name, ...c, rarelyUsed: rarelyUsed(c.shown, c.used) };
    if (!o.ok) return { ...base, state: "broken" as const, error: o.error };
    const d = o.def;
    return {
      ...base,
      state: d.disabled ? ("disabled" as const) : ("ok" as const),
      when: d.when,
      ...(d.why ? { why: d.why } : {}),
      title: d.title,
      shownBy: d.shownBy,
      onlyIf: d.onlyIf,
      repeat: d.repeat,
      buttons: d.buttons.map((b) => ({
        label: b.label,
        about: b.about,
        kind: b.run ? ("run" as const) : ("send" as const),
        ...(b.run ? { run: b.run } : {}),
        ...(b.to ? { to: b.to } : {}),
        ...(b.onlyIf?.length ? { onlyIf: b.onlyIf } : {}),
        ...(b.confirm ? { confirm: b.confirm } : {}),
        ...(b.landing ? { landing: b.landing } : {}),
      })),
    };
  });
  const fp = runFingerprint(file);
  return { root, file: "ok", offers, ...(fp ? { runs: { fingerprint: fp, approved: runsApproved(root, file), buttons: runButtonsOf(file) } } : {}) };
}

// ---- the agent's note and the asks-you mark -----------------------------------------------------

/**
 * The hidden note at the agent's next turn (§chat.offers/card): the newest run button's outcome. The
 * same text every time until a newer one, so the note hook's digest sends it once.
 */
export function offerNoteFor(sessionId: string): string | null {
  const rec = readRecord(sessionId);
  const card = lastOf(rec?.cards ?? [], (c) => !!(c.choice && c.outcome && c.outcome.state !== "running"));
  if (!card?.choice || !card.outcome) return null;
  return `Offer ${card.id} (${card.name}): the user pressed "${card.choice.label}". ${card.outcome.state === "done" ? "It ran" : "It failed"}: ${card.outcome.text ?? ""}`.trim();
}

let openIndex: { dir: string; open: Map<string, { title: string; at: number; name: string; root: string }> } | null = null;

/** The session's open offer: its Needs you item (§app.overseer/attention-digest, `offer-waiting`) and, while idle, its
    asks-you mark (§app.decisions/asks-user). Read from one index of every record. */
export function openOfferOf(sessionId: string): { title: string; at: number } | undefined {
  const dir = offersDir();
  if (!openIndex || openIndex.dir !== dir) {
    openIndex = { dir, open: new Map() };
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const n of names) {
      if (!n.endsWith(".json") || n === "counts.json") continue;
      const rec = readRecord(n.slice(0, -5));
      const open = rec ? lastOf(rec.cards, (c) => c.state === "open") : undefined;
      if (rec && open) openIndex.open.set(rec.sessionId, { title: open.title, at: Date.parse(open.at), name: open.name, root: open.root });
    }
  }
  const hit = openIndex.open.get(sessionId);
  if (!hit) return undefined;
  // An offer that left the file stops at once: its open card is withdrawn.
  if (!liveOffer(readOffersFile(hit.root), hit.name)) {
    const rec = readRecord(sessionId);
    if (rec) {
      for (const c of rec.cards) if (c.state === "open") c.state = "withdrawn";
      saveRecord(rec);
    } else openIndex.open.delete(sessionId);
    return undefined;
  }
  return { title: hit.title, at: hit.at };
}

/**
 * A row's signals with an open offer folded in (§app.decisions/asks-user): while an idle session shows
 * one, it asks the user, with no model call. `running`: a turn runs, so the card isn't waiting yet.
 */
export function withOpenOffer(sessionId: string, signals: SessionSignals | undefined, running: boolean): SessionSignals | undefined {
  const offer = running ? undefined : openOfferOf(sessionId);
  if (!offer || signals?.kinds.includes("asks-you")) return signals;
  // No classifier asked: the provider is the turn's own when one was, else nominal (the wire needs one).
  return { ...(signals ?? { turnId: "offer", provider: "pi" as const }), at: Math.max(signals?.at ?? 0, offer.at), kinds: ["asks-you", ...(signals?.kinds ?? [])] };
}

export { OFFER_DETAILS_VERSION };
