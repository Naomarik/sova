/**
 * What an extension adds under a reply (§app.commands/reply-slot): its answer validated into data
 * Sova draws itself (chips) and at most one walled-off frame, each extension's answer awaited on its
 * own with a time limit, the user's off switch and Sova's auto-mute. DOM- and Solid-free: the
 * component (src/components/ReplySlot.tsx) only draws what this returns.
 *
 * The page asks only the extensions whose offers (GET /api/extensions, shared/extension-offers.ts)
 * name the `reply` place, once per extension for a whole session, and the answer is keyed by entry
 * (createReplyAnswers below; src/lib/reply-place.ts wires it to a view).
 */
import type { IconName } from "../components/ui";
import { ACTION_LABEL, type MessageActionKind } from "./message-actions";

export const CHIP_LABEL_MAX = 24;
export const CHIP_CONFIRM_MAX = 120;
export const CHIPS_PER_EXTENSION = 3;
export const CHIPS_PER_REPLY = 6;
export const CONTENT_MAX_BYTES = 64 * 1024;
export const CONTENT_HEIGHT_MIN = 32;
export const CONTENT_HEIGHT_MAX = 320;
export const SLOT_TIMEOUT_MS = 2000;
/** Answers dropped in a row before an extension is muted until the page reloads. */
export const MUTE_AFTER = 3;

export const CHIP_TONES = ["ok", "warn", "error", "info", "muted"] as const;
export type ChipTone = (typeof CHIP_TONES)[number];

/** The icons a chip may name: Sova's own, and none that stands for one of its message actions. */
export const CHIP_ICONS = [
  "alert-circle", "archive", "arrow-right", "bell", "bulb", "check", "clock", "code", "external", "eye", "file", "folder",
  "gauge", "info", "network", "search", "settings", "shield", "sliders", "star", "terminal", "wrench", "activity",
] as const satisfies readonly IconName[];

/** The extension as the slot knows it: its id and title, and the actions its manifest declares. */
export interface SlotExtension {
  id: string;
  title: string;
  actions: readonly string[];
}

export interface ReplyChip {
  extension: string;
  extensionTitle: string;
  label: string;
  tone: ChipTone;
  icon?: (typeof CHIP_ICONS)[number];
  href?: string;
  action?: string;
  confirm?: string;
}

export interface ReplyContent {
  extension: string;
  extensionTitle: string;
  html: string;
  height: number;
}

/** Letters, digits, spaces and plain punctuation: never `<`, `>`, quotes, `&`, backticks or controls. */
const PLAIN = /^[\p{L}\p{N} .,:;!?()/+#%_-]+$/u;
const plainText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && PLAIN.test(v);

/** Sova's own message actions, by kind and by label: a chip may not take one of their names. */
const SOVA_NAMES = new Set<string>([
  ...(Object.keys(ACTION_LABEL) as MessageActionKind[]),
  ...Object.values(ACTION_LABEL),
].map((s) => s.toLowerCase()));

function httpHref(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** One chip, or null (dropped alone). */
export function validChip(raw: unknown, ext: SlotExtension): ReplyChip | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!plainText(r.label, CHIP_LABEL_MAX) || SOVA_NAMES.has(r.label.toLowerCase())) return null;
  if (!(CHIP_TONES as readonly unknown[]).includes(r.tone)) return null;
  if (r.icon !== undefined && !(CHIP_ICONS as readonly unknown[]).includes(r.icon)) return null;
  const chip: ReplyChip = { extension: ext.id, extensionTitle: ext.title, label: r.label, tone: r.tone as ChipTone };
  if (r.icon !== undefined) chip.icon = r.icon as ReplyChip["icon"];
  // Exactly one of a link or one of the extension's own declared actions.
  if ((r.href === undefined) === (r.action === undefined)) return null;
  if (r.href !== undefined) {
    const href = httpHref(r.href);
    if (!href) return null;
    chip.href = href;
  } else {
    if (typeof r.action !== "string" || !ext.actions.includes(r.action)) return null;
    chip.action = r.action;
  }
  if (r.confirm !== undefined) {
    if (!plainText(r.confirm, CHIP_CONFIRM_MAX)) return null;
    chip.confirm = r.confirm;
  }
  return chip;
}

