// Sova's app-wide keyboard shortcuts, in one table.
//
// Each row is one chord with the rules for where it fires. The first four rules are exactly what
// each key did before this table existed (Alt+O in App, Ctrl/⌘+P in ComposerMenu, Ctrl/⌘+B and "/"
// in Sidebar). Ctrl/⌘+K (the command palette) and "?" (the shortcut sheet) came after, both owned
// by App (§app/command-palette). Keys scoped to a widget (GroupView, ChangesViewer, InsightStrip,
// VoiceInput, a chart's Escape) stay with their widget and are not here.
//
// Scope words:
// - `textEntry`: "ignored" means a keydown whose target is a caret-bearing field (lib/text-entry)
//   does nothing; "fires" means it fires there too.
// - `composing`: whether an IME composition (`isComposing`) stops it. No key checks it today, so all
//   say "fires": a composition keydown carries key "Process", which matches no chord anyway.
// - `modal`: no key checks for an open modal today; a modal that stops the event first wins.
// - Extension frames: a keydown inside an iframe never reaches this page's listeners, so no key
//   fires from inside one. That holds for every row and needs no rule.
// - `target`: the listener's place (window or document), kept as it was so propagation order with
//   the other listeners is unchanged.
//
// This file stays DOM-free at import: listeners attach on the first `bindKey`.

import { isOverseerShortcut } from "../lib/overseer";
import { isTextEntry } from "../lib/text-entry";

export type KeyId = "overseer.open" | "model.picker" | "sidebar.toggle" | "sidebar.search" | "palette.open" | "shortcuts.open";

export interface KeyLike {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
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
  modal: "fires";
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
    id: "palette.open",
    label: "Ctrl/⌘+K",
    does: "Opens or closes the command palette, instead of the browser's search. On a Mac, Ctrl+K in a text field stays the field's own.",
    target: "document",
    textEntry: "fires",
    composing: "fires",
    modal: "fires",
    chord: (e) => ctrlOrMeta(e, "k"),
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

/**
 * Runs a key's owners as its chord would, for a row that does the same thing from the command
 * palette ("Collapse Sessions Pane" runs Ctrl/⌘+B's owner). True when one acted.
 */
export function runKey(id: KeyId): boolean {
  const e = new Event("keydown") as KeyboardEvent; // no chord: owners act on their own condition
  let acted = false;
  for (const run of [...(bound.get(id) ?? [])]) if (run(e)) acted = true;
  return acted;
}

/**
 * What Ctrl/⌘+K's owner does with one keydown (§app.command-palette/opening): `field` leaves it to
 * the browser (a Mac's Ctrl+K in a text field is the field's own delete-to-end, held or not),
 * `repeat` swallows an auto-repeat (a held key toggles once), `toggle` opens or closes the palette.
 * Pure: the order of the checks is the rule.
 */
export function paletteKeyAction(e: KeyLike & { repeat?: boolean }, mac: boolean): "field" | "repeat" | "toggle" {
  if (mac && e.ctrlKey && !e.metaKey && isTextEntry(e.target as Parameters<typeof isTextEntry>[0])) return "field";
  if (e.repeat) return "repeat";
  return "toggle";
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
