// Slash-command autocomplete logic for the composer: find the "/token" at the caret, rank the
// session's commands against it, and splice the chosen command back into the text.

import type { SlashCommand } from "../../shared/protocol";

export interface SlashToken {
  /** Index of the "/" in the text. */
  start: number;
  /** End of the token (the next whitespace, or the end of the text). */
  end: number;
  /** What follows the "/", up to the caret. */
  query: string;
}

/**
 * The slash token the caret sits in: a "/" at the start of the text or right after whitespace,
 * with no whitespace between it and the caret. Paths like "src/app" never qualify.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  if (text[start] !== "/") return null;
  const query = text.slice(start + 1, caret);
  if (query.includes("/")) return null;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return { start, end, query };
}

/** Name prefix matches first, then name substring, then description matches; each by name. */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name);
  if (!q) return [...commands].sort(byName);
  const prefix: SlashCommand[] = [];
  const inName: SlashCommand[] = [];
  const inDescription: SlashCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) inName.push(c);
    else if (c.description?.toLowerCase().includes(q)) inDescription.push(c);
  }
  return [...prefix.sort(byName), ...inName.sort(byName), ...inDescription.sort(byName)];
}

/** A command Sova answers itself rather than sending to the runtime. */
export type LocalCommand = "subagents" | "new" | "tree" | "timeline";

/**
 * The local command a message is, if any. A bare "/agents" or
 * "/subagents" opens the subagents pane here: the runtime's monitor is TUI-only, so forwarding it
 * only earns a "requires Pi's interactive TUI" notice. With arguments ("/subagents models …") it
 * is the runtime's command and goes through untouched. A bare "/new" starts a fresh session in the
 * same folder, like the TUI's own; the runtime doesn't register it. A bare "/tree" opens the
 * session pane's Timeline filtered to your messages, where rows rewind the chat: pi's own "/tree" is a TUI built-in, so
 * sent as a prompt it would reach the model as literal text. A bare "/timeline" opens the pane's
 * Timeline tab, the session's one time axis; pi has no such built-in either, so as a prompt it
 * would reach the model as literal text.
 */
export function localCommand(text: string): LocalCommand | null {
  const t = text.trim();
  if (/^\/(agents|subagents)$/.test(t)) return "subagents";
  if (t === "/new") return "new";
  if (t === "/tree") return "tree";
  if (t === "/timeline") return "timeline";
  return null;
}

/**
 * Enter on a bare local command runs it, even with the "/" menu open: "/new" also matches
 * "btw:new" by substring, and inserting that would hijack it. Shift+Enter and Tab stay the menu's.
 */
export function enterRunsLocal(text: string, key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey && localCommand(text) !== null;
}

/** No "/" menu once the whole text is a bare local command ("/ne" still gets one). */
export function slashMenuSuppressed(text: string): boolean {
  return localCommand(text) !== null;
}

/** Replaces the token with "/name " and returns the new text with the caret after the space. */
export function insertCommand(text: string, token: SlashToken, name: string): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end).replace(/^\s+/, "");
  const inserted = `/${name} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
