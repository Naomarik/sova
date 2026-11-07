/**
 * The merge thread: one chat per project that follows the project's merge-queue playbook, started by
 * Sova. The queue tells it what happens (an entry queued, a conflict, a red run, a pause) and it acts
 * only through the merge verbs: a note on each landing, extra checks picked by blast radius, a
 * judgement on each conflict, an explanation of each failure; and, when a project has no private-names
 * list, the names interview with the user in its own chat.
 *
 * It is off the critical path by construction: `notify` returns at once and never throws; the work
 * runs on a per-project chain that the queue never awaits. A thread that is missing, slow or broken
 * costs a landing its note and its picks, never its turn.
 *
 * The thread starts with memory on (UniiChat), so one chat per project lasts: it is replaced only when
 * it is gone, archived, open in a terminal, refuses messages after two retries, is past half its
 * context (a safety net), or at the user's Start Fresh. A thread whose memory switch was refused keeps
 * the old 24 h rule as well. Each replaced thread is kept in the record's history, with why.
 *
 * Harness-neutral: sessions are reached through injected deps (the live ones go through Sova's own
 * routes and helpers), never through a harness package.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { MergeEntry, MergeThreadAsk } from "../../shared/merge-queue";
import { mergeThreadTitle } from "../../shared/fixed-names";
import { NEEDS_USER_RULE } from "./rulings";
import { serverStart } from "../project-services/self-host";

/** A thread without memory older than this is replaced at its next event (a thread with memory never ages out). */
export const THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A thread past this share of its context window is replaced at its next event. */
export const THREAD_MAX_CONTEXT = 0.5;
/** A replaced thread may still finish what it was doing through the verbs for this long. */
export const THREAD_GRACE_MS = 60 * 60 * 1000;
/** A refused wake is tried again after each of these before the thread is replaced. */
export const WAKE_RETRY_MS: readonly number[] = [5_000, 20_000];
/** How many replaced threads the record keeps (newest last). */
export const THREAD_HISTORY_MAX = 200;
/** The memory type the thread runs with, whatever Settings → Memory's default says. */
export const THREAD_MEMORY_TYPE = "uniichat";
/** One delivery (create or wake) gives up after this; the chain moves on. */
export const DELIVERY_TIMEOUT_MS = 60_000;

/** The shipped profile and playbook ids. */
export const THREAD_PROFILE = "merge-thread";
export const PLAYBOOK_ID = "merge-queue";
/** A project's own playbook, relative to its root. */
export const PROJECT_PLAYBOOK = join(".sova", "playbooks", PLAYBOOK_ID);
/** The generic default that ships with Sova, for a project without its own. */
export const DEFAULT_PLAYBOOK_DIR = fileURLToPath(new URL(`../../playbooks/${PLAYBOOK_ID}`, import.meta.url));

/** What the thread needs to know about an entry. */
export type ThreadEntry = Pick<MergeEntry, "id" | "branch" | "commit" | "target">;

/** `base`: the target's commit the entry was queued (or run) against. The branch's own changes are
    `base...commit` even after it landed, when `target...commit` is empty. Absent: the target's name. */
export type ThreadEvent =
  | { kind: "queued"; entry: ThreadEntry; base?: string }
  /** `scratch`: the copy Sova made for the thread to resolve in (scratch.ts); `scratchError`: why none could be made. */
  | { kind: "conflict"; entry: ThreadEntry; run: string; files: string[]; base?: string; scratch?: string; scratchError?: string }
  | { kind: "failed"; entry: ThreadEntry; run: string; summary?: string; base?: string }
  /** Can't tell whose failure: a check failed on the merge and on the target alone; the user is asked meanwhile. */
  | { kind: "unattributed"; entry: ThreadEntry; run: string; summary?: string; base?: string }
  /** The review said blocking: its findings went back to the branch's chat by themselves. */
  | { kind: "review"; entry: ThreadEntry; run: string; findings: string; base?: string }
  /** A resolution the thread judged safe failed a check: the branch isn't blamed; it rules again. */
  | { kind: "resolution-failed"; entry: ThreadEntry; run: string; files: string[]; summary?: string; base?: string; scratch?: string; scratchError?: string }
  /** The branch's spec drafts changed since the user's Land. */
  | { kind: "drafts-changed"; entry: ThreadEntry; names?: string[]; request?: string; base?: string }
  /** The branch's chat answered a request Fixed: check the fix changes only what was asked. */
  | { kind: "fix"; entry: ThreadEntry; request: string; asked: string; commit?: string; drafts?: boolean; summary?: string; base?: string }
  /** The branch's chat answered a request "Can't" or "Needs you". `otherTried`: the thread already tried another approach. */
  | { kind: "chat-answer"; entry: ThreadEntry; request: string; answer: "cant" | "needs-you"; text: string; otherTried?: boolean }
  | { kind: "paused"; why: string }
  /** Nothing left to check and nothing running: `entry` changed last; `lastLanded` is the newest landing; `head` the target's. */
  | { kind: "idle"; entry: ThreadEntry; lastLanded?: { id: string; branch: string; sha: string }; head?: string }
  /** The project has no private-names list: pushes are held until the user answers the interview. */
  | { kind: "names"; file: string; target: string }
  /** The user's answer to a merge.ask, relayed by the chat it was asked in (or typed on the tab). */
  | { kind: "answer"; ask: Pick<MergeThreadAsk, "id" | "question" | "branch">; text: string; from: string };

