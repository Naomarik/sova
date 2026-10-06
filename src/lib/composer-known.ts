// What the composer knows about a chat before its socket says (§chat.composer/known-on-switch): its
// model, thinking level, mode, whether a turn runs, its sandbox and its Claude login. A switch
// disposes the whole view, so the composer's own signals start empty each time; these are what it
// shows from its first frame, and each gives way to the socket's own word once it has said.
//
// Two sources, the newer winning: what this tab last saw of the chat (`rememberComposer`, written
// as the socket says, in memory only, keyed like lib/transcript-cache by sessionViewKey) and the
// session list's row (its model and `busy`, and for a chat its server holds, the optional `chat`
// field). A row's age is when the list carrying it was fetched (`stampListRows`).
// The rules are pure (composer-known.test.ts); the store is a plain Map, read when the view opens.

import type { ChatClaudeLogin, ModeApplies, SandboxInfo, SessionSummary } from "../../shared/protocol";

/** A chat's mode as the composer shows it. `applies` is there only when its source said it (the
    socket's `mode` message or the list's `chat` field): a remembered one may be stale, so a mode
    known without it makes no promise about when a switch applies. */
export interface KnownMode {
  mode: string;
  minorModes: string[];
  strict: boolean;
  applies?: ModeApplies;
}

/** What the composer shows before the socket says; null where nothing knows (or, for the sandbox
    and the login, where a source knows there is none). */
export interface KnownComposer {
  model: string | null;
  thinking: string | null;
  mode: KnownMode | null;
  running: boolean;
  sandbox: SandboxInfo | null;
  login: ChatClaudeLogin | null;
}

/** Each field's known value. The sandbox and the login may be known to be none (null). */
type Fields = { model: string; thinking: string; mode: KnownMode; running: boolean; sandbox: SandboxInfo | null; login: ChatClaudeLogin | null };
/** One remembered value and when (ms) the socket said it. */
type Seen<T> = { value: T; at: number };
/** What this tab last saw of one chat, field by field. */
export type ComposerSeen = { [K in keyof Fields]?: Seen<Fields[K]> };

const seen = new Map<string, ComposerSeen>();

/** What this tab last saw of the chat under `key` (sessionViewKey), if anything. */
export const composerSeen = (key: string): ComposerSeen | undefined => seen.get(key);

/**
 * The socket said these: remember them, stamped `at`. A null model or thinking level says nothing
 * to remember; a null sandbox or login says there is none, and is remembered. A mode is kept
 * without `applies`: how a switch applies changes with the turn (after-turn → now at its end),
 * unseen once the view is gone. A login is kept without its waiting pick, which lives in the
 * server's memory and may be gone by the next visit.
 */
export function rememberComposer(
  key: string,
  said: { model?: string | null; thinking?: string | null; mode?: KnownMode | null; running?: boolean; sandbox?: SandboxInfo | null; login?: ChatClaudeLogin | null },
  at = Date.now(),
): void {
  const e: ComposerSeen = { ...seen.get(key) };
  if (said.model) e.model = { value: said.model, at };
  if (said.thinking) e.thinking = { value: said.thinking, at };
  if (said.mode) e.mode = { value: { mode: said.mode.mode, minorModes: [...said.mode.minorModes], strict: said.mode.strict }, at };
  if (said.running !== undefined) e.running = { value: said.running, at };
  if (said.sandbox !== undefined) e.sandbox = { value: said.sandbox && { ...said.sandbox }, at };
  if (said.login !== undefined) {
    const { pending: _pending, ...login } = said.login ?? {};
    e.login = { value: said.login && (login as ChatClaudeLogin), at };
  }
  seen.set(key, e);
}

/** Tests only: forget everything. */
export const forgetComposers = (): void => seen.clear();

const fetched = new WeakMap<object, number>();

/** The list carrying these rows was fetched at `at` (ms): call it after each successful read,
    with the rows as kept (a row reused from the last list is as fresh as this one). */
export function stampListRows(rows: readonly SessionSummary[], at: number): void {
  for (const r of rows) fetched.set(r, at);
}

/** When the list carrying `row` was fetched; undefined for a row no list carried (a just-created
    session, a link's summary), whose age nobody knows. */
export const listFetchedAt = (row: SessionSummary | undefined): number | undefined => (row ? fetched.get(row) : undefined);

type Row = Pick<SessionSummary, "model" | "busy" | "activity" | "chat">;

/** The row's own word on each field; undefined where it says nothing. */
function rowSays(row: Row): { [K in keyof Fields]?: Fields[K] } {
  const c = row.chat;
  return {
    // A held chat's model is its runtime's; the file tail's is the newest one written.
    model: (c ? c.model : row.model) ?? undefined,
    thinking: c?.thinking || undefined,
    mode: c ? { mode: c.mode, minorModes: [...c.minorModes], strict: c.strict, applies: c.applies } : undefined,
    // A chat the server holds: its `busy` is the runtime's own. Else a live record's activity says it too.
    running: c ? row.busy : row.busy || row.activity?.state === "working",
    // Only once the server built the message (and not from an older server): absent says nothing.
    sandbox: c && "sandbox" in c ? (c.sandbox ?? null) : undefined,
    login: c && "login" in c ? (c.login ?? null) : undefined,
  };
}

/**
 * Each field from the newer of the two sources that know it: what this tab saw (`cache`) wins when
 * it was written after the list carrying `row` was fetched (`listAt`), else the row does. A row of
 * unknown age (`listAt` undefined) loses to anything remembered. Neither knowing: null (false for
 * running). The socket's own word is the caller's, and it beats both.
 */
export function knownComposer(cache: ComposerSeen | undefined, row: Row | undefined, listAt: number | undefined): KnownComposer {
  const says = row ? rowSays(row) : {};
  const pick = <K extends keyof Fields>(k: K): Fields[K] | undefined => {
    const mine = cache?.[k] as Seen<Fields[K]> | undefined;
    const theirs = says[k] as Fields[K] | undefined;
    if (mine === undefined) return theirs;
    if (theirs === undefined) return mine.value;
    return listAt === undefined || mine.at > listAt ? mine.value : theirs;
  };
  return {
    model: pick("model") ?? null,
    thinking: pick("thinking") ?? null,
    mode: pick("mode") ?? null,
    running: pick("running") ?? false,
    sandbox: pick("sandbox") ?? null,
    login: pick("login") ?? null,
  };
}

const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Equal for the composer: a list refresh that changes none of these re-renders nothing. */
export const sameKnown = (a: KnownComposer, b: KnownComposer): boolean =>
  a.model === b.model && a.thinking === b.thinking && a.running === b.running && sameJson(a.mode, b.mode) && sameJson(a.sandbox, b.sandbox) && sameJson(a.login, b.login);
