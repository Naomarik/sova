import { createSignal, onCleanup, Show } from "solid-js";
import { tildePath } from "../lib/format";
import { AFTER_REPLY, NOT_SHARED, shellNotes, shellStatus, type ShellCardData } from "../lib/shell-runs";
import { home } from "../lib/ui-state";
import { Chip } from "./ui";
import { ShellOutputWindow, type OutputSource } from "./ShellOutputWindow";
import "../shell-mode.css";

/** Within this many px of the output's end, a running command's output keeps following its end; a
    card opens at that end. */
const FOLLOW_SLACK = 24;

/**
 * A command you ran, once it ended (§chat.shell-mode/card): the command in mono, the output it kept,
 * how it ended, and Show Full Output, which opens the whole output in a window. The same card for a
 * saved row and a run that ended and waits to be saved, one run in pi's own terminal included. A
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
  /** At the output's end until the reader scrolls up: the card opens there, where the latest lines are. */
  let atEnd = true;
  return (
    <article class="shell-card" aria-label="Command you ran">
      <div class="shell-card-head">
        <code class="shell-card-command">$ {props.card.command}</code>
        <Chip tone={status().tone === "live" ? "accent" : status().tone === "error" ? "error" : undefined} live={status().tone === "live"}>
          {status().word}
        </Chip>
      </div>
      <Show when={props.card.output}>
        <pre
          class="shell-card-output"
          ref={(el) => {
            // It opens at the end of the output, where the latest lines are (a cut one most of all):
            // at its first layout, which may come later than now (a row drawn off screen).
            const sized = new ResizeObserver(() => {
              if (atEnd) el.scrollTop = el.scrollHeight;
            });
            sized.observe(el);
            onCleanup(() => sized.disconnect());
          }}
          tabindex="0"
          aria-label="Output"
          onScroll={(e) => {
            const el = e.currentTarget;
            atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
          }}
        >
          {props.card.output}
        </pre>
      </Show>
      <Show when={notes().cut}>
        {(cut) => (
          <p class="shell-card-note">
            {cut()}
            <Show when={notes().fullOutputPath}>
              {(path) => (
                <>
                  {" · the whole output is in "}
                  <code>{tildePath(path(), home())}</code>
                </>
              )}
            </Show>
          </p>
        )}
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
