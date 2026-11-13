// `--picked-groups`, the merge queue's form of the slow-group selection (Sova's Slow test group check): the real runner
// in a throwaway repository of its own (runner-copy.test.helper.ts), over probe test files that log their own run, so
// what ran is counted from what executed. Named groups run as --groups runs them; none named (a trial runs the check
// with no selection) runs the groups a landing runs for the branch's changes since the merge base with the queue's
// target, never the everyday set, and with none to run it skips, exit 0, saying why. A bare `--groups` typed by hand
// stays a usage error (run-tests.integration.test.ts's usage table).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { scratchRoot } from "../server/test-scratch";
import { git, runnerProjects } from "./runner-copy.test.helper";

const base = scratchRoot("sova-picked-groups-");
after(() => rmSync(base, { recursive: true, force: true }));
const project = runnerProjects(base);

const MQ = "server/merge-queue/probe.integration.test.ts";
const TRIAL = "server/chat-runtime/trial-probe.integration.test.ts";
const TOURS = "server/tours/probe.integration.test.ts";
const EVERYDAY = "server/everyday.integration.test.ts";
const SKIPPED = "no slow group applies to this branch's changes";

test("a bare --picked-groups runs exactly the slow groups a landing runs for the branch's changes against the target; none: skipped, exit 0, saying why", { timeout: 240_000 }, () => {
  const p = project();
  for (const f of [MQ, TRIAL, TOURS, EVERYDAY]) p.probe(f);
  p.commit("target");
  // Each branch's changes, and the slow groups' files a landing runs for them, by hand from scripts/test-groups.mjs:
  // the queue's code triggers Merge queue, chat code Chat processes, tour code Tours (never at a landing), a README none.
  const cases: [string, string[], string[]][] = [
    ["queue", ["server/merge-queue/queue.ts"], [MQ]],
    ["chats", ["server/chat-runtime/host.ts"], [TRIAL]],
    ["both", ["server/merge-queue/queue.ts", "server/chat-runtime/host.ts"], [MQ, TRIAL]],
    ["tours", ["server/tours/browser.ts"], []],
    ["readme", ["README.md"], []],
  ];
  for (const [name, changed, want] of cases) {
    git(p.root, "checkout", "-q", "-b", `feat/${name}`, "master");
    for (const f of changed) p.put(f, `// ${name}\n`);
    p.commit(name);
    // As a trial runs it: the tried commit checked out, the target named in SOVA_MERGE_TARGET.
    const r = p.run(["--integration", "--picked-groups"], { SOVA_MERGE_TARGET: "master" });
    assert.equal(r.code, 0, `${name}: ${r.out}`);
    assert.deepEqual(r.ran, [...want].sort(), `${name}: what ran\n${r.out}`);
    assert.deepEqual([...(r.report?.ranFiles ?? [])].sort(), [...want].sort(), `${name}: the report's ranFiles`);
    if (want.length) assert.equal(r.report?.passed, want.length, name);
    else {
      assert.equal(r.report?.skipped, SKIPPED, `${name}: the report says why it skipped`);
      assert.equal(r.report?.passed, 0);
      assert.equal(r.report?.failed, 0);
      assert.match(r.out, new RegExp(`skipped: ${SKIPPED}`), name);
    }
  }
  // The target is the queue's, not master by default: against itself the queue branch has no change, so it skips.
  git(p.root, "checkout", "-q", "feat/queue");
  const self = p.run(["--integration", "--picked-groups"], { SOVA_MERGE_TARGET: "feat/queue" });
  assert.equal(self.code, 0, self.out);
  assert.deepEqual(self.ran, []);
  assert.equal(self.report?.skipped, SKIPPED);
});

test("--picked-groups with names runs only those groups, as --groups does, whatever the branch changed", { timeout: 240_000 }, () => {
  const p = project();
  for (const f of [MQ, TRIAL, EVERYDAY]) p.probe(f);
  p.commit("target");
  git(p.root, "checkout", "-q", "-b", "feat/x", "master");
  p.put("server/merge-queue/queue.ts", "// x\n");
  p.commit("x");
  // Fresh: the tree doesn't change between these runs, so a file that passed once would be reused, not run.
  const env = { SOVA_MERGE_TARGET: "master", SOVA_FRESH: "1" };
  // The selection the queue appends: one group per pick, or several.
  for (const [args, want] of [[["trial"], [TRIAL]], [["trial", "merge-queue"], [MQ, TRIAL]], [["trial,merge-queue"], [MQ, TRIAL]]] as [string[], string[]][]) {
    const r = p.run(["--integration", "--picked-groups", ...args], env);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.deepEqual(r.ran, want.sort(), args.join(" "));
  }
  const unknown = p.run(["--integration", "--picked-groups", "no-such-group"], env);
  assert.equal(unknown.code, 2, unknown.out);
  assert.match(unknown.out, /no test group no-such-group/);
  assert.deepEqual(unknown.ran, []);
});
