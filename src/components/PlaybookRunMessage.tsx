import { Show, useContext } from "solid-js";
import type { RunMessageInfo } from "../../shared/playbook-run";
import { clockTime } from "../lib/format";
import { PlaybookRunsContext, showPlaybookCard } from "./PlaybookCard";
import { Icon } from "./ui";
import "./PlaybookCard.css";

/** The message Start gave the main chat, as the conversation's mark of when the run started: one
    row, the `.toolcard` shell a schedule's fire uses (WakeCard.tsx). The run's state is on its
    strip above the message box; Open Card opens that card, and the whole text the chat was sent
    is one click away, exactly as sent. */
export function PlaybookRunMessage(props: { run: RunMessageInfo; text: string; time?: string }) {
  /** This pane's runs, when a chat view shows the row: Open Card opens the card here. */
  const store = useContext(PlaybookRunsContext);
  return (
    <div class="pb-mark">
      <details class="toolcard">
        <summary class="toolcard-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <Icon name="activity" small />
          <span class="toolcard-name">Playbook {props.run.title} started</span>
          <span class="toolcard-arg">revision {props.run.revision} · Show What Was Sent</span>
          <Show when={props.time}>{(t) => <span class="toolcard-wake-time">{clockTime(t())}</span>}</Show>
        </summary>
        <div class="toolcard-body">
          <div class="toolcard-section">
            <pre class="toolcard-output">{props.text}</pre>
          </div>
        </div>
      </details>
      {/* Beside the row, never inside its summary: a button in a summary loses its own press. Only
          where a chat's cards can open it: a read-only watch has none, so no button there. */}
      <Show when={store}>
        {(here) => (
          <button type="button" class="button button-sm button-ghost pb-mark-open" onClick={() => showPlaybookCard(props.run.runId, here())}>
            Open Card
          </button>
        )}
      </Show>
    </div>
  );
}
