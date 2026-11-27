import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";

/** How long a dialog's answer buttons do nothing after the request it shows changes (§mesh.lan/proposals). */
export const ANSWER_HOLD_MS = 1000;

/**
 * A hold on a dialog's answers, tied to what it shows, never to the dialog mounting: each time `key()` turns to a new
 * request (its first, or the next one taking the place of one answered, run out or withdrawn), `held()` reads true for
 * `ms`, and `onNew` runs (the dialog moves the keyboard to itself there). So a second click or a key press meant for
 * the previous request, or for whatever was focused before the dialog appeared, can't answer one not yet read.
 * The same key again (a feed frame repeating the list) starts nothing. Call inside a component or root.
 */
export function createAnswerHold(key: Accessor<string | undefined>, opts: { ms?: number; onNew?: (key: string) => void } = {}): Accessor<boolean> {
  const ms = opts.ms ?? ANSWER_HOLD_MS;
  const [held, setHeld] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  createEffect(
    on(key, (k, prev) => {
      if (k === prev) return;
      clear();
      if (k === undefined) return void setHeld(false);
      setHeld(true);
      timer = setTimeout(() => {
        timer = undefined;
        setHeld(false);
      }, ms);
      opts.onNew?.(k);
    }),
  );
  onCleanup(clear);
  return held;
}

/** Whether a click on a dialog's answer button answers: the person's own (`isTrusted`), none in flight, no hold. */
export const answerCounts = (e: { isTrusted: boolean }, state: { busy: boolean; held: boolean }): boolean => e.isTrusted && !state.busy && !state.held;
