// `/compact [instructions]`: the one slash command Sova runs itself on a chat runtime (pi's own
// AgentSession.compact, the TUI's /compact). Shared so the server's interception and the client's
// "is this a compaction" read the same text the same way.
import type { SlashCommand } from "./protocol";

/** The builtin row the commands list leads with (server/chat-manager.ts listCommands). */
export const COMPACT_COMMAND: SlashCommand = {
  name: "compact",
  description: "Summarize older context to free the window",
  source: "builtin",
};

/** The refusal a /compact carrying images gets: nothing is dropped silently, and it is no message. */
export const COMPACT_IMAGES_REFUSAL = "Send /compact without images.";

/**
 * Whether `text`, as a WHOLE message, is `/compact` with optional instructions after whitespace:
 * `{}` for a bare one, `{ instructions }` with them trimmed, null for anything else. `/compacting`
 * and `please /compact` are ordinary messages.
 */
export function compactCommand(text: string): { instructions?: string } | null {
  const m = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const instructions = m[1]?.trim();
  return instructions ? { instructions } : {};
}
