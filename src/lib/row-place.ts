/**
 * The row place (§app.extensions/row-chips): line 3 of a session row in the sessions pane, the reply
 * place's pattern (src/lib/reply-place.ts) for a row. Two lanes, always in this order: Sova's own
 * built-ins (the merge-readiness badge, trusted, drawn exactly as it always was), then what
 * extensions add (chips: data Sova draws, never markup, never interactive, since the row itself is
 * the link to its session). src/components/RowPlace.tsx draws both.
 *
 * The extension lane asks per list, never per row: one request per extension whose offers name
 * `row` (GET /ext/<id>/api/screens/row), answered keyed by session id, when the pane has its list,
 * when that set of extensions changes, and after the list changes, at most once per ROW_ASK_MIN_MS
 * per extension. With no such extension it costs nothing: no request, no state, no timer, and every
 * row's chips read undefined. The validator, the caps, the auto-mute and the off switch are the
 * reply slot's (src/lib/reply-slot.ts), with the row's own limits and its own switch.
 */
import { createContext, createEffect, createMemo, createSignal, on, onCleanup, useContext, type Accessor } from "solid-js";
import type { ExtensionInfo, SessionReadiness, SessionSummary } from "../../shared/protocol";
import { offersPlace, screenPath } from "../../shared/extension-offers";
import { readinessBadge, readinessTitle, readinessWord } from "./readiness";
import { ExtensionsContext } from "./reply-place";
import { CHIP_TONES, createSlotPolicy, readCappedJson, SLOT_TIMEOUT_MS, type ChipTone, type SlotPolicy, type SlotStorage } from "./reply-slot";
import { hostOf } from "./mesh";
import { hostTone } from "./mesh-details";

export const ROW_CHIP_LABEL_MAX = 16;
export const ROW_CHIP_TITLE_MAX = 120;
/** Chips one extension adds to one row. */
export const ROW_CHIPS_PER_EXTENSION = 1;
/** Chips on one row, from every extension. */
export const ROW_CHIPS_PER_ROW = 2;
/** Sessions read from one answer; the rest make it bad. */
export const ROW_SESSIONS_MAX = 2000;
/** The least time between two asks of one extension that a list change starts. */
export const ROW_ASK_MIN_MS = 10_000;
/** Where the user's switch for the row place is kept: apart from the reply place's. */
export const ROW_OFF_KEY = "sova.row-place.off";

// ---- the built-ins -----------------------------------------------------------------------------

/** One thing a built-in stands on line 3, after a " · ": its words, its class, its tooltip. */
export interface RowItem {
  label: string;
  class: string;
  title?: string;
}

/** One of Sova's own contributions to the place: what it stands on a session's line 3. */
export interface RowBuiltIn {
  id: string;
  items(session: SessionSummary): RowItem[];
}

/** The merge-readiness badge (§chat.worktrees/readiness), muted, after the worktree count. */
export const readinessItems = (r: SessionReadiness | undefined): RowItem[] => {
  const label = readinessBadge(r);
  if (label === null) return [];
  const title = readinessTitle(r);
  return [title === null ? { label, class: "session-readiness" } : { label, class: "session-readiness", title }];
};

/** Sova's own contributions to line 3, in the order they stand. */
export const ROW_BUILT_INS: readonly RowBuiltIn[] = [{ id: "sova.readiness", items: (s) => readinessItems(s.readiness) }];

// ---- what an extension adds ----------------------------------------------------------------------

/** The extension as the row place knows it. */
export interface RowExtension {
  id: string;
  title: string;
}

export interface RowChip {
  extension: string;
  extensionTitle: string;
  label: string;
  tone: ChipTone;
  title?: string;
}

