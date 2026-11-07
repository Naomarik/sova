import { createEffect, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { ApiError, fetchShellOutput } from "../lib/api";
import { createOutputReader, OUTPUT_GONE, readWords } from "../lib/shell-output";
import { shellStatus, type ShellCardData } from "../lib/shell-runs";
import { NOT_SHARED } from "../lib/shell-runs";
import { Chip, trapFocus } from "./ui";
import "../shell-mode.css";

/** Within this many px of the output's end, new live output keeps the window at its end. */
const FOLLOW_SLACK = 24;

/** Where the window's output comes from: the run's live output as it arrives, or a saved row's whole
    output, read from the server a page at a time. */
export type OutputSource = { live: true } | { path: string; entry: string };

/**
 * A command's output in a window (§chat.shell-mode/card): a running command's as it arrives, with Stop
 * Command; a saved one's in full, Load More following its pages. Esc, Close or the scrim close it, and
 * focus goes back to the button that opened it.
 */
export function ShellOutputWindow(props: {
  card: ShellCardData;
  source: OutputSource;
  onClose(): void;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const status = () => shellStatus(props.card);
  const titleId = `shell-window-${Math.random().toString(36).slice(2, 8)}`;
  const saved = () => ("entry" in props.source ? props.source : null);
  const reader = createOutputReader({
    fetch: (from) => {
      const s = saved()!;
      return fetchShellOutput(s.path, s.entry, from);
    },
    gone: (e) => e instanceof ApiError && e.status === 404 && (e.body as { code?: string } | undefined)?.code === "gone",
  });
  const { read, error, loading } = reader;
  const load = () => (saved() ? reader.load() : Promise.resolve());
  onCleanup(() => reader.close());
  let out: HTMLPreElement | undefined;
  let atEnd = true;
  let dialog: HTMLDivElement | undefined;
  let close: HTMLButtonElement | undefined;
  // Stop Command leaves with the run it stopped: focus it held goes to Close, so it stays in the
  // window and Esc still closes it.
  createEffect(
    on(
      () => props.card.running,
      (running) => {
        if (running || !dialog) return;
        queueMicrotask(() => {
          if (dialog?.isConnected && !dialog.contains(document.activeElement)) close?.focus();
        });
      },
      { defer: true },
    ),
  );
  onMount(() => void load());

  /** What the window shows: the live output, or the whole output read so far. */
  const text = () => (saved() ? read()?.text ?? "" : props.card.output);
  const more = () => {
    const r = read();
    return r ? readWords(r, new TextEncoder().encode(r.text).length) : null;
  };
  createEffect(
    on(text, () => {
      if (out && atEnd && !saved()) out.scrollTop = out.scrollHeight;
    }),
  );

  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal modal-wide shell-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => {
          dialog = el;
          trapFocus(el);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <i class="sheet-grip" aria-hidden="true" />
        <div class="modal-head shell-window-head">
          <h2 class="modal-title" id={titleId}>
            Command Output
          </h2>
          <div class="shell-card-head">
            <code class="shell-card-command">$ {props.card.command}</code>
            <Chip tone={status().tone === "live" ? "accent" : status().tone === "error" ? "error" : undefined} live={status().tone === "live"}>
              {status().word}
            </Chip>
          </div>
          <Show when={props.card.private}>
            <p class="shell-card-note">{NOT_SHARED}</p>
          </Show>
        </div>
        <div class="modal-body shell-window-body">
          <Show when={error()}>
            {(why) => (
              <p class="shell-card-note" role="alert">
                {why()}
              </p>
            )}
          </Show>
          <Show when={saved() && !read() && loading()}>
            <p class="shell-card-note" role="status">
              Loading the output…
            </p>
          </Show>
          <Show when={text() || (!saved() && !props.card.running) || (read() && read()!.total === 0)}>
            <pre
              class="shell-window-output"
              ref={(el) => {
                out = el;
                if (!saved()) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
              }}
              tabindex="0"
              aria-label="Output"
              onScroll={(e) => {
                const el = e.currentTarget;
                atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
              }}
            >
              {text() || "No output."}
            </pre>
          </Show>
          <Show when={!saved() && props.card.running && !text()}>
            <p class="shell-card-note">No output yet.</p>
          </Show>
        </div>
        <div class="modal-foot">
          <Show when={props.card.running && props.onStop}>
            {(stop) => (
              <button
                type="button"
                class="button button-destructive"
                aria-disabled={props.stopping ? "true" : undefined}
                onClick={() => !props.stopping && stop()()}
              >
                {props.stopping ? "Stopping…" : "Stop Command"}
              </button>
            )}
          </Show>
          <Show when={more()}>
            {(words) => (
              <>
                <span class="shell-card-note">{words()}</span>
                <button type="button" class="button" aria-disabled={loading() ? "true" : undefined} onClick={() => void load()}>
                  {loading() ? "Loading…" : "Load More"}
                </button>
              </>
            )}
          </Show>
          <Show when={error() && error() !== OUTPUT_GONE}>
            <button type="button" class="button" onClick={() => void load()}>
              Try Again
            </button>
          </Show>
          <span class="modal-spacer" />
          <button ref={close} type="button" class="button button-ghost" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}
