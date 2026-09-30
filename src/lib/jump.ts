// Jumping to a session entry in the transcript on screen. The thread renders each entry as
// `<div class="entry" data-entry="<id>">`, and an assistant entry's blocks as `<id>:<i>`, so an
// id resolves either to its own row or to the first row of the entry it belongs to. The outline
// strip, the Skills tab and the Timeline's input rows all land here.

import type { RowTarget } from "./older-rows";

/** How long the row we landed on stays tinted. */
export const JUMP_HIGHLIGHT_MS = 1500;
/** The tint's class, on the landed-on row. */
export const JUMP_CLASS = "entry-jumped";
/** Dispatched on the transcript before a jump scrolls it: the transcript stops following the
    bottom, so a row still rendering below can't pull the view back down mid-scroll. */
export const JUMP_EVENT = "sova-jump";

const escape = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&"));

/**
 * The ENTRY id behind a rendered row's id. The thread gives an assistant message one item per
 * content block, with ids `${entryId}:${blockIndex}` (plus `:stop`), so a row's id is frequently
 * not an entry id at all. Anything that talks to the server about an entry has to send this, and
 * anything matching a server-supplied entry id against rendered rows has to compare with it.
 */
export const entryIdOf = (rowId: string): string => {
  const i = rowId.indexOf(":");
  return i < 0 ? rowId : rowId.slice(0, i);
};

/**
 * The selectors to try, in order: the entry's own rows, then — for a block id like `<id>:2` —
 * the rows of the entry it came from. A transcript that shows the entry but not that block
 * still answers the jump.
 */
export function entrySelectors(entryId: string): string[] {
  const one = (id: string) => `[data-entry="${escape(id)}"], [data-entry^="${escape(id)}:"]`;
  const i = entryId.indexOf(":");
  return i < 0 ? [one(entryId)] : [one(entryId), one(entryId.slice(0, i))];
}

/**
 * The transcript element of each session on screen, by session path. One pane per path, so this
 * is where a jump finds the right transcript in a workspace; the single-session view registers
 * here too, and anything that doesn't know a path falls back to the bare `#transcript`.
 */
const transcripts = new Map<string, HTMLElement>();

/** Called by the transcript itself: `el` on mount, null on cleanup. */
export function registerTranscript(path: string, el: HTMLElement | null): void {
  if (el) transcripts.set(path, el);
  else transcripts.delete(path);
}

/**
 * The transcript to search: the pane for `path` when there is one, else the one on the page.
 */
export function transcriptRoot(path?: string | null): HTMLElement | null {
  const el = path ? transcripts.get(path) : undefined;
  if (el?.isConnected) return el;
  return document.getElementById("transcript");
}

/**
 * The rows a transcript renders, as data. The thread opens on its newest rows and builds the older
 * ones in the background (lib/tail-render), so a row can be on the branch and not in the DOM yet:
 * "is it there" is asked of these, and a jump mounts its target before it scrolls.
 */
export interface TranscriptRows {
  /** Whether the thread renders a row for this entry, built yet or not. */
  has(entryId: string): boolean;
  /** Builds every row from this entry's down, now. False when the thread has no such row. */
  ensure(entryId: string): boolean;
  /** The branch may have rows above the list that the view doesn't hold yet (lib/older-rows):
      a row that isn't here may still be there, so "not there" isn't known yet. */
  older(): boolean;
  /** Fetches the rows down to `target`, so the list holds it: "missing" when the branch has no
      such row, "stale" when a new hello replaced the list meanwhile. */
  load(target: RowTarget): Promise<"here" | "missing" | "stale">;
}

const rowSources = new WeakMap<HTMLElement, TranscriptRows>();

/** Called by the thread inside a transcript: its rows on mount, null on cleanup. */
export function registerRows(root: HTMLElement, rows: TranscriptRows | null): void {
  if (rows) rowSources.set(root, rows);
  else rowSources.delete(root);
}

/**
 * The entry's rendered row, built first if the thread hasn't reached it yet; null when the
 * transcript has no row for it. A transcript that doesn't register its rows (a worker's) answers
 * from the DOM alone, as does a row only an open hidden-rows disclosure shows.
 */
export function ensureRendered(entryId: string, root: HTMLElement | null = transcriptRoot()): HTMLElement | null {
  if (!root) return null;
  rowSources.get(root)?.ensure(entryId);
  return findEntryRow(entryId, root);
}

/** Whether the transcript may have rows above the ones it holds: until they're fetched, a row
    that isn't there may still be on the branch. */
export function rowsOlder(root: HTMLElement | null = transcriptRoot()): boolean {
  return !!root && !!rowSources.get(root)?.older();
}

/** Fetches the transcript's rows down to `target` (lib/older-rows); null when it has none above
    the ones it holds, so a row not there isn't there. */
