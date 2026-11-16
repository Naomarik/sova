// An opened design holds still: its page loads only when the version on show changes, by value, and
// the page on show stays until the new one has drawn. A fresh record for the same design and version
// (every other design's progress replaces the whole view) loads nothing and replaces nothing. The
// last test holds the open view to this helper: keying its load on a raw `on` over the record again
// fails it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createPageSlots } = await import("./design-page-slots");

const tick = () => new Promise((r) => setTimeout(r, 0));
type Rec = { label: string; status: string; chars: number };

function mount(first: { d: Rec; v: number }) {
  const [state, setState] = solid.createSignal(first);
  const loads: string[] = [];
  let fail = false;
  const pages = solid.createRoot((dispose) => {
    // Like PageFrame: props.d is a fresh record on every design event.
    const p = createPageSlots(
      () => ({ label: state().d.label, v: state().v }),
      async (label, v) => {
        loads.push(`${label}:${v}`);
        if (fail) throw new Error("gone");
        return `<p>${label} v${v}</p>`;
      },
    );
    return { ...p, dispose };
  });
  return { pages, setState, loads, failNext: () => (fail = true) };
}

test("a fresh record with the same design and version loads nothing and keeps the same page", async () => {
  const { pages, setState, loads } = mount({ d: { label: "A", status: "ready", chars: 0 }, v: 2 });
  await tick();
  assert.deepEqual(loads, ["A:2"]);
  const shown = pages.slots()[0]!;
  pages.drawn(shown);
  // Another design streams: the whole view is replaced, this record is a new object, a minute of it.
  for (let i = 0; i < 60; i++) setState({ d: { label: "A", status: i % 2 ? "ready" : "fixing", chars: i }, v: 2 });
  await tick();
  assert.deepEqual(loads, ["A:2"], "never loaded again");
  assert.equal(pages.slots().length, 1);
  assert.equal(pages.slots()[0], shown, "the very same page (one frame, its scroll kept)");
  assert.equal(pages.front(), "A:2");
  pages.dispose();
});

test("a new version: the earlier page stays on show until the new one has drawn", async () => {
  const { pages, setState, loads } = mount({ d: { label: "A", status: "ready", chars: 0 }, v: 1 });
  await tick();
  const v1 = pages.slots()[0]!;
  pages.drawn(v1);
  setState({ d: { label: "A", status: "ready", chars: 1 }, v: 2 });
  await tick();
  assert.deepEqual(loads, ["A:1", "A:2"]);
  assert.deepEqual(pages.slots().map((s) => s.key), ["A:1", "A:2"], "both: v1 still drawn beneath");
  assert.equal(pages.front(), "A:1", "v1 still on top until v2 draws");
  const v2 = pages.slots()[1]!;
  pages.drawn(v2);
  assert.equal(pages.front(), "A:2");
  assert.deepEqual(pages.slots(), [v2], "v1 goes once v2 is on show");
  // A late 'drawn' from a page no longer wanted changes nothing.
  pages.drawn(v1);
  assert.equal(pages.front(), "A:2");
  pages.dispose();
});

test("picking back to the version on show fetches nothing; a page that arrives after you moved on is dropped", async () => {
  const { pages, setState, loads } = mount({ d: { label: "A", status: "ready", chars: 0 }, v: 3 });
  await tick();
  pages.drawn(pages.slots()[0]!);
  setState({ d: { label: "A", status: "ready", chars: 0 }, v: 1 });
  setState({ d: { label: "A", status: "ready", chars: 0 }, v: 3 }); // before v1's text came back
  await tick();
  assert.deepEqual(loads, ["A:3", "A:1"]);
  assert.deepEqual(pages.slots().map((s) => s.key), ["A:3"], "v1 arrived too late and was dropped");
  assert.equal(pages.front(), "A:3");
  pages.dispose();
});

test("a page that can't load says so and keeps the earlier page", async () => {
  const { pages, setState, failNext } = mount({ d: { label: "A", status: "ready", chars: 0 }, v: 1 });
  await tick();
  pages.drawn(pages.slots()[0]!);
  failNext();
  setState({ d: { label: "A", status: "ready", chars: 0 }, v: 2 });
  await tick();
  assert.equal(pages.error(), "gone");
  assert.deepEqual(pages.slots().map((s) => s.key), ["A:1"]);
  pages.dispose();
});

test("the open view loads its page through this helper, never a raw `on` over the record", () => {
  const src = readFileSync(new URL("../components/DesignOpen.tsx", import.meta.url), "utf8");
  const frame = src.slice(src.indexOf("function PageFrame"), src.indexOf("function ChatPane"));
  assert.ok(frame.includes("createPageSlots("), "PageFrame keys its page on createPageSlots");
  assert.ok(!/on\(\s*\(\)\s*=>\s*\[?\s*props\.d\b/.test(frame), "no effect keyed on the record itself");
  assert.ok(!/setHtml\(null\)/.test(frame), "nothing clears the page before its replacement draws");
});
