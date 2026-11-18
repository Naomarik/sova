// Playbook runs on disk: <state root>/playbook-runs/<run id>.json, one whole file per run.
// Keyed by the run's own id, never by a session: a draft may have no chat yet, and the chat that showed the
// card may not be the chat that conducts it. Writes are whole-file and atomic; every run is read once and kept.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPlaybookRunId, type PlaybookCardEdits, type PlaybookChoiceOrigin, type PlaybookRoleEdit, type PlaybookRunAnchor, type PlaybookRunStarted, type PlaybookRunState } from "../../shared/playbook-run";
import type { PlaybookPlan } from "./plan";
import { sessionsChanged } from "../list-generation";
import { stateRoot } from "../state-root";

export interface PlaybookRef {
  source: "sova" | "user" | "project";
  id: string;
  dir: string;
  /** Its entry file's name (PLAYBOOK.md or SKILL.md). */
  entry: string;
  title: string;
}

/** One run, as kept. */
export interface PlaybookRunRecord {
  v: 1;
  id: string;
  playbook: PlaybookRef;
  /** The folder the run belongs to (the chat's, or the one the new chat screen named). */
  cwd: string;
  /** The chat whose card this is; none when it was opened outside a chat. */
  shownIn?: { id: string; path: string };
  /** Where its card stands in the chat's conversation, set when it was opened and never changed. */
  anchor?: PlaybookRunAnchor;
  /** Waiting on the alignment its playbook requires first (align-first.ts), since when; no card is drawn meanwhile. */
  aligning?: { since: string };
  /** Words typed after /<id>. */
  text?: string;
  revision: number;
  /** The card's first values, with where each came from (Default, Same as last time, …). */
  initial: { choices: Record<string, unknown>; origins: Record<string, PlaybookChoiceOrigin>; roles?: Record<string, PlaybookRoleEdit>; stops?: Record<string, boolean>; cycle?: { max?: number; askEvery?: number; until?: "rule" | "max" } };
  /** Everything the person changed on the card since. */
  edits: PlaybookCardEdits;
  state: PlaybookRunState;
  createdAt: string;
  updatedAt: string;
  started?: PlaybookRunStarted;
  /** The plan Start froze: what the card showed at the revision Start named. */
  plan?: PlaybookPlan;
  startError?: string;
  /** A chat an unfinished Start made: the next Start uses it rather than make another. */
  halfMade?: { id: string; path: string };
  /** A draft the person closed: kept on disk, never listed. */
  closed?: true;
}

export const playbookRunsDir = (): string => join(stateRoot(), "playbook-runs");
const fileOf = (id: string): string => join(playbookRunsDir(), `${id}.json`);

let runs: Map<string, PlaybookRunRecord> | null = null;

function all(): Map<string, PlaybookRunRecord> {
  if (runs) return runs;
  runs = new Map();
  let names: string[] = [];
  try {
    names = readdirSync(playbookRunsDir());
  } catch {
    // None yet.
  }
  for (const n of names) {
    const id = n.replace(/\.json$/, "");
    if (!n.endsWith(".json") || !isPlaybookRunId(id)) continue;
    try {
      const r = JSON.parse(readFileSync(fileOf(id), "utf8")) as PlaybookRunRecord;
      if (r?.v === 1 && r.id === id && r.playbook && typeof r.revision === "number") {
        // A start the server stopped in the middle of never finished: the card is a draft again, saying so.
        if (r.state === "starting") {
          r.state = "draft";
          r.startError = "Sova stopped while this run was starting. Check the chat, then press Start again if nothing started.";
        }
        runs.set(id, r);
      }
    } catch {
      // A broken file is no run.
    }
  }
  return runs;
}

