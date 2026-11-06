import { createEffect, on, Show } from "solid-js";
import { tildePath } from "../lib/format";
import { AFTER_REPLY, NOT_SHARED, shellNotes, shellStatus, type ShellCardData } from "../lib/shell-runs";
import { home } from "../lib/ui-state";
import { Chip } from "./ui";
import "../shell-mode.css";

/** Within this many px of the output's end, a running command's output keeps following its end. */
const FOLLOW_SLACK = 24;

/**
 * A command you ran (§chat.shell-mode/card): the command in mono, its output as it arrives, and
 * while it runs the live chip and Stop Command; once it ends, how it ended. The same card for a live
 * run and a saved row, one run in pi's own terminal included.
 */
export function ShellCard(props: {
  card: ShellCardData & { underReply?: boolean };
  /** The model's reply is still running (the mid-reply note holds only until it ends). */
  replying?: boolean;
  /** The card's Stop Command (a live run of this chat only). */
  onStop?: () => void;
  /** A stop is on its way: Stop Command waits for the end. */
  stopping?: boolean;
}) {
  const status = () => shellStatus(props.card);
  const notes = () => shellNotes(props.card, !!props.replying);
  let out: HTMLPreElement | undefined;
  /** At the output's end when it last changed: a running command's new output then keeps it there. */
  let atEnd = true;
  createEffect(
    on(
      () => props.card.output,
      () => {
        if (!out || !props.card.running || !atEnd) return;
        out.scrollTop = out.scrollHeight;
      },
    ),
  );
  return (
    <article class="shell-card" aria-label="Command you ran">
      <div class="shell-card-head">
        <code class="shell-card-command">$ {props.card.command}</code>
        <Chip tone={status().tone === "live" ? "accent" : status().tone === "error" ? "error" : undefined} live={status().tone === "live"}>
          {status().word}
        </Chip>
        <Show when={props.card.running && props.onStop}>
          {(stop) => (
            <button
              type="button"
              class="button button-sm button-destructive shell-card-stop"
              aria-disabled={props.stopping ? "true" : undefined}
              onClick={() => !props.stopping && stop()()}
            >
              Stop Command
            </button>
          )}
        </Show>
      </div>
      <Show when={props.card.output}>
        <pre
          class="shell-card-output"
          ref={out}
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
    </article>
  );
}
