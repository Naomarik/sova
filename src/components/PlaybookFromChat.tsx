import { Show } from "solid-js";
import { FROM_CHAT } from "../lib/playbook-card";

/** Beside a card value the chat set (a member's model, a note, a stop, a cycle setting): the same
    muted words a chat-filled choice shows in its right-hand column. Nothing when the chat didn't set it. */
export function FromChat(props: { when: boolean }) {
  return (
    <Show when={props.when}>
      <span class="pb-from-chat">{FROM_CHAT}</span>
    </Show>
  );
}
