import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { applyToData, changeWords, editSettingsText, isEmptyChange, parseChange, REVIEW_KIT_DIR, SettingsEditError } from "./settings-edit";

// §app.merge-queue/settings

const SOVA = readFileSync(new URL("../../.sova/project.json", import.meta.url), "utf8");

/** The lines that differ between two texts (by position; the edits here never add or drop lines unless said). */
function changedLines(a: string, b: string): string[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push(y[i] ?? "<gone>");
  return out;
}

describe("editing Sova's own project file in place", () => {
  test("a check's time limit changes only that number on that line", () => {
    const out = editSettingsText(SOVA, { checks: { unit: { timeoutSec: 1200 } } });
    assert.deepEqual(changedLines(SOVA, out), [SOVA.split("\n").find((l) => l.includes('"id": "unit"'))!.replace('"timeout": 1500', '"timeout": 1200')]);
  });

  test("push off, review off, a check made optional and another's rerun dropped: every other byte stays", () => {
    const out = editSettingsText(SOVA, { push: false, review: false, checks: { build: { optional: true }, unit: { rerun: false } } });
    const raw = JSON.parse(SOVA);
    assert.deepEqual(JSON.parse(out), applyToData(raw, { push: false, review: false, checks: { build: { optional: true }, unit: { rerun: false } } }));
    const changed = changedLines(SOVA, out.replace(/"install": (\{.*\})\n/, '"install": $1,\n'));
    // push's line, the build and unit lines, the install line (it lost its trailing comma) and review's line (gone)
    assert.ok(changed.some((l) => l.includes('"push": false')));
    assert.ok(changed.some((l) => l.includes('"id": "build"') && l.endsWith('"timeout": 900, "optional": true},')));
    assert.ok(changed.some((l) => l.includes('"id": "unit"') && !l.includes("rerun")));
    assert.equal(out.split("\n").length, SOVA.split("\n").length - 1);
    assert.equal(out.slice(0, out.indexOf('"merge"')), SOVA.slice(0, SOVA.indexOf('"merge"')));
  });

  test("review back on restores the kit folder; on and off round-trip to the same bytes", () => {
    const off = editSettingsText(SOVA, { review: false });
    assert.equal(JSON.parse(off).merge.review, undefined);
    const on = editSettingsText(off, { review: true }, { kitExists: true });
    assert.equal(on, SOVA);
  });

  test("How it lands (al_3): github-pr adds merge.land, local removes it: the round trip is the same bytes", () => {
    const pr = editSettingsText(SOVA, { land: "github-pr" });
    assert.equal(JSON.parse(pr).merge.land, "github-pr");
    assert.deepEqual(JSON.parse(pr), applyToData(JSON.parse(SOVA), { land: "github-pr" }));
    assert.equal(editSettingsText(pr, { land: "local" }), SOVA);
    assert.equal(editSettingsText(SOVA, { land: "local" }), SOVA, "local is the default: nothing written");
    assert.equal(JSON.parse(editSettingsText('{\n  "version": 1\n}\n', { land: "gitlab-mr" })).merge.land, "gitlab-mr");
    assert.deepEqual(parseChange({ land: "push-branch" }), { land: "push-branch" });
    assert.throws(() => parseChange({ land: "pr" }), SettingsEditError);
    assert.equal(changeWords({ land: "github-pr" }), "lands by pull request on GitHub");
    assert.equal(isEmptyChange({ land: "local" }), false);
  });

  test("setting a value to what it already is changes nothing", () => {
    assert.equal(editSettingsText(SOVA, { push: true, checks: { typecheck: { timeoutSec: 600, rerun: false } } }), SOVA);
  });
});

describe("other shapes", () => {
  test("one-line objects get a member in their own style; a file without a merge section gets one", () => {
    const text = '{"version": 1, "merge": {"checks": [{"id": "t", "run": ["x"]}]}}\n';
    assert.equal(editSettingsText(text, { push: false, checks: { t: { timeoutSec: 90 } } }), '{"version": 1, "merge": {"checks": [{"id": "t", "run": ["x"], "timeout": 90}], "push": false}}\n');
    const bare = '{\n  "version": 1\n}\n';
    assert.equal(editSettingsText(bare, { push: false }), '{\n  "version": 1,\n  "merge": {"push": false}\n}\n');
  });

  test("refusals: an undeclared check, checks from test.run, review on without a kit, a definition the change breaks", () => {
    const text = '{"version": 1, "merge": {"checks": [{"id": "t", "run": ["x"]}, {"id": "u", "run": ["y"], "optional": true}]}}';
    assert.throws(() => editSettingsText(text, { checks: { nope: { rerun: true } } }), SettingsEditError);
    assert.throws(() => editSettingsText('{"version": 1, "test": {"run": ["x"]}}', { checks: { tests: { rerun: true } } }), /aren't declared/);
    assert.throws(() => editSettingsText(text, { review: true }), new RegExp(REVIEW_KIT_DIR.replace(/[./]/g, "\\$&")));
    // The last required check made optional: the parser refuses it, so the save does.
    assert.throws(() => editSettingsText(text, { checks: { t: { optional: true } } }), /valid definition/);
  });

  test("parseChange takes only what q3 allows", () => {
    assert.deepEqual(parseChange({ push: true, checks: { unit: { timeoutSec: 60, rerun: false } } }), { push: true, checks: { unit: { timeoutSec: 60, rerun: false } } });
    assert.throws(() => parseChange({ target: "main" }), /can't be changed here/);
    assert.throws(() => parseChange({ checks: { unit: { run: ["x"] } } }), /can't be changed here/);
    assert.throws(() => parseChange({ checks: { unit: { timeoutSec: 99999 } } }), /1–1800/);
    assert.throws(() => parseChange({ push: "yes" }), SettingsEditError);
  });

  test("words and emptiness", () => {
    assert.equal(changeWords({ push: false, checks: { unit: { timeoutSec: 1500, optional: true } } }), "push off; unit: 25 min, only when picked");
    assert.equal(isEmptyChange({ checks: { unit: {} } }), true);
    assert.equal(isEmptyChange({ review: false }), false);
  });
});
