import { For, Show } from "solid-js";
import type { TopicBatchInfo } from "../../shared/topic-message";
import { clockTime } from "../lib/format";
import { Icon } from "./ui";

/** A topic batch (§chat.topics/row): notes other sessions pushed, reusing the `.toolcard` shell
    like WakeCard. A machine row, never a "You" bubble, though pi sees it as a user message.
    Collapsed: "Queue · {topic} · {n} notes" and who sent them; open: each note with its sender.
    A paired topic's batch (§app.overseer/pairs) also says Paired, and open, that its notes may be
    acted on with this chat's own user first, and the topic replies go to. */
export function TopicCard(props: { batch: TopicBatchInfo; time?: string }) {
  const n = () => props.batch.notes.length;
  const senders = () => [...new Map(props.batch.notes.map((it) => [it.from.sessionId, it.from])).values()];
  const href = (id: string) => `#/sid/${encodeURIComponent(id)}`;
  return (
    <details class="toolcard">
      <summary class="toolcard-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <Icon name="network" small />
        <span class="toolcard-name">
          Queue · {props.batch.topic} · {n()} {n() === 1 ? "note" : "notes"}
        </span>
        <Show when={props.batch.pair}>
          <span class="chip chip-count">Paired</span>
        </Show>
        <span class="toolcard-arg">
          <For each={senders()}>
            {(from, i) => (
              <>
                {i() > 0 ? ", " : "from "}
                <a href={href(from.sessionId)} onClick={(e) => e.stopPropagation()}>
                  {from.title || "a session"}
                </a>
              </>
            )}
          </For>
        </span>
        <Show when={props.time}>
          <span class="toolcard-wake-time">{clockTime(props.time!)}</span>
        </Show>
      </summary>
      <div class="toolcard-body">
        <Show when={props.batch.pair}>
          {(p) => (
            <p class="text-muted toolcard-section">
              Notes from this chat's paired chat, "{p().partner}". It may act on them, with your requests first. Its replies go to <code>{p().reply}</code>.
            </p>
          )}
        </Show>
        <For each={props.batch.notes}>
          {(note) => (
            <div class="toolcard-section">
              <p class="text-muted">
                <a href={href(note.from.sessionId)}>{note.from.title || "a session"}</a>
                {note.at && !Number.isNaN(Date.parse(note.at)) ? ` · ${clockTime(note.at)}` : ""}
              </p>
              <pre class="toolcard-output">{note.text}</pre>
            </div>
          )}
        </For>
      </div>
    </details>
  );
}
