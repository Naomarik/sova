// What the browsers of a chat hear about its designs: a page's slices as they are written, and the
// whole view when anything changes. Fan-out only: ws.ts subscribes each open pane to its own chat.
import type { DesignChatView } from "../../shared/design";
import { DESIGN_SAFETY_CHARS } from "../../shared/design";
import type { SovaEvent } from "../../shared/harness";
import { onDesignChanged, viewOf } from "./store";

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
  gen: number;
  text: string;
}
const pages = new Map<string, Buffer>();
const keyOf = (sessionId: string, label: string) => `${sessionId}\0${label}`;

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

/** The page being written, as far as this server has it. */
export function livePage(sessionId: string, label: string): { version: number; at: 0; text: string; chars: number } | null {
  const b = pages.get(keyOf(sessionId, label));
  return b ? { version: b.version, at: 0, text: b.text, chars: b.text.length } : null;
}

/** Apply one slice from a design session. True when this slice began a new page. */
export function applySlice(sessionId: string, label: string, version: number, f: { gen: number; at: number; text: string }): boolean {
  const key = keyOf(sessionId, label);
  let b = pages.get(key);
  let began = false;
  if (!b || b.gen !== f.gen || b.version !== version) {
    // A new page starts at 0; a later slice of one this server never held waits for the resync.
    if (f.at !== 0) return false;
    // Another page: a document already written can't be taken back.
    endFollowers(key);
    b = { version, gen: f.gen, text: "" };
    pages.set(key, b);
    began = true;
  } else if (f.at === 0) {
    b.text = "";
  } else if (f.at !== b.text.length) {
    return false;
  }
  // The guard stops the session at its safety limit; this only keeps a broken one from growing without bound.
  if (b.text.length + f.text.length > 2 * DESIGN_SAFETY_CHARS) return began;
  b.text += f.text;
  for (const follower of followers.get(key) ?? []) {
    // The same page told again from the start: only what this one hasn't had.
    if (b.text.length <= follower.sent) continue;
    follower.text(b.text.slice(follower.sent));
    follower.sent = b.text.length;
  }
  tell({ sessionId, event: { type: "design.live", label, version, at: f.at, text: f.text, chars: b.text.length } });
  return began;
}

export function clearLivePage(sessionId: string, label: string): void {
  const key = keyOf(sessionId, label);
  pages.delete(key);
  endFollowers(key);
}

/** The view as the page reads it, each page in progress at its current length. */
export function designView(sessionId: string): DesignChatView {
  const v = viewOf(sessionId);
  return { ...v, designs: v.designs.map((d) => (d.live ? { ...d, live: { ...d.live, chars: livePage(sessionId, d.label)?.chars ?? d.live.chars } } : d)) };
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
