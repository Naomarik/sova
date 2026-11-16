import { Show } from "solid-js";
import type { RunMessageInfo } from "../../shared/playbook-run";
import { clockTime } from "../lib/format";
import { Icon } from "./ui";

/** The message Start gave the main chat: one folded row, the `.toolcard` shell a schedule's fire uses
    (WakeCard.tsx). The playbook's card above the composer is what the person reads; the whole text the
    chat was sent is one click away, exactly as sent. */
export function PlaybookRunMessage(props: { run: RunMessageInfo; text: string; time?: string }) {
  return (
    <details class="toolcard">
      <summary class="toolcard-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <Icon name="activity" small />
        <span class="toolcard-name">Started playbook {props.run.title}</span>
        <span class="toolcard-arg">revision {props.run.revision} · Show What Was Sent</span>
        <Show when={props.time}>{(t) => <span class="toolcard-wake-time">{clockTime(t())}</span>}</Show>
      </summary>
      <div class="toolcard-body">
        <div class="toolcard-section">
          <pre class="toolcard-output">{props.text}</pre>
        </div>
      </div>
    </details>
  );
}
