import { createEffect, createSignal, on, type Accessor } from "solid-js";
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
