// Run: npx tsx --test server/mode-state.test.ts (or npm test). Writes only under a mkdtemp dir.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { appliesAfter, defaultPatchOf, mergeMode, modeApplyPlan, modeInfo, modeKey, parseModePatch, parseModeRequest, readMode, resolveChatMode, writeMode } from "./mode-state";
import { normalizeEntry } from "./transcript";

const dir = mkdtempSync(join(tmpdir(), "sova-mode-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string) => join(dir, name);

describe("parseModePatch (POST /api/mode body)", () => {
  test("accepts a major mode, minor modes, or both; minors come back canonical and deduped", () => {
    assert.deepEqual(parseModePatch({ mode: "delegate" }), { mode: "delegate" });
    assert.deepEqual(parseModePatch({ minorModes: ["align", "align"] }), { minorModes: ["align"] });
    assert.deepEqual(parseModePatch({ mode: "normal", minorModes: [] }), { mode: "normal", minorModes: [] });
  });

  test("rejects bad bodies and unknown names with a reason", () => {
    for (const body of [null, [], "x", {}, { mode: "turbo" }, { mode: "Delegate" }, { minorModes: "align" }, { minorModes: ["align", "nope"] }, { minorModes: [1] }, { strict: true }]) {
      const r = parseModePatch(body);
      assert.ok("error" in r, JSON.stringify(body));
    }
    assert.match((parseModePatch({ minorModes: ["nope"] }) as { error: string }).error, /Unknown minor mode: nope \(known: align, spec\)/);
  });
});

describe("parseModeRequest (whole POST /api/mode body)", () => {
  test("a patch is a patch, and never reads as the save-default instruction", () => {
    assert.deepEqual(parseModeRequest({ mode: "delegate" }), { kind: "patch", patch: { mode: "delegate" } });
    assert.deepEqual(parseModeRequest({ minorModes: ["align"] }), { kind: "patch", patch: { minorModes: ["align"] } });
  });

  test("saveDefault on its own is the instruction to save THIS chat's mode", () => {
    assert.deepEqual(parseModeRequest({ saveDefault: true }), { kind: "saveDefault" });
  });

  test("saveDefault never rides along with a mode: two intentions in one body, one of them silently losing", () => {
    const both = parseModeRequest({ saveDefault: true, mode: "delegate" });
    assert.ok("error" in both);
    assert.match((both as { error: string }).error, /send no mode or minorModes/);
    assert.ok("error" in parseModeRequest({ saveDefault: true, minorModes: [] }));
    assert.ok("error" in parseModeRequest({ saveDefault: "yes" }));
  });

  test("bad bodies are the same errors parseModePatch gives", () => {
    for (const body of [null, [], "x", {}, { minorModes: ["nope"] }]) assert.ok("error" in parseModeRequest(body), JSON.stringify(body));
  });
});

describe("defaultPatchOf (what Save as default writes)", () => {
  test("exactly the three fields /mode default writes: mode, strict and the minors — never a shortcut or version", () => {
    const state = { version: 1 as const, mode: "delegate" as const, strict: true, shortcut: "alt+h", minorModes: ["align" as const] };
    const patch = defaultPatchOf(state);
    assert.deepEqual(patch, { mode: "delegate", strict: true, minorModes: ["align"] });
    assert.deepEqual(Object.keys(patch).sort(), ["minorModes", "mode", "strict"]);
    // A copy: a later change to the chat's own list can't reach into what was handed to the write.
    assert.notEqual(patch.minorModes, state.minorModes);
  });

  test("written over a file, it replaces those three and keeps everything else", () => {
    const f = file("save-default.json");
    writeFileSync(f, JSON.stringify({ version: 1, mode: "normal", strict: false, shortcut: "alt+h", minorModes: [] }));
    const written = writeMode(defaultPatchOf({ mode: "delegate", strict: true, minorModes: ["align"] }), f);
    assert.deepEqual({ mode: written.mode, strict: written.strict, minorModes: written.minorModes }, { mode: "delegate", strict: true, minorModes: ["align"] });
    const onDisk = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(onDisk.strict, true, "strict is saved, as /mode default saves it");
    assert.equal(onDisk.shortcut, "alt+h", "a field the save doesn't carry is kept");
    // strict OFF is written too: a chat with strict off must be able to clear a default that has it on.
    writeMode(defaultPatchOf({ mode: "delegate", strict: false, minorModes: [] }), f);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).strict, false);
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
    writeMode({ mode: "delegate" }, f);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).minorModes, ["align"]); // untouched by a major-only patch
  });

  test("the merge reads the fresh file (a TUI write in between survives)", () => {
    const f = file("fresh.json");
    writeMode({ mode: "delegate" }, f);
    writeFileSync(f, JSON.stringify({ version: 1, mode: "delegate", strict: true, minorModes: [] })); // "the TUI"
    writeMode({ minorModes: ["align"] }, f);
    const s = readMode(f);
    assert.equal(s.strict, true);
    assert.equal(s.mode, "delegate");
  });

  test("a corrupt file merges from defaults instead of throwing", () => {
    const f = file("corrupt.json");
    writeFileSync(f, "{not json");
    assert.equal(writeMode({ mode: "delegate" }, f).mode, "delegate");
  });

  test("mergeMode is pure and normalizes", () => {
    const base = readMode(file("absent.json"));
    const m = mergeMode(base, { mode: "delegate" });
    assert.equal(base.mode, "normal");
    assert.equal(m.mode, "delegate");
  });

  test("modeKey covers exactly mode + minorModes", () => {
    const a = readMode(file("absent.json"));
    const strictOn: typeof a = { ...a, strict: true };
    assert.equal(modeKey(a), modeKey(strictOn));
    assert.notEqual(modeKey(a), modeKey({ ...a, minorModes: ["align"] }));
    assert.notEqual(modeKey(a), modeKey({ ...a, mode: "delegate" }));
  });

  test("modeInfo lists what exists", () => {
    const info = modeInfo(readMode(file("absent.json")));
    assert.deepEqual(info.modes.map((m) => m.id), ["normal", "delegate"]);
    assert.match(info.modes[1]!.description, /^Orchestrate: /);
    assert.deepEqual(info.minors.map((m) => m.id), ["align", "spec"]);
    assert.ok(info.minors[0]!.description.length > 0);
  });
});

