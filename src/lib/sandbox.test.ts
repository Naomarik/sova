// Run: npx tsx --test src/lib/sandbox.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxInfo } from "../../shared/protocol";
import { SANDBOX_ROWS, sandboxBadge, sandboxOffMissing, sandboxStateOf } from "./sandbox";

const info = (on: boolean, enforcement: SandboxInfo["enforcement"], status = "s", state?: SandboxInfo["state"]): SandboxInfo => ({ on, enforcement, status, ...(state ? { state } : {}) });

test("the shield hides only when the extension never reported", () => {
  assert.equal(sandboxBadge(null), null);
});

test("every state has its own glyph, so it never rests on hue", () => {
  const off = sandboxBadge(info(false, "none", "Sandbox off · x", "off"))!;
  const sub = sandboxBadge(info(false, "none", "Sandbox subagents only · x", "subagents"))!;
  const on = sandboxBadge(info(true, "full", "Sandbox on · x", "on"))!;
  assert.equal(new Set([off.icon, sub.icon, on.icon]).size, 3);
  assert.deepEqual([off.icon, sub.icon, on.icon], ["shield-off", "shield-partial", "shield-on"]);
  // Off is the faint ghost; the default and full On are calm ink. None of the three needs a word.
  assert.equal(off.tone, "off");
  assert.equal(sub.tone, "ok");
  assert.equal(on.tone, "ok");
  for (const b of [off, sub, on]) assert.equal(b.word, null);
  // The accessible name is the extension's own line.
  assert.equal(off.label, "Sandbox off · x");
});

test("a server without the three states: on false reads as Subagents only, never Off", () => {
  assert.equal(sandboxStateOf(info(false, "none")), "subagents");
  assert.equal(sandboxStateOf(info(true, "full")), "on");
  assert.equal(sandboxBadge(info(false, "none"))!.icon, "shield-partial");
});

test("every On short of full carries a word and a tone that is not ok", () => {
  const seen = new Set<string>();
  for (const e of ["partial", "unavailable", "none"] as const) {
    const b = sandboxBadge(info(true, e, "s", "on"))!;
    assert.equal(b.icon, "shield-on", e);
    assert.notEqual(b.tone, "ok", e);
    assert.ok(b.word, e);
    seen.add(`${b.tone}/${b.word}`);
  }
  assert.equal(seen.size, 3, "partial, unavailable and not-enforced read differently");
  assert.notEqual(sandboxBadge(info(true, "partial", "s", "on"))!.tone, sandboxBadge(info(true, "unavailable", "s", "on"))!.tone);
});

test("the group's rows: Off, Subagents only, On, each saying what it confines and from when", () => {
  assert.deepEqual(SANDBOX_ROWS.map((r) => [r.state, r.label]), [["off", "Off"], ["subagents", "Subagents only"], ["on", "On"]]);
  for (const r of SANDBOX_ROWS) {
    assert.ok(r.title.startsWith(`${r.label}: `), r.state);
    assert.match(r.title, /next tool call, and to subagents started or resumed from now\.$/, r.state);
  }
  assert.equal(new Set(SANDBOX_ROWS.map((r) => r.title)).size, 3);
});

test("Off asked of an older host (no state in its answer) toasts that it has none", () => {
  assert.equal(sandboxOffMissing("off", info(false, "none", "Sandbox off")), "This host's Sova has no Off; its sandbox stays Sandbox off.");
  assert.equal(sandboxOffMissing("off", info(false, "none", "s", "off")), null);
  assert.equal(sandboxOffMissing("subagents", info(false, "none", "s")), null);
});
