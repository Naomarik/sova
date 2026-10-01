// Letting go of a closed view that an event or a text control would keep alive.
//
// Two holds, found with heap snapshots after a session switch (scripts/perf-load, the switch
// check), each enough to keep a closed chat's whole transcript alive:
//   - Chrome 154: Solid's delegated-event getter, cached in the event class's shared map —
//       FocusEvent (internal cache) → Map → DescriptorArray → AccessorPair → getter `get` (Solid)
//       → FocusEvent → blink::EventPath → <div class="composer-row"> → … → div.transcript-wrap.
//     `guardDelegatedEvents` keeps that getter out of the shared map.
//   - Chromium 148: a native handle on the last focused text control —
//       C++ Persistent roots → <textarea class="composer-input"> → $$keydown → … → div.transcript-wrap.
//     `releaseControl` makes the closing textarea a dead end: out of its parent, with no handler on
//     it. Handlers Solid adds with addEventListener (focus, blur, paste) can't be taken off
//     afterwards, so such a control uses delegated ones (`onFocusIn`/`onFocusOut`), or listens with
//     a signal its closing aborts.

import { DelegatedEvents } from "solid-js/web";

/** The slice of an element this needs, so a test can hand in a plain object. */
export interface Releasable {
  remove(): void;
}

/** Take a closing control out of its parent and drop every handler Solid's delegation stored on it
    (its `$$<event>` and `$$<event>Data` properties). Safe on one already detached. */
export function releaseControl(el: Releasable | undefined): void {
  if (!el) return;
  el.remove();
  const own = el as unknown as Record<string, unknown>;
  for (const key of Object.keys(own)) if (key.startsWith("$$")) delete own[key];
}

/** The slice of a window this needs. */
export interface EventScope {
  addEventListener(type: string, listener: (e: Event) => void, options: { capture: true; passive: true }): void;
}

/**
 * Keep Solid's per-event `currentTarget` getter out of the event classes' shared maps.
 *
 * Solid defines `currentTarget` on every delegated event with a getter that closes over the event,
 * and V8 keeps the accessor that first adds the property to a class's map for the life of the page
 * (the Chrome 154 hold above). A capturing listener on the window runs before Solid's on the
 * document and defines it first, with the browser's own getter: it closes over nothing and answers
 * what the native property does. Solid's redefinition then stays on the one event. Call once,
 * before `render`.
 */
export function guardDelegatedEvents(
  scope: EventScope,
  nativeGetter: (this: Event) => unknown,
  types: Iterable<string> = DelegatedEvents,
): void {
  const define = (e: Event) => {
    Object.defineProperty(e, "currentTarget", { configurable: true, get: nativeGetter });
  };
  for (const type of types) scope.addEventListener(type, define, { capture: true, passive: true });
}