export function loadRow(root: HTMLElement | null, target: RowTarget): Promise<"here" | "missing" | "stale"> | null {
  const rows = root ? rowSources.get(root) : undefined;
  return rows?.older() ? rows.load(target) : null;
}

/** Whether the transcript has a row for this entry, built yet or not: the outline strip's
    "Jump to Message" is offered on this. */
export function hasEntryRow(entryId: string, root: HTMLElement | null = transcriptRoot()): boolean {
  if (!root) return false;
  return !!rowSources.get(root)?.has(entryId) || !!findEntryRow(entryId, root);
}

/** The rendered row for an entry id, or null when the transcript doesn't show it (compacted
    away, or a different session on screen). */
export function findEntryRow(entryId: string, root: ParentNode | null = transcriptRoot()): HTMLElement | null {
  if (!root) return null;
  for (const selector of entrySelectors(entryId)) {
    const wrap = root.querySelector<HTMLElement>(selector);
    const row = wrap?.firstElementChild as HTMLElement | null;
    if (row) return row;
  }
  return null;
}

/**
 * Scroll the entry's row into the middle of the transcript and tint it briefly, so the eye can
 * find where it landed. Returns false when the transcript has no such row: callers say so rather
 * than scrolling nowhere. `path` picks the pane in a workspace; without it, the page's transcript.
 */
export function jumpToEntry(entryId: string, path?: string | null): boolean {
  const root = transcriptRoot(path);
  const row = ensureRendered(entryId, root);
  if (!row) return false;
  root?.dispatchEvent(new Event(JUMP_EVENT));
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add(JUMP_CLASS);
  setTimeout(() => row.classList.remove(JUMP_CLASS), JUMP_HIGHLIGHT_MS);
  if (root) recenter(root, row, JUMP_CORRECTIONS);
  return true;
}

/** The jump waiting for older rows, if any: a newer jump replaces it. */
let waitingJump: (() => void) | null = null;

/**
 * `jumpToEntry`, except that a row not there while the transcript may have older rows it doesn't
 * hold isn't "not there" yet: the rows down to it are fetched in one request, then the jump lands
 * (or, the branch having no such row, calls `missing`). A slow fetch shows at the transcript's top
 * edge (lib/older-rows `slow`), as a scroll-up fetch does; nothing is said. A newer jump, from
 * anywhere, drops a waiting one. A new hello meanwhile (a rewind, a reconnect) asks again, once.
 */
export function jumpWhenArrived(entryId: string, path: string | null | undefined, missing: () => void): "jumped" | "waiting" | "missing" {
  waitingJump?.();
  waitingJump = null;
  if (jumpToEntry(entryId, path)) return "jumped";
  const first = loadRow(transcriptRoot(path), { entry: entryId });
  if (!first) {
    missing();
    return "missing";
  }
  let over = false;
  const done = () => {
    over = true;
  };
  waitingJump = done;
  const settle = (r: "here" | "missing" | "stale", again: boolean) => {
    if (over) return;
    if (r === "stale" && again) {
      const retry = loadRow(transcriptRoot(path), { entry: entryId });
      if (retry) return void retry.then((x) => settle(x, false));
    }
    done();
    waitingJump = null;
    // Outside the list's update: the rows it added are built by the jump itself (`ensure`).
    queueMicrotask(() => (r === "here" && jumpToEntry(entryId, path)) || missing());
  };
  void first.then((r) => settle(r, true));
  return "waiting";
}

/** Off center by more than this after a jump's scroll, the jump aims again. */
const JUMP_TOLERANCE_PX = 24;
/** At most this many more aims. */
const JUMP_CORRECTIONS = 2;
/** A scroll is over once no scroll event has come for this long. */
const SCROLL_QUIET_MS = 150;

/**
 * A long jump aims at a position computed partly from estimated row heights (rows never drawn are
 * skipped at an estimate, app.css `.entry`), and the rows it passes are drawn at their real
 * heights on the way. Once the scroll comes to rest, aim again from the row's real position if it
 * didn't land in the middle: each pass starts nearer, among rows already drawn.
 */
function recenter(root: HTMLElement, row: HTMLElement, left: number): void {
  let timer = 0;
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    root.removeEventListener("scroll", onScroll);
    root.removeEventListener("scrollend", finish);
    if (!row.isConnected) return;
    const view = root.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    const off = (box.top + box.bottom) / 2 - (view.top + view.bottom) / 2;
    // A row taller than the view never sits inside it: filling it is landing enough.
    const landed = Math.abs(off) <= JUMP_TOLERANCE_PX || (box.height > view.height && box.top <= view.top && box.bottom >= view.bottom);
    if (landed || left <= 0) return;
    root.dispatchEvent(new Event(JUMP_EVENT));
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    recenter(root, row, left - 1);
  };
  // The scroll is over at `scrollend` where the browser has it, else after a quiet spell (which
  // also covers a scroll that never started: the row was already in place).
  const onScroll = () => {
    clearTimeout(timer);
    timer = window.setTimeout(finish, SCROLL_QUIET_MS);
  };
  root.addEventListener("scroll", onScroll, { passive: true });
  root.addEventListener("scrollend", finish);
  timer = window.setTimeout(finish, SCROLL_QUIET_MS);
}

