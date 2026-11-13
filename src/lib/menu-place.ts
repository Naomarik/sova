/**
 * Sova's menus, as data. Every menu — a session's, a group's, a pane's, a message's, a worktree's —
 * is one declaration (`MenuDecl`): its name, its table of rows, and, for a menu place, what
 * extensions add. One body draws any declaration (src/components/MenuPlace.tsx `MenuBody`), and a
 * place's ⋯ and its right-click (§app/context-menus) both draw it, so the doors can't drift and a
 * test reads each table without a DOM.
 * A menu place is a menu that Sova's own rows and extensions both add to, the reply place's pattern
 * (src/lib/reply-place.ts) for a menu: Sova's rows first (trusted, interactive), then what
 * extensions add (data Sova draws: a label, a summary and a declared command, never markup). All
 * five menus are menu places: "session", "group", "pane", "message" and "worktree". An extension
 * adds to one by declaring `"menu": "<place>"` on one of its manifest `commands`
 * (shared/extension-offers.ts MENU_PLACES); GET /api/extensions carries it in `offers.commands`. The extension lane costs nothing beyond the list the page already polls:
 * no request until a row runs, and none of its rows when no running extension declares one.
 */
import type { ExtensionInfo, WorktreeRemoveAnyway } from "../../shared/protocol";
import type { MenuPlace } from "../../shared/extension-offers";
import type { IconName } from "../components/ui";

/**
 * What pressing a row does: exactly one of a catalogue command (shared/commands-catalog.ts, named
 * with the params its route takes; `via` is the place's own wrapper around `send`, the command's
 * request: its toasts, refusals and refresh), a local act (`local`, or a link row's `href`: what
 * only the browser does), or a second screen in the same menu. `keepFocus`: the act moves focus
 * itself, so the menu doesn't put it back on the thing.
 */
export type MenuAct =
  | { command: string; params: Readonly<Record<string, unknown>>; via(send: () => Promise<unknown>): unknown; keepFocus?: boolean }
  | { local(): unknown; keepFocus?: boolean }
  | { href: string }
  | { screen: MenuScreen };

/** A row's second screen: the one name box, the one question, or a list of rows (Move to Group…). */
export type MenuScreen =
  | {
      kind: "name";
      /** The box's accessible name: "Rename “Work”". */
      label: string;
      initial: string;
      placeholder: string;
      max: number;
      /** The line under the box. */
      hint?: string;
      /** Leaving the box (a click outside) saves what's there; otherwise it saves nothing. */
      leaveSaves?: boolean;
      /** What saving `value` (as typed) does; `opened` is what the box opened with. Null: nothing to write. */
      save(value: string, opened: string, via: "enter" | "leave"): MenuAct | null;
    }
  | { kind: "confirm"; note: string; confirm: string; act: MenuAct }
  | { kind: "rows"; label: string; sections: MenuSection[]; load?(): void }
  | {
      kind: "worktree-remove";
      /** The ordinary question or the dry run's reason. The listing replaces it on Remove Anyway. */
      note: string;
      /** The exact confirmed listing, once Remove Anyway asks for it. */
      listing?: { data: WorktreeRemoveAnyway; home: string | null };
      /** Remove Worktree, Remove Anyway, or Delete and Remove Worktree. No button for a hard hold. */
      confirm?: ({ label: string; disabled?: boolean } & ({ act: MenuAct } | { show(): void }));
      /** Back from the exact listing to the reason. */
      back?(): void;
      /** Start the dry run when this screen opens; stop holding its state when it closes. */
      load?(): void;
      unload?(): void;
    };

/** One row, in every menu: its words, its icon, why it can't run, and what it does. */
export interface MenuItem {
  label: string;
  /** The row's accessible name: it says which thing the row acts on. */
  aria: string;
  icon?: IconName;
  title?: string;
  description?: string;
  /** Why it can't run, said before the press; absent or "" when it can. */
  disabled?: string;
  act: MenuAct;
}

/** Rows drawn together: `name` makes them a named group (none: bare rows); `heading` shows a label over them. */
export interface MenuSection {
  name?: string;
  heading?: string;
  rows: MenuItem[];
}

/** One place's menu, for every door. */
export interface MenuDecl<T> {
  /** The menu's name, the ⋯ trigger's: every door names it the same. */
  label(subject: T): string;
  /** Sova's rows, in their sections and order; a section with no rows isn't drawn. */
  table(subject: T): MenuSection[];
  /** A menu place: what extensions add after Sova's rows. `payload` is what an entry is sent
      (null: none here, such as another computer's); `name` how its rows name the subject. */
  extensions?: { place: MenuPlace; payload(subject: T): Record<string, string> | null; name(subject: T): string };
}

/** One extension's entry in a menu: copied field by field from its validated offers. */
export interface MenuEntry {
  extension: string;
  extensionTitle: string;
  name: string;
  label: string;
  summary?: string;
}

/** One extension's entries, in declared order: drawn as one group headed by its title. */
export interface MenuGroup {
  extension: string;
  title: string;
  entries: MenuEntry[];
}

