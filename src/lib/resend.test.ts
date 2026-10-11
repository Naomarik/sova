// Run: npx tsx --test src/lib/resend.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageResend } from "../../shared/usage/wire";
import { resendReasonLine, resendReasons, resendReasonWords, resendShare, resendSummary, resentAnything, resumedWords, shareWords } from "./resend";

const contract: UsageResend = {
  usd: 3.12,
  tokens: 610_204,
  launches: 3,
  resumed: 5,
  recorded: 9,
  reasons: [
    { why: "system-prompt", fallback: null, launches: 2, usd: 2.4, tokens: 470_100 },
    { why: "process-start", fallback: "login-moved", launches: 1, usd: 0.72, tokens: 140_104 },
  ],
};

test("the collapsed line: count, dollars and the share of the spend beside it", () => {
  assert.deepEqual(resendSummary(contract, 12.48, "its spend"), { text: "Re-sent history 3× · $3.12 · 25% of its spend", high: true });
  assert.deepEqual(resendSummary(contract, 31.2, "the main thread"), { text: "Re-sent history 3× · $3.12 · 10% of the main thread", high: false });
});

test("a share under 1% says so; an unpriced re-send shows tokens and no share", () => {
  assert.equal(shareWords(0.004), "under 1%");
  assert.equal(shareWords(0.996), "100%");
  const unpriced = { ...contract, usd: 0, reasons: [] };
  assert.equal(resendShare(unpriced, 10), null);
  assert.deepEqual(resendSummary(unpriced, 10, "its spend"), { text: "Re-sent history 3× · 610k tokens", high: false });
  assert.equal(resendShare(contract, 0), null);
});

test("reasons in plain words, the saved copy's fallback after, unknown words as written", () => {
  assert.equal(resendReasonWords({ why: "system-prompt", fallback: null }), "Instructions changed");
  assert.equal(resendReasonWords({ why: "process-start", fallback: "login-moved" }), "Server restarted or chat reopened; couldn't pick up its saved copy: login moved");
  assert.equal(resendReasonWords({ why: "reaped", fallback: "resume-failed" }), "Set aside while idle (too many idle Claude chats); couldn't pick up its saved copy: picking up failed");
  assert.equal(resendReasonWords({ why: "brand-new-why", fallback: "odd-one" }), "brand-new-why; couldn't pick up its saved copy: odd-one");
  assert.equal(resendReasonLine(contract.reasons[0]!), "Instructions changed · 2× · $2.40");
});

test("costliest reason first, and the saved-copy line only when some launch picked it up", () => {
  const flipped = { ...contract, reasons: [...contract.reasons].reverse() };
  assert.deepEqual(resendReasons(flipped).map((r) => r.why), ["system-prompt", "process-start"]);
  assert.equal(resumedWords(contract), "Picked up Claude's saved copy instead 5×.");
  assert.equal(resumedWords({ ...contract, resumed: 0 }), null);
});

test("nothing to show when nothing was re-sent or nothing was recorded", () => {
  assert.equal(resentAnything(undefined), false);
  assert.equal(resentAnything({ ...contract, usd: 0, tokens: 0, launches: 0, reasons: [] }), false);
  assert.equal(resentAnything(contract), true);
});
