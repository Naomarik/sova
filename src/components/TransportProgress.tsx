// A transport's progress (§app.transport/dialog, words in §design.copy-deck/transport): the dialog's steps, in order,
// each done with a tick, the current one with the live dot, a stopped one with its reason; while it sends, a meter of
// what arrived with the speed and time left once known. And the chat head's compact line, which opens the dialog.
import { createMemo, For, Show } from "solid-js";
import { headParts, sendingOf, transportSteps } from "../lib/transport-progress";
import type { TransportView } from "../lib/transport-api";
import { TransportWaiting } from "./TransportHelpers";
import { Icon } from "./ui";
import "./TransportProgress.css";

const HIDDEN: Record<string, string> = { done: "done", current: "now", failed: "stopped", todo: "" };

export function TransportSteps(props: { t: TransportView; onInterrupt(): void }) {
  const steps = createMemo(() => transportSteps(props.t));
  const sending = createMemo(() => sendingOf(props.t));
  // What a screen reader hears: the step, not every count while it sends.
  const now = createMemo(() => steps().find((s) => s.state === "current" || s.state === "failed")?.label ?? "");
  return (
    <>
      <span class="visually-hidden" role="status" aria-live="polite">
        {now()}
      </span>
      <ol class="transport-steps" aria-label="Transport steps">
        <For each={steps()}>
          {(s) => (
            <li class="transport-step" data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
              <span class="transport-step-mark" aria-hidden="true">
                <Show when={s.state === "done"}>
                  <Icon name="check" small />
                </Show>
                <Show when={s.state === "current"}>
                  <span class="live-dot" />
                </Show>
                <Show when={s.state === "failed"}>
                  <Icon name="alert-circle" small />
                </Show>
                <Show when={s.state === "todo"}>
                  <span class="transport-step-todo" />
                </Show>
              </span>
              <span class="transport-step-text">
                <span class="transport-step-label">
                  {s.label}
                  <Show when={HIDDEN[s.state]}>{(w) => <span class="visually-hidden"> · {w()}</span>}</Show>
                </span>
                <Show when={s.state === "current" && s.id === "helpers"}>
                  <TransportWaiting waiting={props.t.ext?.waiting ?? 0} onInterrupt={() => props.onInterrupt()} />
                </Show>
                <Show when={s.state === "current" && s.id === "send" && sending()}>
                  {(v) => (
                    <div class="meter transport-meter">
                      <p class="meter-head">
                        <span class="meter-label">Sent</span>
                        <span class="meter-value">{v().amount}</span>
                      </p>
                      <div class="meter-track" aria-hidden="true">
                        <span class="meter-fill transport-meter-fill" style={{ "--meter-pct": `${v().percent}%` }} />
                      </div>
                      <Show when={v().speed}>
                        <p class="meter-context">{[v().speed, v().left].filter(Boolean).join(" · ")}</p>
                      </Show>
                    </div>
                  )}
                </Show>
                <Show when={s.state === "failed" && props.t.needsYou?.reason}>{(r) => <span class="transport-step-reason">{r()}</span>}</Show>
              </span>
            </li>
          )}
        </For>
      </ol>
    </>
  );
}

/** The chat head's line while a transport of this chat runs: "Moving to Laptop · Sending 12 of 34 MB"; opens the dialog. */
export function TransportHeadStatus(props: { t: TransportView | null; onOpen(): void }) {
  const line = createMemo(() => (props.t ? headParts(props.t) : null));
  return (
    <Show when={line()}>
      {(l) => (
        <p class="session-head-transport">
          <button type="button" class="transport-head-status" data-state={props.t?.state === "needs-you" ? "needs-you" : "running"} onClick={() => props.onOpen()} title="Open the Transport dialog">
            <Show when={props.t?.state === "needs-you"} fallback={<span class="live-dot" aria-hidden="true" />}>
              <Icon name="alert-circle" small />
            </Show>
            {/* Where it goes gives way first on a narrow head: the step and its figure stay whole. */}
            <span class="transport-head-status-text">{l().lead}</span>
            <Show when={l().step}>
              {(st) => (
                <span class="transport-head-status-step">
                  <span aria-hidden="true">·</span> {st()}
                </span>
              )}
            </Show>
          </button>
        </p>
      )}
    </Show>
  );
}
