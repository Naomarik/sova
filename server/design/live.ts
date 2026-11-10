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
  tell({ sessionId, event: { type: "design.live", label, version, at: f.at, text: f.text, chars: b.text.length } });
  return began;
}

export const clearLivePage = (sessionId: string, label: string): void => void pages.delete(keyOf(sessionId, label));

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