/** Extension rows past this many, in all, are never drawn. */
export const MENU_ROWS_MAX = 8;

/** A running entry with no answer in this long tells the user its extension isn't answering. */
export const MENU_RUN_TIMEOUT_MS = 10_000;

/** Every label Sova's own rows can show in any of the five menus, one list for all of them: an
    extension entry may not take one in any menu, so no row of an extension's reads as Sova's (the
    reply chips' rule). The tables' test fails when a label a table draws is missing here, or when one
    here is no table's. Open Session stays reserved though the session menu no longer has it. */
export const MENU_NAMES: readonly string[] = [
  // a session's
  "Open Session",
  "Session Details",
  "Close Session Details",
  "Open Subagents",
  "Rename…",
  "Use Gist as Title",
  "Reset to Original Title",
  "Move to Group…",
  "Archive",
  "Unarchive",
  "Copy Path",
  // a group's (and Rename…)
  "Open workspace",
  "Delete group…",
  // a pane's (and Rename…)
  "Open",
  "Wider",
  "Narrower",
  "Move Left",
  "Move Right",
  "Focus",
  "Promote",
  "Remove From Group",
  // a message's
  "Copy",
  "Copy as Plain Text",
  "Share From Here",
  "Rewind…",
  "Regenerate…",
  "Fork From Here",
  // a worktree row's
  "Merge Branch",
  "Land",
  "Remove Worktree…",
];

/** A label as the name check compares it: case, inner whitespace and a trailing ellipsis ignored. */
export const menuName = (label: string): string => label.trim().replace(/\s+/g, " ").replace(/(…|\.\.\.)$/, "").trimEnd().toLowerCase();

const SOVA_NAMES = new Set(MENU_NAMES.map(menuName));

/** Whether a label is one of Sova's own in any menu. */
export const isSovaName = (label: string): boolean => SOVA_NAMES.has(menuName(label));

/**
 * The groups extensions add to this menu: running extensions only (one whose backend is down adds
 * nothing until a later poll finds it up), in manifest order, each with its entries for `place` in
 * declared order, at most MENU_ROWS_MAX rows in all. An entry whose label is one of Sova's own
 * (MENU_NAMES) is left out of the menu; the command itself stays. An extension with none
 * adds no group.
 */
export function menuGroups(list: readonly ExtensionInfo[] | undefined, place: MenuPlace): MenuGroup[] {
  const out: MenuGroup[] = [];
  let left = MENU_ROWS_MAX;
  for (const e of list ?? []) {
    if (left <= 0) break;
    if (e.status !== "ok") continue;
    const entries: MenuEntry[] = [];
    for (const c of e.offers?.commands ?? []) {
      if (c.menu !== place || entries.length >= left || isSovaName(c.label)) continue;
      const entry: MenuEntry = { extension: e.id, extensionTitle: e.title, name: c.name, label: c.label };
      if (c.summary) entry.summary = c.summary;
      entries.push(entry);
    }
    if (!entries.length) continue;
    left -= entries.length;
    out.push({ extension: e.id, title: e.title, entries });
  }
  return out;
}

/** Same groups, same rows: a poll that changes nothing redraws nothing. */
export const sameGroups = (a: readonly MenuGroup[], b: readonly MenuGroup[]): boolean =>
  a.length === b.length &&
  a.every(
    (g, i) =>
      g.extension === b[i]!.extension &&
      g.title === b[i]!.title &&
      g.entries.length === b[i]!.entries.length &&
      g.entries.every((x, j) => {
        const y = b[i]!.entries[j]!;
        return x.name === y.name && x.label === y.label && x.summary === y.summary;
      }),
  );

/** An extension row's tooltip: its label, then the extension it comes from. */
export const entryTitle = (e: MenuEntry): string => `${e.label} · From ${e.extensionTitle}`;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Run one extension entry: POST /ext/<id>/api/commands/<name> with its menu's payload, as the
 * place's declaration builds it (`MenuDecl.extensions.payload`: a session's `{session}`, a group's
 * `{group}`, a pane's `{session}`, a message's `{session, entry}`, a worktree row's
 * `{project, branch, session}`), sent as it is, through Sova's extension proxy (which takes Sova's token off), the path a reply chip's action
 * takes. Resolves to the sentence to tell the user; never throws. No answer within `timeoutMs`
 * (headers and body) is the same as no answer at all.
 */
export async function runMenuEntry(
  entry: MenuEntry,
  payload: Readonly<Record<string, string>>,
  fetch: Fetch = (url, init) => globalThis.fetch(url, init),
  timeoutMs = MENU_RUN_TIMEOUT_MS,
): Promise<string> {
  try {
    const res = await fetch(`/ext/${encodeURIComponent(entry.extension)}/api/commands/${encodeURIComponent(entry.name)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.ok ? `Sent to ${entry.extensionTitle}.` : `${entry.extensionTitle} answered HTTP ${res.status}.`;
  } catch {
    return `${entry.extensionTitle} isn't answering.`;
  }
}