/** Letters, digits, spaces and plain punctuation: the reply chip's rule. */
const PLAIN = /^[\p{L}\p{N} .,:;!?()/+#%_-]+$/u;
const plainText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && PLAIN.test(v);

/** Every word Sova itself shows on a row's lines: a chip may not take one, so none reads as Sova's. */
export const ROW_SOVA_WORDS: readonly string[] = [
  "TUI",
  "Draft",
  "restart pending",
  ...(["merged", "stale", "in-progress", "blocked", "ready", "waiting-approval", "removed"] as const).map(readinessWord),
  // The host mark's state words, on the same meta line with the same dot (src/lib/mesh-details.ts).
  ...(["down", "skewed", "refused", "hidden"] as const).map((state) => hostTone(state).word!),
];
const SOVA_WORDS = new Set(ROW_SOVA_WORDS.map((w) => w.toLowerCase()));
/** The follow-up count ("2 follow-ups") and the worktree count ("2 of 3"). */
const SOVA_FIGURES = [/^\d+ follow-ups?$/i, /^\d+ of \d+$/i];

/** Whether a label is one of Sova's own words on a row. */
export const isRowSovaWord = (label: string): boolean => SOVA_WORDS.has(label.toLowerCase()) || SOVA_FIGURES.some((re) => re.test(label));

/** One chip, or null (dropped alone). */
export function validRowChip(raw: unknown, ext: RowExtension): RowChip | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!plainText(r.label, ROW_CHIP_LABEL_MAX) || isRowSovaWord(r.label)) return null;
  if (!(CHIP_TONES as readonly unknown[]).includes(r.tone)) return null;
  // A row chip does nothing when pressed: the row is the link. One that asks to do something is dropped.
  if (r.href !== undefined || r.action !== undefined) return null;
  const chip: RowChip = { extension: ext.id, extensionTitle: ext.title, label: r.label, tone: r.tone as ChipTone };
  if (r.title !== undefined) {
    if (!plainText(r.title, ROW_CHIP_TITLE_MAX)) return null;
    chip.title = r.title;
  }
  return chip;
}

/** A session id as the list has it. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One extension's answer, `{"sessions": {"<session id>": {"chips": [ … ]}}}`, into its chips per
 * session (at most ROW_CHIPS_PER_EXTENSION each), whether any of it was bad, and whether it was
 * malformed (not that shape at all: dropped whole). Each session is read on its own, so a bad one
 * loses only its own chips.
 */
export function validateRowAnswer(raw: unknown, ext: RowExtension): { bySession: Map<string, RowChip[]>; bad: boolean; malformed: boolean } {
  const bySession = new Map<string, RowChip[]>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { bySession, bad: true, malformed: true };
  const all = (raw as Record<string, unknown>).sessions;
  if (typeof all !== "object" || all === null || Array.isArray(all)) return { bySession, bad: true, malformed: true };
  const keys = Object.keys(all);
  let bad = keys.length > ROW_SESSIONS_MAX;
  for (const key of keys.slice(0, ROW_SESSIONS_MAX)) {
    const v = (all as Record<string, unknown>)[key];
    if (!SESSION_ID_RE.test(key) || typeof v !== "object" || v === null || Array.isArray(v)) {
      bad = true;
      continue;
    }
    const raws = (v as Record<string, unknown>).chips;
    if (raws === undefined) continue;
    if (!Array.isArray(raws)) {
      bad = true;
      continue;
    }
    const chips: RowChip[] = [];
    for (const c of raws) {
      const chip = validRowChip(c, ext);
      if (!chip || chips.length >= ROW_CHIPS_PER_EXTENSION) bad = true;
      else chips.push(chip);
    }
    if (chips.length) bySession.set(key, chips);
  }
  return { bySession, bad, malformed: false };
}

/** The running extensions whose offers name the row place, in manifest order. */
export function rowExtensions(list: readonly ExtensionInfo[] | undefined): RowExtension[] {
  const out: RowExtension[] = [];
  for (const e of list ?? []) if (e.status === "ok" && offersPlace(e.offers, "row")) out.push({ id: e.id, title: e.title });
  return out;
}

/** Same extensions, same titles: a poll that changes nothing asks nothing. */
export const sameRowExtensions = (a: readonly RowExtension[], b: readonly RowExtension[]): boolean =>
  a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.title === b[i]!.title);

/** An extension chip's tooltip: its title, else its label, then the extension it comes from. */
export const rowChipTitle = (c: RowChip): string => `${c.title ?? c.label} · From ${c.extensionTitle}`;

// ---- asking the extensions, per list -------------------------------------------------------------

export interface RowSource {
  ext: RowExtension;
  ask(signal: AbortSignal): Promise<unknown>;
}

