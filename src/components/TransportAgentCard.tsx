import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { TransportAgentNote } from "../../shared/transport-agent-card";
import { sessionHrefOn } from "../lib/mesh";
import { type TransportView, transportOf } from "../lib/transport-api";
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
 * seconds while it works: its state, what is still to set up, and Open Agent Chat (on the device it works on).
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
        <Show when={agent()}>{(a) => <Chip tone={STATE[a().state].tone} live={a().state === "working"}>{STATE[a().state].word}</Chip>}</Show>
      </div>
      <p class="transport-agent-card-name text-caption text-muted">{agent()?.title ?? props.card.title}</p>
      <Show when={agent()} fallback={<p class="transport-agent-card-line text-caption">Its progress shows on {device()}.</p>}>
        {(a) => (
          <Show when={left().length > 0} fallback={<p class="transport-agent-card-line text-caption">{a().state === "ready" ? `${device()} has what this project needs.` : "Checking what's left to set up."}</p>}>
            <p class="transport-agent-card-line text-caption">{a().state === "needs-you" ? "Still missing:" : "Setting up:"}</p>
            <ul class="transport-agent-card-list text-caption">
              <For each={left()}>{(c) => <li>{c.detail}</li>}</For>
            </ul>
          </Show>
        )}
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
