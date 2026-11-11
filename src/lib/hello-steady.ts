import { createEffect, createMemo, on } from "solid-js";

/**
 * A new chat's screen holds still through a hello. A decision on the folder's list rebuilds the
 * chat, and its socket says hello again: what the screen shows must not blink out and back, nor the
 * view move, or the reader is thrown to the top of the page.
 */

/**
 * The chat's profile as shown, kept through a hello until the messages after it settle it: its
 * "profile" message (`said`), else the "claude_login" that comes after the profile's place in every
 * hello's train (`settled`), else `ms` passing. Cleared at the hello, the picker unmounted and the
 * setup card's decisions shut for a moment, and the page lost its height.
 */
export function createProfileHold<T>(set: (info: T | null) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const said = (info: T | null) => {
    clearTimeout(timer);
    timer = undefined;
    set(info);
  };
  return {
    /** A hello: what is shown stays until it is settled. */
    hello() {
      clearTimeout(timer);
      timer = setTimeout(() => said(null), ms);
    },
    said,
    /** The message after the profile's place: none said by now means none. */
    settled() {
      if (timer !== undefined) said(null);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Runs `fn` when `empty` turns to a new VALUE (and once at the start). `on(() => !!props.empty, …)`
 * re-fires whenever a signal the prop reads changes, and every hello changes those: the effect sent a
 * new chat's reader back to the top at each rebuild. The memo gates on the value.
 */
export function onEmptyChange(empty: () => boolean, fn: (now: boolean, was: boolean | undefined) => void): void {
  const value = createMemo(() => !!empty());
  createEffect(on(value, fn));
}
