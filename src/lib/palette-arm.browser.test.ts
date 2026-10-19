// Run: pnpm test -- src/lib/palette-arm.browser.test.ts (Solid's reactive build).
// A command panel's two-step button (§app.command-palette/command-panel): the arming holds the
// session it stood over; the open session changing disarms it, so a second press after navigating
// never runs on the session the user moved to.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const { createRoot, createSignal } = await import("solid-js");
const { createPanelArm } = await import("./palette-arm");
type Session = import("./palette").PaletteContext["session"];

const A: Session = { path: "/sessions/a.jsonl", id: "a", title: "Chat A", terminal: false };
const B: Session = { path: "/sessions/b.jsonl", id: "b", title: "Chat B", terminal: false };
const tick = () => new Promise((r) => setTimeout(r, 0));

function panel(changes = true) {
  const [session, setSession] = createSignal<Session>(A);
  const runs: Session[] = [];
  let dispose = () => {};
  const button = createRoot((d) => {
    dispose = d;
    return createPanelArm({ changes, session, run: (s) => runs.push(s) });
  });
  return { button, setSession, runs, dispose };
}

test("armed on chat A, the open session becoming chat B disarms it: the next press arms again and nothing runs", async () => {
  const p = panel();
  await tick();
  assert.equal(p.button.press(), "armed");
  p.setSession(B);
  await tick();
  assert.equal(p.button.armed(), false);
  assert.equal(p.button.press(), "armed");
  assert.deepEqual(p.runs, []);
  assert.equal(p.button.press(), "ran");
  assert.deepEqual(p.runs, [B]);
  p.dispose();
});

test("armed on chat A, the second press runs on chat A: the session the arming held", async () => {
  const p = panel();
  await tick();
  p.button.press();
  p.setSession({ ...A, title: "Chat A, renamed" }); // the same session redrawn: still armed
  await tick();
  assert.equal(p.button.armed(), true);
  assert.equal(p.button.press(), "ran");
  assert.deepEqual(p.runs, [A]);
  p.dispose();
});

test("a command that only looks runs on the first press, on the open session", async () => {
  const p = panel(false);
  await tick();
  assert.equal(p.button.press(), "ran");
  assert.deepEqual(p.runs, [A]);
  p.dispose();
});
