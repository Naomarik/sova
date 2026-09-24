// Selecting several sessions in the sidebar: what a selection is, what the toolbar may offer it, and what a bulk archive says
// afterwards. The pure part runs under `tsx --test`; the store at the bottom is the tab's own
// selection, module state for the same reason the drag and the open groups are — every folder,
// group and Recent row is rebuilt on each poll of the list, and a selection must outlive that.

import { createSignal } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { sessionWorking } from "./workers";

/** What the rules below need of a row. The sidebar passes whole summaries; the tests pass this. */
export type SelectableSession = Pick<SessionSummary, "path" | "id" | "title" | "archived" | "origin" | "busy" | "live" | "workers">;

/**
 * Why this session can't be archived right now, or null when it can. Four rules, all enforced by
 * the route with a 409 (`archiveSession` in server/sessions-index.ts); the session pane's Archive
 * button also states the TUI and subagent ones before it asks (SessionDetails' ArchiveAction).
 * Stated here so a bulk press can say them BEFORE it writes anything, rather than discovering
 * them as failures. This is the list's view, a poll old: a subagent started since is caught by
 * the route, and its sentence comes back as a failure (archiveSummary). An archived session is
 * never blocked: unarchiving is always allowed.
 */
export function archiveBlockReason(s: SelectableSession): string | null {
  if (s.archived) return null;
  if (s.live) return "open in a TUI";
  if (s.origin !== "web") return "not started in Sova";
  if (s.busy) return "mid-turn";
  // No count of its own: blockedSentence prefixes the number of SESSIONS, and "1 2 subagents
  // working" read as nonsense. "1 with subagents working" reads at any count.
  if (sessionWorking(s) > 0) return "with subagents working";
  return null;
}

/** What the archive control does for this selection, and why it may be able to do nothing. */
export type ArchiveMode = "archive" | "unarchive" | "mixed";

export interface SelectionPlan {
  count: number;
  /** Renaming is a one-session gesture: with 2 selected there is no field to show. */
  canRename: boolean;
  /** Which way the archive control points. "mixed" is a disabled control with an explanation. */
  mode: ArchiveMode;
  /** The rows the archive control would actually write, in the caller's order. */
  eligible: SelectableSession[];
  /** The rows it would skip, each with the reason it was skipped. Empty for an unarchive. */
  blocked: { session: SelectableSession; reason: string }[];
  /** Why the control can't run at all, or "" when it can. Said before the press, never after. */
  disabled: string;
}

/** The toolbar's whole state for the sessions that are selected right now. */
export function selectionPlan(sessions: readonly SelectableSession[]): SelectionPlan {
  const count = sessions.length;
  const archived = sessions.filter((s) => s.archived);
  const mode: ArchiveMode = count === 0 || archived.length === 0 ? "archive" : archived.length === count ? "unarchive" : "mixed";
  const eligible: SelectableSession[] = [];
  const blocked: { session: SelectableSession; reason: string }[] = [];
  if (mode === "archive") {
    for (const s of sessions) {
      const reason = archiveBlockReason(s);
      if (reason) blocked.push({ session: s, reason });
      else eligible.push(s);
    }
  } else if (mode === "unarchive") {
    eligible.push(...sessions);
  }
  const disabled =
    count === 0
      ? "Nothing is selected."
      : mode === "mixed"
        ? `${archived.length} of these ${count} are archived and the rest aren't. Select one kind, or the other.`
        : eligible.length === 0
          ? `Nothing here can be archived: ${blockedSentence(blocked)}`
          : "";
  return { count, canRename: count === 1, mode, eligible, blocked, disabled };
}

/** "2 open in a TUI, 1 mid-turn" — the reasons counted, most common first, never a list of rows. */
export function blockedSentence(blocked: readonly { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const b of blocked) counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
}

/** The distinct things that went wrong, said once each: a failure carries the server's own
    sentence, and counting those ("1 The agent is mid-turn") would read as nonsense. */
function reasonsSentence(failed: readonly { reason: string }[]): string {
  return [...new Set(failed.map((f) => f.reason))].join(" ");
}

/** "sessions" / "session", for every sentence below. */
const sessionsWord = (n: number) => (n === 1 ? "session" : "sessions");

/**
 * What a finished bulk archive says — ONE sentence for the whole run, however many rows it
 * touched: what it did, then what it didn't and why. A run that wrote nothing still says so; a
 * failure is never silent and never repeated per row.
 */
export function archiveSummary(r: {
  mode: ArchiveMode;
  done: number;
  blocked: readonly { reason: string }[];
  failed: readonly { reason: string }[];
}): string {
  const verb = r.mode === "unarchive" ? "Unarchived" : "Archived";
  const parts: string[] = [r.done > 0 ? `${verb} ${r.done} ${sessionsWord(r.done)}.` : `${verb} nothing.`];
  if (r.blocked.length > 0) parts.push(`Skipped ${r.blocked.length}: ${blockedSentence(r.blocked)}.`);
  if (r.failed.length > 0) parts.push(`${r.failed.length} failed: ${reasonsSentence(r.failed)}`);
  return parts.join(" ");
}

/** The same shape for the bulk group move: one sentence, whatever the count. */
export function groupMoveSummary(r: { done: number; groupName: string | null; failed: number }): string {
  const where = r.groupName === null ? "out of their group" : `to “${r.groupName}”`;
  const parts = [r.done > 0 ? `Moved ${r.done} ${sessionsWord(r.done)} ${where}.` : `Moved nothing ${where}.`];
  if (r.failed > 0) parts.push(`${r.failed} failed.`);
  return parts.join(" ");
}