const listeners = new Set<(run: PlaybookRunRecord) => void>();
/** Hear that a run changed. */
export function onPlaybookRunChanged(fn: (run: PlaybookRunRecord) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** What of a run the session list reads, per run, as last written. */
const listed = new Map<string, string>();
const listKey = (r: PlaybookRunRecord): string => JSON.stringify([r.closed ?? false, r.state === "started", r.shownIn?.id, r.started?.chat.id, r.playbook.title]);

function write(r: PlaybookRunRecord): void {
  mkdirSync(playbookRunsDir(), { recursive: true, mode: 0o700 });
  const f = fileOf(r.id);
  writeFileSync(`${f}.tmp`, JSON.stringify(r), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
  // A chat showing a card is listed even before its first message (sessions-index.ts): the list reads again
  // when that could change (a run made, closed or started, or moved to another chat), never for an edit.
  const key = listKey(r);
  if (listed.get(r.id) !== key) {
    listed.set(r.id, key);
    sessionsChanged();
  }
  for (const fn of listeners) {
    try {
      fn(r);
    } catch (err) {
      console.error("[playbook-runs] a change listener failed", err);
    }
  }
}

export const newRunId = (): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(12);
  return `pr_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
};

export function createRun(r: Omit<PlaybookRunRecord, "v" | "id" | "revision" | "createdAt" | "updatedAt" | "state" | "edits"> & { edits?: PlaybookCardEdits }): PlaybookRunRecord {
  const now = new Date().toISOString();
  const run: PlaybookRunRecord = { v: 1, id: newRunId(), revision: 1, state: "draft", createdAt: now, updatedAt: now, edits: {}, ...r };
  all().set(run.id, run);
  write(run);
  return run;
}

export const runById = (id: string): PlaybookRunRecord | undefined => (isPlaybookRunId(id) ? all().get(id) : undefined);

/** Change one run and save it; every change goes through here. Throws for an unknown id. */
export function changeRun<T>(id: string, fn: (r: PlaybookRunRecord) => T): T {
  const r = runById(id);
  if (!r) throw new Error(`No playbook run ${id}.`);
  const out = fn(r);
  r.updatedAt = new Date().toISOString();
  write(r);
  return out;
}

/** The runs a chat shows: drafts shown in it, runs started from it and runs it conducts; newest first. */
export function runsOfChat(sessionId: string): PlaybookRunRecord[] {
  return [...all().values()]
    .filter((r) => !r.closed && (r.shownIn?.id === sessionId || r.started?.chat.id === sessionId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The run that holds a chat, if one does: a chat runs one playbook at most. It holds the chat it conducts, put
 * away or not, and the chat whose card started it while that card is still shown there. `except` leaves one run out.
 */
export function runHolding(sessionId: string, except?: string): PlaybookRunRecord | undefined {
  return [...all().values()].find(
    (r) =>
      r.id !== except &&
      (r.state === "started" || r.state === "starting") &&
      ((r.started?.chat.id === sessionId) || (r.state === "starting" && r.halfMade?.id === sessionId) || (!r.closed && r.shownIn?.id === sessionId)),
  );
}

/** Why a chat a run holds starts no other. */
export const oneRunRefusal = (holding: PlaybookRunRecord): string => `This chat already runs the playbook ${holding.playbook.title}, and a chat runs one playbook. Start this one in a new chat.`;

/** The chat's open drafts, any playbook's. */
export const draftsOf = (sessionId: string): PlaybookRunRecord[] => runsOfChat(sessionId).filter((r) => r.state === "draft");

/** The chat's open draft of one playbook, if it has one. */
export function openDraftOf(sessionId: string, playbook: { source: string; id: string }): PlaybookRunRecord | undefined {
  return runsOfChat(sessionId).find((r) => r.state === "draft" && r.playbook.source === playbook.source && r.playbook.id === playbook.id);
}

/** The playbook a chat conducts a run of, newest first: the one its playbook block names when given. */
export function conductedBy(sessionId: string, hint?: { id: string; dir?: string }): PlaybookRunRecord | undefined {
  return [...all().values()]
    .filter((r) => r.started?.chat.id === sessionId && (!hint || (r.playbook.id === hint.id && (!hint.dir || r.playbook.dir === hint.dir))))
    .sort((a, b) => (b.started!.at ?? "").localeCompare(a.started!.at ?? ""))[0];
}

/** The chats a run's news goes to. */
export const chatsOfRun = (r: PlaybookRunRecord): string[] => [...new Set([r.shownIn?.id, r.started?.chat.id, r.started?.fromChat?.id].filter((x): x is string => !!x))];

/** Tests: forget the kept copies, so the next read comes from disk (a restart). */
export function forgetPlaybookRuns(): void {
  runs = null;
  listed.clear();
}
