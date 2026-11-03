// `<For>` keyed by a string the caller names rather than by object identity (§app.session-list/content-rules,
// Refreshing). The session list rebuilds every section, project and row as a new object on each refresh, so a plain
// `<For>` over them tore down and rebuilt every node each time: the focused row lost its focus and the list's scroll
// position moved. Keyed by an id, a cwd or a path, each one is built once and its item accessor follows the fresh
// object in place.
//
// Plain TypeScript (no JSX) so a `*.browser.test.ts` can drive it under Solid's reactive build with no DOM.
import { createComponent, createMemo, For, type JSX } from "solid-js";

/** Same keys in the same order: the `<For>` underneath has nothing to do. */
const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

/** The last item is held while a removed key is being disposed, so an accessor read in that gap never sees `undefined`. */
export function ForKey<T>(props: { each: readonly T[]; by: (item: T) => string; children: (item: () => T, index: () => number) => JSX.Element }): JSX.Element {
  const byKey = createMemo(() => new Map(props.each.map((x) => [props.by(x), x] as const)));
  const keys = createMemo(() => props.each.map((x) => props.by(x)), undefined, { equals: sameKeys });
  return createComponent(For, {
    get each() {
      return keys();
    },
    children: (k: string, i: () => number) => {
      let last = byKey().get(k)!;
      return props.children(() => (last = byKey().get(k) ?? last), i);
    },
  });
}