describe("modeApplyPlan (how the chat a switch was sent to takes it)", () => {
  const base = { foreign: false, hasModeCommand: true, pristine: false, streaming: false };
  test("the extension's command, never a reload (its workers would stop)", () => {
    assert.equal(modeApplyPlan(base), "command");
    assert.equal(modeApplyPlan({ ...base, streaming: true }), "command");
  });
  test("never prompted takes the command path too: the marker entry pins this session's mode", () => {
    assert.equal(modeApplyPlan({ ...base, pristine: true }), "command");
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
    assert.equal(appliesAfter("unsupported", false), "new-chats");
    assert.equal(appliesAfter("unsupported", true), "new-chats");
    assert.equal(appliesAfter("skip", true), "new-chats");
  });
});

describe("resolveChatMode (one chat's own mode when it opens)", () => {
  const active = (mode: string, strict: boolean, minorModes: string[]) => ({ version: 1, mode, strict, minorModes });
  const entry = (data: unknown) => ({ type: "custom", customType: "mode", data });
  /** A default file that is deliberately NOT what the entries say, so overlays are visible. */
  const defaultFile = () => {
    const f = file(`default-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: ["align"], shortcut: "alt+m" }));
    return f;
  };

  test("an empty branch is the file default, shortcuts and all", () => {
    const f = defaultFile();
    const s = resolveChatMode([], f);
    assert.equal(s.mode, "normal");
    assert.deepEqual(s.minorModes, ["align"]);
    assert.equal(s.shortcut, "alt+m");
  });

  test("the newest entry with an active snapshot wins over the default", () => {
    const f = defaultFile();
    const s = resolveChatMode(
      [
        { type: "message", data: {} },
        entry({ mode: "delegate", active: active("delegate", false, []) }),
        entry({ strict: true, active: active("delegate", true, ["align"]) }),
      ],
      f,
    );
    assert.equal(s.mode, "delegate");
    assert.equal(s.strict, true);
    assert.deepEqual(s.minorModes, ["align"]);
    assert.equal(s.shortcut, "alt+m"); // the file still owns everything outside the active triple
  });

  test("legacy markers and malformed entries are skipped, so the default stands", () => {
    const f = defaultFile();
    const s = resolveChatMode(
      [
        entry({ mode: "delegate" }), // legacy: written under global semantics
        entry({ minor: "align", on: true }),
        entry({ active: { version: 2, mode: "delegate" } }), // unknown version
        entry({ active: "nope" }),
        { type: "custom", customType: "align-doc", data: { active: active("delegate", false, []) } },
      ],
      f,
    );
    assert.equal(s.mode, "normal");
    assert.deepEqual(s.minorModes, ["align"]);
  });

  test("a missing file plus an entry: the entry alone decides", () => {
    const s = resolveChatMode([entry({ mode: "delegate", active: active("delegate", false, ["align"]) })], file("absent.json"));
    assert.equal(s.mode, "delegate");
    assert.deepEqual(s.minorModes, ["align"]);
  });

  test("it does not alias the entry's array (the caller may not mutate the session's state)", () => {
    const a = active("delegate", false, ["align"]);
    const s = resolveChatMode([entry({ mode: "delegate", active: a })], file("absent.json"));
    s.minorModes.push("align");
    assert.deepEqual(resolveChatMode([entry({ mode: "delegate", active: a })], file("absent.json")).minorModes, ["align"]);
  });
});

describe("mode markers in the transcript", () => {
  test("customType mode renders as an info row; other custom entries stay hidden", () => {
    const major = normalizeEntry({ type: "custom", customType: "mode", data: { mode: "delegate" }, id: "m1" });
    assert.deepEqual(major.map((i) => [i.kind, i.text]), [["info", "Mode → delegate"]]);
    const unknown = normalizeEntry({ type: "custom", customType: "mode", data: { mode: "someday" }, id: "m5" });
    assert.deepEqual(unknown.map((i) => i.text), ["Mode → someday"], "an unknown name is shown as written, never dropped");
    const minor = normalizeEntry({ type: "custom", customType: "mode", data: { minor: "align", on: false }, id: "m2" });
    assert.deepEqual(minor.map((i) => i.text), ["Minor mode: align off"]);
    assert.deepEqual(normalizeEntry({ type: "custom", customType: "mode", data: {}, id: "m3" }), []);
    assert.deepEqual(normalizeEntry({ type: "custom", customType: "topic-outline", data: { mode: "x" }, id: "m4" }), []);
  });

  test("a strict toggle renders; the active snapshot riding along is state, never a row", () => {
    const on = normalizeEntry({ type: "custom", customType: "mode", data: { strict: true, active: { version: 1, mode: "delegate", strict: true, minorModes: [] } }, id: "s1" });
    assert.deepEqual(on.map((i) => [i.kind, i.text]), [["info", "Strict mode on"]]);
    const off = normalizeEntry({ type: "custom", customType: "mode", data: { strict: false }, id: "s2" });
    assert.deepEqual(off.map((i) => i.text), ["Strict mode off"]);
    // A major switch still renders as the major switch, not as its snapshot's strict flag.
    const major = normalizeEntry({ type: "custom", customType: "mode", data: { mode: "delegate", active: { version: 1, mode: "delegate", strict: true, minorModes: [] } }, id: "s3" });
    assert.deepEqual(major.map((i) => i.text), ["Mode → delegate"]);
    // An entry carrying only the snapshot has nothing to say in the transcript.
    assert.deepEqual(normalizeEntry({ type: "custom", customType: "mode", data: { active: { version: 1, mode: "normal", strict: false, minorModes: [] } }, id: "s4" }), []);
  });
});
