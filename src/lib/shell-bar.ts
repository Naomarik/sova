// The running commands' bar (§chat.shell-mode/card) as state: which commands run, the list shut or
// open, the bar's own button, and Stop / Stop All with what is still stopping. Solid, no DOM:
// ShellDock.tsx draws it, ChatView feeds it the chat's runs and its socket, and
// shell-bar.browser.test.ts presses its buttons.

import { createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type { ChatClientMessage, ShellRun } from "../../shared/protocol";
import { barAction, stillStopping, stopAll, stopRun } from "./shell-runs";

export function createShellBar(o: {
  /** The chat's live runs: running, or ended and not saved yet. */
  runs(): readonly ShellRun[];
  /** Sends a frame on the chat socket; false when it didn't go. */
  send(frame: Extract<ChatClientMessage, { type: "shell_stop" }>): boolean;
}) {
  const [listOpen, setListOpen] = createSignal(false);
  const [stopping, setStopping] = createSignal<ReadonlySet<string>>(new Set());
  // By id, oldest first, so a row stays the same element (and keeps focus) as its output arrives.
  const running = createMemo(() => o.runs().filter((r) => r.state === "running").map((r) => r.id), undefined, {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  // A command that ended stops waiting; with nothing running the list shuts.
  createEffect(on(o.runs, (runs) => setStopping((s) => stillStopping(s, runs)), { defer: true }));
  createEffect(on(() => running().length, (n) => n === 0 && setListOpen(false), { defer: true }));

  return {
    running,
    runOf: (id: string) => o.runs().find((r) => r.id === id),
    newest: () => o.runs().find((r) => r.id === running().at(-1)),
    listOpen,
    toggle: () => setListOpen((v) => !v),
    /** The bar's own button: Stop Command for 1 running with the list shut, Stop All for more with it open. */
    action: () => barAction(running().length, listOpen()),
    stopping,
    allStopping: () => running().every((id) => stopping().has(id)),
    /** Stop Command: this command's stop, once. */
    stop: (id: string) => setStopping((s) => stopRun(s, id, o.send)),
    /** Stop All: each running command's own stop, none twice, none that ended. */
    stopAll: () => setStopping((s) => stopAll(s, untrack(o.runs), o.send)),
    /** The chat closed: nothing waits on a stop any more. */
    reset: () => setStopping(new Set<string>()),
  };
}

export type ShellBar = ReturnType<typeof createShellBar>;
