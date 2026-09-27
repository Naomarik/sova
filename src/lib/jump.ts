// Jumping to a session entry in the transcript on screen. The thread renders each entry as
// `<div class="entry" data-entry="<id>">`, and an assistant entry's blocks as `<id>:<i>`, so an
// id resolves either to its own row or to the first row of the entry it belongs to. The outline
// strip, the Skills tab and the Timeline's input rows all land here.

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
 * not an entry id at all. Anything that talks to the server about an entry — a fanout's
 * `source.leafId`, which is compared against the file's own entry ids — has to send this, and
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
 *
 * This is also where a FORK POINT is read from, and that carries a contract with the server worth
 * stating on this side of the wire too: the leaf a fanout sends (`FanoutRequest.source.leafId`) is
 * the last entry the pane actually RENDERS, on the branch it is showing — read from these rows,
 * never from the newest id in memory and never from the session file's last line. The server
 * computes its own leaf the same way (`readActiveBranch` then `normalizeEntry`, server/fanout.ts),
 * and the two only agree if this side holds up its half.
 *
 * A rewound session is what separates them: its last FILE line is always a rewind marker (`sova-rewind`),
 * which renders as nothing and is not on the active branch at all. Send that id and the server
 * correctly calls it stale — and the user is told to reopen and fork from a message identical to
 * the one on screen, which is an instruction that cannot be followed. The failure lands here
 * whoever computed it wrong.
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
  return true;
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

/**
 * Called by a session view each time its transcript (re)loads. Null when nothing waits for THIS
 * session (another session's request stays). Otherwise the request is consumed, found or not, so it
 * fires exactly once; one past its TTL is dropped unclaimed. The row is the explanation's own
 * report row, found by explanation id: the transcript renders one per id.
 */
export function claimExplainJump(
  view: { path: string; sessionId?: string | null },
  items: readonly { id: string; report?: { explain?: { id: string } } }[],
  now = Date.now(),
): ExplainJumpClaim | null {
  const p = pending;
  if (!p) return null;
  if (now - p.at > PENDING_JUMP_TTL_MS) {
    pending = null;
    return null;
  }
  if (p.path !== view.path && !(view.sessionId && p.sessionId === view.sessionId)) return null;
  pending = null;
  const row = items.find((it) => it.report?.explain?.id === p.explainId);
  return row ? { kind: "jump", rowId: row.id } : { kind: "missing" };
}

/** The toast when the explanation's row isn't in the transcript that loaded. */
export const EXPLAIN_OFF_BRANCH = "That explanation isn't on this branch of the session.";

/**
 * A session view's side of "Open in Session": each time its transcript (re)loads, claim a jump
 * waiting for this session and land on the row once it has rendered (two frames: the rows, then
 * the transcript's own first scroll to the bottom). `say` reports a row that isn't there.
 */
export function landExplainJump(
  view: { path: string; sessionId?: string | null },
  items: readonly { id: string; report?: { explain?: { id: string } } }[],
  say: (text: string) => void,
): void {
  const claim = claimExplainJump(view, items);
  if (!claim) return;
  if (claim.kind === "missing") return say(EXPLAIN_OFF_BRANCH);
  requestAnimationFrame(() => requestAnimationFrame(() => !jumpToEntry(claim.rowId, view.path) && say(EXPLAIN_OFF_BRANCH)));
}
