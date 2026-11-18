// What starts a run, read off pi's `before_agent_start` event. From pi 1.2.0 the hook fires for two
// kinds of run: one the user's message starts (`messageType: "user"`, with `prompt` and `images`) and
// one an extension's message starts while the chat is idle (`messageType: "custom"`, with `message`
// and no prompt: a worker reporting back, a plan sent with triggerTurn). Sova's hooks ask here
// instead of reading the event, so pi's union stays in the adapter. Types only from pi.
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

/** The text of the user's message that starts this run; undefined on a run an extension's message starts. */
export function runPrompt(event: BeforeAgentStartEvent): string | undefined {
  return event.messageType === "custom" ? undefined : event.prompt;
}
