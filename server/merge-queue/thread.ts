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
 * A chat is reused while it is younger than 24 h and under half its context window; otherwise (or
 * when it was archived, is gone, or is open in a terminal) the next event starts a fresh one.
 *
 * Harness-neutral: sessions are reached through injected deps (the live ones go through Sova's own
 * routes and helpers), never through a harness package.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MergeEntry } from "../../shared/merge-queue";

/** A thread older than this is replaced at its next event. */
export const THREAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A thread past this share of its context window is replaced at its next event. */
export const THREAD_MAX_CONTEXT = 0.5;
/** A replaced thread may still finish what it was doing through the verbs for this long. */
export const THREAD_GRACE_MS = 60 * 60 * 1000;
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
  | { kind: "conflict"; entry: ThreadEntry; run: string; files: string[]; base?: string }
  | { kind: "failed"; entry: ThreadEntry; run: string; summary?: string; base?: string }
  | { kind: "paused"; why: string }
  /** The project has no private-names list: pushes are held until the user answers the interview. */
  | { kind: "names"; file: string; target: string };

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

export interface ThreadRecord {
  sessionId: string;
  path: string;
  startedAt: number;
  playbook: string;
  /** The thread this one replaced, and when: it keeps its verbs for THREAD_GRACE_MS. */
  previous?: { sessionId: string; until: number };
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface ThreadDeps {
  now(): number;
  /** The record file (one object keyed by project root). */
  file: string;
  /** The session, by id, or null when it is gone. */
  session(id: string, path: string): Promise<ThreadSession | null>;
  /** A new chat in `root` on the merge-thread profile, with its first message. */
  create(root: string, text: string, title: string): Promise<Result<{ id: string; path: string }>>;
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
  if (now - started > THREAD_MAX_AGE_MS) return "it is more than 24 h old";
  const c = s.context;
  if (c?.window && c.tokens / c.window > THREAD_MAX_CONTEXT) return "it is past half its context";
  return null;
}

/** The playbook folder the thread follows in `root`: the project's own, else the shipped default. */
export function playbookDir(root: string, exists: (p: string) => boolean = existsSync): string {
  const own = join(root, PROJECT_PLAYBOOK);
  return exists(join(own, "PLAYBOOK.md")) ? own : DEFAULT_PLAYBOOK_DIR;
}

const short = (sha: string) => sha.slice(0, 7);

/** The message one event becomes. Each names the verbs to answer with and asks for a short turn. */
export function eventText(ev: ThreadEvent): string {
  switch (ev.kind) {
    case "queued": {
      const e = ev.entry;
      const base = ev.base ?? e.target;
      return [
        `Queued: entry ${e.id} · ${e.branch} at ${short(e.commit)}, onto ${e.target}${ev.base ? ` (at ${short(ev.base)})` : ""}.`,
        `Read what it changes (\`git diff ${base}...${e.commit}\`, read only; it may land before you finish). Then, in one short turn:`,
        `1. pick extra checks by blast radius (the method's scripts/blast-radius.mjs --base ${base} --tip ${e.commit}, references/picks.md) and add them with merge.extend {entry: "${e.id}", checks: [id], why} (skip when nothing beyond the floor fits; "landed" or "busy" means too late: go on to the note);`,
        `2. write its note with merge.note {entry: "${e.id}", note} ("What's worth noting" in the playbook; an empty note when nothing is).`,
      ].join("\n");
    }
    case "conflict": {
      const e = ev.entry;
      return [
        `Conflict: entry ${e.id} · ${e.branch} at ${short(e.commit)} conflicts with ${e.target} in ${ev.files.join(", ") || "(files in the run log)"}. Run ${ev.run}.`,
        `Judge it (references/conflicts.md) and answer with merge.resolve {entry: "${e.id}", verdict, files, ours, theirs, proposal, commit?, note?}: no behaviour change → verdict "no-behaviour-change" with your resolution commit from a side worktree; the two sides want different behaviour → verdict "behaviour-differs", and the user decides.`,
      ].join("\n");
    }
    case "failed": {
      const e = ev.entry;
      return [
        `Failed: entry ${e.id} · ${e.branch} at ${short(e.commit)}, run ${ev.run}${ev.summary ? ` (${ev.summary})` : ""}.`,
        `Explain it in plain words (references/failures.md) with merge.note {entry: "${e.id}", note}. Read the logs with merge.logs {run: "${ev.run}"}.`,
      ].join("\n");
    }
    case "paused":
      return [`The queue paused: ${ev.why}.`, `If the logs say why and the pause holds an entry, explain it on that entry with merge.note (references/failures.md). Never resume it yourself.`].join("\n");
    case "names":
      return [
        `Names: this project has no private-names list, so every push of ${ev.target} is held. Landings go on.`,
        `Run the names interview with the user here, in your chat (references/names.md): \`node ${join(DEFAULT_PLAYBOOK_DIR, "scripts", "discover-names.mjs")} --file ${ev.file} --target ${ev.target} --repo <project root>\`, then ask them what else must never reach the public repo. Never write a name anywhere but that file.`,
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
    `You act only through the merge verbs (the project verbs tool). You never move ${"entry" in ev ? ev.entry.target : "target" in ev ? ev.target : "the target branch"}, never run git that writes in the main checkout, and never land anything: Sova does that.`,
    "",
    eventText(ev),
  ].join("\n");
}

function readRecords(file: string): Record<string, ThreadRecord> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: number; threads?: Record<string, ThreadRecord> };
    return raw?.version === 1 && raw.threads && typeof raw.threads === "object" ? raw.threads : {};
  } catch {
    return {};
  }
}

