// The Transport dialog's parts for the Transport agent and Safe Transport (§app.transport/dialog,
// §app.transport/agent, §app.transport/safe-transport), rendered by TransportDialog.tsx: what that
// device still needs with the agent's Model select, the Busy helpers choice of a Move, and the
// waiting line with Interrupt and Move. Words: §design.copy-deck/transport.
import { For, type JSX, Show } from "solid-js";
import { modelLabel } from "../lib/format";
import { Choice, Select } from "./form";

export type BusyChoice = "safe" | "interrupt";

/** One line of a list: what it is, then its size in a column of its own at the line's end. */
export function TransportRow(props: { children: JSX.Element; size?: string | null; sub?: JSX.Element }) {
  return (
    <li class="transport-row">
      <span class="transport-row-text">
        {props.children}
        <Show when={props.sub}>
          <span class="transport-row-sub">{props.sub}</span>
        </Show>
      </span>
      <Show when={props.size}>
        <span class="transport-size">{props.size}</span>
      </Show>
    </li>
  );
}

/** "That device still needs" and the agent's model: the project when it comes from this device (`fromHere`, its size),
    then each missing check, then what the project's setup definition says is set up once it has arrived
    (`afterArrival`); nothing shown when that device needs nothing. */
export function TransportDeviceNeeds(props: { needs: readonly string[]; fromHere?: string | null; afterArrival?: readonly string[]; models: readonly string[]; model: string | null; onModel(ref: string): void; disabled?: boolean }) {
  const after = () => props.afterArrival ?? [];
  return (
    <Show when={props.needs.length > 0 || !!props.fromHere || after().length > 0}>
      <section class="stack-2" aria-labelledby="transport-needs-title">
        <h3 class="text-eyebrow" id="transport-needs-title">
          That device still needs
        </h3>
        <ul class="transport-rows">
          <Show when={props.fromHere}>{(size) => <TransportRow size={size()}>The project comes from this device: its history and branches</TransportRow>}</Show>
          <For each={props.needs}>{(n) => <TransportRow>{n}</TransportRow>}</For>
        </ul>
        <Show when={after().length > 0}>
          <h4 class="text-eyebrow transport-subhead" id="transport-after-title">
            After it arrives
          </h4>
          <ul class="transport-rows" aria-labelledby="transport-after-title">
            <For each={after()}>{(n) => <TransportRow>{n}</TransportRow>}</For>
          </ul>
        </Show>
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
      <section class="stack-2" aria-labelledby="transport-busy-title">
        <p class="transport-rows-label" id="transport-busy-title" title={props.helpers.map((h) => h.name).join(", ")}>
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
    <div class="spread" role="status">
      <span class="transport-status">{props.waiting === 1 ? "Waiting for 1 helper to finish" : `Waiting for ${props.waiting} helpers to finish`}</span>
      <button type="button" class="button button-sm button-ghost" disabled={props.pending} onClick={() => props.onInterrupt()}>
        Interrupt and Move
      </button>
    </div>
  );
}
