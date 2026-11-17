// The Commands dialog's model (§app/command-palette): the This chat rows a composer's "+" opens,
// the reasons a row can't act, the filter, and which row Enter acts on. DOM- and Solid-free, so
// every rule here runs under `bun test` with no page.
//
// The one rule everything here keeps: nothing acts unless the person chose that row. No row is
// active until an arrow or the pointer makes one so, and `enterTarget` answers null otherwise
// (§app.command-palette/picking).

/** The one group's label: the rows act on the chat whose "+" opened the dialog. */
export const GROUP_LABEL = "This chat";

/** The chat's own actions, in the order they show. No sandbox: the shield has it. */
export const CHAT_ACTIONS = ["attach", "hide-tools", "hide-thinking", "playbooks"] as const;
export type ChatActionId = (typeof CHAT_ACTIONS)[number];

export interface PaletteRow {
  /** Unique within the list: `this:<id>`. */
  key: string;
  id: ChatActionId;
  label: string;
  /** Why it can't act now, or null. Shown under the label. */
  disabled: string | null;
}

/** The chat's composer as the rows read it (commands/composers.ts' handle, read once). */
export interface PaletteComposer {
  /** Why the composer takes nothing now (its own reason line), or null. */
  off: string | null;
  /** This chat's view preferences: its tool calls, its thinking hidden. */
  hideTools: boolean;
  hideThinking: boolean;
  /** A Sova chat holds it, so it can send a playbook (a watch view can't). */
  playbooks: boolean;
}

export const REASON = {
  noPlaybooks: "Only a chat open in Sova can send a playbook.",
} as const;

/** The This chat rows' own copy (§design.copy-deck/composer-flyout). */
export const ACTION_COPY = {
  attach: "Attach images",
  hideTools: (hidden: boolean) => (hidden ? "Show tool calls" : "Hide tool calls"),
  hideThinking: (hidden: boolean) => (hidden ? "Show thinking" : "Hide thinking"),
  playbooks: "Playbooks",
} as const;

/** Why a This chat row can't act now, or null. Hiding is a view preference: it always can. A
    draft never stops these. */
export function actionBlocked(id: ChatActionId, composer: PaletteComposer): string | null {
  if (id === "hide-tools" || id === "hide-thinking") return null;
  if (composer.off) return composer.off;
  if (id === "playbooks") return composer.playbooks ? null : REASON.noPlaybooks;
  return null;
}

const LABEL: Record<ChatActionId, (c: PaletteComposer) => string> = {
  attach: () => ACTION_COPY.attach,
  "hide-tools": (c) => ACTION_COPY.hideTools(c.hideTools),
  "hide-thinking": (c) => ACTION_COPY.hideThinking(c.hideThinking),
  playbooks: () => ACTION_COPY.playbooks,
};

/** The This chat rows, in order. */
export function actionRows(composer: PaletteComposer): PaletteRow[] {
  return CHAT_ACTIONS.map((id) => ({ key: `this:${id}`, id, label: LABEL[id](composer), disabled: actionBlocked(id, composer) }));
}

// ---- filtering ---------------------------------------------------------------------------

/** How well `row` matches a lowercased query: lower is better; null is no match. */
export function matchScore(row: PaletteRow, q: string): number | null {
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = row.label.toLowerCase();
  if (!words.every((w) => label.includes(w))) return null;
  if (label.startsWith(words.join(" "))) return 0;
  if (words.every((w) => label.split(/\s+/).some((part) => part.startsWith(w)))) return 1;
  return 2;
}

/** The rows matching `query`, best match first, ties in their own order. */
export function filterRows(rows: readonly PaletteRow[], query: string): PaletteRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows
    .map((row, i) => ({ row, i, s: matchScore(row, q) }))
    .filter((x): x is { row: PaletteRow; i: number; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.row);
}

// ---- the active row ----------------------------------------------------------------------

/** No row is active: at each opening and after each change of the query. */
export const NO_ROW = -1;

/** The next active index for an arrow, wrapping; from none, ↓ is the first and ↑ the last. */
export function moveActive(active: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return NO_ROW;
  if (active < 0 || active >= count) return dir === 1 ? 0 : count - 1;
  return (active + dir + count) % count;
}

/** The row Enter acts on: the active one, if it can act; otherwise none. */
export function enterTarget(rows: readonly PaletteRow[], active: number): PaletteRow | null {
  const row = active >= 0 ? rows[active] : undefined;
  return row && !row.disabled ? row : null;
}