/** The walled-off content, or null (dropped). */
export function validContent(raw: unknown, ext: SlotExtension): ReplyContent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.html !== "string" || !r.html || new TextEncoder().encode(r.html).length > CONTENT_MAX_BYTES) return null;
  if (typeof r.height !== "number" || !Number.isFinite(r.height)) return null;
  const height = Math.max(CONTENT_HEIGHT_MIN, Math.min(CONTENT_HEIGHT_MAX, Math.round(r.height)));
  return { extension: ext.id, extensionTitle: ext.title, html: r.html, height };
}

/** One extension's answer → what of it may be drawn, and whether it was bad (malformed, or any part dropped). */
export function validateAnswer(raw: unknown, ext: SlotExtension): { chips: ReplyChip[]; content: ReplyContent | null; bad: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { chips: [], content: null, bad: true };
  const r = raw as Record<string, unknown>;
  let bad = false;
  const chips: ReplyChip[] = [];
  if (r.chips !== undefined) {
    if (!Array.isArray(r.chips)) bad = true;
    else
      for (const c of r.chips) {
        const chip = validChip(c, ext);
        if (!chip) bad = true;
        else if (chips.length < CHIPS_PER_EXTENSION) chips.push(chip);
        else bad = true;
      }
  }
  let content: ReplyContent | null = null;
  if (r.content !== undefined) {
    content = validContent(r.content, ext);
    if (!content) bad = true;
  }
  return { chips, content, bad };
}

// ---- the frame's wall ---------------------------------------------------------------------------

/**
 * The frame's CSP: nothing over the network, no script, inline style and data:/blob: media only.
 * It is set twice: as a meta tag first in the document, and as the iframe's `csp` attribute (CSP
 * Embedded Enforcement, Chromium), which also binds any document the frame navigates to.
 */
export const WALLED_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/**
 * The walled-off frame's attributes. NO scripts (`sandbox=""`): with scripts a frame can navigate
 * itself (`location.href = …`), and the request, with whatever it carries in its URL, leaves before
 * any event the page could act on; the meta CSP goes with the replaced document. Without scripts:
 * no meta refresh (the sandbox's automatic-features flag), no forms, no popups, no top navigation,
 * an opaque origin (no allow-same-origin) with no cookies, storage, or reach into the page. What is
 * left is a person following a link inside it, which the parent closes off: the frame takes no
 * pointer (`pointer-events: none`) and no keyboard focus (`tabindex=-1`). It is a picture.
 */
export const WALLED_FRAME_ATTRS = {
  sandbox: "",
  referrerpolicy: "no-referrer",
  csp: WALLED_CSP,
  tabindex: -1,
  style: { "pointer-events": "none" },
} as const;

/** The frame's document: the CSP first, so it stands before any of the extension's markup is parsed. */
export const walledSrcdoc = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${WALLED_CSP}"><meta http-equiv="x-dns-prefetch-control" content="off"></head><body>${html}</body></html>`;

/**
 * The frame's `load` handler. The first load is its own document; any load after it is the frame
 * having navigated somewhere, which the wall above should make impossible: a breach. On a breach it
 * calls `blank` (the owner removes the frame) and mutes the extension at once.
 */
export function frameLoadGuard(extension: string, policy: SlotPolicy, blank: () => void): () => void {
  let loads = 0;
  let breached = false;
  return () => {
    loads++;
    if (loads === 1 || breached) return;
    breached = true;
    blank();
    policy.breach(extension);
  };
}

// ---- the user's switch and Sova's mute ----------------------------------------------------------

export const OFF_KEY = "sova.reply-slot.off";

