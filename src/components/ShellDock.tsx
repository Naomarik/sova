import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { ShellRun } from "../../shared/protocol";
import { barAction, cardOfRun, clock, lastLine, NOT_SHARED } from "../lib/shell-runs";
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
  /** The chat's live runs, running or ended and not saved yet: the bar counts the running ones. */
  runs: readonly ShellRun[];
  onStop(id: string): void;
  /** Stops every running command, each with its own stop. */
  onStopAll(): void;
  stopping: ReadonlySet<string>;
}) {
  const listId = `shell-list-${++lists}`;
  /** The run whose window is open, by id: it stays open as the run's output arrives. */
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [listOpen, setListOpen] = createSignal(false);
  // By id, oldest first, so a row stays the same element (and keeps focus) as its output arrives.
  const running = createMemo(() => props.runs.filter((r) => r.state === "running").map((r) => r.id), undefined, {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  const runOf = (id: string) => props.runs.find((r) => r.id === id);
  const newest = () => runOf(running().at(-1) ?? "");
  const action = () => barAction(running().length, listOpen());
  /** Now, each second while the list shows how long each command has run. */
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!listOpen() || running().length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  createEffect(on(() => running().length, (n) => n === 0 && setListOpen(false), { defer: true }));

  /** The bar, and the pane around it (its message box). */
  let anchor: HTMLSpanElement | undefined;
  /** Focus lost with a row that left (its command ended, or its window closed after): the bar's own
      button, else the pane's message box, so a keyboard user is never left on the page. */
  const refocus = () =>
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const pane = anchor?.parentElement;
      // Not the message box on a touch-only screen: focusing it there raises the keyboard.
      const touchOnly = matchMedia("(hover: none) and (pointer: coarse)").matches;
      const next = pane?.querySelector<HTMLElement>(".shell-list button, .shell-bar-toggle") ?? (touchOnly ? null : pane?.querySelector<HTMLElement>(".composer-input:not([disabled])"));
      next?.focus();
    });
  createEffect(on(running, refocus, { defer: true }));
  /** The run whose window is open, as last seen: one that ends keeps its window (it reads how it ended). */
  let seen: ShellRun | null = null;
  const opened = createMemo(() => {
    const id = openId();
    if (!id) return (seen = null);
    return (seen = props.runs.find((r) => r.id === id) ?? (seen?.id === id ? seen : null));
  });

  const StopButton = (p: { id: string }) => (
    <button
      type="button"
      class="button button-sm button-destructive"
      aria-disabled={props.stopping.has(p.id) ? "true" : undefined}
      onClick={() => !props.stopping.has(p.id) && props.onStop(p.id)}
    >
      {props.stopping.has(p.id) ? "Stopping…" : "Stop Command"}
    </button>
  );
  const allStopping = () => running().every((id) => props.stopping.has(id));

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
            <button type="button" class="shell-bar-toggle" aria-expanded={listOpen()} aria-controls={listId} onClick={() => setListOpen((o) => !o)}>
              <Chip tone="accent" live>
                {running().length} running
              </Chip>
              <code class="shell-bar-line">
                {newest()?.command}: {lastLine(newest()?.output ?? "") || "No output yet."}
              </code>
              <span class="shell-bar-show">{listOpen() ? "Hide" : "Show All"}</span>
            </button>
            <Switch>
              <Match when={action() === "stop" && newest()}>{(run) => <StopButton id={run().id} />}</Match>
              <Match when={action() === "stop-all"}>
                <button
                  type="button"
                  class="button button-sm button-destructive"
                  aria-disabled={allStopping() ? "true" : undefined}
                  onClick={() => !allStopping() && props.onStopAll()}
                >
                  {allStopping() ? "Stopping…" : `Stop All ${running().length}`}
                </button>
              </Match>
            </Switch>
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
            onStop={() => props.onStop(run().id)}
            stopping={props.stopping.has(run().id)}
          />
        )}
      </Show>
    </>
  );
}
