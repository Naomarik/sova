// Create is chosen in the chat and nowhere else (§chat.create-mode/per-chat-only): each place a mode is named refuses it
// in its own words, not as an unknown name and not by falling back, and what a chat's switch does to its state.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { CREATE_NO_DEFAULT, createNotNamed, profileFileError } from "../shared/profiles";
import { parseAutomation } from "../shared/automations";
import { defaults } from "../pi-config/extensions/mode/state.ts";
import { defaultPatchOf, mergeMode, modeInfo, parseModePatch, typedMajorMode, pinEntryFor, readMode, resolveChatMode, writeMode } from "./mode-state";
import { WEB_MODE_HOOK } from "../pi-config/extensions/mode/state.ts";
import { withWebMode } from "./memory/permit";
import { codingModeChoice, codingModeSwitch, hostDefaultMode } from "./project-coding-mode";
import { parseConfigure } from "./sessions-configure";
import { CREATE_INSTRUCTIONS } from "../pi-config/extensions/mode/create/guide.ts";
import { buildDelegateAlignBridge, buildDelegatePrompt, composePrompt, DEFAULT_ROUTES } from "../pi-config/extensions/mode/prompt.ts";

const dir = mkdtempSync(join(tmpdir(), "create-mode-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const chat = (over: Partial<ReturnType<typeof defaults>> = {}) => ({ ...defaults(), ...over });

describe("a chat's switch", () => {
  test("into Create keeps Create, remembers where it came from and turns align on, moving no other minor", () => {
    const next = mergeMode(chat({ mode: "delegate", strict: true, minorModes: ["vis"] }), { mode: "create" });
    assert.equal(next.mode, "create");
    assert.equal(next.lastMode, "delegate");
    assert.equal(next.strict, true);
    assert.deepEqual(next.minorModes, ["align", "vis"]);
  });

  test("align can go off in Create and stays off through other switches; leaving Create leaves it as it is", () => {
    const inCreate = mergeMode(chat(), { mode: "create" });
    const off = mergeMode(inCreate, { minorModes: [] });
    assert.equal(off.mode, "create", "a minor switch doesn't drop the chat out of Create");
    assert.deepEqual(off.minorModes, []);
    assert.equal(off.lastMode, "normal", "and it keeps its last choice");
    const on = mergeMode(inCreate, { mode: "delegate" });
    assert.deepEqual(on.minorModes, ["align"]);
    assert.equal(on.lastMode, undefined);
    assert.equal(on.mode, "delegate");
  });

  test("a chat already in Create that is told Create again doesn't turn align back on", () => {
    const off = mergeMode(mergeMode(chat(), { mode: "create" }), { minorModes: [] });
    assert.deepEqual(mergeMode(off, { mode: "create" }).minorModes, []);
  });

  test("Save as Default saves the last normal or Delegate choice, with the chat's strict and minors", () => {
    const state = mergeMode(chat({ mode: "delegate", strict: true }), { mode: "create" });
    assert.deepEqual(defaultPatchOf(state), { mode: "delegate", strict: true, minorModes: ["align"] });
    assert.equal(defaultPatchOf({ ...state, lastMode: undefined }).mode, "normal", "a chat that has been in no other mode saves normal");
    assert.equal(defaultPatchOf(chat({ mode: "delegate" })).mode, "delegate");
  });

  test("the pin and the restore keep the last choice", () => {
    const state = mergeMode(chat({ mode: "delegate" }), { mode: "create" });
    const pin = pinEntryFor([], state)!;
    assert.equal(pin.data.active.lastMode, "delegate");
    const f = file("pin.json", "{}");
    const back = resolveChatMode([{ type: "custom", customType: pin.customType, data: pin.data }], f);
    assert.equal(back.mode, "create");
    assert.equal(back.lastMode, "delegate");
  });
});

describe("the prompt", () => {
  test("is Delegate's block, the align bridge, then Create's block, in that order; Delegate's own has no Create", () => {
    const create = composePrompt({ mode: "create", strict: false, minorModes: ["align"] }, DEFAULT_ROUTES)!;
    const at = [buildDelegatePrompt(DEFAULT_ROUTES), buildDelegateAlignBridge(), CREATE_INSTRUCTIONS].map((block) => create.indexOf(block));
    assert.ok(at.every((i) => i >= 0), `all three are there: ${at}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    assert.ok(!composePrompt({ mode: "delegate", strict: false, minorModes: ["align"] }, DEFAULT_ROUTES)!.includes(CREATE_INSTRUCTIONS));
    assert.ok(!composePrompt({ mode: "create", strict: false, minorModes: [] }, DEFAULT_ROUTES)!.includes(buildDelegateAlignBridge()), "no bridge once align is off");
  });
});

describe("a typed switch", () => {
  test("reads the three major names, and leaves everything else to the extension", () => {
    assert.deepEqual(["/mode create", " /mode  delegate ", "/mode normal"].map(typedMajorMode), ["create", "delegate", "normal"]);
    for (const other of ["/mode", "/mode status", "/mode default", "/mode align on", "/mode strict on", "/mode create now", "mode create", "/modes create"]) assert.equal(typedMajorMode(other), undefined, other);
  });
});

describe("where it is offered", () => {
  test("only a chat that offers it lists it, and a default never does", () => {
    const ids = (m: ReturnType<typeof modeInfo>) => m.modes.map((x) => x.id);
    assert.deepEqual(ids(modeInfo(chat())), ["normal", "delegate"], "a default");
    assert.deepEqual(ids(modeInfo(chat(), undefined, false)), ["normal", "delegate"], "a gathering chat");
    assert.deepEqual(ids(modeInfo(chat(), undefined, true)), ["normal", "delegate", "create"], "the person's own chat");
  });

  test("a chat in Create says what Save as Default saves; no other does", () => {
    assert.equal(modeInfo(mergeMode(chat({ mode: "delegate" }), { mode: "create" }), undefined, true).saveMode, "delegate");
    assert.equal(modeInfo(chat({ mode: "delegate" }), undefined, true).saveMode, undefined);
  });
});

describe("the Sova-only permit", () => {
  const hook = () => (globalThis as Record<symbol, unknown>)[WEB_MODE_HOOK] as (id: string, mode: string) => boolean;

  test("holds only for that session and mode, only while the handler's first step runs", async () => {
    const during = withWebMode("a", "create", () => [hook()("a", "create"), hook()("b", "create"), hook()("a", "delegate")]);
    assert.deepEqual(during, [true, false, false]);
    assert.equal(hook()("a", "create"), false, "over when it returned");
  });

  test("a throwing handler leaves nothing permitted", () => {
    assert.throws(() => withWebMode("a", "create", () => { throw new Error("no"); }));
    assert.equal(hook()("a", "create"), false);
  });
});

describe("no default holds it", () => {
  test("a mode.json that names it by hand reads as normal, keeping the rest", () => {
    const f = file("hand.json", JSON.stringify({ version: 1, mode: "create", strict: true, minorModes: ["vis"] }));
    const s = readMode(f);
    assert.equal(s.mode, "normal");
    assert.equal(s.strict, true);
    assert.deepEqual(s.minorModes, ["vis"]);
    assert.equal(hostDefaultMode(f).mode, "normal", "and a coding session never starts from it");
  });

  test("the file's writer can't hold it, and Save as Default writes the choice", () => {
    const f = file("write.json", "{}");
    assert.throws(() => writeMode({ mode: "create" }, f), new RegExp(CREATE_NO_DEFAULT));
    assert.equal(readFileSync(f, "utf8"), "{}", "nothing written");
    assert.equal(writeMode(defaultPatchOf(mergeMode(chat({ mode: "delegate" }), { mode: "create" })), f).mode, "delegate");
  });

  test("the words are the copy deck's", () => {
    assert.equal(CREATE_NO_DEFAULT, "Create is chosen in each chat, so no default holds it.");
    assert.equal(createNotNamed("a profile"), "Create is chosen in a chat's own mode menu, so a profile can't name it. Nothing was changed.");
  });
});

describe("each starter refuses by name, with no fallback", () => {
  // A collision, not a literal: each refusal is Create's own, so an "unknown mode" answer can't pass.
  const says = (error: string | undefined | null, who: Parameters<typeof createNotNamed>[0]) => assert.ok(error?.includes(createNotNamed(who)), `${error}`);
  const errorOf = (v: object) => ("error" in v ? (v.error as string) : undefined);

  test("a profile's file doesn't parse", () => {
    says(profileFileError({ mode: "create" }), "a profile");
    assert.ok(!profileFileError({ mode: "delegate" })?.includes("mode"), "Delegate still does");
  });

  test("an automation's settings.mode, so a schedule or playbook through it too", () => {
    says(errorOf(parseAutomation({ id: "a", label: "A", when: "daily 09:00", playbook: "p", session: "long-running", settings: { mode: "create" } }, "a")), "an automation");
  });

  test("a project overseer's start and switch", () => {
    says(errorOf(codingModeChoice({ mode: "create" }, { mode: "normal", minorModes: ["spec"] })), "a project overseer");
    says(errorOf(codingModeSwitch({ mode: "create" })), "a project overseer");
  });

  test("the Overseer's `code`", () => {
    says(errorOf(codingModeChoice({ mode: "create", by: "the Overseer" }, { mode: "normal", minorModes: ["spec"] })), "the Overseer");
  });

  test("the route the Overseer reaches a peer's session by", () => {
    says(errorOf(parseConfigure({ path: "/x.jsonl", mode: "create" })), "the Overseer");
  });

  test("a chat's own mode route still takes it: it is the one way in", () => {
    assert.deepEqual(parseModePatch({ mode: "create" }), { mode: "create" });
  });
});
