// Shell mode in the message box (§chat.shell-mode/box): the box's mode, how it is entered and left,
// what it says, and the draft that keeps it. Pure: Composer.tsx wires it to the textarea.

import type { ShellDraftMode } from "./draft-save";

/** The box's mode: a message, a command (`!`), or a command the model never sees (`!!`). */
export type ShellMode = "off" | "shell" | "private";

/**
 * A composer's shell mode, given only by a chat with its own agent and folder (an explicit opt-in:
 * a composer without one never has shell mode, and a leading `!` there is text).
 */
export interface ShellControl {
  /** Sends the command over the live chat socket: the id it went with, or why it didn't go (the
      command stays in the box and the reason shows under it). */
  run(command: string, priv: boolean): { clientId: string } | { refused: string };
  /** The newest answer to a Run from this tab: started (no `refused`), or refused with the reason. */
  answer(): ShellAnswer | null;
}

export interface ShellAnswer {
  clientId: string;
  /** Why the command didn't run (the kill guard, a sandbox that can't be prepared, one already
      running): it isn't saved and never reaches the model (§chat.shell-mode/running). */
  refused?: string;
}

/** The marker each mode draws at the box's left (and a command keeps in view once it is a message). */
export const SHELL_MARKER: Record<Exclude<ShellMode, "off">, string> = { shell: "!", private: "!!" };

/** The mode one more `!` into the empty box makes: `!` → `!!`; `!!` takes no more (it types). */
const deeper = (mode: ShellMode): ShellMode | null => (mode === "off" ? "shell" : mode === "shell" ? "private" : null);

/**
 * What an input into the EMPTY box does in a box that has shell mode: a typed `!` steps the mode
 * one deeper (message → `!` → `!!`), and pasted or dropped text that starts with `!` enters it as
 * typing would, its leading `!` (or `!!`) becoming the mode and the rest the command. Null: the
 * input is text, as ever (the box wasn't empty, a third `!`, anything else). A character Type
 * anywhere brought into the box (`typedAnywhere`, lib/type-anywhere) is always text: a `!` typed
 * outside the box goes in as a plain `!`.
 */
export function enterOnInput(mode: ShellMode, before: string, value: string, inputType: string, typedAnywhere = false): { mode: ShellMode; text: string } | null {
  if (typedAnywhere) return null;
  if (before !== "" || !value.startsWith("!") || deeper(mode) === null) return null;
  const pasted = inputType === "insertFromPaste" || inputType === "insertFromDrop";
  if (!pasted && value !== "!") return null;
  let next = mode;
  let text = value;
  for (let d = deeper(next); d !== null && text.startsWith("!"); d = deeper(next)) {
    next = d;
    text = text.slice(1);
  }
  return { mode: next, text };
}

/**
 * A key in the EMPTY box that leaves the mode: Backspace steps back one (`!!` → `!` → message),
 * Esc goes straight to a message box. Null: the key is the box's as ever.
 */
export function leaveOnKey(mode: ShellMode, key: string, text: string): ShellMode | null {
  if (mode === "off" || text !== "") return null;
  if (key === "Backspace") return mode === "private" ? "shell" : "off";
  if (key === "Escape") return "off";
  return null;
}

/** The box as a message holds it: a command keeps its "!" or "!!" in view, as text. */
export function asText(mode: ShellMode, text: string): string {
  return mode === "off" || text === "" ? text : SHELL_MARKER[mode] + text;
}

/** The mode the box's draft is saved with, apart from its text: none for a message or an empty command. */
export function savedMode(mode: ShellMode, text: string): ShellDraftMode | undefined {
  return mode === "off" || text === "" ? undefined : mode;
}

/**
 * A stored draft opened in a box. Its mode is the one it was saved with, never read from its text: a
 * leading "!" is only ever text. A command saved in shell mode opens as one where the box offers shell
 * mode; where it doesn't, it shows as its text ("!ls"), a message.
 */
