// Run: pnpm test -- server/harness/pi/sign-in.test.ts. pi's sign-in adapter (§app.openai-login, quirk P37):
// only OpenAI's 404 on the code request is a refusal (the browser route is offered); OpenAI down or
// unreachable is a failure. fetch is stubbed: no network, no port (the code route listens on none).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { piProviderSignIn } from "./sign-in";

const dir = mkdtempSync(join(tmpdir(), "sova-pi-sign-in-unit-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function codeRoute(answer: () => Promise<Response>) {
  const real = globalThis.fetch;
  globalThis.fetch = answer as typeof fetch;
  const shown: string[] = [];
  try {
    return {
      outcome: await piProviderSignIn(() => join(dir, "auth.json")).signIn("openai-codex", "code", {
        onEvent: (e) => shown.push(e.type),
        askAddress: () => Promise.reject(new Error("not asked")),
      }, new AbortController().signal),
      shown,
    };
  } finally {
    globalThis.fetch = real;
  }
}

describe("pi sign-in, the code route", () => {
  test("a 404 is a refusal: nothing shown, the browser route is offered", async () => {
    const { outcome, shown } = await codeRoute(async () => new Response("", { status: 404 }));
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { refused?: true }).refused, true);
    assert.deepEqual(shown, []);
  });

  test("OpenAI down (503) or unreachable is a failure, not a refusal", async () => {
    for (const answer of [async () => new Response("busy", { status: 503 }), async () => { throw new TypeError("fetch failed"); }]) {
      const { outcome } = await codeRoute(answer);
      assert.equal(outcome.ok, false);
      assert.equal((outcome as { refused?: true }).refused, undefined);
      assert.equal((outcome as { cancelled?: true }).cancelled, undefined);
    }
  });
});
