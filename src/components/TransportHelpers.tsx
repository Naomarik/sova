// The Transport dialog's parts for the Transport agent and Safe Transport (§app.transport/dialog,
// §app.transport/agent, §app.transport/safe-transport), rendered by TransportDialog.tsx: what that
// device still needs with the agent's Model select, the Busy helpers choice of a Move, and the
// waiting line with Interrupt and Move. Words: §design.copy-deck/transport.
import { For, Show } from "solid-js";
import { modelLabel } from "../lib/format";
import { Choice, Select } from "./form";

export type BusyChoice = "safe" | "interrupt";

/** "That device still needs" and the agent's model: the project when it comes from this device (`fromHere`, its size),
    then each missing check, then what the project's setup definition says is set up once it has arrived
    (`afterArrival`); nothing shown when that device needs nothing. */
export function TransportDeviceNeeds(props: { needs: readonly string[]; fromHere?: string | null; afterArrival?: readonly string[]; models: readonly string[]; model: string | null; onModel(ref: string): void; disabled?: boolean }) {
  const after = () => props.afterArrival ?? [];
  return (
    <Show when={props.needs.length > 0 || !!props.fromHere || after().length > 0}>
      <section class="card stack" aria-labelledby="transport-needs-title" style={{ padding: "var(--space-3)" }}>
        <h3 class="card-title" id="transport-needs-title">
          That device still needs
        </h3>
        <ul class="text-caption">
          <Show when={props.fromHere}>{(size) => <li>The project comes from this device: its history and branches · {size()}</li>}</Show>
          <For each={props.needs}>{(n) => <li>{n}</li>}</For>
          <Show when={after().length > 0}>
            <li>
              After it arrives:
              <ul>
                <For each={after()}>{(n) => <li>{n}</li>}</For>
              </ul>
            </li>
          </Show>
        </ul>
        <Select label="Model" value={props.model ?? ""} disabled={props.disabled || !props.models.length} options={props.models.map((m) => ({ value: m, label: modelLabel(m) ?? m }))} onChange={(v) => props.onModel(v)} />
      </section>
    </Show>
  );
}

/** A Move's Busy helpers choice: Safe Transport (default) or Interrupt and Move; nothing when none works. */
export function TransportBusyHelpers(props: { helpers: readonly { id: string; name: string }[]; choice: BusyChoice; onChoice(c: BusyChoice): void; disabled?: boolean }) {
  const n = () => props.helpers.length;
  return (
    <Show when={n() > 0}>
      <section class="card stack" aria-labelledby="transport-busy-title" style={{ padding: "var(--space-3)" }}>
        <p class="card-title" id="transport-busy-title" title={props.helpers.map((h) => h.name).join(", ")}>
          {n() === 1 ? "1 helper is working." : `${n()} helpers are working.`}
        </p>
        <Choice
          labelledBy="transport-busy-title"
          cards
          value={props.choice}
          disabled={props.disabled}
          onChange={(v) => props.onChoice(v as BusyChoice)}
          options={[
            { value: "safe", label: "Safe Transport", hint: "They wrap up now and go idle; the Move waits for them." },
            { value: "interrupt", label: "Interrupt and Move", hint: "They stop now and carry on there." },
          ]}
        />
      </section>
    </Show>
  );
}

/** The transport's line while a Safe Transport waits, with Interrupt and Move beside it. */
export function TransportWaiting(props: { waiting: number; onInterrupt(): void; pending?: boolean }) {
  return (
    <div class="cluster" role="status">
      <span>{props.waiting === 1 ? "Waiting for 1 helper to finish" : `Waiting for ${props.waiting} helpers to finish`}</span>
      <button type="button" class="button button-sm button-ghost" disabled={props.pending} onClick={() => props.onInterrupt()}>
        Interrupt and Move
      </button>
    </div>
  );
}
