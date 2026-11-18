// Run: pnpm test server/jsonl.test.ts. The shared JSONL parse (§app.harness/reader): the yielding parse
// is the sync one, object for object, and lets the event loop run between its slices.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJsonl, parseJsonlYielding } from "./jsonl";

const text = ['{"a":1}', "", "   ", "{torn", "42", '"str"', "null", "[1,2]", '{"b":{"c":[3]}}', '{"d":"\\n"}', ""].join("\n");

test("parseJsonlYielding is parseJsonl: blank, malformed and non-object lines skipped, arrays kept, order kept", async () => {
  const want = parseJsonl(text);
  assert.deepEqual(want, [{ a: 1 }, [1, 2], { b: { c: [3] } }, { d: "\n" }]);
  assert.deepEqual(await parseJsonlYielding(text), want);
  assert.deepEqual(await parseJsonlYielding(text, 0), want, "a turn after every line changes nothing");
  assert.deepEqual(await parseJsonlYielding(""), []);
});

test("parseJsonlYielding lets other work run between its slices", async () => {
  const big = Array.from({ length: 2_000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(200) })).join("\n");
  let ran = 0;
  setImmediate(() => ran++);
  const out = await parseJsonlYielding(big, 0);
  assert.equal(out.length, 2_000);
  assert.equal(ran, 1, "a callback queued before the parse ran before it finished");
});
