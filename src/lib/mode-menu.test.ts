import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { APPROVAL_FOOT, approvalLead, CHOOSE_DEFAULT_NOTE, type FootFacts, barePrograms, bareProgramsNote, commandLine, createLimits, filterProfiles, FOOT_NOTE, footNote, nextProjectModes, projectGroupLabel, projectRowState, isDefaultMode, modeSummary, noProfileMatch, savableMode } from "./mode-menu";

const def = (mode: string, minorModes: string[], strict = false) => ({ mode, minorModes, strict });

test("already the default: the same mode AND the same minors in the same order", () => {
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("delegate", ["align"])), true);
  assert.equal(isDefaultMode(def("normal", []), def("normal", [])), true);
  // A different major, a different minor, one extra, one missing, or a different order: all moves.
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("normal", ["align"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("delegate", ["spec"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align", "spec"]), def("delegate", ["align"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align"]), def("delegate", ["align", "spec"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align", "spec"]), def("delegate", ["spec", "align"])), false);
  // strict is one of the three fields a save writes (as `/mode default` does), so it counts too.
  assert.equal(isDefaultMode(def("delegate", ["align"], false), def("delegate", ["align"], true)), false);
  assert.equal(isDefaultMode(def("delegate", ["align"], true), def("delegate", ["align"], false)), false);
  assert.equal(isDefaultMode(def("delegate", ["align"], true), def("delegate", ["align"], true)), true);
});

test("unknown is never 'already the default': the button stays pressable", () => {
  // Nothing read yet, or this chat's mode hasn't arrived: a disabled button would claim knowledge.
  assert.equal(isDefaultMode(null, def("delegate", ["align"])), false);
  assert.equal(isDefaultMode(def("delegate", ["align"]), null), false);
  assert.equal(isDefaultMode(null, null), false);
});

test("modeSummary is the extension's own form: major, strict only when on, then the minors in order", () => {
  assert.equal(modeSummary(def("delegate", [])), "delegate");
  assert.equal(modeSummary(def("delegate", ["align", "spec"])), "delegate · align · spec");
  assert.equal(modeSummary(def("delegate", ["align"], true)), "delegate · strict · align");
});

test("the mode menu offers no Make Default: the default is chosen in Settings → Profiles", () => {
  const source = readFileSync(new URL("../components/ModeMenu.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /putDefaultProfile|the Default`|defaultLabel/);
  // After a press the foot says what new chats start with, from the save's own answer (the listing it returns).
  const update = source.slice(source.indexOf("const updateProfile ="), source.indexOf("const chooseProfile ="));
  assert.match(update, /setListing\(await updateProfileFromChat\(.*\)\);\n(\s*\/\/.*\n)*\s*setSavedTo\(name\);/);
  assert.match(source, /<p class="mode-menu-foot-line" aria-live="polite">/, "the line is announced as it changes");
});

test("the picker search is a case-insensitive name match that keeps list order", () => {
  const list = [{ name: "Off" }, { name: "My setup" }, { name: "Opus everywhere" }, { name: "opus fallback" }];
  assert.deepEqual(filterProfiles(list, "").map((p) => p.name), ["Off", "My setup", "Opus everywhere", "opus fallback"]);
  assert.deepEqual(filterProfiles(list, "OPUS").map((p) => p.name), ["Opus everywhere", "opus fallback"]);
  assert.deepEqual(filterProfiles(list, "off").map((p) => p.name), ["Off"], "Off answers a search like any other row");
  assert.deepEqual(filterProfiles(list, "nothing matches this"), []);
});

test("an empty search says so, and the foot says where new chats start", () => {
  assert.equal(noProfileMatch("xyz"), "No profile matches \u201cxyz\u201d.");
  assert.equal(noProfileMatch("  xyz  "), "No profile matches \u201cxyz\u201d.");
  assert.equal(FOOT_NOTE, "A switch here is this chat's own. New chats start from the default profile.");
});

// ── Project minor modes ───────────────────────────────────────────────────

test("project modes never make a chat 'not the default': no save writes them", () => {
  // The same built-in mode with project modes on is still exactly what a save would write.
  assert.equal(isDefaultMode(def("delegate", ["align"]), { ...def("delegate", ["align"]), projectModes: ["deploy-notes"] }), true);
  assert.equal(modeSummary({ ...def("normal", []), projectModes: ["deploy-notes"] }), "normal");
});

const pm = (over: Record<string, unknown> = {}) => ({ tools: [] as { name: string; description: string; command: string[] }[], ...over });

test("each row state is told apart, and only a broken mode refuses a press", () => {
  const states = [
    [projectRowState(pm(), false), "ok", true],
    [projectRowState(pm(), true), "ok", true],
    [projectRowState(pm({ problem: "MODE.md: missing description" }), false), "broken", false],
    [projectRowState(pm({ removed: true }), true), "removed", true],
    [projectRowState(pm({ changed: true }), true), "changed", true],
    [projectRowState(pm({ needsApproval: true, tools: [{ name: "a", description: "", command: ["./a"] }] }), false), "approval", true],
    [projectRowState(pm({ needsApproval: true }), true), "tools-changed", true],
  ] as const;
  for (const [s, kind, can] of states) {
    assert.equal(s.kind, kind);
    assert.equal(s.canToggle, can, kind);
    assert.equal(s.note === null, kind === "ok", `${kind}: a note exactly when the row isn't ok`);
  }
  // The broken note carries the problem itself.
  assert.match(projectRowState(pm({ problem: "MODE.md: line 3: unknown key" }), false).note!, /MODE\.md: line 3: unknown key/);
  // An ON mode whose files broke since can still be turned off: the press is how it goes away.
  assert.equal(projectRowState(pm({ problem: "bad" }), true).canToggle, true);
  // Removed wins over changed while on: the folder is gone, there's nothing to reload.
  assert.equal(projectRowState(pm({ removed: true, changed: true }), true).kind, "removed");
});

test("the approval counts its tools in digits", () => {
  const t = { name: "x", description: "", command: ["./x"] };
  assert.equal(projectRowState(pm({ needsApproval: true, tools: [t] }), false).note, "Asks before turning on: it runs 1 tool.");
  assert.equal(projectRowState(pm({ needsApproval: true, tools: [t, t, t] }), false).note, "Asks before turning on: it runs 3 tools.");
  assert.match(approvalLead("deploy", "shop", [t]), /^deploy comes from shop's files\. .*this tool/);
  assert.match(approvalLead("deploy", undefined, [t, t]), /this project's files\. .*these 2 tools/);
});

test("a press sends the whole ON set, toggling only its own id", () => {
  assert.deepEqual(nextProjectModes([], "a"), ["a"]);
  assert.deepEqual(nextProjectModes(["a", "b"], "a"), ["b"]);
  assert.deepEqual(nextProjectModes(["b"], "a"), ["b", "a"]);
});

test("a command reads as one line, quoting only what a shell would split", () => {
  assert.equal(commandLine(["./bin/check", "--fast"]), "./bin/check --fast");
  assert.equal(commandLine(["python3", "tool.py", "a b"]), "python3 tool.py 'a b'");
  assert.equal(commandLine(["echo", "it's"]), "echo 'it'\\''s'");
  assert.equal(commandLine(["x", ""]), "x ''");
});

test("the group label names the project when it has one", () => {
  assert.equal(projectGroupLabel("shop"), "This project · shop");
  assert.equal(projectGroupLabel(undefined), "This project");
});

test("the approval says it covers the whole folder, and names the machine's own programs it doesn't cover", () => {
  assert.match(APPROVAL_FOOT, /every file in this folder/);
  const t = (...command: string[]) => ({ name: "t", description: "", command });
  // A program from the folder is covered: nothing to name.
  assert.equal(bareProgramsNote([t("./run.sh", "--fast")]), null);
  assert.deepEqual(barePrograms([t("node", "./check.js"), t("sh", "./a.sh"), t("node", "./b.js"), t("./c")]), ["node", "sh"]);
  assert.equal(bareProgramsNote([t("python3", "./tool.py")]), "python3 is this machine's own program, so the approval doesn't cover it.");
  assert.equal(bareProgramsNote([t("node", "./a.js"), t("sh", "./b.sh")]), "node and sh are this machine's own programs, so the approval doesn't cover them.");
  assert.equal(bareProgramsNote([t("node"), t("sh"), t("bun")]), "node, sh, and bun are this machine's own programs, so the approval doesn't cover them.");
});

test("Create is never a default: a save writes the chat's last other mode, and the foot says which", () => {
  const inCreate = (saveMode?: string) => ({ mode: "create", minorModes: ["align"], strict: true, ...(saveMode ? { saveMode } : {}) });
  assert.equal(savableMode(inCreate("delegate")).mode, "delegate");
  assert.equal(savableMode(inCreate()).mode, "normal", "a chat that has been in no other mode saves normal");
  assert.equal(savableMode({ mode: "delegate", minorModes: [], strict: false }).mode, "delegate");
  assert.equal(isDefaultMode({ mode: "delegate", minorModes: ["align"], strict: true }, savableMode(inCreate("delegate"))), true, "compared by what a save writes");
  assert.equal(isDefaultMode({ mode: "create", minorModes: ["align"], strict: true }, savableMode(inCreate("delegate"))), false);
  assert.equal(footNote(inCreate("delegate"), "Claude"), "Create is chosen in each chat, so no profile starts in it. Update Claude saves delegate · align.");
  assert.equal(footNote(inCreate("delegate")), "Create is chosen in each chat, so no profile starts in it.");
  assert.equal(footNote({ mode: "normal", minorModes: [], strict: false }), FOOT_NOTE);
  assert.equal(footNote(null), FOOT_NOTE);
  assert.ok(!footNote(inCreate("delegate"), "Claude").includes("Update Claude saves create"), "Update never saves Create");
});

test("the foot says what new chats really start with: after a press, off the default, while this chat differs", () => {
  const n = { name: "Claude", mode: "delegate", minorModes: ["align", "spec"] };
  const chat = { mode: "delegate", minorModes: ["align", "spec"], strict: false };
  const facts = (over: Partial<FootFacts> = {}): FootFacts => ({ newChats: n, onDefault: true, differs: false, saved: null, ...over });
  // Right after Update {name}: the confirmation, worded from what was saved (the answer's newChats).
  assert.equal(footNote(chat, null, facts({ saved: "Claude" })), "Saved. New chats start in delegate · align · spec.");
  assert.equal(footNote(chat, null, facts({ saved: "Work", onDefault: false })), "Saved to Work. New chats still start from Claude.");
  // This chat's profile isn't the default: the default named, and where it is chosen, whether or not this chat differs.
  assert.equal(CHOOSE_DEFAULT_NOTE, "Choose the default in Settings → Profiles.");
  assert.equal(footNote(chat, null, facts({ onDefault: false })), "New chats start from Claude. Choose the default in Settings → Profiles.");
  assert.equal(footNote(chat, null, facts({ onDefault: false, differs: true })), "New chats start from Claude. Choose the default in Settings → Profiles.");
  // While this chat differs: what new chats start with now, and the model and effort when they are what differs.
  const plain = { ...n, mode: "normal", minorModes: [] };
  assert.equal(footNote({ ...chat, mode: "normal" }, null, facts({ newChats: plain, differs: true })), "New chats start in normal.");
  assert.equal(footNote(chat, null, facts({ differs: true, modelLine: "Opus 5.5 · medium" })), "New chats start in delegate · align · spec, on Opus 5.5 · medium.");
  // Otherwise the general sentence, naming the default; "the default profile" while it isn't known or there is none.
  assert.equal(footNote(chat, null, facts()), "A switch here is this chat's own. New chats start from Claude.");
  assert.equal(footNote(chat, null, facts({ newChats: { ...n, name: "" }, onDefault: null })), "A switch here is this chat's own. New chats start from the default profile.");
  assert.equal(footNote(chat, null, facts({ onDefault: null })), "A switch here is this chat's own. New chats start from Claude.", "unknown either side is not 'off the default'");
  // An older server sends no newChats: the general sentence, never a confirmation it can't word.
  assert.equal(footNote(chat, null, facts({ newChats: null, saved: "Claude" })), FOOT_NOTE);
  // In Create a press's confirmation still wins; before one, Create's own sentence.
  assert.equal(footNote({ ...chat, mode: "create", saveMode: "delegate" }, "Claude", facts({ differs: true })), "Create is chosen in each chat, so no profile starts in it. Update Claude saves delegate · align · spec.");
  assert.equal(footNote({ ...chat, mode: "create", saveMode: "delegate" }, null, facts({ saved: "Claude" })), "Saved. New chats start in delegate · align · spec.");
});

test("what a chat that can do less can't do in Create: nothing when it can do everything", () => {
  assert.equal(createLimits({ sandboxOn: false, remote: false }), null);
  assert.match(createLimits({ sandboxOn: true, remote: false })!, /write files on this computer, reach Sova's commands, or run project tools/);
  assert.match(createLimits({ sandboxOn: false, remote: true })!, /project modes or cards/);
  const both = createLimits({ sandboxOn: true, remote: true })!;
  assert.ok(both.includes("sandbox On") && both.includes("remote machine"), "both reasons");
});

test("the menu's profile pick goes through menuPick, told whether the first message is sent", () => {
  const source = readFileSync(new URL("../components/ModeMenu.tsx", import.meta.url), "utf8");
  const choose = source.slice(source.indexOf("const chooseProfile ="), source.indexOf("const saveCurrent ="));
  assert.match(choose, /await menuPick\(r, !!props\.control\.beforeFirstMessage\?\.\(\), \{/);
  assert.doesNotMatch(choose.replace(/switchTo: \(id\) => switchProfile\(/, ""), /switchProfile\(/, "no switch around menuPick");
});
