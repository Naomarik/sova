/**
 * Menu places: a menu that Sova's own items and extensions both add to, the reply place's pattern
 * (src/lib/reply-place.ts) for a menu. Two lanes, always in this order: Sova's built-ins (trusted,
 * interactive rows it draws), then what extensions add (data Sova draws: a label, a summary and a
 * declared command, never markup). The one menu place today is "session", the Agents board row's
 * ⋯ menu (src/components/SessionRowMenu.tsx); src/components/MenuPlace.tsx draws both lanes.
 *
 * An extension adds to a menu by declaring `"menu": "<place>"` on one of its manifest `commands`
 * (shared/extension-offers.ts MENU_PLACES); GET /api/extensions carries it in `offers.commands`.
 * The extension lane costs nothing beyond the list the page already polls: no request until a row
 * runs, and none of its rows when no running extension declares one.
 */
import type { ExtensionInfo } from "../../shared/protocol";
import type { MenuPlace } from "../../shared/extension-offers";
import type { IconName } from "../components/ui";

/** One row a built-in draws: what ActionMenu's row needs, with a Sova icon by name. */
export interface MenuRow {
  label: string;
  /** The row's accessible name: it says which thing the row acts on. */
  aria: string;
  icon?: IconName;
  title?: string;
  description?: string;
  run(): void;
}

/** One of Sova's own contributions to a menu place: the rows it adds for that subject. */
export interface MenuBuiltIn<T> {
  id: string;
  rows(subject: T): MenuRow[];
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

/** Every label Sova's own items in the session menu can show: an extension entry may not take one,
    so no row of an extension's reads as Sova's (the reply chips' rule). The session row menu's test
    fails when a label it draws is missing here. */
export const SESSION_MENU_NAMES: readonly string[] = [
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
];

/** A label as the name check compares it: case, inner whitespace and a trailing ellipsis ignored. */
export const menuName = (label: string): string => label.trim().replace(/\s+/g, " ").replace(/(…|\.\.\.)$/, "").trimEnd().toLowerCase();

const SOVA_NAMES = new Set(SESSION_MENU_NAMES.map(menuName));

/** Whether a label is one of Sova's own in the session menu. */
export const isSovaName = (label: string): boolean => SOVA_NAMES.has(menuName(label));

/**
 * The groups extensions add to this menu: running extensions only (one whose backend is down adds
 * nothing until a later poll finds it up), in manifest order, each with its entries for `place` in
 * declared order, at most MENU_ROWS_MAX rows in all. An entry whose label is one of Sova's own
 * (SESSION_MENU_NAMES) is left out of the menu; the command itself stays. An extension with none
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
 * Run one extension entry for a session: POST /ext/<id>/api/commands/<name> with {session},
 * through Sova's extension proxy (which takes Sova's token off), the path a reply chip's action
 * takes. Resolves to the sentence to tell the user; never throws. No answer within `timeoutMs`
 * (headers and body) is the same as no answer at all.
 */
export async function runMenuEntry(
  entry: MenuEntry,
  session: string,
  fetch: Fetch = (url, init) => globalThis.fetch(url, init),
  timeoutMs = MENU_RUN_TIMEOUT_MS,
): Promise<string> {
  try {
    const res = await fetch(`/ext/${encodeURIComponent(entry.extension)}/api/commands/${encodeURIComponent(entry.name)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ session }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.ok ? `Sent to ${entry.extensionTitle}.` : `${entry.extensionTitle} answered HTTP ${res.status}.`;
  } catch {
    return `${entry.extensionTitle} isn't answering.`;
  }
}
