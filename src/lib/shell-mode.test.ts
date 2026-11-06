import assert from "node:assert/strict";
import { test } from "node:test";
import { ALREADY_RUNNING, canRun, draftOf, enterOnInput, folderName, leaveOnKey, modeAnnouncement, onAnswer, openDraft, SHELL_KEYS, SHELL_MARKER, shellPlaceholder, type ShellMode } from "./shell-mode";

test("a typed ! into the empty box steps the mode one deeper, and a third ! types", () => {
  assert.deepEqual(enterOnInput("off", "", "!", "insertText"), { mode: "shell", text: "" });
  assert.deepEqual(enterOnInput("shell", "", "!", "insertText"), { mode: "private", text: "" });
  assert.equal(enterOnInput("private", "", "!", "insertText"), null); // it is the command's first character
});

test("a ! into a box that holds text is text, and so is anything else", () => {
  assert.equal(enterOnInput("off", "ls", "ls!", "insertText"), null);
  assert.equal(enterOnInput("off", "", "a", "insertText"), null);
  // Dictation or an autocomplete putting a whole word in is not the ! key.
  assert.equal(enterOnInput("off", "", "!ls", "insertText"), null);
  assert.equal(enterOnInput("off", "", "!ls", "insertReplacementText"), null);
});

test("pasting text that starts with ! enters the mode as typing it would", () => {
  assert.deepEqual(enterOnInput("off", "", "!git status", "insertFromPaste"), { mode: "shell", text: "git status" });
  assert.deepEqual(enterOnInput("off", "", "!!git status", "insertFromPaste"), { mode: "private", text: "git status" });
  // Only two: the third ! is the command's.
  assert.deepEqual(enterOnInput("off", "", "!!!x", "insertFromPaste"), { mode: "private", text: "!x" });
  // Into an empty ! box, one more makes it !!.
  assert.deepEqual(enterOnInput("shell", "", "!ls", "insertFromPaste"), { mode: "private", text: "ls" });
  assert.deepEqual(enterOnInput("off", "", "!ls", "insertFromDrop"), { mode: "shell", text: "ls" });
  // Pasted into a box with text, or without a leading !, it is text.
  assert.equal(enterOnInput("off", "a", "a!ls", "insertFromPaste"), null);
  assert.equal(enterOnInput("off", "", "ls !", "insertFromPaste"), null);
  assert.equal(enterOnInput("private", "", "!ls", "insertFromPaste"), null);
});

test("Backspace in the empty box steps back one, Esc leaves for a message box", () => {
  assert.equal(leaveOnKey("private", "Backspace", ""), "shell");
  assert.equal(leaveOnKey("shell", "Backspace", ""), "off");
  assert.equal(leaveOnKey("private", "Escape", ""), "off");
  assert.equal(leaveOnKey("shell", "Escape", ""), "off");
  // With a command in the box both keys are the textarea's.
  assert.equal(leaveOnKey("shell", "Backspace", "l"), null);
  assert.equal(leaveOnKey("private", "Escape", "ls"), null);
  // A message box has nothing to leave, and other keys never leave.
  assert.equal(leaveOnKey("off", "Backspace", ""), null);
  assert.equal(leaveOnKey("shell", "Enter", ""), null);
});

test("a draft keeps its leading ! or !!, so it opens in the same mode", () => {
  for (const mode of ["shell", "private"] as const) {
    const stored = draftOf(mode, "pnpm test");
    assert.equal(stored, `${SHELL_MARKER[mode]}pnpm test`);
    assert.deepEqual(openDraft(stored, true), { mode, text: "pnpm test" });
  }
  assert.equal(draftOf("off", "hello"), "hello");
  assert.deepEqual(openDraft("hello", true), { mode: "off", text: "hello" });
  // An empty command is no draft: nothing is kept, mode included.
  assert.equal(draftOf("shell", ""), "");
});

test("without shell mode a leading ! is text, as it always was", () => {
  assert.deepEqual(openDraft("!ls", false), { mode: "off", text: "!ls" });
  assert.deepEqual(openDraft("!!ls", false), { mode: "off", text: "!!ls" });
});

test("the placeholder names the folder's last part, says Run, and carries Enter's hint only when Enter runs", () => {
  assert.equal(folderName("/home/u/projects/sova/"), "sova");
  assert.equal(folderName(null), null);
  assert.deepEqual(shellPlaceholder("shell", "sova", true), ["Run a command in sova…", "Enter runs"]);
  assert.deepEqual(shellPlaceholder("shell", "sova", false), ["Run a command in sova…", ""]);
  assert.deepEqual(shellPlaceholder("private", "sova", true), ["Run a command in sova, not shared with the model…", "Enter runs"]);
  assert.deepEqual(shellPlaceholder("shell", null, false), ["Run a command in this chat's folder…", ""]);
});

test("entering and leaving are said, the private form with what it means", () => {
  const said = (["shell", "private", "off"] as ShellMode[]).map(modeAnnouncement);
  assert.deepEqual(said, ["Shell mode on.", "Shell mode on, not shared with the model.", "Shell mode off."]);
});

test("Run needs a typed command, an enabled box and no Run still waiting for its answer", () => {
  assert.equal(canRun("ls", false, false), true);
  assert.equal(canRun("   \n", false, false), false);
  assert.equal(canRun("ls", true, false), false);
  assert.equal(canRun("ls", false, true), false);
  assert.equal(ALREADY_RUNNING, "A command is already running in this chat.");
});

test("the shortcut sheet lists ! and !!", () => {
  assert.deepEqual(
    SHELL_KEYS.map((k) => k.keys),
    ["!", "!!"],
  );
  assert.match(SHELL_KEYS[0]!.does, /runs a command in this chat's folder/);
  assert.match(SHELL_KEYS[1]!.does, /the model never sees/);
});

test("the chat's answer: started empties the box back to a message box, refused keeps the command with its reason", () => {
  const pending = { clientId: "c1", text: "pnpm test", mode: "shell" as const };
  const now = { text: "pnpm test", mode: "shell" as const };
  assert.deepEqual(onAnswer(pending, { clientId: "c1" }, now), { kind: "started", clear: true });
  assert.deepEqual(onAnswer(pending, { clientId: "c1", refused: "Sova refused this command." }, now), { kind: "refused", reason: "Sova refused this command." });
  // Changed while it was on its way: the box keeps what was typed since.
  assert.deepEqual(onAnswer(pending, { clientId: "c1" }, { text: "pnpm test --watch", mode: "shell" }), { kind: "started", clear: false });
  // Another Run's answer, or none waited on, does nothing.
  assert.deepEqual(onAnswer(pending, { clientId: "c2" }, now), { kind: "none" });
  assert.deepEqual(onAnswer(null, { clientId: "c1" }, now), { kind: "none" });
});
