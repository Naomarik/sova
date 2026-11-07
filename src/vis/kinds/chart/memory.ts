/**
 * The reader's chart views, kept for the tab (§chat.markdown/vis-chart-views): per drawing (its
 * fence's hash), the view and toggles the reader picked, in an in-memory map mirrored to
 * sessionStorage, so a re-render, a remount or a reload of the tab draws the same view and the
 * shell reserves its height. A new tab starts at the model's default. Pure: no Solid, DOM or CSS;
 * the storage is feature-tested, so node tests run it with the map alone (frame/height.ts's pattern).
 */

const STORE_KEY = "sova.vis.chart-views";
const MAX_ENTRIES = 200;

/** What is stored for one drawing; the caller checks it against what the chart offers. */
export interface StoredChoice {
  view: string;
  log: boolean;
  sort: boolean;
  pct: boolean;
}

/** FNV-1a, hex: the same identity markdown.ts gives a drawing's placeholder (`data-vis-key`). */
export function fenceKey(fence: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < fence.length; i++) h = Math.imul(h ^ fence.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const mem = new Map<string, StoredChoice>();
let loaded = false;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

const valid = (c: unknown): c is StoredChoice => {
  const o = c as StoredChoice | null;
  return !!o && typeof o === "object" && typeof o.view === "string" && typeof o.log === "boolean" && typeof o.sort === "boolean" && typeof o.pct === "boolean";
};

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = storage()?.getItem(STORE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [key, c] of Object.entries(data)) if (valid(c)) mem.set(key, { view: c.view, log: c.log, sort: c.sort, pct: c.pct });
  } catch {
    // A corrupt entry costs only the reader's choice.
  }
}

function save() {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(mem)));
  } catch {
    // Full or refused: the in-memory map still serves this page.
  }
}

/** The choice kept for a drawing, or undefined (the model's default). */
export function recallChoice(key: string): StoredChoice | undefined {
  load();
  const c = mem.get(key);
  return c ? { ...c } : undefined;
}

/** Keep a drawing's choice; `undefined` (back to the model's default) forgets it. */
export function rememberChoice(key: string, choice: StoredChoice | undefined): void {
  if (!key) return;
  load();
  if (!choice) {
    if (mem.delete(key)) save();
    return;
  }
  const prev = mem.get(key);
  if (prev && prev.view === choice.view && prev.log === choice.log && prev.sort === choice.sort && prev.pct === choice.pct) return;
  mem.delete(key);
  mem.set(key, { view: choice.view, log: choice.log, sort: choice.sort, pct: choice.pct }); // newest last, so the oldest go first
  while (mem.size > MAX_ENTRIES) mem.delete(mem.keys().next().value!);
  save();
}

/** For tests: forget everything held in memory (the next read reloads from storage). */
export function resetChoiceMemory(): void {
  mem.clear();
  loaded = false;
}