/** What the slot reads and writes of the page's storage (localStorage in the app, a map in tests). */
export interface SlotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The off switch (kept in storage under `offKey`) and the auto-mute (this page's life only). Each
    place keeps its own: the reply place under OFF_KEY, the row place under its own key. */
export function createSlotPolicy(storage: SlotStorage | null, offKey: string = OFF_KEY) {
  const misses = new Map<string, number>();
  /** Extensions whose frame navigated: muted for good (this page), whatever they answer after. */
  const breached = new Set<string>();
  /** Told whenever what isOff or isMuted answers may have changed. */
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of [...listeners]) fn();
  };
  const readOff = (): string[] => {
    try {
      const v = JSON.parse(storage?.getItem(offKey) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    /** The user turned this extension's additions off. */
    isOff: (id: string): boolean => readOff().includes(id),
    setOff(id: string, off: boolean): void {
      const now = new Set(readOff());
      if (off) now.add(id);
      else now.delete(id);
      try {
        storage?.setItem(offKey, JSON.stringify([...now]));
      } catch {
        // storage full or denied: the switch holds for this page only
      }
      changed();
    },
    /** Sova muted it: its last MUTE_AFTER answers were all dropped. */
    isMuted: (id: string): boolean => breached.has(id) || (misses.get(id) ?? 0) >= MUTE_AFTER,
    /** A frame of its navigated (frameLoadGuard): muted at once, until the page reloads. */
    breach(id: string): void {
      if (breached.has(id)) return;
      breached.add(id);
      changed();
    },
    note(id: string, ok: boolean): void {
      const before = (misses.get(id) ?? 0) >= MUTE_AFTER;
      misses.set(id, ok ? 0 : (misses.get(id) ?? 0) + 1);
      if (before !== (misses.get(id)! >= MUTE_AFTER)) changed();
    },
    /** Call `fn` whenever the switch or a mute changes; returns the unsubscribe. */
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
export type SlotPolicy = ReturnType<typeof createSlotPolicy>;

// ---- asking the extensions ----------------------------------------------------------------------

export interface SlotSource {
  ext: SlotExtension;
  /** The extension's answer for this reply (in the app, through its proxied backend). */
  ask(signal: AbortSignal): Promise<unknown>;
}

export interface SlotState {
  chips: ReplyChip[];
  contents: ReplyContent[];
}

/**
 * Ask every source not off and not muted, each on its own with `timeoutMs`; call `update` with what
 * may be drawn so far each time one answers. Returns at once, having drawn nothing: the reply never
 * waits. A late, malformed or throwing answer is dropped whole and counted against its extension.
 * The returned function stops it (an answer after that is ignored).
 */
export function startReplySlot(sources: readonly SlotSource[], policy: SlotPolicy, update: (s: SlotState) => void, timeoutMs = SLOT_TIMEOUT_MS): () => void {
  let stopped = false;
  const got = new Map<string, { chips: ReplyChip[]; content: ReplyContent | null }>();
  const order = sources.map((s) => s.ext.id);
  const emit = () => {
    const chips: ReplyChip[] = [];
    const contents: ReplyContent[] = [];
    for (const id of order) {
      const g = got.get(id);
      if (!g) continue;
      for (const c of g.chips) if (chips.length < CHIPS_PER_REPLY) chips.push(c);
      if (g.content) contents.push(g.content);
    }
    update({ chips, contents });
  };
  const controllers: AbortController[] = [];
  for (const src of sources) {
    const id = src.ext.id;
    if (policy.isOff(id) || policy.isMuted(id)) continue;
    const ac = new AbortController();
    controllers.push(ac);
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let answer: Promise<unknown>;
    try {
      answer = Promise.resolve(src.ask(ac.signal));
    } catch (err) {
      answer = Promise.reject(err);
    }
    const timeout = new Promise<never>((_, fail) => ac.signal.addEventListener("abort", () => fail(new Error("timeout")), { once: true }));
    Promise.race([answer, timeout]).then(
      (raw) => {
        clearTimeout(timer);
        if (stopped) return;
        const v = validateAnswer(raw, src.ext);
        policy.note(id, !v.bad);
        got.set(id, { chips: v.chips, content: v.content });
        emit();
      },
      () => {
        clearTimeout(timer);
        if (stopped) return;
        policy.note(id, false);
      },
    );
  }
  return () => {
    stopped = true;
    for (const ac of controllers) ac.abort();
  };
}

// ---- the reply place: one answer per extension for a whole session ------------------------------

/** An answer's size limit, read as it arrives: past it the answer is dropped whole. */
export const ANSWER_MAX_BYTES = 1024 * 1024;
/** Entries read from one answer; the rest make it bad. */
export const ANSWER_ENTRIES_MAX = 2000;
/** An entry id as the transcript has it (the part before a block's `:<n>`). */
const ENTRY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** What one extension adds under one entry. */
export interface EntryAdditions {
  chips: ReplyChip[];
  content: ReplyContent | null;
}

/**
 * One extension's answer for a session, `{"entries": {"<entry id>": {chips?, content?}}}`, into what
 * of it may be drawn per entry, and whether any of it was bad. Each entry is validated on its own
 * (validateAnswer), so one bad entry loses only its own parts.
 */
export function validateSessionAnswer(raw: unknown, ext: SlotExtension): { entries: Map<string, EntryAdditions>; bad: boolean } {
  const entries = new Map<string, EntryAdditions>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { entries, bad: true };
  const all = (raw as Record<string, unknown>).entries;
  if (typeof all !== "object" || all === null || Array.isArray(all)) return { entries, bad: true };
  const keys = Object.keys(all);
  let bad = keys.length > ANSWER_ENTRIES_MAX;
  for (const key of keys.slice(0, ANSWER_ENTRIES_MAX)) {
    if (!ENTRY_ID_RE.test(key)) {
      bad = true;
      continue;
    }
    const v = validateAnswer((all as Record<string, unknown>)[key], ext);
    if (v.bad) bad = true;
    if (v.chips.length || v.content) entries.set(key, { chips: v.chips, content: v.content });
  }
  return { entries, bad };
}

/**
 * Read a response body as JSON, giving up (a throw) once it passes `max` bytes: an extension can't
 * make the page hold more than that of its answer.
 */
export async function readCappedJson(res: Response, max = ANSWER_MAX_BYTES): Promise<unknown> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) {
    await res.body?.cancel();
    throw new Error("too large");
  }
  const reader = res.body?.getReader();
  if (!reader) return JSON.parse(await res.text());
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("too large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}

/**
 * The reply place's extension lane for one session: `ask` asks every source not off and not muted,
 * once each, with `timeoutMs` each; `update` gets what may be drawn, per entry, whenever an answer
 * lands or a switch or mute changes it. Nothing is drawn before an answer, so a reply never waits.
 *
 * An answer replaces that extension's last one; one that is late, malformed, too large or throws is
 * dropped whole, counted against its extension, and its last good answer stays. A new `ask` while
 * one is out supersedes it, uncounted. An extension that is off or muted draws nothing, earlier
 * answers included. Under one entry: extensions in `sources` order, at most CHIPS_PER_REPLY chips.
 */
export function createReplyAnswers(policy: SlotPolicy, update: (byEntry: ReadonlyMap<string, SlotState>) => void, timeoutMs = SLOT_TIMEOUT_MS) {
  const got = new Map<string, Map<string, EntryAdditions>>();
  const out = new Map<string, AbortController>();
  let order: string[] = [];
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    const byEntry = new Map<string, SlotState>();
    for (const id of order) {
      if (policy.isOff(id) || policy.isMuted(id)) continue;
      for (const [entry, add] of got.get(id) ?? []) {
        let s = byEntry.get(entry);
        if (!s) byEntry.set(entry, (s = { chips: [], contents: [] }));
        for (const c of add.chips) if (s.chips.length < CHIPS_PER_REPLY) s.chips.push(c);
        if (add.content) s.contents.push(add.content);
      }
    }
    update(byEntry);
  };
  const unsubscribe = policy.subscribe(draw);

  return {
    ask(sources: readonly SlotSource[]): void {
      if (stopped) return;
      order = sources.map((s) => s.ext.id);
      let forgot = false;
      for (const id of [...got.keys()])
        if (!order.includes(id)) {
          got.delete(id);
          forgot = true;
        }
      for (const id of [...out.keys()])
        if (!order.includes(id)) {
          out.get(id)!.abort();
          out.delete(id);
        }
      if (forgot) draw();
      for (const src of sources) {
        const id = src.ext.id;
        if (policy.isOff(id) || policy.isMuted(id)) continue;
        out.get(id)?.abort();
        const ac = new AbortController();
        out.set(id, ac);
        const timer = setTimeout(() => ac.abort(), timeoutMs);
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
            clearTimeout(timer);
            if (!current()) return;
            out.delete(id);
            const v = validateSessionAnswer(raw, src.ext);
            got.set(id, v.entries);
            policy.note(id, !v.bad);
            draw();
          },
          () => {
            clearTimeout(timer);
            if (!current()) return;
            out.delete(id);
            policy.note(id, false);
          },
        );
      }
    },
    stop(): void {
      stopped = true;
      unsubscribe();
      for (const ac of out.values()) ac.abort();
      out.clear();
    },
  };
}
