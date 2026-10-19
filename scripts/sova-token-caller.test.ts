// Run: pnpm test -- scripts/sova-token-caller.test.ts
// A script's headers (scripts/sova-token.mjs, §app.command-audit/attribution): the chat's key rides
// beside the token when SOVA_CALLER_KEY is set, and never instead of it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error: a plain .mjs script, no declarations
import { CALLER_HEADER, TOKEN_HEADER, tokenHeaders } from "./sova-token.mjs";

const tmp = mkdtempSync(join(tmpdir(), "sova-token-caller-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const withToken = join(tmp, "with");
mkdirSync(join(withToken, "sova"), { recursive: true });
writeFileSync(join(withToken, "sova", "auth-token"), "T".repeat(43) + "\n");
const without = join(tmp, "without");
const saved = process.env.SOVA_TOKEN;
delete process.env.SOVA_TOKEN;
after(() => {
  if (saved !== undefined) process.env.SOVA_TOKEN = saved;
});

test("the key rides beside the token, and only when it is set", () => {
  assert.equal(CALLER_HEADER, "x-sova-caller");
  assert.deepEqual(tokenHeaders(withToken, {}), { [TOKEN_HEADER]: "T".repeat(43) });
  assert.deepEqual(tokenHeaders(withToken, { SOVA_CALLER_KEY: "  " }), { [TOKEN_HEADER]: "T".repeat(43) });
  assert.deepEqual(tokenHeaders(withToken, { SOVA_CALLER_KEY: " k1 " }), { [TOKEN_HEADER]: "T".repeat(43), [CALLER_HEADER]: "k1" });
});

test("with no token, the key is sent alone: the server then answers 401 as it would with nothing", () => {
  assert.deepEqual(tokenHeaders(without, { SOVA_CALLER_KEY: "k1" }), { [CALLER_HEADER]: "k1" });
  assert.equal(TOKEN_HEADER in tokenHeaders(without, { SOVA_CALLER_KEY: "k1" }), false, "the key is never put in the token's place");
});
