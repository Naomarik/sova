import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { ShellRun } from "../../shared/protocol";
import { cardOfRun, lastLine } from "../lib/shell-runs";
import { Chip } from "./ui";
import { ShellOutputWindow } from "./ShellOutputWindow";
import "../shell-mode.css";

/**
 * The chat's running commands (§chat.shell-mode/card), floating at the bottom of the transcript, one
 * card each, stacked oldest first: the command, the live chip, its newest output line, Show Output
 * (the live output in a window) and Stop Command. When a command ends its card leaves the dock and
 * comes into the transcript as its card.
 */
export function ShellDock(props: {
  /** The chat's live runs, running or ended and not saved yet: the dock shows the running ones. */
  runs: readonly ShellRun[];
  onStop(id: string): void;
  stopping: ReadonlySet<string>;
}) {
  /** The run whose window is open, by id: it stays open as the run's output arrives. */
  const [openId, setOpenId] = createSignal<string | null>(null);
  // By id, so a card stays the same element (and keeps focus) as its output arrives.
  const running = createMemo(() => props.runs.filter((r) => r.state === "running").map((r) => r.id), undefined, {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  const runOf = (id: string) => props.runs.find((r) => r.id === id);
  /** The dock, and the pane around it (its message box). */
  let anchor: HTMLSpanElement | undefined;
  /** Focus lost with a card that left (its command ended, or its window closed after): the next
      card's Show Output, else the pane's message box, so a keyboard user is never left on the page. */
  const refocus = () =>
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const pane = anchor?.parentElement;
      // Not the message box on a touch-only screen: focusing it there raises the keyboard.
      const touchOnly = matchMedia("(hover: none) and (pointer: coarse)").matches;
      const next = pane?.querySelector<HTMLElement>(".shell-dock-card button") ?? (touchOnly ? null : pane?.querySelector<HTMLElement>(".composer-input:not([disabled])"));
      next?.focus();
    });
  createEffect(on(running, refocus, { defer: true }));
  /** The open window's run as last seen: one that ends keeps its window (it reads how it ended), and
      one saved meanwhile keeps the output it had. */
  let seen: ShellRun | null = null;
  const opened = createMemo(() => {
    const id = openId();
    if (!id) return (seen = null);
    return (seen = props.runs.find((r) => r.id === id) ?? (seen?.id === id ? seen : null));
  });
  return (
    <>
    <span ref={anchor} hidden />
    <Show when={running().length > 0}>
      <section class="shell-dock" aria-label={running().length === 1 ? "Running command" : `${running().length} running commands`}>
        <For each={running()}>
          {(id) => {
            const run = runOf(id)!;
            const line = () => lastLine(runOf(id)?.output ?? "");
            return (
              <article class="shell-dock-card" aria-label={`Running: ${run.command}`}>
                <div class="shell-dock-main">
                  <div class="shell-dock-head">
                    <Chip tone="accent" live>
                      Running
                    </Chip>
                    <code class="shell-dock-command" title={run.command}>
                      $ {run.command}
                    </code>
                  </div>
                  <code class="shell-dock-line">{line() || "No output yet."}</code>
                </div>
                <div class="shell-dock-actions">
                  <button type="button" class="button button-sm" aria-haspopup="dialog" onClick={() => setOpenId(id)}>
                    Show Output
                  </button>
                  <button
                    type="button"
                    class="button button-sm button-destructive"
                    aria-disabled={props.stopping.has(id) ? "true" : undefined}
                    onClick={() => !props.stopping.has(id) && props.onStop(id)}
                  >
                    {props.stopping.has(id) ? "Stopping…" : "Stop Command"}
                  </button>
                </div>
              </article>
            );
          }}
        </For>
      </section>
    </Show>
      <Show when={opened()}>
        {(run) => (
          <ShellOutputWindow
            card={cardOfRun(run())}
            source={{ live: true }}
            onClose={() => {
              setOpenId(null);
              refocus();
            }}
            onStop={() => props.onStop(run().id)}
            stopping={props.stopping.has(run().id)}
          />
        )}
      </Show>
    </>
  );
}