/** A session as the thread rules read it. */
export interface ThreadSession {
  id: string;
  path: string;
  createdAt: string;
  archived?: boolean;
  /** Open in a terminal: Sova must not write to it. */
  live?: boolean;
  context?: { tokens: number; window: number | null };
}

/** A thread the project had before its current one. */
export interface ThreadHistoryItem {
  sessionId: string;
  path: string;
  startedAt: number;
  endedAt: number;
  /** Why it was replaced, in plain words ("you started a fresh one", "its chat is gone"). */
  why: string;
  memory?: { type: string };
}

export interface ThreadRecord {
  sessionId: string;
  path: string;
  startedAt: number;
  playbook: string;
  /** The thread this one replaced, and when: it keeps its verbs for THREAD_GRACE_MS. */
  previous?: { sessionId: string; until: number };
  /** Memory as it was switched on at the start; absent: the switch was refused (the age rule applies). */
  memory?: { type: string };
  /** The playbook's content hash the thread last read (playbookHash): a change adds a reread line. */
  playbookHash?: string;
  /** The last event it was sent. */
  lastEvent?: { kind: ThreadEvent["kind"]; at: number; entry?: string; branch?: string };
  /** Earlier threads, oldest first. */
  history?: ThreadHistoryItem[];
}

/** A new question id. */
export const newAskId = (): string => `ak_${randomBytes(6).toString("hex")}`;

/** How many questions the record keeps (the open ones always). */
export const ASKS_MAX = 50;

/** What the record file holds per project: the current thread, or only the history after Start Fresh. */
type StoredThread = (ThreadRecord | { history: ThreadHistoryItem[]; sessionId?: undefined }) & { asks?: MergeThreadAsk[] };


export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ThreadDeps {
  now(): number;
  /** The record file (one object keyed by project root). */
  file: string;
  /** The session, by id, or null when it is gone. */
  session(id: string, path: string): Promise<ThreadSession | null>;
  /** A new chat in `root` on the merge-thread profile, with its first message. `memory`: memory as it
      was switched on before that message (absent: refused, or the chat runs without). */
  create(root: string, text: string, title: string): Promise<Result<{ id: string; path: string; memory?: { type: string } }>>;
  /** Archive a replaced thread (waits for its turn, else stops it). Optional: tests and old wiring skip it. */
  retire?(path: string): Promise<void>;
  /** Waits between wake retries (WAKE_RETRY_MS by default); tests pass zeros. */
  retryMs?: readonly number[];
  sleep?(ms: number): Promise<void>;
  /** A message to an existing chat (queued as a follow-up when it is busy). */
  wake(path: string, text: string): Promise<Result>;
  /** Defaults to existsSync; tests pin it. */
  exists?(path: string): boolean;
  log?(line: string): void;
  timeoutMs?: number;
}

/** Why a recorded thread can't take the next event (null: it can). */
export function replaceReason(rec: ThreadRecord | undefined, s: ThreadSession | null, now: number): string | null {
  if (!rec) return "no thread yet";
  if (!s) return "its chat is gone";
  if (s.archived) return "its chat was archived";
  if (s.live) return "its chat is open in a terminal";
  const started = Date.parse(s.createdAt) || rec.startedAt;
  // Memory keeps one chat going (UniiChat): age never replaces it. Without memory the old day rule holds.
  if (!rec.memory && now - started > THREAD_MAX_AGE_MS) return "it is more than 24 h old";
  const c = s.context;
  if (c?.window && c.tokens / c.window > THREAD_MAX_CONTEXT) return "it is past half its context";
  return null;
}

/** The playbook folder the thread follows in `root`: the project's own, else the shipped default. */
export function playbookDir(root: string, exists: (p: string) => boolean = existsSync): string {
  const own = join(root, PROJECT_PLAYBOOK);
  return exists(join(own, "PLAYBOOK.md")) ? own : DEFAULT_PLAYBOOK_DIR;
}

/** The files of a playbook folder that the thread reads: PLAYBOOK.md and everything under references/. */
function playbookFiles(dir: string): string[] {
  const out: string[] = [];
  const top = join(dir, "PLAYBOOK.md");
  if (existsSync(top)) out.push(top);
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      } catch {
        /* gone meanwhile */
      }
    }
  };
  walk(join(dir, "references"));
  return out;
}

/** One hash over what the thread follows: the method (the shipped default) and the project's own playbook. */
export function playbookHash(playbook: string, method: string = DEFAULT_PLAYBOOK_DIR): string {
  const h = createHash("sha256");
  for (const dir of [...new Set([method, playbook])]) {
    for (const f of playbookFiles(dir)) {
      h.update(f);
      h.update("\0");
      try {
        h.update(readFileSync(f));
      } catch {
        /* unreadable: counts as empty */
      }
      h.update("\0");
    }
  }
  return h.digest("hex").slice(0, 16);
}

