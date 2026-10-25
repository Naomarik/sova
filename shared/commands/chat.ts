/**
 * In-chat actions with an outcome to wait for (§app/chat-actions): Stop, Compact, Rewind,
 * Regenerate, Remove a queued message and Reload Now, each one request to POST /api/chat/action
 * (server/chat-actions.ts), which hands the chat the same frame its button sends; and a project mode's
 * command (POST /api/mode/command). Part of the
 * command catalogue, through shared/commands/other.ts's OTHER_ENTRIES (rules: agents/server/commands/overview.md).
 * No dialog answer: it can approve a sandbox widening. Pure, erasable syntax only.
 */
import type { CommandEntry, CommandParam } from "./types.ts";

const session: CommandParam = { type: "session", description: "The session, by id or by path", in: "query", key: "path", required: true };
const wait: CommandParam = {
  type: "integer",
  description: "How long to wait for the outcome, in ms (0 to 300000; default 30000). Past it the answer is `unknown` (exit 5), never a retry",
  in: "query",
};
const route = (type: string) => ({ method: "POST" as const, path: "/api/chat/action", fixed: { type } });
const entry = (id: string, label: string, summary: string, type: string, params: Record<string, CommandParam> = {}): CommandEntry => ({
  id,
  label,
  summary,
  effect: "changes",
  params: { session, wait, ...params },
  route: route(type),
  sessionKey: "path",
  sessionFile: "refuses-live",
  meshNeed: "sessions",
});

export const CHAT_ENTRIES: CommandEntry[] = [
  entry("chat.stop", "Stop", "Stop a chat's reply, as its Stop button does, and wait until it has stopped.", "abort"),
  entry("chat.compact", "Compact", "Compact a chat's context now, as /compact does, and wait for the outcome.", "compact", {
    instructions: { type: "string", description: "What the summary should keep", in: "body" },
  }),
  entry("chat.rewind", "Rewind", "Rewind a chat to just before one of its messages; the answer holds that message's text.", "rewind", {
    entry: { type: "string", description: "The user message's transcript row id", in: "body", key: "entryId", required: true },
  }),
  entry("chat.regenerate", "Regenerate", "Redo the reply an assistant row belongs to, with the chat's current model.", "regenerate", {
    entry: { type: "string", description: "The assistant row's transcript id", in: "body", key: "entryId", required: true },
  }),
  entry("chat.queue.remove", "Remove Queued Message", "Remove one still-unsent message from a chat's queue.", "queue_remove", {
    item: { type: "string", description: "The queued message's id", in: "body", key: "itemId", required: true },
  }),
  entry("chat.reload-code", "Reload Now", "Reload a chat on the server's current code, now or at its next quiet moment.", "reload_code"),
  // A project mode's command (§chat.mode-menu/project-mode-commands): `sova run mode.<id>.<name>` lands here.
  {
    id: "chat.mode-command",
    label: "Run Mode Command",
    summary: "Run a command of a project mode that is on in a chat, from the version the chat approved.",
    effect: "changes",
    params: {
      session,
      mode: { type: "string", description: "The project mode's id", in: "body", required: true },
      name: { type: "string", description: "The command's name", in: "body", required: true },
      args: { type: "json", description: "The command's arguments, a JSON object", in: "body" },
    },
    route: { method: "POST", path: "/api/mode/command" },
    sessionKey: "path",
    sessionFile: "refuses-live",
    meshNeed: "full",
  },
];
