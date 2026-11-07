import assert from "node:assert/strict";
import { test } from "node:test";
import { ALREADY_RUNNING, NOT_CONNECTED_YET, codeSpans, runWhileBlocked, canRun, asText, savedMode, enterOnInput, folderName, leaveOnKey, modeAnnouncement, onAnswer, openDraft, SHELL_KEYS, SHELL_MARKER, shellPlaceholder, type ShellMode } from "./shell-mode";

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

test("a draft written in shell mode keeps its mode apart from its text, and opens in it", () => {
  for (const mode of ["shell", "private"] as const) {
    assert.equal(savedMode(mode, "pnpm test"), mode);
    assert.deepEqual(openDraft({ text: "pnpm test", mode }, true), { mode, text: "pnpm test" });
  }
  assert.equal(savedMode("off", "hello"), undefined);
  // An empty command is no draft: nothing is kept, mode included.
  assert.equal(savedMode("shell", ""), undefined);
  assert.deepEqual(openDraft({ text: "", mode: "shell" }, true), { mode: "off", text: "" });
});

test("a leading ! in a draft's text is only ever text, with shell mode or without", () => {
  // A message that starts with "!" (a Markdown image, a draft set by a script or a card) stays a message.
  for (const text of ["!ls", "!!ls", "![shot](a.png)"]) {
    assert.deepEqual(openDraft({ text }, true), { mode: "off", text });
    assert.deepEqual(openDraft({ text }, false), { mode: "off", text });
  }
});

test("a command opened where the box has no shell mode shows as its text, marker in view", () => {
  assert.deepEqual(openDraft({ text: "ls", mode: "shell" }, false), { mode: "off", text: "!ls" });
  assert.deepEqual(openDraft({ text: "ls", mode: "private" }, false), { mode: "off", text: "!!ls" });
  assert.equal(asText("private", "ls"), "!!ls");
  assert.equal(asText("off", "!ls"), "!ls");
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

test("Run while the box waits for its chat says why under the box, once nothing on screen does", () => {
  // Connecting and Reconnecting are said for the ear only (the transcript's note says them).
  assert.equal(runWhileBlocked({ quiet: true }), NOT_CONNECTED_YET);
  assert.equal(NOT_CONNECTED_YET, "Not connected yet. Run it again once the chat connects.");
  // A reason already on screen ("Switching model…") says why itself; no reason, nothing to add.
  assert.equal(runWhileBlocked({}), null);
  assert.equal(runWhileBlocked(null), null);
});

test("a refusal's backticked quotes are code, and an unmatched backtick is text", () => {
  assert.deepEqual(codeSpans("Sova refused this command. `pkill -0 node`: too broad. Fix: `kill $(cat app.pid)`."), [
    { text: "Sova refused this command. ", code: false },
    { text: "pkill -0 node", code: true },
    { text: ": too broad. Fix: ", code: false },
    { text: "kill $(cat app.pid)", code: true },
    { text: ".", code: false },
  ]);
  assert.deepEqual(codeSpans("A command is already running in this chat."), [{ text: "A command is already running in this chat.", code: false }]);
  assert.deepEqual(codeSpans("odd ` one"), [{ text: "odd ` one", code: false }]);
});
