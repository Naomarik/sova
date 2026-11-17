// Sova's app-wide keyboard shortcuts, in one table.
//
// Each row is one chord with the rules for where it fires. The first four rules are exactly what
// each key did before this table existed (Alt+O in App, Ctrl/⌘+P in ComposerMenu, Ctrl/⌘+B and "/"
// in Sidebar). "?" (the shortcut sheet) came after, owned by App. Ctrl/⌘+K is Sova's no more: it
// stays the browser's. A typed character (compose.type) came last, owned by App too: it starts the
// message in the chat's message box (lib/type-anywhere). Keys scoped to a widget
// (GroupView, ChangesViewer, InsightStrip, VoiceInput, a chart's Escape, the message box's Escape in
// Composer) stay with their widget and
// are not here.
//
// Scope words:
// - `textEntry`: "ignored" means a keydown whose target is a caret-bearing field (lib/text-entry)
//   does nothing; "fires" means it fires there too.
// - `composing`: whether an IME composition (`isComposing`) stops it. Only a typed character checks
//   it; the others say "fires": a composition keydown carries key "Process", which matches no chord.
// - `modal`: "fires" means no check for an open modal; a modal that stops the event first wins.
//   "ignored" means the row's owner declines while a dialog, sheet, menu or popover is open or holds
//   the target (lib/type-anywhere checks it, not this table).
// - Extension frames: a keydown inside an iframe never reaches this page's listeners, so no key
//   fires from inside one. That holds for every row and needs no rule.
// - `target`: the listener's place (window or document), kept as it was so propagation order with
//   the other listeners is unchanged.
//
// This file stays DOM-free at import: listeners attach on the first `bindKey`.

import { isOverseerShortcut } from "../lib/overseer";
import { isTextEntry } from "../lib/text-entry";
import { typesCharacter } from "../lib/type-anywhere";

export type KeyId = "overseer.open" | "model.picker" | "sidebar.toggle" | "sidebar.search" | "shortcuts.open" | "compose.type";

export interface KeyLike {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?(key: string): boolean;
  target?: unknown;
}

export interface KeyRow {
  id: KeyId;
  /** What the sheet would show. */
  label: string;
  /** What it does, and the condition its owner checks (not part of the chord). */
  does: string;
  target: "window" | "document";
  textEntry: "fires" | "ignored";
  composing: "fires" | "ignored";
  modal: "fires" | "ignored";
  /** The chord, without the scope rules. */
  chord: (e: KeyLike) => boolean;
}

const ctrlOrMeta = (e: KeyLike, letter: string) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === letter;

export const KEYS: readonly KeyRow[] = [
  {
    id: "overseer.open",
    label: "Alt+O",
    does: "Opens the Overseer, from anywhere.",
    target: "window",
    textEntry: "fires",
    composing: "fires",
    modal: "fires",
    chord: (e) => isOverseerShortcut(e),
  },
  {
    id: "model.picker",
    label: "Ctrl/⌘+P",
    does: "Opens or closes the model picker while a chat is open, instead of print.",
    target: "document",
    textEntry: "fires",
    composing: "fires",
    modal: "fires",
    chord: (e) => ctrlOrMeta(e, "p"),
  },
  {
    id: "sidebar.toggle",
    label: "Ctrl/⌘+B",
    does: "Collapses or expands the sessions pane, on desktop with the sidebar unfolded.",
    target: "document",
    textEntry: "fires",
    composing: "fires",
    modal: "fires",
    chord: (e) => ctrlOrMeta(e, "b"),
  },
  {
    id: "sidebar.search",
    label: "/",
    does: "Focuses session search, opening a collapsed pane.",
    target: "document",
    textEntry: "ignored",
    composing: "fires",
    modal: "fires",
    // Shift is allowed: on some layouts "/" needs it.
    chord: (e) => e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey,
  },
  {
    id: "shortcuts.open",
    label: "?",
    does: "Opens this list of keyboard shortcuts.",
    target: "document",
    textEntry: "ignored",
    composing: "fires",
    modal: "fires",
    // Shift is allowed, as most layouts need it for "?".
    chord: (e) => e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey,
  },
  {
    id: "compose.type",
    label: "A character",
    does: "Starts typing in the chat's message box, from outside a text field.",
    // On the window, so it runs after every widget's own handler (Solid delegates to the document).
    // Its owner always returns false, so the browser types the character in the box it focused.
    target: "window",
    textEntry: "ignored",
    composing: "ignored",
    modal: "ignored",
    // Any key that types a character, except another row's: "/", "?" and Alt+O (ø on a Mac) keep theirs.
    chord: (e) => typesCharacter(e) && !KEYS.some((r) => r.id !== "compose.type" && r.chord(e)),
  },
];

const BY_ID = new Map(KEYS.map((r) => [r.id, r]));

export const keyRow = (id: KeyId): KeyRow => BY_ID.get(id)!;

/** Whether this keydown is the row's chord and its scope lets it fire. Pure. */
export function keyFires(row: KeyRow, e: KeyLike): boolean {
  if (!row.chord(e)) return false;
  if (row.textEntry === "ignored" && isTextEntry(e.target as Parameters<typeof isTextEntry>[0])) return false;
  if (row.composing === "ignored" && e.isComposing) return false;
  return true;
}

/** The rows a keydown on `target` fires, in table order. Pure. */
export const firingRows = (target: KeyRow["target"], e: KeyLike): KeyRow[] => KEYS.filter((r) => r.target === target && keyFires(r, e));

/**
 * A key's owner: returns true when it acted (the browser default is then prevented), false when its
 * own condition (a chat open, the sidebar unfolded) says no, leaving the key to the browser.
 */
export type KeyRun = (e: KeyboardEvent) => boolean;

// Every owner of a key runs, in bind order: a page can hold several composers, each its own owner,
// as each once held its own listener.
const bound = new Map<KeyId, KeyRun[]>();
let attached = { window: false, document: false };

function dispatch(target: KeyRow["target"], e: KeyboardEvent) {
  for (const row of firingRows(target, e)) {
    for (const run of [...(bound.get(row.id) ?? [])]) if (run(e)) e.preventDefault();
  }
}
const onWindow = (e: KeyboardEvent) => dispatch("window", e);
const onDocument = (e: KeyboardEvent) => dispatch("document", e);

function sync() {
  const want = { window: false, document: false };
  for (const id of bound.keys()) want[keyRow(id).target] = true;
  if (want.window !== attached.window) {
    if (want.window) window.addEventListener("keydown", onWindow);
    else window.removeEventListener("keydown", onWindow);
  }
  if (want.document !== attached.document) {
    if (want.document) document.addEventListener("keydown", onDocument);
    else document.removeEventListener("keydown", onDocument);
  }
  attached = want;
}

/** Binds an owner to a row; returns the unbind (idempotent). */
export function bindKey(id: KeyId, run: KeyRun): () => void {
  const entry: KeyRun = (e) => run(e); // a fresh identity, so binding one function twice unbinds singly
  bound.set(id, [...(bound.get(id) ?? []), entry]);
  sync();
  return () => {
    const rest = (bound.get(id) ?? []).filter((r) => r !== entry);
    if (rest.length) bound.set(id, rest);
    else bound.delete(id);
    sync();
  };
}
