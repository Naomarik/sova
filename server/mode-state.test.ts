// Run: npx tsx --test server/mode-state.test.ts (or npm test). Writes only under a mkdtemp dir.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { appliesAfter, mergeMode, modeApplyPlan, modeInfo, modeKey, parseModePatch, readMode, writeMode } from "./mode-state";
import { normalizeEntry } from "./transcript";

const dir = mkdtempSync(join(tmpdir(), "pi-web-mode-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string) => join(dir, name);

describe("parseModePatch (POST /api/mode body)", () => {
  test("accepts a major mode, minor modes, or both; minors come back canonical and deduped", () => {
    assert.deepEqual(parseModePatch({ mode: "claude-heavy" }), { mode: "claude-heavy" });
    assert.deepEqual(parseModePatch({ minorModes: ["align", "align"] }), { minorModes: ["align"] });
    assert.deepEqual(parseModePatch({ mode: "normal", minorModes: [] }), { mode: "normal", minorModes: [] });
  });

  test("rejects bad bodies and unknown names with a reason", () => {
    for (const body of [null, [], "x", {}, { mode: "turbo" }, { minorModes: "align" }, { minorModes: ["align", "nope"] }, { minorModes: [1] }, { strict: true }]) {
      const r = parseModePatch(body);
      assert.ok("error" in r, JSON.stringify(body));
    }
    assert.match((parseModePatch({ minorModes: ["nope"] }) as { error: string }).error, /Unknown minor mode: nope \(known: align\)/);
  });
});

describe("mode.json read/merge/write", () => {
  test("a missing file reads as defaults", () => {
    assert.deepEqual(readMode(file("absent.json")), { version: 1, mode: "normal", strict: false, minorModes: [] });
  });

  test("a write changes only mode/minorModes and keeps strict and the shortcuts", () => {
    const f = file("keep.json");
    writeFileSync(f, JSON.stringify({ version: 1, mode: "normal", strict: true, shortcut: "alt+h", minorModes: [], minorShortcuts: { align: "alt+a" } }));
    const written = writeMode({ minorModes: ["align"] }, f);
    const onDisk = JSON.parse(readFileSync(f, "utf8"));
    assert.deepEqual(onDisk, { version: 1, mode: "normal", strict: true, shortcut: "alt+h", minorModes: ["align"], minorShortcuts: { align: "alt+a" } });
    assert.deepEqual(written, onDisk);
    writeMode({ mode: "claude-heavy" }, f);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).minorModes, ["align"]); // untouched by a major-only patch
  });

  test("the merge reads the fresh file (a TUI write in between survives)", () => {
    const f = file("fresh.json");
    writeMode({ mode: "claude-heavy" }, f);
    writeFileSync(f, JSON.stringify({ version: 1, mode: "claude-heavy", strict: true, minorModes: [] })); // "the TUI"
    writeMode({ minorModes: ["align"] }, f);
    const s = readMode(f);
    assert.equal(s.strict, true);
    assert.equal(s.mode, "claude-heavy");
  });

  test("a corrupt file merges from defaults instead of throwing", () => {
    const f = file("corrupt.json");
    writeFileSync(f, "{not json");
    assert.equal(writeMode({ mode: "claude-heavy" }, f).mode, "claude-heavy");
  });

  test("mergeMode is pure and normalizes", () => {
    const base = readMode(file("absent.json"));
    const m = mergeMode(base, { mode: "claude-heavy" });
    assert.equal(base.mode, "normal");
    assert.equal(m.mode, "claude-heavy");
  });

  test("modeKey covers exactly mode + minorModes", () => {
    const a = readMode(file("absent.json"));
    const strictOn: typeof a = { ...a, strict: true };
    assert.equal(modeKey(a), modeKey(strictOn));
    assert.notEqual(modeKey(a), modeKey({ ...a, minorModes: ["align"] }));
    assert.notEqual(modeKey(a), modeKey({ ...a, mode: "claude-heavy" }));
  });

  test("modeInfo lists what exists", () => {
    const info = modeInfo(readMode(file("absent.json")));
    assert.deepEqual(info.modes.map((m) => m.id), ["normal", "claude-heavy"]);
    assert.deepEqual(info.minors.map((m) => m.id), ["align"]);
    assert.ok(info.minors[0]!.description.length > 0);
  });
});

describe("modeApplyPlan (how one held chat takes a switch)", () => {
  const base = { foreign: false, hasModeCommand: true, pristine: false, streaming: false };
  test("a chat that has run: the extension's command, never a reload (its workers would stop)", () => {
    assert.equal(modeApplyPlan(base), "command");
    assert.equal(modeApplyPlan({ ...base, streaming: true }), "command");
  });
  test("never prompted and idle: reload (writes nothing)", () => {
    assert.equal(modeApplyPlan({ ...base, pristine: true }), "reload");
    assert.equal(modeApplyPlan({ ...base, pristine: true, streaming: true }), "command");
  });
  test("no mode command: never prompt, never reload", () => {
    assert.equal(modeApplyPlan({ ...base, hasModeCommand: false }), "unsupported");
    assert.equal(modeApplyPlan({ ...base, hasModeCommand: false, pristine: true }), "unsupported");
  });
  test("a foreign writer wins over everything", () => {
    assert.equal(modeApplyPlan({ ...base, foreign: true, pristine: true }), "skip");
  });
  test("what the selector says", () => {
    assert.equal(appliesAfter("command", false), "now");
    assert.equal(appliesAfter("command", true), "after-turn");
    assert.equal(appliesAfter("reload", false), "now");
    assert.equal(appliesAfter("unsupported", false), "new-chats");
    assert.equal(appliesAfter("skip", true), "new-chats");
  });
});

describe("mode markers in the transcript", () => {
  test("customType mode renders as an info row; other custom entries stay hidden", () => {
    const major = normalizeEntry({ type: "custom", customType: "mode", data: { mode: "claude-heavy" }, id: "m1" });
    assert.deepEqual(major.map((i) => [i.kind, i.text]), [["info", "Mode → claude-heavy"]]);
    const minor = normalizeEntry({ type: "custom", customType: "mode", data: { minor: "align", on: false }, id: "m2" });
    assert.deepEqual(minor.map((i) => i.text), ["Minor mode: align off"]);
    assert.deepEqual(normalizeEntry({ type: "custom", customType: "mode", data: {}, id: "m3" }), []);
    assert.deepEqual(normalizeEntry({ type: "custom", customType: "topic-outline", data: { mode: "x" }, id: "m4" }), []);
  });
});