function writeRecords(file: string, threads: Record<string, ThreadRecord>): void {
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

  private say(line: string): void {
    (this.deps.log ?? ((l: string) => console.warn(`[merge-thread] ${l}`)))(line);
  }

  private async deliver(root: string, ev: ThreadEvent): Promise<void> {
    const ms = this.deps.timeoutMs ?? DELIVERY_TIMEOUT_MS;
    const now = this.deps.now();
    const rec = readRecords(this.deps.file)[root];
    const s = rec ? await withTimeout(this.deps.session(rec.sessionId, rec.path), ms, "reading the thread") : null;
    const why = replaceReason(rec, s, now);
    if (!why && rec) {
      const r = await withTimeout(this.deps.wake(rec.path, eventText(ev)), ms, "waking the thread");
      if (r.ok) return;
      this.say(`${root}: the thread refused a message (${r.error}); starting a fresh one`);
    } else if (rec) this.say(`${root}: a fresh thread, since ${why}`);
    const playbook = playbookDir(root, this.deps.exists ?? existsSync);
    const date = new Date(now).toISOString().slice(0, 10);
    const name = root.split("/").filter(Boolean).pop() ?? root;
    const r = await withTimeout(this.deps.create(root, firstText(root, playbook, ev), `Merge thread · ${name} · ${date}`), ms, "starting the thread");
    if (!r.ok) throw new Error(`couldn't start a thread: ${r.error}`);
    const all = readRecords(this.deps.file);
    all[root] = { sessionId: r.id, path: r.path, startedAt: now, playbook, ...(rec ? { previous: { sessionId: rec.sessionId, until: now + THREAD_GRACE_MS } } : {}) };
    writeRecords(this.deps.file, all);
  }
}

// ---- the server's one thread keeper ---------------------------------------------------------------

let current: MergeThread | null = null;

/** The server's keeper; null in tests and before the server wires it (notify is then a no-op). */
export function mergeThread(): Pick<MergeThread, "notify" | "isThreadChat"> {
  return current ?? { notify: () => {}, isThreadChat: () => false };
}

/** The project's thread for the queue's view: its chat and when it started (ISO), or null. */
export function threadOf(root: string): { session: string; startedAt: string } | null {
  const rec = current?.record(root);
  return rec ? { session: rec.sessionId, startedAt: new Date(rec.startedAt).toISOString() } : null;
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
  const { writeAutoTitle } = await import("../session-titles");
  writeAutoTitle(json.id, title);
  return { ok: true, id: json.id, path: json.path };
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
    create: async (root, text, title) => createChat(request, root, THREAD_PROFILE, text, title, await (await import("./models")).startingModel(root, "thread")),
    async wake(path, text) {
      const r = await promptSession(path, text);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
  });
  setMergeThread(t);
  return t;
}
