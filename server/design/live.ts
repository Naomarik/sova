// What the browsers of a chat hear about its designs: a page's slices as they are written, and the
// whole view when anything changes. Fan-out only: ws.ts subscribes each open pane to its own chat.
import type { DesignChatView } from "../../shared/design";
import { DESIGN_SAFETY_CHARS } from "../../shared/design";
import type { SovaEvent } from "../../shared/harness";
import { tokensOfText } from "../../src/lib/design-frame";
import { FIRST_INPUT_TOKENS, tokenRates } from "./setup";
import { designOf, onDesignChanged, pendingPage, readDesigns, viewOf } from "./store";
import { historyMark } from "./history";

/** How long changes gather before the view goes out. */
const VIEW_EVERY_MS = 250;

export interface DesignNews {
  sessionId: string;
  event: Extract<SovaEvent, { type: "design.live" | "design.state" }>;
}

const listeners = new Set<(n: DesignNews) => void>();
export function onDesignNews(fn: (n: DesignNews) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function tell(n: DesignNews): void {
  for (const fn of listeners) {
    try {
      fn(n);
    } catch (err) {
      console.error("[design] a news listener failed", err);
    }
  }
}

interface Buffer {
  version: number;
  /** The page of the session's process this buffer last heard; -1 for one rebuilt from the saved draft. */
  gen: number;
  text: string;
  /** Where the page being written began in `text`: 0 for a whole page, the draft's length for a part added to its
      end, all of it for one redrawn from the draft. What lies past it is what the session is writing now. */
  base: number;
  /** Names the document on show: a new one (a whole page again, or the draft redrawn after edits) gets a new number,
      and a frame showing another reconnects. Unique across restarts, so a browser's old number never matches. */
  draw: number;
}
const pages = new Map<string, Buffer>();
const keyOf = (sessionId: string, label: string) => `${sessionId}\0${label}`;
let draws = Date.now();
const nextDraw = () => ++draws;

interface Follower {
  sent: number;
  text(text: string): void;
  end(): void;
}
/** Each design's open live documents (server/design/live-route.ts). */
const followers = new Map<string, Set<Follower>>();

function endFollowers(key: string): void {
  const set = followers.get(key);
  followers.delete(key);
  for (const f of set ?? []) f.end();
}

/** A buffer holding the saved draft as it stands, or none when there is no draft. */
function seed(sessionId: string, label: string, version: number, draw?: number): Buffer | undefined {
  const draft = pendingPage(sessionId, label);
  if (!draft) return undefined;
  const b: Buffer = { version, gen: -1, text: draft, base: draft.length, draw: draw ?? nextDraw() };
  pages.set(keyOf(sessionId, label), b);
  return b;
}

/** The buffer of a design whose page is being written, rebuilt from its saved draft when this server holds none (it
    restarted between two steps): the tile goes on showing the draft. */
function bufferOf(sessionId: string, label: string): Buffer | undefined {
  const held = pages.get(keyOf(sessionId, label));
  if (held) return held;
  const live = designOf(sessionId, label)?.live;
  return live ? seed(sessionId, label, live.version, live.draw) : undefined;
}

/** Hear the page this far on: each new stretch of it, then `end` when it is over. The returned function stops it. */
export function followLivePage(sessionId: string, label: string, from: number, on: { text(text: string): void; end(): void }): () => void {
  const key = keyOf(sessionId, label);
  const f: Follower = { sent: from, text: on.text, end: on.end };
  let set = followers.get(key);
  if (!set) followers.set(key, (set = new Set()));
  set.add(f);
  return () => {
    const held = followers.get(key);
    held?.delete(f);
    if (held?.size === 0) followers.delete(key);
  };
}

/** The page being written, as far as this server has it. `written`: the characters the session is writing now (the
    part past the draft it continues). */
export function livePage(sessionId: string, label: string): { version: number; draw: number; at: 0; text: string; chars: number; written: number } | null {
  const b = bufferOf(sessionId, label);
  return b ? { version: b.version, draw: b.draw, at: 0, text: b.text, chars: b.text.length, written: b.text.length - b.base } : null;
}

/** What a slice did: began a new document (`draw` names it), went on with the one on show, or was set aside. */
export type SliceResult = { began: boolean; draw: number } | null;

/** Apply one slice from a design session. `append`: the slice belongs to a part added to the draft's end, so it goes
    on in the document on show (seeded from the saved draft when this server holds none), its `at` counted from where
    that part began. */
export function applySlice(sessionId: string, label: string, version: number, f: { gen: number; at: number; text: string; append?: true }): SliceResult {
  const key = keyOf(sessionId, label);
  let b = pages.get(key);
  let began = false;
  if (b && b.version !== version) b = undefined;
  if (!b || b.gen !== f.gen) {
    // A new page starts at 0; a later slice of one this server never held waits for the resync.
    if (f.at !== 0) return null;
    if (f.append) {
      // A part added to the end: the same document goes on, from the draft as it stands. What is on show but isn't the
      // draft (a call that was turned away streamed it) is drawn again from the draft first.
      const draft = pendingPage(sessionId, label);
      if (!draft) return null;
      if (!b) {
        // This server held none (it restarted): the document the tile already shows, when it is this version's.
        const live = designOf(sessionId, label)?.live;
        b = seed(sessionId, label, version, live?.version === version ? live.draw : undefined);
      } else if (b.text !== draft) {
        endFollowers(key);
        b = seed(sessionId, label, version);
        began = true;
      }
      if (!b) return null;
      b.gen = f.gen;
      b.base = b.text.length;
    } else {
      // Another page: a document already written can't be taken back, so the frame draws a new one.
      endFollowers(key);
      b = { version, gen: f.gen, text: "", base: 0, draw: nextDraw() };
      pages.set(key, b);
      began = true;
    }
  } else if (f.at === 0) {
    // The same page told again from its start.
    b.text = b.text.slice(0, b.base);
  } else if (b.base + f.at !== b.text.length) {
    return null;
  }
  const at = b.base + f.at;
  // The guard stops the session at its safety limit; this only keeps a broken one from growing without bound.
  if (b.text.length + f.text.length > 2 * DESIGN_SAFETY_CHARS) return { began, draw: b.draw };
  b.text += f.text;
  tellFollowers(key, b);
  tell({ sessionId, event: { type: "design.live", label, version, draw: b.draw, at, text: f.text, chars: b.text.length } });
  return { began, draw: b.draw };
}

function tellFollowers(key: string, b: Buffer): void {
  for (const follower of followers.get(key) ?? []) {
    // The same page told again from the start: only what this one hasn't had.
    if (b.text.length <= follower.sent) continue;
    follower.text(b.text.slice(follower.sent));
    follower.sent = b.text.length;
  }
}

/** The draft was saved (a whole page, a part added, or edits): the document on show becomes the draft. Already the same
    (a part streamed onto it): nothing happens. Otherwise it is drawn again from the draft under a new `draw`, which is
    returned; the frame keeps the old picture until the new one has painted. */
export function drawDraftLive(sessionId: string, label: string, version: number, draft: string): number | null {
  const key = keyOf(sessionId, label);
  const b = pages.get(key);
  if (b && b.version === version && b.text === draft) {
    b.base = b.text.length;
    return null;
  }
  endFollowers(key);
  const next: Buffer = { version, gen: -1, text: draft, base: draft.length, draw: nextDraw() };
  pages.set(key, next);
  tell({ sessionId, event: { type: "design.live", label, version, draw: next.draw, at: 0, text: draft, chars: draft.length } });
  return next.draw;
}

export function clearLivePage(sessionId: string, label: string): void {
  const key = keyOf(sessionId, label);
  pages.delete(key);
  endFollowers(key);
}

/** The view as the page reads it, each page in progress at its current length and, where its model has a price,
    what the session has cost so far: the reply in progress (its input, and the page so far at the output price) on top
    of its finished replies. */
export function designView(sessionId: string): DesignChatView {
  const v = viewOf(sessionId);
  return {
    ...v,
    history: historyMark(sessionId),
    designs: v.designs.map((d) => {
      if (!d.live) return d;
      const page = livePage(sessionId, d.label);
      const chars = page?.chars ?? d.live.chars;
      // Only what this reply is writing is output not yet charged: a draft written in earlier steps was.
      const written = page?.written ?? d.live.chars;
      const rate = tokenRates(d.model);
      if (!rate) return { ...d, live: { ...d.live, chars } };
      // The reply being written is charged for its input too: what its session had in context when it began.
      const input = readDesigns(sessionId).internal?.[d.label]?.context ?? FIRST_INPUT_TOKENS;
      return { ...d, live: { ...d.live, chars, estimateUsd: (d.usage?.cost ?? 0) + input * rate.input + tokensOfText(written) * rate.output } };
    }),
  };
}

const due = new Map<string, NodeJS.Timeout>();
onDesignChanged((sessionId) => {
  if (due.has(sessionId)) return;
  const t = setTimeout(() => {
    due.delete(sessionId);
    tell({ sessionId, event: { type: "design.state", state: designView(sessionId) } });
  }, VIEW_EVERY_MS);
  t.unref?.();
  due.set(sessionId, t);
});