/** The line put before an event when the playbook changed since the thread last read it. */
export function rereadLine(playbook: string, method: string = DEFAULT_PLAYBOOK_DIR): string {
  const files = [join(method, "PLAYBOOK.md"), ...(playbook !== method ? [join(playbook, "PLAYBOOK.md")] : [])];
  return `The playbook changed since you read it: read ${files.join(" and ")} again first, with the references they name.`;
}

const short = (sha: string) => sha.slice(0, 7);

/** Each moment's name in the playbook's "Read as you go" table (PLAYBOOK.md; a project's own playbook may list other pages). */
export const READ_AS_YOU_GO: Readonly<Record<ThreadEvent["kind"], string>> = {
  queued: "Queued",
  conflict: "Conflict",
  failed: "Failed",
  unattributed: "Failed",
  review: "Failed",
  "resolution-failed": "Conflict",
  "drafts-changed": "Fix",
  fix: "Fix",
  "chat-answer": "Chat answer",
  paused: "Paused",
  idle: "Idle",
  names: "Names",
  answer: "Answer",
};

/** The line every event message ends with: the method's pages are read fresh at each event, never from memory. */
export function readAsYouGoLine(kind: ThreadEvent["kind"]): string {
  return `Before you act, read your playbook's "Read as you go" row for ${READ_AS_YOU_GO[kind]} and the pages it names, now, never from memory (the project's own playbook wins where its list differs).`;
}

/** The message one event becomes: the event, then the reread line. Each names the verbs to answer with and asks for a short turn. */
export function eventText(ev: ThreadEvent): string {
  return `${eventBody(ev)}\n${readAsYouGoLine(ev.kind)}`;
}

/** The rule every ruling message carries: what is the user's to decide (rulings.ts). */
const NEEDS_USER_LINE = `Rule "needs-user" only for what is the user's. ${NEEDS_USER_RULE} Everything else you and the branch's chat settle yourselves.`;

const resolveLine = (id: string): string =>
  `Judge it (references/conflicts.md) and answer with merge.resolve {entry: "${id}", verdict, files, ours, theirs, proposal, contents?, text?, choices?, note?}: no behaviour change → verdict "no-behaviour-change" with contents, each conflicted file's whole merged text by its path (Sova merges, writes and commits it in the scratch copy); you can't resolve it safely but it needs no decision of the user's → verdict "chat-fixes", with your diagnosis in proposal and no contents, and the branch's chat fixes it; the two sides want different behaviour → verdict "needs-user" with your question in text and its choices and no contents, and the user decides.`;

