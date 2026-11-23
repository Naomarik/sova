import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { PairView } from "../../shared/protocol";

/**
 * A chat's pairings, read for its Paired with lines (§app.overseer/pairs "What the user sees"). A read
 * that fails keeps the lines this chat had, but they never outlive the chat: when `id` changes they
 * go at once (a reused view must not show the last chat's under this one), and an answer for the
 * chat it has left is dropped. `onChange`: the id moved (what else belonged to the last chat).
 */
export function pairLinesOf(id: Accessor<string | undefined>, read: (sessionId: string) => Promise<PairView[]>, onChange?: () => void) {
  const [pairs, setPairs] = createSignal<PairView[]>([]);
  let gen = 0;
  const load = async (): Promise<void> => {
    const sid = id();
    const mine = ++gen;
    if (!sid) return void setPairs([]);
    try {
      const got = await read(sid);
      if (mine === gen) setPairs(got);
    } catch {
      // An older server has no pairings, and a read that fails keeps the lines it had.
    }
  };
  createEffect(
    on(id, () => {
      setPairs([]);
      onChange?.();
      void load();
    }),
  );
  return { pairs, load };
}

/** From this many pairings a chat's lines fold into one: past 2 stacked banners, none get read. */
export const FOLD_AT = 3;

/** How the lines draw: each as it is, folded into one line, or that line with the lines opened under it. */
export type PairFold = "plain" | "folded" | "open";

export function pairFold(count: number, open: boolean): PairFold {
  return count < FOLD_AT ? "plain" : open ? "open" : "folded";
}

/**
 * The fold over a chat's pairings (§app.overseer/pairs "What the user sees"): Show All / Hide lasts
 * while the chat stays; moving to another chat, or falling under FOLD_AT, shuts it, so the next fold
 * starts folded. Nothing is stored.
 */
export function pairFoldOf(id: Accessor<string | undefined>, pairs: Accessor<readonly PairView[]>) {
  const [open, setOpen] = createSignal(false);
  const count = () => pairs().length;
  createEffect(on(id, () => setOpen(false), { defer: true }));
  createEffect(on(() => count() >= FOLD_AT, (folds) => !folds && setOpen(false), { defer: true }));
  const paused = createMemo(() => pairs().filter((p) => p.a.paused || p.b.paused).length);
  return {
    state: () => pairFold(count(), open()),
    count,
    paused,
    /** The folded line's tone: a pause never hides in the fold. */
    tone: (): "info" | "warn" => (paused() > 0 ? "warn" : "info"),
    /** Show All / Hide: only while the lines fold. */
    toggle: () => count() >= FOLD_AT && setOpen((v) => !v),
  };
}
