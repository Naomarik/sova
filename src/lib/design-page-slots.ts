import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";

/** One loaded page: which version of which design, and its text. */
export interface PageSlot {
  key: string;
  label: string;
  v: number;
  html: string;
}

/**
 * The open view's page, held still: a page loads only when the version on show changes (its label
 * and version, compared by value, so a fresh copy of the same design record loads nothing), and the
 * page already on show stays, untouched, until the new one reports it has drawn. Nothing is ever
 * cleared before its replacement is ready, so the view never goes white and, while the version
 * holds, the frame (and its scroll) is never replaced.
 */
export function createPageSlots(want: Accessor<{ label: string; v: number }>, load: (label: string, v: number) => Promise<string>) {
  const key = createMemo(() => {
    const w = want();
    return `${w.label}:${w.v}`;
  });
  const [slots, setSlots] = createSignal<PageSlot[]>([]);
  const [front, setFront] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  createEffect(
    on(key, (k) => {
      setError("");
      const { label, v } = want();
      if (v <= 0) {
        setSlots([]);
        setFront(null);
        return;
      }
      if (slots().some((s) => s.key === k)) {
        // Already loaded (back to the version on show, or one still drawing): nothing to fetch.
        if (front() === k) setSlots((list) => list.filter((s) => s.key === k));
        return;
      }
      load(label, v)
        .then((html) => {
          if (key() !== k) return;
          setSlots((list) => [...list.filter((s) => s.key === front()), { key: k, label, v, html }]);
        })
        .catch((e) => {
          if (key() === k) setError(e instanceof Error ? e.message : "This page couldn't be loaded.");
        });
    }),
  );
  /** A slot's page reports it has drawn: if it is the version wanted, it comes to the front and the rest go. */
  const drawn = (slot: PageSlot) => {
    if (slot.key !== key()) return;
    setFront(slot.key);
    setSlots((list) => (list.length === 1 && list[0] === slot ? list : list.filter((s) => s === slot)));
  };
  return { slots, front, error, drawn, key };
}