function eventBody(ev: ThreadEvent): string {
  switch (ev.kind) {
    case "queued": {
      const e = ev.entry;
      const base = ev.base ?? e.target;
      return [
        `Queued: entry ${e.id} · ${e.branch} at ${short(e.commit)}, onto ${e.target}${ev.base ? ` (at ${short(ev.base)})` : ""}.`,
        `Read what it changes (\`git diff ${base}...${e.commit}\`, read only; it may land before you finish). Then, in one short turn:`,
        `1. pick extra checks by blast radius (the method's scripts/blast-radius.mjs --base ${base} --tip ${e.commit}, references/picks.md) and add them with merge.extend {entry: "${e.id}", checks: [id], why, select} (select is part of the pick: copy the pick's select whenever it has one, since a check that takes a group or files fails at once without it; skip when nothing beyond the floor fits; "landed" or "busy" means too late: go on to the note);`,
        `2. write its note with merge.note {entry: "${e.id}", note} ("What's worth noting" in the playbook; an empty note when nothing is).`,
      ].join("\n");
    }
    case "conflict": {
      const e = ev.entry;
      return [
        `Conflict: entry ${e.id} · ${e.branch} at ${short(e.commit)} conflicts with ${e.target} in ${ev.files.join(", ") || "(files in the run log)"}.${ev.run ? ` Run ${ev.run}.` : ""}`,
        ev.scratch
          ? `Sova made a scratch copy for it at ${ev.scratch}: a worktree with no branch, at ${e.target}'s head. Read it, try the merge in a scratch clone in your temp folder (delete it when done), and never make a worktree of your own; Sova removes the copy when this attempt ends.`
          : `Sova couldn't make a scratch copy for it${ev.scratchError ? ` (${ev.scratchError})` : ""}: judge it from the diff and answer with no contents: verdict "chat-fixes" when it needs no decision of the user's, else "needs-user".`,
        resolveLine(e.id),
        NEEDS_USER_LINE,
      ].join("\n");
    }
    case "failed": {
      const e = ev.entry;
      return [
        `Failed: entry ${e.id} · ${e.branch} at ${short(e.commit)}, run ${ev.run}${ev.summary ? ` (${ev.summary})` : ""}. Sova proved it the branch's: it passes on ${e.target} alone.`,
        `Read the logs with merge.logs {run: "${ev.run}"} and the branch's diff (references/failures.md), then rule, in one call, within a few minutes (the request waits for you, then goes without your diagnosis):`,
        `- merge.rule {entry: "${e.id}", ruling: "chat-fixes", text: <your diagnosis: what failed, what in the branch causes it, what to change>} — it goes to the branch's chat with the request; or`,
        `- merge.rule {entry: "${e.id}", ruling: "needs-user", text: <the question>, choices: [..]} when fixing it needs a decision that is the user's.`,
        `Then write the entry's note with merge.note {entry: "${e.id}", note} (what failed, in a line).`,
        NEEDS_USER_LINE,
      ].join("\n");
    }
    case "unattributed": {
      const e = ev.entry;
      return [
        `Can't tell whose failure: entry ${e.id} · ${e.branch} at ${short(e.commit)}, run ${ev.run}${ev.summary ? ` (${ev.summary})` : ""}. A check failed on the merge and on ${e.target} alone, naming no failure. The user is asked meanwhile (Land Anyway, Try Again, Remove from Queue); nothing went to the branch's chat.`,
        `Read both logs with merge.logs {run: "${ev.run}"}. Rule only when the logs settle it:`,
        `- the branch's own errors show (different from ${e.target}'s): merge.rule {entry: "${e.id}", ruling: "chat-fixes", text: <diagnosis>};`,
        `- it was the machine or a flake: merge.rule {entry: "${e.id}", ruling: "try-again", text: <why>} (counts no try);`,
        `- otherwise leave it to the user and explain it with merge.note {entry: "${e.id}", note}.`,
      ].join("\n");
    }
    case "review": {
      const e = ev.entry;
      return [
        `Review flagged: entry ${e.id} · ${e.branch} at ${short(e.commit)}, run ${ev.run}. Its findings went back to the branch's chat by themselves:`,
        ev.findings,
        `If a finding can't be fixed without a decision that is the user's, rule merge.rule {entry: "${e.id}", ruling: "needs-user", text: <the question>, choices: [..]}. Otherwise nothing is needed: end your turn.`,
        NEEDS_USER_LINE,
      ].join("\n");
    }
    case "resolution-failed": {
      const e = ev.entry;
      return [
        `Your resolution failed: entry ${e.id} · ${e.branch} at ${short(e.commit)}, run ${ev.run}${ev.summary ? ` (${ev.summary})` : ""}. The resolution you judged safe for ${ev.files.join(", ") || "its conflict"} failed a check. The branch isn't blamed and nothing went to its chat.`,
        ev.scratch
          ? `Sova made a fresh scratch copy at ${ev.scratch}, at ${e.target}'s head. Read the run's logs with merge.logs {run: "${ev.run}"}, then rule again:`
          : `Sova couldn't make a scratch copy${ev.scratchError ? ` (${ev.scratchError})` : ""}. Read the run's logs with merge.logs {run: "${ev.run}"}, then rule again (no new resolution of your own):`,
        resolveLine(e.id),
        NEEDS_USER_LINE,
      ].join("\n");
    }
    case "drafts-changed": {
      const e = ev.entry;
      return [
        `Drafts changed: entry ${e.id} · ${e.branch}'s spec drafts changed since the user's Land${ev.names?.length ? ` (${ev.names.join(", ")})` : ""}.`,
        `Compare them with the drafts as approved (the branch's .sova/spec/drafts; references/fixes.md). Only made fit (the same promises, reworded or reordered to fit): merge.rule {entry: "${e.id}", ruling: "checked"${ev.request ? `, request: "${ev.request}"` : ""}}. A new or changed promise: merge.rule {entry: "${e.id}", ruling: "beyond"${ev.request ? `, request: "${ev.request}"` : ""}, text: <what it changes>}; the user decides.`,
      ].join("\n");
    }
    case "fix": {
      const e = ev.entry;
      const what = [ev.commit ? `commit ${short(ev.commit)}` : "", ev.drafts ? "its spec drafts" : ""].filter(Boolean).join(" and ") || "its branch";
      return [
        `Fix: entry ${e.id} · ${e.branch}'s chat answered request ${ev.request} Fixed, changing ${what}${ev.summary ? `: ${ev.summary}` : ""}.`,
        `What was asked: ${ev.asked}`,
        `Check the fix (references/fixes.md)${ev.commit ? `: \`git range-diff ${ev.base ? short(ev.base) : e.target} ${short(e.commit)} ${short(ev.commit)}\` in the project (the branch as approved against the branch now, each against the target; \`git diff ${ev.base ? short(ev.base) : e.target}...${short(ev.commit)}\` is the whole branch now)` : ""}: does it change only what was asked, and does it decide nothing that is the user's? Then rule, in one call:`,
        `- only what was asked, and nothing of the user's decided: merge.rule {entry: "${e.id}", request: "${ev.request}", ruling: "checked"} — it goes back in line on the user's Land;`,
        `- it decides something that is the user's (wording a person sees in the product (UI copy, messages, docs they read), layout, controls, defaults, notifications, noticeable timing, data kept or deleted, permissions; e.g. it picked "Store" where the branch said "Save changes"): merge.rule {entry: "${e.id}", ruling: "needs-user", text: <the question>, choices: [<the fix's way>, <the other way>]} — never "checked", even when it was the only way to make it pass;`,
        `- more than was asked: merge.rule {entry: "${e.id}", request: "${ev.request}", ruling: "beyond", text: <what more it changes>} — the user decides.`,
        NEEDS_USER_LINE,
      ].join("\n");
    }
    case "chat-answer": {
      const e = ev.entry;
      if (ev.answer === "needs-you")
        return [
          `Needs you: entry ${e.id} · ${e.branch}'s chat answered request ${ev.request} that only the user can decide: ${ev.text}`,
          "It waits for the user as a decision; you can't overrule it. Nothing is needed: end your turn (a note with merge.note if it helps the user).",
        ].join("\n");
      return [
        `Can't: entry ${e.id} · ${e.branch}'s chat answered request ${ev.request} that it can't: ${ev.text}`,
        ev.otherTried
          ? `You already tried another approach for it: raise it to the user, merge.rule {entry: "${e.id}", ruling: "needs-user", text: <the question, "can't be settled without you">, choices: [..]}.`
          : `You may try one other approach: merge.rule {entry: "${e.id}", ruling: "try-again", text: <the other way, for the chat>} (or a resolution of your own with merge.resolve, for a conflict). With no other approach, raise it: merge.rule {entry: "${e.id}", ruling: "needs-user", text: <the question>, choices: [..]}.`,
      ].join("\n");
    }
    case "paused":
      return [`The queue paused: ${ev.why}.`, `If the logs say why and the pause holds an entry, explain it on that entry with merge.note (references/failures.md). Never resume it yourself.`].join("\n");
    case "idle": {
      const e = ev.entry;
      const l = ev.lastLanded;
      return [
        `Idle: the queue has nothing left to check and nothing running (the last change: entry ${e.id} · ${e.branch}).${l ? ` The newest landing: entry ${l.id} · ${l.branch} as ${short(l.sha)}.` : ""}${ev.head ? ` ${e.target} is at ${short(ev.head)}.` : ""}`,
        `Sova runs ${short(serverStart().head ?? "") || "an unknown commit"} (merge.live {project} answers it with the restart plan).`,
        `If the project's playbook says what to do once the queue is quiet ("When the queue is idle"), do it now, through the verbs; merge.hold {action: "set"} keeps new runs from starting meanwhile and {action: "clear"} lifts it. Otherwise nothing is needed: end your turn.`,
      ].join("\n");
    }
    case "names":
      return [
        `Names: this project has no private-names list, so every push of ${ev.target} is held. Landings go on.`,
        `Run the names interview (references/names.md): merge.names {action: "discover"} (Sova fills the project's names file and answers kinds and counts), then ask the user what else must never reach the public repo with merge.ask {text, entry?} (the newest landed entry, so its branch's chat asks them). Never wait for them in your chat, and never put a name in a question, a note or anywhere but that file.`,
      ].join("\n");
    case "answer":
      return [
        `Answer to your question ${ev.ask.id}${ev.ask.branch ? ` (about ${ev.ask.branch})` : ""}, from ${ev.from}:`,
        ev.text,
        `Your question was: ${ev.ask.question}`,
        "Go on with what it was for, through the verbs. Another question: merge.ask again.",
      ].join("\n");
  }
}

