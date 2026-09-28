// Run: pnpm exec tsx --test server/project-coding-mode.test.ts. The project's coding mode (stored
// tolerantly, patched strictly, Automatic from the spec's presence, the overseer's requests under the
// ceiling) and the promotion commit's message.
// Files in a throwaway dir (PI_CODING_AGENT_DIR too). No model, no git.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-po-mode-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
after(() => rmSync(tmp, { recursive: true, force: true }));
const { automaticMode, baseCodingMode, codingModeChoice, parseCodingMode } = await import("./project-coding-mode");
const store = await import("./project-overseer-store");
const { promotionMessage } = await import("./reconcile");

test("Automatic: normal · spec when the root has a spec manifest, else normal; never mode.json", () => {
  const root = join(tmp, "root");
  mkdirSync(root);
  assert.deepEqual(automaticMode(root), { mode: "normal", minorModes: [] });
  mkdirSync(join(root, ".sova", "spec"), { recursive: true });
  writeFileSync(join(root, ".sova", "spec", "manifest.json"), "{}");
  assert.deepEqual(automaticMode(root), { mode: "normal", minorModes: ["spec"] });
  assert.deepEqual(baseCodingMode({ mode: "delegate", minorModes: [] }, root), { mode: "delegate", minorModes: [] }, "the setting wins over Automatic");
});

test("stored tolerantly: anything unusable (align included) reads as Automatic", () => {
  assert.equal(parseCodingMode(undefined), null);
  assert.equal(parseCodingMode({ mode: "turbo" }), null);
  assert.equal(parseCodingMode({ mode: "normal", minorModes: ["align"] }), null);
  assert.equal(parseCodingMode({ mode: "normal", minorModes: ["nope"] }), null);
  assert.deepEqual(parseCodingMode({ mode: "delegate", minorModes: ["spec"] }), { mode: "delegate", minorModes: ["spec"] });
  assert.deepEqual(parseCodingMode({ mode: "normal" }), { mode: "normal", minorModes: [] });
  assert.equal(store.parsePoSettings({}).codingMode, null);
});

test("patched strictly: a sentence for each problem; null goes back to Automatic", () => {
  const p = store.projectOverseerPaths("org_aaaaaaaa", "prj_bbbbbbbb", join(tmp, "ws"));
  assert.throws(() => store.patchPoSettings(p, { codingMode: "delegate" }), /codingMode must be null \(Automatic\) or/);
  assert.throws(() => store.patchPoSettings(p, { codingMode: { minorModes: [] } }), /codingMode\.mode is required/);
  assert.throws(() => store.patchPoSettings(p, { codingMode: { mode: "turbo" } }), /Unknown mode turbo: use normal or delegate\./);
  assert.throws(() => store.patchPoSettings(p, { codingMode: { mode: "normal", minorModes: ["align"] } }), /Align needs someone to answer its questions/);
  assert.deepEqual(store.patchPoSettings(p, { codingMode: { mode: "delegate", minorModes: ["spec"] } }).codingMode, { mode: "delegate", minorModes: ["spec"] });
  assert.deepEqual(store.readPoSettings(p).codingMode, { mode: "delegate", minorModes: ["spec"] });
  assert.equal(store.patchPoSettings(p, { codingMode: null }).codingMode, null);
});

test("the overseer's request over the base: field by field, under the ceiling", () => {
  const spec = { mode: "normal" as const, minorModes: ["spec"] };
  assert.deepEqual(codingModeChoice({}, spec, null), { mode: spec });
  assert.deepEqual(codingModeChoice({ mode: "normal" }, spec, null), { mode: spec }, "omitted minors keep the base's");
  assert.equal((codingModeChoice({ minor_modes: [] }, spec, null) as { error: string }).error, "Spec is on for this project's coding sessions; only the operator can turn it off on the project page.");
  assert.match((codingModeChoice({ mode: "delegate" }, spec, spec) as { error: string }).error, /Delegate is off/);
  assert.match((codingModeChoice({ minor_modes: "spec" }, spec, null) as { error: string }).error, /minor_modes must be a list/);
  assert.equal((codingModeChoice({ minor_modes: ["bogus", "align"] }, spec, null) as { error: string }).error, "Unknown minor mode bogus: only spec is allowed.");
  const del = { mode: "delegate" as const, minorModes: [] };
  assert.deepEqual(codingModeChoice({ minor_modes: ["spec"] }, del, del), { mode: { mode: "delegate", minorModes: ["spec"] } });
  assert.deepEqual(codingModeChoice({ mode: "normal", minor_modes: [] }, del, del), { mode: { mode: "normal", minorModes: [] } });
});

test("the promotion commit's message names every promoted decision: area — statement, each ≤ 72, at most 10", () => {
  assert.equal(
    promotionMessage([
      { statement: "Exports run on Fridays.", area: "Payroll export" },
      { statement: "Over $5,000 needs a\nsecond approver.", area: "Approvals" },
    ]),
    "Promote 2 decisions: payroll export — Exports run on Fridays; approvals — Over $5,000 needs a second approver.",
  );
  const many = promotionMessage(Array.from({ length: 13 }, (_, i) => ({ statement: `Rule ${i} ${"x".repeat(100)}`, area: "Area" })));
  assert.match(many, /^Promote 13 decisions: /);
  assert.match(many, / and 3 more\.$/);
  const items = many.replace(/^Promote 13 decisions: /, "").replace(/ and 3 more\.$/, "").split("; ");
  assert.equal(items.length, 10);
  assert.ok(items.every((x) => x.length <= 72));
  // A cut last item ends the line with its ellipsis, not "…."
  assert.match(promotionMessage([{ statement: "y".repeat(100), area: "Login" }]), /y…$/);
});
