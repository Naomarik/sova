import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import type { TransportAgentNote } from "../../shared/transport-agent-card";
import { sessionHrefOn } from "../lib/mesh";
import { allowTransportDownloads, bringTransportFile, saveTransportHostValues, transportAdminDone, transportFilePlaced, type TransportView, transportOf } from "../lib/transport-api";
import { openAppHref, transportCardActions } from "../lib/transport-card-actions";
import { copyText } from "../lib/ui-state";
import { TextField } from "./form";
import { Chip, CopyButton } from "./ui";
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
 * On either device it shows what the agent asks you: a download list (each tool, its version and its site), which
 * Allow Downloads lets it fetch from exactly those sites, and a command needing administrator rights, which you run
 * yourself (Copy Command beside it) and answer with Done, and a file that lives outside the project on the device the
 * chat came from (Copy Path beside it), which Bring From {device} copies here once or you place yourself. After arrival
 * Ready means the app runs: the chat's running copy is up and its entry page answers, and Open App opens it. Every button
 * sits in one row at the card's foot: the answers first, the first of them primary, then Open App, then Open Agent Chat.
 * While anything waits on you, the card reads Needs you, never Ready.
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
    const c = t?.side === "destination" ? t.ext?.copy : undefined;
    const under = t && t.state !== "cancelled" && (!a || a.state === "working" || c?.state === "starting");
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
  /** The arrived chat's running copy, here where it runs. */
  const copy = () => (view()?.side === "destination" ? (view()?.ext?.copy ?? null) : null);
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
  const [answering, setAnswering] = createSignal<string | null>(null);
  const [answerError, setAnswerError] = createSignal<{ id: string; message: string } | null>(null);
  const answer = async (id: string, act: () => Promise<unknown>) => {
    setAnswering(id);
    setAnswerError(null);
    try {
      await act();
      clearTimeout(timer);
      await read();
    } catch (err) {
      setAnswerError({ id, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setAnswering(null);
    }
  };
  const downloads = () => agent()?.downloads ?? null;
  const askedSteps = () => (agent()?.admin ?? []).filter((s) => s.state === "asked");
  const lastDone = () => (askedSteps().length ? null : ([...(agent()?.admin ?? [])].reverse().find((s) => s.state === "done") ?? null));
  const askedFiles = () => (agent()?.outside ?? []).filter((f) => f.state === "asked");
  const lastFile = () => (askedFiles().length ? null : ([...(agent()?.outside ?? [])].reverse().find((f) => f.state !== "asked") ?? null));
  const waiting = () => downloads()?.state === "asked" || askedSteps().length > 0 || askedFiles().length > 0;
  /** Its state as the chip shows it: never Ready while something it asked you waits. */
  const shown = (s: "working" | "ready" | "needs-you") => (waiting() ? "needs-you" : s);
  /** With no agent here, the running copy's state stands for it. */
  const copyState = (): "working" | "ready" | "needs-you" | null => {
    const c = copy();
    if (!c || c.state === "none") return null;
    return c.state === "running" ? "ready" : c.state === "failed" ? "needs-you" : "working";
  };
  const ready = () => (agent() ? shown(agent()!.state) === "ready" : copyState() === "ready");
  const running = () => (copy()?.state === "running" ? copy()!.copies : []);
  /** Open App: the running copy's entry page, on the host this page was opened from, once the card reads Ready. */
  const app = () => openAppHref({ ready: ready(), copy: copy(), host: location.hostname });
  const copyLine = () => {
    const c = copy();
    if (!c) return null;
    if (c.state === "none") return "This project has no running-copy definition, so no copy was started.";
    if (c.state === "running") return `Its running copy ${c.copies.map((x) => x.name).join(", ")} runs here.`;
    return null;
  };
  const hostsText = (items: readonly { host: string }[]) => [...new Set(items.map((i) => i.host))].join(", ");
  const device = () => agent()?.device || props.card.device || "that device";
  const left = () => (agent()?.checks ?? []).filter((c) => !c.ok);
  // The source keeps the agent the other device reports: its chat is there.
  const href = () => {
    const a = agent();
    const v = view();
    return a && v ? sessionHrefOn(v.side === "source" ? v.peer : null, a.path) : null;
  };
  const actions = () =>
    transportCardActions({
      downloads: downloads()?.state === "asked" ? downloads()!.id : null,
      commands: askedSteps().map((st) => st.id),
      files: askedFiles().map((f) => ({ id: f.id, from: f.from })),
      hostValues: asks().length > 0,
      app: app(),
      href: href(),
    });
  const formId = createUniqueId();
  const kind = (primary: boolean) => `button button-sm${primary ? " button-primary" : ""}`;
  return (
    <section class="card transport-agent-card" aria-label={`Transport agent on ${device()}`}>
      <div class="transport-agent-card-body">
        <div class="transport-agent-card-head">
          <span class="transport-agent-card-title">Transport agent on {device()}</span>
          <Show
            when={agent()}
            fallback={
              <Show when={blocked() ? "needs-you" : copyState()}>
                {(st) => (
                  <Chip tone={STATE[st()].tone} live={st() === "working"}>
                    {STATE[st()].word}
                  </Chip>
                )}
              </Show>
            }
          >
            {(a) => <Chip tone={STATE[shown(a().state)].tone} live={shown(a().state) === "working"}>{STATE[shown(a().state)].word}</Chip>}
          </Show>
        </div>
        <p class="transport-agent-card-name text-caption text-muted">{agent()?.title ?? props.card.title}</p>
        <Show when={blocked()}>{(why) => <p class="transport-agent-card-line text-caption">{why()}.</p>}</Show>
        <Show
          when={agent()}
          fallback={
            <Show when={!blocked() && !asks().length && !saved()}>
              <p class="transport-agent-card-line text-caption">
                {copy()?.state === "starting" ? "Starting its running copy here." : copy()?.state === "failed" ? (copy()!.copies.find((c) => !c.ok)?.detail ?? "Its running copy didn't start.") : copyLine() ?? `Its progress shows on ${device()}.`}
              </p>
            </Show>
          }
        >
          {(a) => (
            <Show
              when={left().length > 0}
              fallback={
                <Show when={!waiting()}>
                  <p class="transport-agent-card-line text-caption">{a().state === "ready" ? `${device()} has what this project needs.${copyLine() ? ` ${copyLine()}` : ""}` : "Checking what's left to set up."}</p>
                </Show>
              }
            >
              <p class="transport-agent-card-line text-caption">{shown(a().state) === "needs-you" ? "Still missing:" : "Setting up:"}</p>
              <ul class="transport-agent-card-list text-caption">
                <For each={left()}>{(c) => <li>{c.detail}</li>}</For>
              </ul>
            </Show>
          )}
        </Show>
        <Show when={downloads()}>
          {(d) => (
            <Show
              when={d().state === "asked"}
              fallback={<p class="transport-agent-card-line text-caption">Allowed from <span class="text-mono">{hostsText(d().items)}</span>. The agent carries on.</p>}
            >
              <div class="transport-agent-card-ask">
                <p class="transport-agent-card-line text-caption">
                  It needs to download {d().items.length === 1 ? "1 tool" : `${d().items.length} tools`} from sites its sandbox doesn't reach. Nothing downloads until you allow it.
                </p>
                <ul class="transport-agent-card-list text-caption">
                  <For each={d().items}>
                    {(i) => (
                      <li>
                        {i.tool} {i.version} <span class="text-muted">from</span> <span class="text-mono">{i.host}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={d().why}>{(w) => <p class="transport-agent-card-line text-caption text-muted">{w()}</p>}</Show>
                <Show when={answerError()?.id === d().id}><p class="field-error">{answerError()!.message}</p></Show>
              </div>
            </Show>
          )}
        </Show>
        <For each={askedSteps()}>
          {(st, i) => (
            <div class="transport-agent-card-ask">
              <p class="transport-agent-card-line text-caption">
                <Show when={askedSteps().length > 1}>
                  <span class="transport-agent-card-command-n">Command {i() + 1}.</span>{" "}
                </Show>
                This needs administrator rights, which the agent doesn't have. Run it yourself in a terminal on {device()}:
              </p>
              <div class="transport-agent-card-command-row">
                <pre class="transport-agent-card-command text-mono">{st.command}</pre>
                <CopyButton label="Copy Command" text={() => st.command} onCopy={(t) => copyText(t, "Copied the command.")} />
              </div>
              <Show when={st.why}>{(w) => <p class="transport-agent-card-line text-caption text-muted">{w()}</p>}</Show>
              <Show when={answerError()?.id === st.id}><p class="field-error">{answerError()!.message}</p></Show>
            </div>
          )}
        </For>
        <Show when={lastDone()}>
          <p class="transport-agent-card-line text-caption">You ran it. The agent carries on.</p>
        </Show>
        <For each={askedFiles()}>
          {(f, i) => (
            <div class="transport-agent-card-ask">
              <p class="transport-agent-card-line text-caption">
                <Show when={askedFiles().length > 1}>
                  <span class="transport-agent-card-command-n">File {i() + 1}.</span>{" "}
                </Show>
                It needs a file that lives outside the project on {f.from}. Bring that one file from there, or place it yourself in <span class="text-mono">{f.folder}</span> on {device()}:
              </p>
              <div class="transport-agent-card-command-row">
                <pre class="transport-agent-card-command text-mono">{f.path}</pre>
                <CopyButton label="Copy Path" text={() => f.path} onCopy={(t) => copyText(t, "Copied the path.")} />
              </div>
              <Show when={f.why}>{(w) => <p class="transport-agent-card-line text-caption text-muted">{w()}</p>}</Show>
              <Show when={answerError()?.id === f.id}><p class="field-error">{answerError()!.message}</p></Show>
            </div>
          )}
        </For>
        <Show when={lastFile()}>
          {(f) => (
            <p class="transport-agent-card-line text-caption">
              {f().state === "kept" ? (
                <>
                  <span class="text-mono">{f().path}</span> was already on {device()}, so it was kept and nothing was brought. The agent carries on.
                </>
              ) : f().state === "placed" ? (
                <>
                  You placed <span class="text-mono">{f().path}</span>. The agent carries on.
                </>
              ) : (
                <>
                  Brought <span class="text-mono">{f().path}</span> from {f().from}. The agent carries on.
                </>
              )}
            </p>
          )}
        </Show>
        <Show when={asks().length > 0}>
          <form id={formId} class="transport-agent-card-host" onSubmit={(e) => void save(e)}>
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
          </form>
        </Show>
        <Show when={saved() && !asks().length}>
          <p class="transport-agent-card-line text-caption">Saved on this device.</p>
        </Show>
      </div>
      <Show when={actions().length > 0}>
        <div class="card-foot transport-agent-card-foot">
          <For each={actions()}>
            {(act) => {
              if (act.kind === "open")
                return (
                  <a class="button button-sm" href={act.href}>
                    {act.label}
                  </a>
                );
              if (act.kind === "app")
                return (
                  <a class={kind(act.primary)} href={act.href} target="_blank" rel="noopener noreferrer" title={`Open the running copy (${running().find((c) => c.entry)?.entry?.endpoint ?? "its entry page"}) in a new tab`}>
                    {act.label}
                  </a>
                );
              if (act.kind === "save")
                return (
                  <button class={kind(act.primary)} type="submit" form={formId} disabled={saving() || !asks().some((x) => valueOf(x.name, x.value))}>
                    {act.label}
                  </button>
                );
              const run =
                act.kind === "allow"
                  ? () => allowTransportDownloads(props.card.tid, act.id)
                  : act.kind === "bring"
                    ? () => bringTransportFile(props.card.tid, act.id)
                    : act.kind === "placed"
                      ? () => transportFilePlaced(props.card.tid, act.id)
                      : () => transportAdminDone(props.card.tid, act.id);
              return (
                <button class={kind(act.primary)} type="button" disabled={answering() !== null} onClick={() => void answer(act.id, run)}>
                  {act.label}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}