/** The timers the lane waits with (the page's, or a test's). */
export interface RowClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}
const PAGE_CLOCK: RowClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/**
 * The row place's extension lane for a whole list. `ask(sources, soon)` asks every source not off
 * and not muted: at once, or, when `soon` (a list change), no sooner than ROW_ASK_MIN_MS after that
 * source's last ask, as one trailing ask however many changes came in between. `update` gets the
 * chips per session whenever an answer lands or a switch or mute changes them: extensions in
 * `sources` order, at most ROW_CHIPS_PER_ROW on a row.
 *
 * An answer replaces that extension's last one; one that is late, malformed, too large or throws is
 * dropped whole, counted against its extension, and its last good answer stays. A newer ask while
 * one is out supersedes it, uncounted. An extension that is off or muted draws nothing.
 */
export function createRowAnswers(
  policy: SlotPolicy,
  update: (bySession: ReadonlyMap<string, RowChip[]>) => void,
  opts: { timeoutMs?: number; minMs?: number; clock?: RowClock } = {},
) {
  const timeoutMs = opts.timeoutMs ?? SLOT_TIMEOUT_MS;
  const minMs = opts.minMs ?? ROW_ASK_MIN_MS;
  const clock = opts.clock ?? PAGE_CLOCK;
  const got = new Map<string, Map<string, RowChip[]>>();
  const out = new Map<string, AbortController>();
  const last = new Map<string, number>();
  const waiting = new Map<string, unknown>();
  let order: RowSource[] = [];
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    const bySession = new Map<string, RowChip[]>();
    for (const { ext } of order) {
      if (policy.isOff(ext.id) || policy.isMuted(ext.id)) continue;
      for (const [session, chips] of got.get(ext.id) ?? []) {
        let row = bySession.get(session);
        if (!row) bySession.set(session, (row = []));
        for (const c of chips) if (row.length < ROW_CHIPS_PER_ROW) row.push(c);
      }
    }
    update(bySession);
  };
  const unsubscribe = policy.subscribe(draw);

  const askOne = (src: RowSource) => {
    const id = src.ext.id;
    if (stopped || policy.isOff(id) || policy.isMuted(id)) return;
    out.get(id)?.abort();
    const ac = new AbortController();
    out.set(id, ac);
    last.set(id, clock.now());
    const timer = clock.setTimeout(() => ac.abort(), timeoutMs);
    let answer: Promise<unknown>;
    try {
      answer = Promise.resolve(src.ask(ac.signal));
    } catch (err) {
      answer = Promise.reject(err);
    }
    const aborted = new Promise<never>((_, fail) => ac.signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true }));
    // Only the newest ask of a source still running speaks for it: a superseded or stopped one is
    // dropped without counting, a timeout (the abort above) counts.
    const current = () => !stopped && out.get(id) === ac;
    Promise.race([answer, aborted]).then(
      (raw) => {
        clock.clearTimeout(timer);
        if (!current()) return;
        out.delete(id);
        const v = validateRowAnswer(raw, src.ext);
        policy.note(id, !v.bad);
        // A malformed answer is dropped whole: the last good one stays. A partly bad one draws the rest.
        if (!v.malformed) {
          got.set(id, v.bySession);
          draw();
        }
      },
      () => {
        clock.clearTimeout(timer);
        if (!current()) return;
        out.delete(id);
        policy.note(id, false);
      },
    );
  };

  return {
    ask(sources: readonly RowSource[], soon = false): void {
      if (stopped) return;
      order = [...sources];
      const ids = new Set(sources.map((s) => s.ext.id));
      let forgot = false;
      for (const id of [...got.keys()])
        if (!ids.has(id)) {
          got.delete(id);
          last.delete(id);
          forgot = true;
        }
      for (const [id, ac] of [...out])
        if (!ids.has(id)) {
          ac.abort();
          out.delete(id);
        }
      for (const [id, t] of [...waiting])
        if (!ids.has(id)) {
          clock.clearTimeout(t);
          waiting.delete(id);
        }
      if (forgot) draw();
      for (const src of sources) {
        const id = src.ext.id;
        if (policy.isOff(id) || policy.isMuted(id)) continue;
        const wait = soon ? (last.get(id) ?? -Infinity) + minMs - clock.now() : 0;
        if (wait <= 0) {
          if (waiting.has(id)) {
            clock.clearTimeout(waiting.get(id));
            waiting.delete(id);
          }
          askOne(src);
        } else if (!waiting.has(id)) {
          waiting.set(
            id,
            clock.setTimeout(() => {
              waiting.delete(id);
              const now = order.find((s) => s.ext.id === id);
              if (now) askOne(now);
            }, wait),
          );
        }
      }
    },
    stop(): void {
      stopped = true;
      unsubscribe();
      for (const ac of out.values()) ac.abort();
      out.clear();
      for (const t of waiting.values()) clock.clearTimeout(t);
      waiting.clear();
    },
  };
}

