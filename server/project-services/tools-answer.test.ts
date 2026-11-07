// fitMergeAnswer (tools.ts): a merge verb's answer stays under the size the Claude Code CLI saves to a file a sandboxed
// chat can't read; a longer one is sent compact, then cut, saying how to ask for less. Other verbs are left as they are.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyOf, fitMergeAnswer, MERGE_ANSWER_MAX, renderResult } from "./tools";
import type { VerbResult } from "../../shared/project-contract";

const result = (verb: string, merge: unknown): VerbResult => ({ v: 1, verb, project: "/p", instance: null, slot: null, generation: null, checkout: null, branch: null, ok: true, changed: false, state: "absent", steps: [], services: [], data: [], links: [], merge, defHash: null, at: "t" }) as unknown as VerbResult;

test("a small merge answer is as rendered; a big one is compact, then cut under the cap with how to ask for less", () => {
  const small = result("merge.status", { view: { entries: [] } });
  assert.equal(renderResult(small), fitMergeAnswer(small, renderResult(small)));
  const mid = result("merge.status", { view: { rows: Array.from({ length: 400 }, (_, i) => ({ id: `mq_${i}`, branch: `feat/${i}` })) } });
  const midText = renderResult(mid);
  assert.ok(midText.length <= MERGE_ANSWER_MAX && !midText.includes("<<cut"), `compact JSON fits: ${midText.length}`);
  const big = result("merge.status", { view: { rows: Array.from({ length: 3000 }, (_, i) => ({ id: `mq_${i}`, note: "x".repeat(40) })) } });
  const text = renderResult(big);
  assert.ok(text.length <= MERGE_ANSWER_MAX, `${text.length}`);
  assert.ok(text.includes('"mq_0"') && !text.includes('"mq_2999"'), "a merge answer other than logs keeps its head");
  assert.match(text, /<<cut: this answer was \d+ characters and only the first 24000 are shown; ask for less: merge\.status \{entry\} answers one entry, merge\.logs \{run, step, lines\} one step>>$/);
  const other = result("status", { lines: Array.from({ length: 3000 }, () => "y".repeat(40)) });
  assert.ok(renderResult(other).length > MERGE_ANSWER_MAX, "only merge verbs are capped");
});

test("a cut merge.logs answer keeps its newest lines, whole and in order, and says to ask for fewer lines", () => {
  const all = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
  const text = renderResult(result("merge.logs", { run: { id: "mr_1", steps: [] }, lines: all }));
  assert.ok(text.length <= MERGE_ANSWER_MAX, `${text.length}`);
  const m = text.match(/\n<<cut: this answer was (\d+) characters; the oldest (\d+) of its 3000 log lines are left out and the newest (\d+) shown; ask for fewer lines: merge\.logs \{run, step, lines\}>>$/);
  assert.ok(m, text.slice(-300));
  const dropped = Number(m![2]);
  const kept = Number(m![3]);
  assert.equal(dropped + kept, 3000);
  assert.ok(kept > 100, `keeps as many as fit: ${kept}`);
  // The JSON before the cut note is whole: its lines are exactly the newest `kept`.
  const json = JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n<<cut")));
  assert.deepEqual(json.merge.lines, all.slice(-kept));
  assert.equal(json.merge.run.id, "mr_1");
  // One more line would not have fit.
  const more = JSON.stringify({ ...json, merge: { ...json.merge, lines: all.slice(-(kept + 1)) } });
  assert.ok(text.length - JSON.stringify(json).length + more.length > MERGE_ANSWER_MAX, "the most newest lines that fit");
});

test("merge.note sends an empty note (it clears the note); other merge verbs leave an empty key out", () => {
  assert.deepEqual(bodyOf({ verb: "merge.note", entry: "mq_1", note: "" }, "/p"), { entry: "mq_1", note: "", project: "/p" });
  assert.equal("note" in bodyOf({ verb: "merge.resolve", entry: "mq_1", note: "" }, "/p"), false);
  assert.equal(bodyOf({ verb: "merge.note", entry: "mq_1", note: "fixed" }, "/p").note, "fixed");
});