/** The first message of a new thread: who it is, the method, the project's own playbook, then the event. */
export function firstText(root: string, playbook: string, ev: ThreadEvent): string {
  const method = join(DEFAULT_PLAYBOOK_DIR, "PLAYBOOK.md");
  const own = join(playbook, "PLAYBOOK.md");
  const read = own === method ? `Read ${method} now and follow it` : `Read the method, ${method}, then this project's own playbook, ${own}, which wins where they differ; follow them`;
  return [
    `You are the merge thread for the project at ${root}. ${read}, and read their references as they say. The method's scripts are in ${join(DEFAULT_PLAYBOOK_DIR, "scripts")}.`,
    `You act only through the merge verbs (the project verbs tool), on your own: you never wait for the user in this chat. When you need them, ask with merge.ask {text, entry?}: Sova asks in the branch's own chat and their answer comes back to you as a message. The user may still write to you here; answer them when they do.`,
    `You never move ${"entry" in ev ? ev.entry.target : "target" in ev ? ev.target : "the target branch"}, never run git that writes in the main checkout, and never land anything: Sova does that.`,
    `Your tools run in a sandbox that writes only in your own temp folder and has no network: read anything, try things in a scratch clone there (delete it when done), and do everything else through the merge verbs, which Sova runs for you.`,
    "",
    eventText(ev),
  ].join("\n");
}

function readStored(file: string): Record<string, StoredThread> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: number; threads?: Record<string, StoredThread> };
    return raw?.version === 1 && raw.threads && typeof raw.threads === "object" ? raw.threads : {};
  } catch {
    return {};
  }
}

