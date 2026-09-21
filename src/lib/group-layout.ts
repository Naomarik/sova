// How one workspace is laid out: split (panes side by side, scrolled horizontally) or tabs (one
// pane visible, all of them mounted so every stream keeps running). Per group, persisted in
// localStorage under the app's `pi-web:` prefix — a VIEW preference, never membership: which
// sessions a group holds is the server's, and only the server's.
//
// The pure helpers here are what the tests cover; the storage wrapper never throws, because a
// blocked or full localStorage must not break a render.

export type GroupLayoutMode = "split" | "tabs";

/** A pane narrower than this can't hold a transcript and a composer; the floor for every width. */
export const PANE_MIN_WIDTH = 440;
/** Nothing is gained past this, and one very wide pane hides its neighbours. */
export const PANE_MAX_WIDTH = 1200;
/** What Wider/Narrower move by. */
export const PANE_WIDTH_STEP = 120;
/** Below this viewport width a split row has no room for two panes: the workspace is tabs only. */
export const TABS_ONLY_WIDTH = 768;

const PREFIX = "pi-web:";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice still holds for this page; persisting it is a convenience.
  }
}

const modeKey = (id: string) => `${PREFIX}group-mode-${id}`;
const widthsKey = (id: string) => `${PREFIX}group-widths-${id}`;
const activeKey = (id: string) => `${PREFIX}group-active-${id}`;
const orderKey = (id: string) => `${PREFIX}group-order-${id}`;

/** Every pane gets the same share of the row, never below the floor and never absurdly wide. */
export function defaultPaneWidth(available: number, panes: number): number {
  if (!Number.isFinite(available) || available <= 0 || panes <= 0) return PANE_MIN_WIDTH;
  return clampWidth(Math.floor(available / panes));
}

export const clampWidth = (px: number): number => Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, Math.round(px)));

/** Wider (+1) / Narrower (-1), clamped. Returns the current width when it can't move. */
export const stepWidth = (current: number, direction: 1 | -1): number => clampWidth(current + direction * PANE_WIDTH_STEP);

/** Stored widths by session path; anything unparseable or out of range is dropped. */
export function parseWidths(raw: string | null): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[path] = clampWidth(value);
  }
  return out;
}

/**
 * The panes of a group in the order to show them: the stored order first (for the paths still in
 * the group), then anything the stored order doesn't mention, in the list's own order. A member
 * the user never moved therefore lands at the end, and a member they moved keeps its place.
 */
export function orderPanes(paths: readonly string[], stored: readonly string[]): string[] {
  const have = new Set(paths);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of stored) {
    if (have.has(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** `list` with the item at `from` moved one step in `direction`; unchanged at either end. */
export function movePane(list: readonly string[], path: string, direction: 1 | -1): string[] {
  const from = list.indexOf(path);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return [...list];
  const out = [...list];
  out.splice(from, 1);
  out.splice(to, 0, path);
  return out;
}

/** The pane to focus after `removed` leaves: its right-hand neighbour, else its left, else null. */
export function neighbourOf(list: readonly string[], removed: string): string | null {
  const i = list.indexOf(removed);
  if (i < 0) return null;
  return list[i + 1] ?? list[i - 1] ?? null;
}

// ---- Stored per-group preferences -----------------------------------------

export function readMode(id: string): GroupLayoutMode | null {
  const v = read(modeKey(id));
  return v === "split" || v === "tabs" ? v : null;
}

export const writeMode = (id: string, mode: GroupLayoutMode): void => write(modeKey(id), mode);

export const readWidths = (id: string): Record<string, number> => parseWidths(read(widthsKey(id)));

export const writeWidths = (id: string, widths: Record<string, number>): void => write(widthsKey(id), JSON.stringify(widths));

export const readActive = (id: string): string | null => read(activeKey(id));

export const writeActive = (id: string, path: string): void => write(activeKey(id), path);

export function readOrder(id: string): string[] {
  const raw = read(orderKey(id));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export const writeOrder = (id: string, order: readonly string[]): void => write(orderKey(id), JSON.stringify(order));
