// Run: npx tsx --test src/lib/sandbox.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SandboxInfo } from "../../shared/protocol";
import { sandboxBadge, sandboxRowTitle } from "./sandbox";

const info = (on: boolean, enforcement: SandboxInfo["enforcement"], status = "s"): SandboxInfo => ({ on, enforcement, status });

test("the shield hides when off and when the extension never reported", () => {
  assert.equal(sandboxBadge(null), null);
  assert.equal(sandboxBadge(info(false, "none")), null);
});

test("full enforcement is the calm shield with no word; the tooltip is the extension's line", () => {
  assert.deepEqual(sandboxBadge(info(true, "full", "Sandbox on · workspace-write · full enforcement")), {
    tone: "ok",
    word: null,
    label: "Sandbox on · workspace-write · full enforcement",
  });
});

test("every on state short of full carries a word and a tone that is not ok", () => {
  const seen = new Set<string>();
  for (const e of ["partial", "unavailable", "none"] as const) {
    const b = sandboxBadge(info(true, e))!;
    assert.notEqual(b.tone, "ok", e);
    assert.ok(b.word, e);
    seen.add(`${b.tone}/${b.word}`);
  }
  assert.equal(seen.size, 3, "partial, unavailable and not-enforced read differently");
  assert.notEqual(sandboxBadge(info(true, "partial"))!.tone, sandboxBadge(info(true, "unavailable"))!.tone);
});

test("the row title says what a click does, and from when", () => {
  assert.match(sandboxRowTitle(info(false, "none")), /next tool call/);
  assert.match(sandboxRowTitle(info(true, "full", "Sandbox on · x")), /^Sandbox on · x\. Turning it off applies from the next tool call/);
});