/**
 * Whether a key pressed on this element belongs to the element rather than to the sidebar. The
 * question is "is the user TYPING here", and `tagName === "INPUT"` does not answer it: a checkbox
 * is an `<input>` too, and treating it as a text field is what swallowed Escape on every row's
 * checkbox — the one control selection mode puts under the keyboard's hands. Only the input types
 * that carry a caret count, plus `<textarea>` and anything contenteditable. A type attribute that
 * is missing or unknown is text (the HTML default), so a new type is never silently treated as a
 * button.
 */
const CARETLESS_INPUT_TYPES = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

export function isTextEntry(el: { tagName?: string | null; type?: string | null; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  return !CARETLESS_INPUT_TYPES.has((el.type ?? "text").toLowerCase());
}

/** A path in or out of the selection, as a new set (the signal's value must change identity). */
export function toggleSelected(selected: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(path)) next.add(path);
  return next;
}

/**
 * The selection with everything the list no longer holds dropped — and THE SAME SET BACK when
 * nothing dropped. Identity is the whole point: this runs on every poll of the session list, and
 * a fresh Set each time would be a new signal value every few seconds, re-rendering every row and
 * (worse) making a "the selection survives polling" bug impossible to see.
 */
export function prunedSelection(selected: ReadonlySet<string>, present: readonly string[]): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const have = new Set(present);
  let drops = 0;
  for (const p of selected) if (!have.has(p)) drops++;
  if (drops === 0) return selected;
  return new Set([...selected].filter((p) => have.has(p)));
}

/** The sessions of a selection, in the list's own order — never the order they were picked in. */
export function selectedSessions(sessions: readonly SelectableSession[], selected: ReadonlySet<string>): SelectableSession[] {
  return sessions.filter((s) => selected.has(s.path));
}

// ---------------------------------------------------------------------------
// The tab's selection
// ---------------------------------------------------------------------------

const [selecting, setSelecting] = createSignal(false);
const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set<string>());
/** An action (archive, group move, rename) is in flight for this tab. */
const [busy, setBusy] = createSignal(false);
/**
 * The action that owns the tab right now, `null` when none does. One at a time, and identified by
 * a token that only ever increases: a run that comes back to a tab whose selection has moved on —
 * cancelled, left and re-entered, picked again — must not write its leftovers over the new one.
 * That is not a theoretical race: every one of these actions is several awaited requests long,
 * and the toolbar it belongs to is rebuilt whenever the mode is re-entered.
 */
let owner: number | null = null;
let nextToken = 0;

/** Whether the sidebar is in selection mode: rows toggle instead of opening. */
export { selecting as selectionMode };
/** The selected session paths. Keyed by PATH, so the same session selected in Recent, in a group
    and in Live & web is one selection with three checked boxes. */
export { selected as selectedPaths };

/** Whether an action is in flight. Every control that could contradict one reads this. */
export { busy as selectionBusy };

export const isSelected = (path: string) => selected().has(path);

/**
 * Claim the tab for one action, or `null` when another one already holds it. The caller passes the
 * token back to `finishSelectionAction`; until it does, `selectionBusy()` is true and the toolbar
 * refuses every gesture that would contradict the run in flight.
 */
export function beginSelectionAction(): number | null {
  if (owner !== null) return null;
  owner = ++nextToken;
  setBusy(true);
  return owner;
}

/**
 * Hand the tab back and, if this action still owns it, apply what it left over — the rows it
 * could not act on (`keep`), or nothing at all (`undefined`, for a rename). Returns whether it
 * was still the owner: a superseded run writes NOTHING, neither the selection nor the busy flag,
 * because something newer is using both.
 */
export function finishSelectionAction(token: number, keep?: readonly string[]): boolean {
  if (owner !== token) return false;
  owner = null;
  setBusy(false);
  if (keep) keepSelected(keep);
  return true;
}

/** Whether `token` still owns the tab — for a run that wants to check before a later step. */
export const ownsSelectionAction = (token: number) => owner === token;

/** Enter selection mode, optionally with the row the hold started on already selected. */
export function startSelection(path?: string): void {
  if (busy()) return; // an action is mid-flight; its own rows are what the mode is about
  setSelecting(true);
  if (path) setSelected((s) => (s.has(path) ? s : toggleSelected(s, path)));
}

export function toggleSelection(path: string): void {
  if (busy()) return; // the run in flight is about the selection as it was when it started
  setSelected((s) => toggleSelected(s, path));
}

/**
 * Leave selection mode and forget the selection — Cancel, Escape, and every finished action.
 * It also takes the tab away from whatever action holds it: a run that finishes after this can
 * no longer put its leftovers back on screen. The toolbar refuses Cancel while one is in flight,
 * so in practice this is the unmount/reset path, and the ownership reset is what makes it safe.
 */
export function clearSelection(): void {
  owner = null;
  setBusy(false);
  setSelecting(false);
  setSelected(new Set<string>());
}

/** Keep these paths selected and stay in selection mode: what a bulk action does with the rows it
    could not act on, so the user can see which ones are left and decide. */
export function keepSelected(paths: readonly string[]): void {
  if (paths.length === 0) {
    clearSelection();
    return;
  }
  setSelecting(true);
  setSelected(new Set(paths));
}

/** Drop whatever the list no longer holds; never touches the signal when nothing dropped. */
export function pruneSelection(present: readonly string[]): void {
  setSelected((s) => prunedSelection(s, present));
}
