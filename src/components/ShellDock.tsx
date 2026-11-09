import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { ShellRun } from "../../shared/protocol";
import { cardOfRun, clock, lastLine, NOT_SHARED } from "../lib/shell-runs";
import type { ShellBar } from "../lib/shell-bar";
import { Chip } from "./ui";
import { ShellOutputWindow } from "./ShellOutputWindow";
import "../shell-mode.css";

let lists = 0;

/**
 * The chat's running commands (§chat.shell-mode/card): one quiet bar above the message box, "N
 * running" with the newest command and its latest line. With exactly 1 running, Stop Command sits on
 * the bar. Show All opens the list above it: each command, how long it has run, its latest line, Show
 * Output (the live output in a window) and Stop Command; with more than 1, Stop All. When a command
 * ends it leaves the list and comes into the transcript as its card.
 */
export function ShellDock(props: {
  /** The bar's state (lib/shell-bar): what runs, the list, Stop and Stop All. */
  bar: ShellBar;
}) {
  const bar = props.bar;
  const listId = `shell-list-${++lists}`;
  /** The run whose window is open, by id: it stays open as the run's output arrives. */
  const [openId, setOpenId] = createSignal<string | null>(null);
  const { running, runOf, newest, listOpen, buttons, stopping, allStopping } = bar;
  /** Now, each second while the list shows how long each command has run. */
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!listOpen() || running().length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  /** The bar, and the pane around it (its message box). */
  let anchor: HTMLSpanElement | undefined;
  /** Focus lost with a row that left (its command ended, the list closed as the count fell to 1, or its
      window closed after): the list's first button or the bar's (with 1 running, its Show Output),
      else the pane's message box, so a keyboard user is never left on the page. */
  const refocus = () =>
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const pane = anchor?.parentElement;
      // Not the message box on a touch-only screen: focusing it there raises the keyboard.
      const touchOnly = matchMedia("(hover: none) and (pointer: coarse)").matches;
      const next = pane?.querySelector<HTMLElement>(".shell-list button, .shell-bar button") ?? (touchOnly ? null : pane?.querySelector<HTMLElement>(".composer-input:not([disabled])"));
      next?.focus();
    });
  createEffect(on(running, refocus, { defer: true }));
  /** The run whose window is open, as last seen: one that ends keeps its window (it reads how it ended). */
  let seen: ShellRun | null = null;
  const opened = createMemo(() => {
    const id = openId();
    if (!id) return (seen = null);
    return (seen = runOf(id) ?? (seen?.id === id ? seen : null));
  });

  const BarSummary = () => (
    <>
      <Chip tone="accent" live>
        {running().length} running
      </Chip>
      <code class="shell-bar-line">
        {newest()?.command}: {lastLine(newest()?.output ?? "") || "No output yet."}
      </code>
    </>
  );
  const StopButton = (p: { id: string }) => (
    <button
      type="button"
      class="button button-sm button-destructive"
      aria-disabled={stopping().has(p.id) ? "true" : undefined}
      onClick={() => !stopping().has(p.id) && bar.stop(p.id)}
    >
      {stopping().has(p.id) ? "Stopping…" : "Stop Command"}
    </button>
  );

  return (
    <>
      <span ref={anchor} hidden />
      <Show when={running().length > 0}>
        <section class="shell-dock" aria-label={running().length === 1 ? "Running command" : `${running().length} running commands`}>
          <Show when={listOpen()}>
            <ul class="shell-list" id={listId}>
              <For each={running()}>
                {(id) => {
                  const run = runOf(id)!;
                  return (
                    <li class="shell-list-row" aria-label={`Running: ${run.command}`}>
                      <div class="shell-list-main">
                        <div class="shell-list-head">
                          <code class="shell-list-command" title={run.command}>
                            $ {run.command}
                          </code>
                          <span class="shell-list-time">{clock(now() - run.startedAt)}</span>
                        </div>
                        <code class="shell-list-line">{lastLine(runOf(id)?.output ?? "") || "No output yet."}</code>
                        <Show when={run.private}>
                          <span class="shell-list-note">{NOT_SHARED}</span>
                        </Show>
                      </div>
                      <div class="shell-list-actions">
                        <button type="button" class="button button-sm" aria-haspopup="dialog" onClick={() => setOpenId(id)}>
                          Show Output
                        </button>
                        <StopButton id={id} />
                      </div>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
          <div class="shell-bar">
            {/* The chip and the newest command's latest line: Show All / Hide for 2 or more, plain text for 1. */}
            <Show
              when={buttons().showAll}
              fallback={
                <div class="shell-bar-summary">
                  <BarSummary />
                </div>
              }
            >
              <button type="button" class="shell-bar-toggle" aria-expanded={listOpen()} aria-controls={listId} onClick={() => bar.toggle()}>
                <BarSummary />
                <span class="shell-bar-show">{listOpen() ? "Hide" : "Show All"}</span>
              </button>
            </Show>
            <div class="shell-bar-actions">
            <Show when={buttons().showOutput && newest()}>
              {(run) => (
                <>
                  <button type="button" class="button button-sm" aria-haspopup="dialog" onClick={() => setOpenId(run().id)}>
                    Show Output
                  </button>
                  <StopButton id={run().id} />
                </>
              )}
            </Show>
            <Show when={buttons().stopAll}>
              <button
                type="button"
                class="button button-sm button-destructive"
                aria-disabled={allStopping() ? "true" : undefined}
                onClick={() => !allStopping() && bar.stopAll()}
              >
                {allStopping() ? "Stopping…" : `Stop All ${running().length}`}
              </button>
            </Show>
            </div>
          </div>
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
            onStop={() => bar.stop(run().id)}
            stopping={stopping().has(run().id)}
          />
        )}
      </Show>
    </>
  );
}
