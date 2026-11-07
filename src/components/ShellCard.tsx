import { createSignal, Show } from "solid-js";
import { AFTER_REPLY, clock, lastLines, NOT_SHARED, shellNotes, shellStatus, type ShellCardData } from "../lib/shell-runs";
import { Chip } from "./ui";
import { ShellOutputWindow, type OutputSource } from "./ShellOutputWindow";
import "../shell-mode.css";

/**
 * A command you ran, once it ended (§chat.shell-mode/card): the command in mono, how it ended and how
 * long it took, its last 3 lines, and Show Full Output, which opens the whole output in a window.
 * The same card for a saved row and a run that ended and waits to be saved, one run in pi's own terminal included. A
 * running command is the dock's (ShellDock), not this card.
 */
export function ShellCard(props: {
  card: ShellCardData & { underReply?: boolean };
  /** The model's reply is still running (the mid-reply note holds only until it ends). */
  replying?: boolean;
  /** Where Show Full Output reads from: a saved row's whole output; absent, the output the card holds. */
  full?: { path: string; entry: string };
}) {
  const [open, setOpen] = createSignal(false);
  const source = (): OutputSource => props.full ?? { live: true };
  const status = () => shellStatus(props.card);
  const notes = () => shellNotes(props.card, !!props.replying);
  /** How long it took, when the run says (a command saved before durations were kept doesn't). */
  const took = () => (props.card.durationMs === undefined ? null : clock(props.card.durationMs));
  return (
    <article class="shell-card" aria-label="Command you ran">
      <div class="shell-card-head">
        <code class="shell-card-command">$ {props.card.command}</code>
        <Chip tone={status().tone === "live" ? "accent" : status().tone === "error" ? "error" : undefined} live={status().tone === "live"}>
          {status().word}
        </Chip>
        <Show when={took()}>{(t) => <span class="shell-card-took">took {t()}</span>}</Show>
      </div>
      {/* Its last 3 lines; the whole output is one press away (Show Full Output). */}
      <Show when={props.card.output}>
        <pre class="shell-card-output" tabindex="0" aria-label="Last lines of output">
          {lastLines(props.card.output, 3)}
        </pre>
      </Show>
      <Show when={notes().notShared}>
        <p class="shell-card-note">{NOT_SHARED}</p>
      </Show>
      <Show when={notes().afterReply}>
        <p class="shell-card-note">{AFTER_REPLY}</p>
      </Show>
      <Show when={!props.card.running && (props.card.output || props.full)}>
        <div class="shell-card-actions">
          <button type="button" class="button button-sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>
            Show Full Output
          </button>
        </div>
      </Show>
      <Show when={open()}>
        <ShellOutputWindow card={props.card} source={source()} onClose={() => setOpen(false)} />
      </Show>
    </article>
  );
}
