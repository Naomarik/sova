// Run: pnpm test -- src/lib/design-history.browser.test.ts (Solid's reactive build, a stand-in history).
// What a chat's Lookbook has open follows the browser's history and address: each open is one step,
// Back and Forward retrace them, closing leaves no step for Back to reopen, and an address names it.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

/** A tab's history: its entries, the one showing, and popstate fired a moment after a traversal, as a browser does. */
const entries: { state: unknown; hash: string }[] = [];
let at = -1;
const listeners = new Set<() => void>();
const g = globalThis as Record<string, unknown>;
const fakeHistory = {
  get state() {
    return entries[at]!.state;
  },
  pushState(state: unknown, _t: string, url: string) {
    entries.splice(at + 1, entries.length, { state: structuredClone(state), hash: url });
    at++;
  },
  replaceState(state: unknown, _t: string, url: string) {
    entries[at] = { state: structuredClone(state), hash: url.startsWith("#") ? url : entries[at]!.hash };
  },
  go(n: number) {
    const to = Math.max(0, Math.min(entries.length - 1, at + n));
    if (to === at) return;
    at = to;
    setTimeout(() => listeners.forEach((f) => f()), 0);
  },
};
g.history = fakeHistory;
g.location = {
  get hash() {
    return entries[at]!.hash;
  },
  get href() {
    return entries[at]!.hash;
  },
};
g.window = { addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) };

const solid = await import("solid-js");
const { designOfHash, hashWithDesign, useDesignOpen } = await import("./design-history");
const { sessionRouteFromHash } = await import("./mesh");

const PATH = "/s/a b.jsonl";
const CHAT = `#/s/${encodeURIComponent(PATH)}`;
const settle = () => new Promise((r) => setTimeout(r, 5));
const back = async () => (fakeHistory.go(-1), settle());
const forward = async () => (fakeHistory.go(1), settle());
const reset = (hash: string, state: unknown = null) => {
  entries.splice(0, entries.length, { state: null, hash: "#/" }, { state, hash });
  at = 1;
};
const shown = (nav: ReturnType<typeof useDesignOpen>) => {
  const t = nav.target();
  return t ? (t.kind === "coordinator" ? "coordinator" : t.label) : null;
};
const mount = () => solid.createRoot((dispose) => ({ nav: useDesignOpen(PATH, null), dispose }));

test("the address names the open design or the coordinator, and still names the same session", () => {
  const a = hashWithDesign(CHAT, { kind: "design", label: "A" });
  assert.equal(a, `${CHAT}?design=A`);
  assert.equal(hashWithDesign(CHAT, { kind: "coordinator" }), `${CHAT}?design=coordinator`);
  assert.deepEqual(designOfHash(a), { kind: "design", label: "A" });
  assert.deepEqual(designOfHash(`${CHAT}?design=coordinator`), { kind: "coordinator" });
  assert.equal(hashWithDesign(a, null), CHAT);
  // A peer's session keeps its host beside the design, and both name the same route.
  const peer = hashWithDesign(`${CHAT}?host=laptop`, { kind: "design", label: "B" });
  assert.equal(peer, `${CHAT}?host=laptop&design=B`);
  assert.deepEqual(sessionRouteFromHash(peer), { host: "laptop", path: PATH });
  assert.deepEqual(sessionRouteFromHash(a), sessionRouteFromHash(CHAT));
  // Not a session's address: left as it is, and a parameter it doesn't know names no session.
  assert.equal(hashWithDesign("#/g/x", { kind: "coordinator" }), "#/g/x");
  assert.equal(sessionRouteFromHash(`${CHAT}?other=1`), null);
  assert.equal(sessionRouteFromHash(`${CHAT}?design=A&design=B`), null);
});

test("coordinator, then a design: Back retraces both, Forward reopens them, the route never changes", async () => {
  reset(CHAT);
  const { nav, dispose } = mount();
  assert.equal(shown(nav), null);
  nav.open({ kind: "coordinator" });
  nav.open({ kind: "design", label: "A" });
  assert.equal(location.hash, `${CHAT}?design=A`);
  assert.equal(entries.length, 4, "one step each");
  await back();
  assert.equal(shown(nav), "coordinator");
  await back();
  assert.equal(shown(nav), null);
  assert.equal(location.hash, CHAT);
  await forward();
  assert.equal(shown(nav), "coordinator");
  await forward();
  assert.equal(shown(nav), "A");
  for (const e of entries.slice(1)) assert.equal(sessionRouteFromHash(e.hash)?.path, PATH);
  dispose();
});

test("closing goes back past every step it opened, so Back afterwards never reopens it", async () => {
  reset(CHAT);
  const { nav, dispose } = mount();
  nav.open({ kind: "coordinator" });
  nav.open({ kind: "design", label: "A" });
  nav.open({ kind: "design", label: "B" });
  nav.close();
  assert.equal(shown(nav), null);
  await settle();
  assert.equal(at, 1);
  assert.equal(location.hash, CHAT);
  await back();
  assert.equal(at, 0);
  assert.equal(shown(nav), null);
  dispose();
});

test("an address arrived at with a view open reopens it; closing it then leaves the chat alone", async () => {
  for (const name of ["A", "coordinator"]) {
    reset(`${CHAT}?design=${name}`);
    const { nav, dispose } = mount();
    assert.equal(shown(nav), name);
    nav.open({ kind: "design", label: "C" });
    nav.close();
    await settle();
    assert.equal(at, 1, "back to the entry it was reloaded on");
    assert.equal(location.hash, CHAT, "which no longer names it");
    assert.equal(shown(nav), null);
    await back();
    await forward();
    assert.equal(shown(nav), null, "Forward to that entry reopens nothing");
    dispose();
  }
});

test("a design the chat no longer has: dropped from the address with no step", () => {
  reset(`${CHAT}?design=Z`);
  const { nav, dispose } = mount();
  nav.drop();
  assert.equal(shown(nav), null);
  assert.equal(entries.length, 2);
  assert.equal(location.hash, CHAT);
  dispose();
});

test("every surface of a chat shares one open view; the first mounted draws it", () => {
  reset(CHAT);
  solid.createRoot((dispose) => {
    const card = useDesignOpen(PATH, null);
    const gallery = useDesignOpen(PATH, null);
    gallery.open({ kind: "coordinator" });
    assert.equal(shown(card), "coordinator");
    assert.equal(card.draws(), true);
    assert.equal(gallery.draws(), false);
    dispose();
  });
});
