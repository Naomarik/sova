import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition } from "./project-contract";
import { setupChanges, setupMapOf, shortHash, type SetupChange, type SetupFacts } from "./merge-queue-setup-map";

const facts = (o: Partial<SetupFacts> = {}): SetupFacts => ({ of: "main", commit: "a".repeat(40), remote: "origin", names: "answered", ...o });
const def = (merge: Record<string, unknown>, extra: Record<string, unknown> = {}) => parseDefinition(JSON.stringify({ version: 1, merge, ...extra }));
const unit = { id: "unit", label: "Unit tests", run: ["pnpm", "test"], timeout: 600 };
const e2e = { id: "e2e", label: "Browser tests", run: ["pnpm", "e2e"], timeout: 900, optional: true };
const base = { checks: [unit, e2e], rules: [{ paths: ["src/**"], check: "e2e", why: "the UI changed" }] };

test("the hash is the setup's, never where it was read from", () => {
  const a = setupMapOf(def(base), facts());
  const b = setupMapOf(def(base), facts({ of: "proposal", commit: "b".repeat(40), dirty: true, branch: "feat/setup" }));
  assert.equal(a.hash, b.hash);
  assert.equal(shortHash({ x: 1, y: [2] }), shortHash({ y: [2], x: 1 }));
  assert.notEqual(setupMapOf(def({ ...base, reuse: false }), facts()).hash, a.hash);
});

test("a project pushes only with a remote and merge.push not false; names matter only when it pushes", () => {
  assert.deepEqual(setupMapOf(def(base), facts()).push, { on: true, remote: "origin", names: "answered" });
  assert.deepEqual(setupMapOf(def(base), facts({ remote: null })).push, { on: false, remote: null, names: null });
  assert.deepEqual(setupMapOf(def({ ...base, push: false }), facts()).push, { on: false, remote: "origin", names: null });
});

test("the check list: declared, none, the test command's one check, or unset", () => {
  assert.equal(setupMapOf(def(base), facts()).checksFrom, "declared");
  assert.equal(setupMapOf(def({ checks: "none" }), facts()).checksFrom, "none");
  const t = setupMapOf(parseDefinition(JSON.stringify({ version: 1, test: { run: ["make", "test"], smoke: ["unit"] } })), facts());
  assert.equal(t.checksFrom, "test-command");
  assert.deepEqual(t.checks.map((c) => c.run), [["make", "test"]]);
  assert.equal(setupMapOf(null, facts()).checksFrom, "unset");
});

/** Each edit to a setup, and the stage its one change must name. */
const EDITS: [string, Record<string, unknown>, SetupChange["stage"]][] = [
  ["a check added", { ...base, checks: [unit, e2e, { id: "lint", label: "Lint", run: ["pnpm", "lint"], timeout: 60 }] }, "checks"],
  ["a check's time limit", { ...base, checks: [{ ...unit, timeout: 1200 }, e2e] }, "checks"],
  ["an optional check made required", { ...base, checks: [unit, { ...e2e, optional: false }] }, "checks"],
  ["a rule added", { ...base, rules: [...base.rules, { paths: ["server/**"], check: "unit", why: "server code" }] }, "rules"],
  ["a rule's reason", { ...base, rules: [{ ...base.rules[0], why: "a page changed" }] }, "rules"],
  ["how it lands", { ...base, squash: true }, "land"],
  ["the push", { ...base, push: false }, "push"],
  ["reuse", { ...base, reuse: false }, "copy"],
];

test("every edit shows as exactly one change, on the stage it touches", () => {
  const a = setupMapOf(def(base), facts());
  for (const [what, merge, stage] of EDITS) {
    const b = setupMapOf(def(merge), facts());
    const ch = setupChanges(a, b);
    assert.equal(ch.length, 1, `${what}: ${JSON.stringify(ch)}`);
    assert.equal(ch[0]!.stage, stage, what);
  }
  assert.deepEqual(setupChanges(a, setupMapOf(def(base), facts({ of: "proposal" }))), []);
});

test("an addition read backwards is a removal", () => {
  const a = setupMapOf(def(base), facts());
  for (const [what, merge] of EDITS.filter(([w]) => w.endsWith("added"))) {
    const b = setupMapOf(def(merge), facts());
    assert.equal(setupChanges(a, b)[0]!.tag, "add", what);
    assert.equal(setupChanges(b, a)[0]!.tag, "remove", what);
  }
});