export function openDraft(stored: { text: string; mode?: ShellDraftMode }, shell: boolean): { mode: ShellMode; text: string } {
  if (!stored.mode || !stored.text) return { mode: "off", text: stored.text };
  return shell ? { mode: stored.mode, text: stored.text } : { mode: "off", text: asText(stored.mode, stored.text) };
}

/** The last part of a folder's path, for the placeholder; null when the chat's folder isn't known. */
export function folderName(cwd: string | null | undefined): string | null {
  return cwd?.split("/").filter(Boolean).pop() ?? null;
}

/**
 * The shell box's placeholder in reading order (lib/placeholder-fit drops the key hint first): the
 * sentence, then the key hint exactly when Enter runs, as the message box's "Enter sends".
 */
export function shellPlaceholder(mode: Exclude<ShellMode, "off">, folder: string | null, enterRuns: boolean): string[] {
  const where = folder ?? "this chat's folder";
  const sentence = mode === "private" ? `Run a command in ${where}, not shared with the model…` : `Run a command in ${where}…`;
  return [sentence, enterRuns ? "Enter runs" : ""];
}

/** What the box says to a screen reader as its mode changes (the pane's polite live region). */
export function modeAnnouncement(mode: ShellMode): string {
  return mode === "shell" ? "Shell mode on." : mode === "private" ? "Shell mode on, not shared with the model." : "Shell mode off.";
}

/**
 * What the chat's answer does to the box that sent the Run (`pending`: what it held then): started,
 * the box is a message box again, unless the command was changed meanwhile (then it stays as it is);
 * refused, the command stays and the reason shows under it. Another Run's answer does nothing.
 */
export function onAnswer(
  pending: { clientId: string; text: string; mode: ShellMode } | null,
  answer: ShellAnswer | null,
  now: { text: string; mode: ShellMode },
): { kind: "none" } | { kind: "refused"; reason: string } | { kind: "started"; clear: boolean } {
  if (!pending || !answer || answer.clientId !== pending.clientId) return { kind: "none" };
  if (answer.refused) return { kind: "refused", reason: answer.refused };
  return { kind: "started", clear: now.text === pending.text && now.mode === pending.mode };
}

/** Run follows Send's rows (§chat.composer/disabled-states), and only a typed command enables it. */
export function canRun(command: string, disabled: boolean, pending: boolean): boolean {
  return !disabled && !pending && command.trim().length > 0;
}

/** Run with no open connection: the command stays in the box (§chat.shell-mode/who: only the live socket). */
export const NOT_CONNECTED = "Not connected. Run it again once the chat reconnects.";

/** Run while the box waits for its chat (connecting, reconnecting): nothing is sent, now or later. */
export const NOT_CONNECTED_YET = "Not connected yet. Run it again once the chat connects.";

/**
 * What a Run the box can't take now says under the box: a wait said only to the ear (connecting,
 * reconnecting: the transcript's note says it for the eye) gets its sentence; a reason already on
 * screen says why itself (null).
 */
export function runWhileBlocked(reason: { quiet?: boolean } | null): string | null {
  return reason?.quiet ? NOT_CONNECTED_YET : null;
}

/** A refusal's text in pieces: what it quotes in backticks is code, drawn as code (the kill guard's reply). */
export function codeSpans(text: string): { text: string; code: boolean }[] {
  const parts = text.split("`");
  // An odd count of backticks leaves the last one unmatched: it is text, as written.
  if (parts.length % 2 === 0) return [{ text, code: false }];
  return parts.map((t, i) => ({ text: t, code: i % 2 === 1 })).filter((p) => p.text !== "");
}

/** The shortcut sheet's shell-mode rows, after the palette's keys (§app.command-palette/shortcut-sheet). */
export const SHELL_KEYS: readonly { keys: string; does: string }[] = [
  { keys: "!", does: "In an empty message box: runs a command in this chat's folder." },
  { keys: "!!", does: "In an empty message box: runs a command the model never sees." },
];
