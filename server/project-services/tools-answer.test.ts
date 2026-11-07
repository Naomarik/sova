// fitMergeAnswer (tools.ts): a merge verb's answer stays under the size the Claude Code CLI saves to a file a sandboxed
// chat can't read; a longer one is sent compact, then cut, saying how to ask for less. Other verbs are left as they are.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitMergeAnswer, MERGE_ANSWER_MAX, renderResult } from "./tools";
import type { VerbResult } from "../../shared/project-contract";

const result = (verb: string, merge: unknown): VerbResult => ({ v: 1, verb, project: "/p", instance: null, slot: null, generation: null, checkout: null, branch: null, ok: true, changed: false, state: "absent", steps: [], services: [], data: [], links: [], merge, defHash: null, at: "t" }) as unknown as VerbResult;

test("a small merge answer is as rendered; a big one is compact, then cut under the cap with how to ask for less", () => {
  const small = result("merge.status", { view: { entries: [] } });
  assert.equal(renderResult(small), fitMergeAnswer(small, renderResult(small)));
  const mid = result("merge.status", { view: { rows: Array.from({ length: 400 }, (_, i) => ({ id: `mq_${i}`, branch: `feat/${i}` })) } });
  const midText = renderResult(mid);
  assert.ok(midText.length <= MERGE_ANSWER_MAX && !midText.includes("<<cut"), `compact JSON fits: ${midText.length}`);
  const big = result("merge.logs", { lines: Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(40)}`) });
  const text = renderResult(big);
  assert.ok(text.length <= MERGE_ANSWER_MAX, `${text.length}`);
  assert.match(text, /<<cut: this answer was \d+ characters and only the first 24000 are shown; ask for less: merge\.status \{entry\} answers one entry, merge\.logs \{run, step, lines\} one step>>$/);
  const other = result("status", { lines: Array.from({ length: 3000 }, () => "y".repeat(40)) });
  assert.ok(renderResult(other).length > MERGE_ANSWER_MAX, "only merge verbs are capped");
});