/** The current thread per project (a project whose thread was cleared by Start Fresh has none). */
function readRecords(file: string): Record<string, ThreadRecord> {
  const out: Record<string, ThreadRecord> = {};
  for (const [root, r] of Object.entries(readStored(file))) if (r && typeof r.sessionId === "string") out[root] = r as ThreadRecord;
  return out;
}

function writeRecords(file: string, threads: Record<string, StoredThread>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, threads }, null, 2)}\n`);
  renameSync(tmp, file);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export class MergeThread {
  private chains = new Map<string, Promise<void>>();
  constructor(readonly deps: ThreadDeps) {}

  /** Tell the project's thread about an event. Returns at once; never throws; never awaited by a run. */
  notify(root: string, ev: ThreadEvent): void {
    try {
      const prev = this.chains.get(root) ?? Promise.resolve();
      const next = prev.then(() => this.deliver(root, ev)).catch((err) => this.say(`${root}: ${ev.kind} not delivered: ${err instanceof Error ? err.message : String(err)}`));
      this.chains.set(root, next);
    } catch (err) {
      this.say(`${root}: ${ev.kind} not delivered: ${String(err)}`);
    }
  }

  /** Resolves once every event handed to `root` so far was delivered or given up (tests). */
  idle(root: string): Promise<void> {
    return this.chains.get(root) ?? Promise.resolve();
  }

  /** The recorded thread of `root` (or the one it replaced, within its grace) is `sessionId`. */
  isThreadChat(root: string, sessionId: string): boolean {
    const rec = readRecords(this.deps.file)[root];
    if (!rec || !sessionId) return false;
    if (rec.sessionId === sessionId) return true;
    return rec.previous?.sessionId === sessionId && rec.previous.until > this.deps.now();
  }

  record(root: string): ThreadRecord | undefined {
    return readRecords(this.deps.file)[root];
  }

  /** The project's earlier threads, oldest first. */
  history(root: string): ThreadHistoryItem[] {
    return readStored(this.deps.file)[root]?.history ?? [];
  }

  /** The project's questions, oldest first (the open ones and the last answered). */
  asks(root: string): MergeThreadAsk[] {
    return readStored(this.deps.file)[root]?.asks ?? [];
  }

  /** The open question, newest first, or undefined. */
  openAsk(root: string): MergeThreadAsk | undefined {
    return [...this.asks(root)].reverse().find((a) => !a.answered);
  }

  private writeAsks(root: string, fn: (asks: MergeThreadAsk[]) => MergeThreadAsk[]): void {
    const all = readStored(this.deps.file);
    const cur = all[root] ?? { history: [] };
    const next = fn([...(cur.asks ?? [])]);
    const open = next.filter((a) => !a.answered);
    const done = next.filter((a) => a.answered).slice(-Math.max(0, ASKS_MAX - open.length));
    all[root] = { ...cur, asks: next.filter((a) => open.includes(a) || done.includes(a)) };
    writeRecords(this.deps.file, all);
  }

  /** Record a new question (merge.ask). `where`: the chat Sova asked in, or null: the tab holds it. */
  recordAsk(root: string, q: { question: string; entry?: string; branch?: string; id?: string }, where: { session: string; path: string } | null): MergeThreadAsk {
    const ask: MergeThreadAsk = {
      id: q.id ?? newAskId(),
      question: q.question,
      at: new Date(this.deps.now()).toISOString(),
      ...(q.entry ? { entry: q.entry } : {}),
      ...(q.branch ? { branch: q.branch } : {}),
      ...(where ? { askedIn: where } : { onTab: true as const }),
    };
    this.writeAsks(root, (asks) => [...asks, ask]);
    return ask;
  }

  /**
   * The user's answer (merge.reply, or typed on the tab): the question is closed and the answer goes to the
   * thread as its next event. Refused for an unknown or answered question.
   */
  answer(root: string, id: string, text: string, by: { kind: "chat" | "operator"; session?: string; from: string; quiet?: true }): Result<{ ask: MergeThreadAsk }> {
    const ask = this.asks(root).find((a) => a.id === id);
    if (!ask) return { ok: false, error: `no question ${id} of this project's merge thread` };
    if (ask.answered) return { ok: false, error: `question ${id} was already answered` };
    const answered: MergeThreadAsk = { ...ask, answered: { at: new Date(this.deps.now()).toISOString(), by: by.kind, ...(by.session ? { session: by.session } : {}) } };
    this.writeAsks(root, (asks) => asks.map((a) => (a.id === id ? answered : a)));
    // `quiet`: the answer reached the thread already, typed in its own chat with the question beside it (q15).
    if (by.quiet) return { ok: true, ask: answered };
    this.notify(root, { kind: "answer", ask: { id, question: ask.question, ...(ask.branch ? { branch: ask.branch } : {}) }, text, from: by.from });
    return { ok: true, ask: answered };
  }

  /**
   * Start Fresh (the user's): the current thread goes to the history, "you started a fresh one", and is
   * archived (waiting for its turn, else stopped); the next event starts a new one. Runs on the
   * project's chain, after what is being delivered. Resolves false when there was no thread.
   */
  startFresh(root: string): Promise<boolean> {
    const prev = this.chains.get(root) ?? Promise.resolve();
    const run = prev.then(async () => {
      const rec = this.record(root);
      if (!rec) return false;
      this.retireRecord(root, rec, "you started a fresh one", true);
      await this.deps.retire?.(rec.path).catch((err) => this.say(`${root}: the old thread wasn't archived: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    });
    this.chains.set(root, run.then(() => undefined, () => undefined));
    return run;
  }

  /** Move `rec` into the history with `why`; `clear` leaves the project with no current thread. */
  private retireRecord(root: string, rec: ThreadRecord, why: string, clear: boolean): ThreadHistoryItem[] {
    const all = readStored(this.deps.file);
    const item: ThreadHistoryItem = { sessionId: rec.sessionId, path: rec.path, startedAt: rec.startedAt, endedAt: this.deps.now(), why, ...(rec.memory ? { memory: rec.memory } : {}) };
    const history = [...(rec.history ?? []), item].slice(-THREAD_HISTORY_MAX);
    if (clear) {
      const asks = all[root]?.asks;
      all[root] = { history, ...(asks?.length ? { asks } : {}) };
      writeRecords(this.deps.file, all);
    }
    return history;
  }

  private async wakeWithRetries(root: string, path: string, text: string, ms: number): Promise<Result> {
    const waits = this.deps.retryMs ?? WAKE_RETRY_MS;
    const sleep = this.deps.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
    let r: Result = { ok: false, error: "not tried" };
    for (let i = 0; i <= waits.length; i++) {
      if (i > 0) await sleep(waits[i - 1]!);
      r = await withTimeout(this.deps.wake(path, text), ms, "waking the thread").catch((err) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
      if (r.ok) return r;
      if (i < waits.length) this.say(`${root}: the thread refused a message (${r.error}); trying again`);
    }
    return r;
  }

  private say(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(`[merge-thread] ${l}`)))(line);
  }

  private async deliver(root: string, ev: ThreadEvent): Promise<void> {
    const ms = this.deps.timeoutMs ?? DELIVERY_TIMEOUT_MS;
    const now = this.deps.now();
    const rec = readRecords(this.deps.file)[root];
    const s = rec ? await withTimeout(this.deps.session(rec.sessionId, rec.path), ms, "reading the thread") : null;
    let why = replaceReason(rec, s, now);
    const playbook = playbookDir(root, this.deps.exists ?? existsSync);
    const hash = playbookHash(playbook);
    const last = { kind: ev.kind, at: now, ...("entry" in ev ? { entry: ev.entry.id, branch: ev.entry.branch } : {}) };
    if (!why && rec) {
      const changed = !!rec.playbookHash && rec.playbookHash !== hash;
      const text = changed ? `${rereadLine(playbook)}\n\n${eventText(ev)}` : eventText(ev);
      const r = await this.wakeWithRetries(root, rec.path, text, ms);
      if (r.ok) {
        const all = readStored(this.deps.file);
        const cur = all[root];
        if (cur?.sessionId === rec.sessionId) {
          all[root] = { ...(cur as ThreadRecord), playbookHash: hash, playbook, lastEvent: last };
          writeRecords(this.deps.file, all);
        }
        return;
      }
      why = `it refused messages (${r.error})`;
      this.say(`${root}: the thread refused a message three times (${r.error}); starting a fresh one`);
    } else if (rec) this.say(`${root}: a fresh thread, since ${why}`);
    const r = await withTimeout(this.deps.create(root, firstText(root, playbook, ev), mergeThreadTitle(root, now)), ms, "starting the thread");
    if (!r.ok) throw new Error(`couldn't start a thread: ${r.error}`);
    const history = rec ? this.retireRecord(root, rec, why ?? "replaced", false) : (readStored(this.deps.file)[root]?.history ?? []);
    const all = readStored(this.deps.file);
    all[root] = {
      sessionId: r.id,
      path: r.path,
      startedAt: now,
      playbook,
      playbookHash: hash,
      lastEvent: last,
      ...(r.memory ? { memory: r.memory } : {}),
      ...(rec ? { previous: { sessionId: rec.sessionId, until: now + THREAD_GRACE_MS } } : {}),
      ...(history.length ? { history } : {}),
      ...(all[root]?.asks?.length ? { asks: all[root]!.asks } : {}),
    };
    writeRecords(this.deps.file, all);
  }
}

// ---- the server's one thread keeper ---------------------------------------------------------------

let current: MergeThread | null = null;

/** The server's keeper itself, or null (tests, before the server wires it). */
export function mergeThreadKeeper(): MergeThread | null {
  return current;
}

/** The server's keeper; null in tests and before the server wires it (notify is then a no-op). */
export function mergeThread(): Pick<MergeThread, "notify" | "isThreadChat"> {
  return current ?? { notify: () => {}, isThreadChat: () => false };
}

/** The project's thread for the queue's view: its chat and when it started (ISO), or null. */
export function threadOf(root: string): { session: string; startedAt: string } | null {
  const rec = current?.record(root);
  return rec ? { session: rec.sessionId, startedAt: new Date(rec.startedAt).toISOString() } : null;
}

/** The Merge thread card's facts for `root` (null: no thread now). `busy`: its turn is running. */
export function threadInfo(keeper: Pick<MergeThread, "record" | "openAsk"> | null, root: string, busy: (path: string) => boolean = () => false): import("../../shared/merge-queue").MergeThreadInfo | null {
  const rec = keeper?.record(root);
  if (!rec) return null;
  const ask = keeper!.openAsk(root);
  let working = false;
  try {
    working = busy(rec.path);
  } catch {
    working = false;
  }
  return {
    session: rec.sessionId,
    path: rec.path,
    startedAt: new Date(rec.startedAt).toISOString(),
    ...(rec.memory ? { memory: rec.memory.type } : {}),
    state: ask ? "asking" : working ? "working" : "idle",
    ...(rec.lastEvent ? { lastEvent: { kind: rec.lastEvent.kind, at: new Date(rec.lastEvent.at).toISOString(), ...(rec.lastEvent.branch ? { branch: rec.lastEvent.branch } : {}) } } : {}),
    ...(ask ? { ask } : {}),
  };
}

/** The server wired a thread keeper: the queue may wait for a conflict judgement (none: it hands back at once). */
export function hasMergeThread(): boolean {
  return current !== null;
}

export function setMergeThread(t: MergeThread | null): void {
  current = t;
}

export type AppRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

/** A new chat in `cwd` on one of Sova's shipped profiles, with its first message and its title (the
    start a profile gets from the list: POST /api/sessions). Shared by the thread and the reviewer. */
export async function createChat(request: AppRequest, cwd: string, profile: string, text: string, title: string, model?: { model: string; thinking?: string | null } | null): Promise<Result<{ id: string; path: string }>> {
  // The project's own pick for this chat (models.ts), else the new-chat default (nothing sent).
  const opening = model ? { model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) } : {};
  const res = await request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, profile: { source: "sova", id: profile }, prompt: text, ...opening }),
  });
  const json = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
  if (res.status !== 201 || !json?.id || !json.path) return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
  // The name Sova gives it, in its own store: no rename (the user's, the Overseer's, the namer's) reaches it.
  const [{ setSovaChatName }, { sovaNamedKind }] = await Promise.all([import("../sova-chat-names"), import("../../shared/fixed-names")]);
  const kind = sovaNamedKind({ source: "sova", id: profile });
  if (kind) setSovaChatName(json.id, kind, title);
  else (await import("../session-titles")).writeAutoTitle(json.id, title);
  return { ok: true, id: json.id, path: json.path };
}

