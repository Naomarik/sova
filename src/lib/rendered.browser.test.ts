// Run: pnpm test -- src/lib/rendered.browser.test.ts (Solid's reactive build).
// §app.overseer/pairs: a chat with no pairing shows no strip above its transcript. These resolve the
// real control flow through `children`, since what Show and For give back is the thing being gated.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSX } from "solid-js";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { rendersSomething } = await import("./rendered");

const { For, children, createComponent, createRoot, createSignal } = solid;
// The overload without `keyed`, which createComponent's inference can't pick.
const Show = solid.Show as (props: { when: unknown; children: JSX.Element }) => JSX.Element;

test("the Paired with lines' shape: a Show holding a For draws nothing with no items, something with one", () => {
  createRoot((dispose) => {
    const [items, setItems] = createSignal<string[]>([]);
    const [on, setOn] = createSignal(true);
    const resolved = children(() =>
      createComponent(Show, {
        get when() {
          return on();
        },
        get children() {
          return createComponent(For, {
            get each() {
              return items();
            },
            children: (x: string) => x,
          });
        },
      }),
    );
    assert.deepEqual(resolved(), [], "the array a bare truthiness check takes for content");
    assert.equal(rendersSomething(resolved()), false);
    setItems(["line"]);
    assert.equal(rendersSomething(resolved()), true);
    setItems([]);
    assert.equal(rendersSomething(resolved()), false, "the last line going takes the strip with it");
    setItems(["line"]);
    setOn(false);
    assert.equal(rendersSomething(resolved()), false, "an archived pane or the Overseer: the Show is off");
    dispose();
  });
});

test("no header at all, and nests of nothing, draw nothing; any one real child draws", () => {
  for (const nothing of [undefined, null, false, true, "", [], [[]], [null, [undefined, false]]]) assert.equal(rendersSomething(nothing), false, JSON.stringify(nothing));
  for (const something of ["text", 0, {}, [null, ["text"]], [[{}]]]) assert.equal(rendersSomething(something), true, JSON.stringify(something));
});
