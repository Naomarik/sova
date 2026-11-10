// §chat.worktrees/retirement: one summary after the first pass, posted only when it really was.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { retirePass, type PassResult, type RetireDeps } from "./worktree-retire";

const dir = mkdtempSync(join(tmpdir(), "sova-retire-summary-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function deps(name: string, post: (s: PassResult) => Promise<boolean | void>): RetireDeps {
  return { allowed: () => ({ on: true }), repos: () => [], records: async () => ({ records: [], unreadable: [] }), now: () => 1000, pendingFile: () => join(dir, `${name}.json`), firstPassDone: post } as unknown as RetireDeps;
}
const saved = (name: string) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as { firstPass: { posted?: boolean; done?: boolean } };

test("an Overseer that's busy gets the first pass's summary at a later pass, once; a posted one is never posted again", async () => {
  const answers = [false, true];
  const seen: PassResult[] = [];
  const d = deps("busy", async (s) => (seen.push(s), answers.shift()));
  await retirePass(d);
  assert.equal(saved("busy").firstPass.posted, undefined, "busy: not marked posted");
  assert.equal(saved("busy").firstPass.done, true, "though the first pass is over");
  await retirePass(d);
  assert.equal(saved("busy").firstPass.posted, true);
  await retirePass(d);
  assert.equal(seen.length, 2, "asked once per pass until it got through, then never");
});

test("a post that throws is asked again too, and fails no pass", async () => {
  let n = 0;
  const d = deps("throws", async () => {
    if (++n === 1) throw new Error("the Overseer won't open");
  });
  assert.deepEqual((await retirePass(d)).repos, []);
  assert.equal(saved("throws").firstPass.posted, undefined);
  await retirePass(d);
  assert.equal(saved("throws").firstPass.posted, true);
  assert.equal(n, 2);
});