// ---- A jump asked for before the session is on screen ------------------------------------------

/** How long an unclaimed request waits for its session's transcript before it is dropped. */
export const PENDING_JUMP_TTL_MS = 60_000;

/**
 * "Open in Session" on an Explanations card: the session opens by route, and its transcript lands
 * later (a chat's `hello`, a watch view's snapshot), so the jump waits here until that transcript
 * claims it. One at a time; a newer request replaces an older one. `path` is null when the card
 * linked by id (`#/sid/<id>`): the view then matches on its session id.
 */
export interface PendingExplainJump {
  explainId: string;
  sessionId: string;
  path: string | null;
  at: number;
}

let pending: PendingExplainJump | null = null;

export function requestExplainJump(req: Omit<PendingExplainJump, "at">, now = Date.now()): void {
  pending = { ...req, at: now };
}

/** The request waiting, if any (tests, and a view deciding whether to look). */
export const pendingExplainJump = (): PendingExplainJump | null => pending;

export function clearExplainJump(): void {
  pending = null;
}

/** What a loaded transcript does with the request: jump to this row, or say it isn't there. */
export type ExplainJumpClaim = { kind: "jump"; rowId: string } | { kind: "missing" };

const forView = (p: PendingExplainJump, view: { path: string; sessionId?: string | null }) =>
  p.path === view.path || (!!view.sessionId && p.sessionId === view.sessionId);

/**
 * Called by a session view each time its transcript (re)loads. Null when nothing waits for THIS
 * session (another session's request stays). Otherwise the request is consumed, found or not, so it
 * fires exactly once; one past its TTL is dropped unclaimed. The row is the explanation's own
 * report row, found by explanation id: the transcript renders one per id. While the transcript
 * isn't `whole` (it may have older rows it doesn't hold, or it is a list kept from the last visit),
 * a request whose row isn't there yet stays waiting: only a whole transcript can say "missing".
 */
export function claimExplainJump(
  view: { path: string; sessionId?: string | null },
  items: readonly { id: string; report?: { explain?: { id: string } } }[],
  now = Date.now(),
  whole = true,
): ExplainJumpClaim | null {
  const p = pending;
  if (!p) return null;
  if (now - p.at > PENDING_JUMP_TTL_MS) {
    pending = null;
    return null;
  }
  if (!forView(p, view)) return null;
  const row = items.find((it) => it.report?.explain?.id === p.explainId);
  if (!row && !whole) return null;
  pending = null;
  return row ? { kind: "jump", rowId: row.id } : { kind: "missing" };
}

/** The request whose row is being fetched, so it is fetched once. */
let loadingFor: PendingExplainJump | null = null;

/** The toast when the explanation's row isn't in the transcript that loaded. */
export const EXPLAIN_OFF_BRANCH = "That explanation isn't on this branch of the session.";

/**
 * A session view's side of "Open in Session": each time its transcript (re)loads, claim a jump
 * waiting for this session and land on the row once it has rendered (two frames: the rows, then
 * the transcript's own first scroll to the bottom). `say` reports a row that isn't there, which
 * only a `whole` transcript can know; while it isn't, the request waits (a slow fetch shows at the
 * transcript's top edge, lib/older-rows `slow`; nothing is said). With `load` (the view knows what's above its rows, lib/older-rows),
 * a row that isn't here is fetched, in one request, once: the list then holds it and this runs
 * again with it, or the branch has no such row and that is said.
 */
export function landExplainJump(
  view: { path: string; sessionId?: string | null },
  items: readonly { id: string; report?: { explain?: { id: string } } }[],
  say: (text: string) => void,
  whole = true,
  load?: (target: RowTarget) => Promise<"here" | "missing" | "stale">,
): void {
  const claim = claimExplainJump(view, items, Date.now(), whole);
  const p = pending;
  if (!claim && !whole && p && forView(p, view)) {
    if (load && loadingFor !== p) {
      loadingFor = p;
      void load({ explain: p.explainId }).then((r) => {
        if (loadingFor === p) loadingFor = null;
        if (r !== "missing" || pending !== p) return; // "here": the new list claims it; "stale": its hello will
        pending = null;
        say(EXPLAIN_OFF_BRANCH);
      });
    }
  }
  if (!claim) return;
  if (claim.kind === "missing") return say(EXPLAIN_OFF_BRANCH);
  requestAnimationFrame(() => requestAnimationFrame(() => !jumpToEntry(claim.rowId, view.path) && say(EXPLAIN_OFF_BRANCH)));
}