/**
 * The thread's one mode switch, the server's own (the mode menu is refused for queue chats): memory on,
 * type UniiChat whatever Settings → Memory's default type is, then pinned so mode.json never reaches it.
 * Its profile already pinned mode normal with no minor modes. Resolves the memory it runs with, or
 * undefined when the runtime has no memory engine.
 */
export async function threadMemoryOn(path: string): Promise<{ type: string } | undefined> {
  const { acquireChatHandle } = await import("../chat-handle");
  const chat = await acquireChatHandle(path);
  const result = await chat.switchMode({ minorModes: ["memory"], memory: { type: THREAD_MEMORY_TYPE } });
  chat.pinMode();
  return result.minorModes.includes("memory") ? { type: THREAD_MEMORY_TYPE } : undefined;
}

/** Wire the keeper on the server: sessions through Sova's own routes and helpers. */
export async function startMergeThread(request: AppRequest, file?: string): Promise<MergeThread> {
  const [{ stateRoot }, { getSessionSummary }, { promptSession }] = await Promise.all([import("../state-root"), import("../sessions-index"), import("../session-prompt")]);
  const t = new MergeThread({
    now: () => Date.now(),
    file: file ?? join(stateRoot(), "merge-queue", "threads.json"),
    async session(id, path) {
      const s = await getSessionSummary(path).catch(() => null);
      if (!s || s.id !== id) return null;
      return { id: s.id, path, createdAt: s.createdAt, archived: !!s.archived, live: !!s.live, ...(s.context ? { context: s.context } : {}) };
    },
    async create(root, text, title) {
      // Created without its first message: memory goes on (UniiChat, pinned) before the thread reads anything.
      const made = await createChat(request, root, THREAD_PROFILE, "", title, await (await import("./models")).startingModel(root, "thread"));
      if (!made.ok) return made;
      const memory = await threadMemoryOn(made.path).catch((err) => {
        console.warn(`[merge-thread] ${root}: memory wasn't switched on: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
      const sent = await promptSession(made.path, text);
      if (!sent.ok) return { ok: false, error: `its first message was refused: ${sent.error}` };
      return { ok: true, id: made.id, path: made.path, ...(memory ? { memory } : {}) };
    },
    async wake(path, text) {
      const r = await promptSession(path, text);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    async retire(path) {
      const { liveRetireDeps, retireChat } = await import("./retire");
      await retireChat(path, { ...(await liveRetireDeps()), log: (l) => console.warn(`[merge-thread] ${l}`) });
    },
  });
  setMergeThread(t);
  return t;
}
