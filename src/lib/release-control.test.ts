import assert from "node:assert/strict";
import { test } from "node:test";
import { DelegatedEvents } from "solid-js/web";
import { guardDelegatedEvents, releaseControl } from "./release-control";

/** A field as Solid leaves it: in a parent, with delegated handlers and their data on it. */
function field() {
  const parent = { children: [] as unknown[] };
  const el: Record<string, unknown> & { remove(): void } = {
    id: "composer-input",
    $$keydown: () => {},
    $$input: () => {},
    $$click: () => {},
    $$clickData: { some: "data" },
    $$focusout: () => {},
    remove() {
      parent.children = parent.children.filter((c) => c !== el);
    },
  };
  parent.children.push(el);
  return { el, parent };
}

test("a released field leaves its parent and keeps no handler, so whatever still holds it reaches nothing else", () => {
  const { el, parent } = field();
  releaseControl(el);
  assert.deepEqual(parent.children, []);
  assert.deepEqual(
    Object.keys(el).filter((k) => k.startsWith("$$")),
    [],
  );
  assert.equal(el.id, "composer-input", "its own non-handler properties stay");
});

test("releasing twice, or nothing at all, is safe", () => {
  const { el } = field();
  releaseControl(el);
  releaseControl(el);
  releaseControl(undefined);
  assert.equal(Object.keys(el).some((k) => k.startsWith("$$")), false);
});

test("the guard listens, capturing and passive, to exactly the event types Solid delegates", () => {
  const seen: { type: string; options: unknown }[] = [];
  guardDelegatedEvents({ addEventListener: (type, _l, options) => seen.push({ type, options }) }, function () {
    return null;
  });
  assert.deepEqual(seen.map((s) => s.type).sort(), [...DelegatedEvents].sort());
  assert.ok(seen.every((s) => JSON.stringify(s.options) === JSON.stringify({ capture: true, passive: true })));
});

test("the guard defines currentTarget with the native getter itself, and leaves it redefinable for Solid", () => {
  let listener: ((e: Event) => void) | undefined;
  function nativeGetter(this: Event) {
    return "native";
  }
  guardDelegatedEvents({ addEventListener: (_t, l) => (listener = l) }, nativeGetter, ["click"]);
  const e = {} as Event;
  listener!(e);
  const d = Object.getOwnPropertyDescriptor(e, "currentTarget")!;
  assert.equal(d.get, nativeGetter, "the getter is the browser's own, closing over nothing");
  assert.equal(d.configurable, true);
  Object.defineProperty(e, "currentTarget", { configurable: true, get: () => "solid" });
  assert.equal((e as unknown as { currentTarget: string }).currentTarget, "solid");
});
