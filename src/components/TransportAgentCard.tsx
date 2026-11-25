import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { TransportAgentNote } from "../../shared/transport-agent-card";
import { sessionHrefOn } from "../lib/mesh";
import { saveTransportHostValues, type TransportView, transportOf } from "../lib/transport-api";
import { TextField } from "./form";
import { Chip } from "./ui";
import "./TransportAgentCard.css";

/** How often a working agent's card reads its transport again. */
const POLL_MS = 3_000;

const STATE: Record<"working" | "ready" | "needs-you", { word: string; tone: "accent" | "success" | "warn" }> = {
  working: { word: "Working", tone: "accent" },
  ready: { word: "Ready", tone: "success" },
  "needs-you": { word: "Needs you", tone: "warn" },
};

/**
 * The Transport agent's card (§app.transport/agent, words in §design.copy-deck/transport), in the chat it gets a
 * device ready for: before arrival in the original chat, after arrival in the chat where it arrived. It reads the
 * transport's agent from this device's record (the source keeps what the destination reports), again every few
 * seconds while it works: its state, what is still to set up, and Open Agent Chat (on the device it works on). In the
 * arrived chat it also asks for each host value this device lacks for the project, prefilled with the source's value
 * (Save Values writes them here, on your click), and says why the agent couldn't start when this device can't confine it.
 */
export function TransportAgentCard(props: { card: TransportAgentNote }) {
  const [view, setView] = createSignal<TransportView | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gone = false;
  const read = async () => {
    const t = await transportOf(props.card.tid).catch(() => null);
    if (gone) return;
    setView(t);
    const a = t?.ext?.agent;
    const under = t && t.state !== "cancelled" && (!a || a.state === "working");
    if (under) timer = setTimeout(() => void read(), POLL_MS);
  };
  onMount(() => void read());
  onCleanup(() => {
    gone = true;
    clearTimeout(timer);
  });
  const agent = () => view()?.ext?.agent ?? null;
  const asks = () => (view()?.side === "destination" ? (view()?.ext?.hostAsk ?? []) : []);
  const blocked = () => (view()?.side === "destination" ? (view()?.ext?.agentBlocked ?? null) : null);
  const [edits, setEdits] = createSignal<Record<string, string>>({});
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const valueOf = (name: string, from: string) => edits()[name] ?? from;
  const save = async (e: Event) => {
    e.preventDefault();
    const values = Object.fromEntries(asks().map((a) => [a.name, valueOf(a.name, a.value)]).filter(([, v]) => v));
    if (!Object.keys(values).length) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveTransportHostValues(props.card.tid, values);
      setSaved(true);
      setEdits({});
      await read();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const device = () => agent()?.device || props.card.device || "that device";
  const left = () => (agent()?.checks ?? []).filter((c) => !c.ok);
  // The source keeps the agent the other device reports: its chat is there.
  const href = () => {
    const a = agent();
    const v = view();
    return a && v ? sessionHrefOn(v.side === "source" ? v.peer : null, a.path) : null;
  };
  return (
    <section class="card transport-agent-card" aria-label={`Transport agent on ${device()}`}>
      <div class="transport-agent-card-head">
        <span class="transport-agent-card-title">Transport agent on {device()}</span>
        <Show when={agent()} fallback={<Show when={blocked()}><Chip tone={STATE["needs-you"].tone}>{STATE["needs-you"].word}</Chip></Show>}>
          {(a) => <Chip tone={STATE[a().state].tone} live={a().state === "working"}>{STATE[a().state].word}</Chip>}
        </Show>
      </div>
      <p class="transport-agent-card-name text-caption text-muted">{agent()?.title ?? props.card.title}</p>
      <Show when={blocked()}>{(why) => <p class="transport-agent-card-line text-caption">{why()}.</p>}</Show>
      <Show when={agent()} fallback={<Show when={!blocked() && !asks().length && !saved()}><p class="transport-agent-card-line text-caption">Its progress shows on {device()}.</p></Show>}>
        {(a) => (
          <Show when={left().length > 0} fallback={<p class="transport-agent-card-line text-caption">{a().state === "ready" ? `${device()} has what this project needs.` : "Checking what's left to set up."}</p>}>
            <p class="transport-agent-card-line text-caption">{a().state === "needs-you" ? "Still missing:" : "Setting up:"}</p>
            <ul class="transport-agent-card-list text-caption">
              <For each={left()}>{(c) => <li>{c.detail}</li>}</For>
            </ul>
          </Show>
        )}
      </Show>
      <Show when={asks().length > 0}>
        <form class="transport-agent-card-host" onSubmit={(e) => void save(e)}>
          <p class="transport-agent-card-line text-caption">
            This device doesn't have {asks().length === 1 ? "this host value" : "these host values"} for this project yet. Each holds {view()?.peerLabel ?? "the other device"}'s; keep it or change it.
          </p>
          <For each={asks()}>
            {(a) => (
              <TextField
                label={<span class="text-mono">{a.name}</span>}
                value={valueOf(a.name, a.value)}
                autocomplete="off"
                spellcheck={false}
                onInput={(v) => setEdits({ ...edits(), [a.name]: v })}
              />
            )}
          </For>
          <Show when={saveError()}>{(m) => <p class="field-error">{m()}</p>}</Show>
          <div class="transport-agent-card-foot">
            <button class="button button-sm" type="submit" disabled={saving() || !asks().some((a) => valueOf(a.name, a.value))}>
              Save Values
            </button>
          </div>
        </form>
      </Show>
      <Show when={saved() && !asks().length}>
        <p class="transport-agent-card-line text-caption">Saved on this device.</p>
      </Show>
      <Show when={href()}>
        {(h) => (
          <div class="transport-agent-card-foot">
            <a class="button button-sm" href={h()}>
              Open Agent Chat
            </a>
          </div>
        )}
      </Show>
    </section>
  );
}
