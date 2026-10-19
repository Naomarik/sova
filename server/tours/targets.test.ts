import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright-core";
import { TourCaptureFailure, tourLocator, uniqueTourTarget } from "./targets";

/** The pattern a text target is matched with, as tourLocator hands it to the page. */
function tourTextPattern(text: string): RegExp {
  let seen: unknown;
  tourLocator({ getByText: (t: unknown) => { seen = t; return {}; } } as unknown as Page, { kind: "text", text });
  assert.ok(seen instanceof RegExp, `a text target is matched by a pattern, not ${JSON.stringify(seen)}`);
  return seen;
}

test("semantic targets keep exact role/name and text matching (case and whole text), never a first match", () => {
  const calls: unknown[][] = []; const result = {};
  const page = { getByRole: (...args: unknown[]) => { calls.push(args); return result; }, getByText: (...args: unknown[]) => { calls.push(args); return result; }, getByTestId: (...args: unknown[]) => { calls.push(args); return result; } } as unknown as Page;
  assert.equal(tourLocator(page, { kind: "role", role: "button", name: "Open details" }), result);
  assert.equal(tourLocator(page, { kind: "text", text: "Saved draft" }), result);
  assert.equal(tourLocator(page, { kind: "testId", testId: "draft-state" }), result);
  assert.equal(calls[0]![0], "button");
  const name = (calls[0]![1] as { name: RegExp }).name, text = calls[1]![0] as RegExp;
  assert.deepEqual(calls[2], ["draft-state"]);
  for (const re of [name, text]) assert.ok(re instanceof RegExp);
  assert.ok(name.test("Open details") && name.test("  Open \n details ") && !name.test("open details") && !name.test("Open details now") && !name.test("Open"));
  assert.ok(text.test("Saved draft") && !text.test("Saved drafts") && !text.test("saved draft"));
});
test("text and names ignore invisible direction marks on both sides, and nothing else", () => {
  const re = tourTextPattern("AED 0.00");
  for (const shown of ["AED 0.00", "\u2066AED 0.00\u2069", "\u200fAED\u00a0\u200e0.00", "AED \u202a0.00\u202c"]) assert.ok(re.test(shown), JSON.stringify(shown));
  assert.ok(!re.test("AED 0x00") && !re.test("AED 0.000"), "the dot is a literal dot; the whole text must match");
  assert.ok(tourTextPattern("\u2066AED 0.00\u2069").test("AED 0.00"), "marks in the script are ignored too");
  assert.ok(tourTextPattern("a+b (c)? [d] / e\\f").test("a+b (c)? [d] / e\\f"), "punctuation is literal");
});
test("zero and multiple matches fail with nearby controls as targets; a neighboring control is not chosen", async () => {
  for (const matches of [0, 2]) {
    const locator = { filter: () => locator, waitFor: async () => { throw new Error("not unique"); }, count: async () => matches };
    const one = { filter: () => one, count: async () => 1 };
    const page = {
      getByRole: (role: string) => role === "heading" ? locator : one,
      getByText: () => one,
      locator: () => ({ evaluateAll: async () => [{ role: "button", name: "Unrelated control", text: "Unrelated control" }, { role: "tab", name: "Saved drafts", text: "Saved drafts" }] }),
    } as unknown as Page;
    await assert.rejects(() => uniqueTourTarget(page, { kind: "role", role: "heading", name: "Saved drafts" }), (error: unknown) => error instanceof TourCaptureFailure && error.failure.matches === matches
      && JSON.stringify(error.failure.nearby?.[0]) === JSON.stringify({ target: { kind: "role", role: "tab", name: "Saved drafts" }, matches: 1 }) && error.failure.nearest === undefined);
  }
});
