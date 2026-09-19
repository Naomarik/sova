// App-wide UI signals that don't belong to any one view: toasts, the polite status region,
// $HOME for path display, and per-session composer drafts.

import { createSignal } from "solid-js";

export interface Toast {
  id: number;
  text: string;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastId = 0;

export { toasts };

/** Transient confirmation ("Copied path."). Never the only record of a fact. */
export function toast(text: string) {
  const id = ++toastId;
  setToasts((t) => [...t, { id, text }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3000);
}

const [announcement, setAnnouncement] = createSignal("");
export { announcement };

/** Speaks through the single visually-hidden role=status region. */
export function announce(text: string) {
  // Clear first so repeating the same sentence is still announced.
  setAnnouncement("");
  queueMicrotask(() => setAnnouncement(text));
}

export const [home, setHome] = createSignal<string | null>(null);

/** Composer drafts by session path. Kept in memory so switching sessions never loses one. */
export const drafts = new Map<string, string>();

export async function copyText(text: string, done: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    toast("Couldn't reach the clipboard. Nothing was copied.");
    return false;
  }
}
