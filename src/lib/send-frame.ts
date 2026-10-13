import type { ChatClientMessage } from "../../shared/protocol";

/**
 * The frame a chat send goes out as (§chat.composer/behavior). A message typed in the composer is
 * ALWAYS a `steer`, whatever this tab believes about the run: idle, the server starts a turn with it
 * exactly as with a prompt; busy, it lands at the agent's next step with every other waiting steer,
 * even when this tab hasn't seen the run start yet (a quick second message). Everything else stays a
 * `prompt`, a follow-up mid-turn: a playbook (a new job, never steered into a turn), a quick action or
 * review button, and a card's confirm click, which carries its `confirm` field.
 */
export function sendFrame(text: string, clientId: string, o: { typed: boolean; confirm?: string }): Extract<ChatClientMessage, { type: "prompt" | "steer" }> {
  if (o.typed && !o.confirm) return { type: "steer", text, clientId };
  return { type: "prompt", text, clientId, ...(o.confirm ? { confirm: o.confirm } : {}) };
}