// ---- the page's lane --------------------------------------------------------------------------

const storage = (): SlotStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** The row place's switch and mute record for the whole page. */
export const rowPolicy = createSlotPolicy(storage(), ROW_OFF_KEY);
const [policyVersion, setPolicyVersion] = createSignal(0);
rowPolicy.subscribe(() => setPolicyVersion((v) => v + 1));
/** The user's switch for one extension on rows, reactive. */
export const rowAdditionsOff = (id: string): boolean => (policyVersion(), rowPolicy.isOff(id));
/** Sova muted it on rows until the page reloads, reactive. */
export const rowAdditionsMuted = (id: string): boolean => (policyVersion(), rowPolicy.isMuted(id));

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** GET /ext/<id>/api/screens/row, through the proxy (which strips Sova's token). No query: per list. */
async function askRow(fetch: Fetch, id: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`/ext/${encodeURIComponent(id)}${screenPath("row")}`, { signal, headers: { accept: "application/json" }, credentials: "same-origin" });
  return readCappedJson(res);
}

/** What the rows read: a session's extension chips, or undefined (nothing to draw). */
export type RowChips = (session: SessionSummary) => RowChip[] | undefined;

/** The pane's lane, handed to its rows. Outside a pane: no chips, ever. */
export const RowPlaceContext = createContext<RowChips>(() => undefined);

/** The pane's lane over its list, with the page's extension list. */
export function useRowAdditions(opts: { sessions: Accessor<readonly SessionSummary[] | undefined> }): RowChips {
  return createRowAdditions({ ...opts, extensions: useContext(ExtensionsContext) });
}

/** useRowAdditions with its extension list (and, for tests, its fetch, policy and clock) handed in. */
export function createRowAdditions(opts: {
  sessions: Accessor<readonly SessionSummary[] | undefined>;
  extensions: Accessor<readonly ExtensionInfo[] | undefined>;
  fetch?: Fetch;
  policy?: SlotPolicy;
  clock?: RowClock;
}): RowChips {
  const fetch: Fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const policy = opts.policy ?? rowPolicy;
  const sources = createMemo(() => rowExtensions(opts.extensions()), [], { equals: sameRowExtensions });
  const [bySession, setBySession] = createSignal<ReadonlyMap<string, RowChip[]> | null>(null);
  let lane: ReturnType<typeof createRowAnswers> | null = null;

  const close = () => {
    lane?.stop();
    lane = null;
    if (bySession()) setBySession(null);
  };
  const ask = (soon: boolean) => {
    const list = sources();
    if (!list.length || !opts.sessions()) return close();
    lane ??= createRowAnswers(policy, (m) => setBySession(m.size ? m : null), { clock: opts.clock });
    lane.ask(list.map((ext): RowSource => ({ ext, ask: (signal) => askRow(fetch, ext.id, signal) })), soon);
  };

  // Whether the list is there yet, and which extensions: at once. The list changing: no sooner than
  // ROW_ASK_MIN_MS after the last ask. With no extension that adds to rows neither does anything.
  const hasList = createMemo(() => !!opts.sessions());
  createEffect(on([hasList, sources], () => ask(false)));
  createEffect(on(opts.sessions, () => sources().length > 0 && ask(true), { defer: true }));
  // A switch turned back on asks soon, so its chips come back without waiting for the list.
  const offPolicy = policy.subscribe(() => lane && ask(true));
  onCleanup(() => {
    offPolicy();
    close();
  });

  return (s) => {
    const m = bySession();
    if (!m) return undefined;
    const chips = m.get(s.id);
    // An extension is this host's: a session on another host never shows one.
    return chips && hostOf(s.path) === null ? chips : undefined;
  };
}
