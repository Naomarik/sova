// The Transport dialog (§app.transport/dialog, words in §design.copy-deck/transport): Move or Copy, the
// device and its folder, what travels and what stays, the private files git ignores (ticked), the large
// untracked files (unticked), what that device still needs, and busy helpers at a Move. Start Transport is
// your click; then the dialog follows the transport until it is done or needs you (Retry, Cancel).
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { sessionHrefOn } from "../lib/mesh";
import { type BackState, moveBack, type TransportView, sizeText, startTransport, transportAct, transportBack, transportOf, transportPreview, transportsOf } from "../lib/transport-api";
import { announce, toast } from "../lib/ui-state";
import { Select, TextField, Toggle } from "./form";
import { type BusyChoice, TransportBusyHelpers, TransportDeviceNeeds, TransportWaiting } from "./TransportHelpers";
import { Banner, Icon, trapFocus } from "./ui";

type Mode = "move" | "copy";
const MODES: readonly { id: Mode; label: string; line: string }[] = [
  { id: "move", label: "Move", line: "Hands the chat to that device. Here it becomes a Moved row." },
  { id: "copy", label: "Copy", line: "Leaves this chat here as it is." },
];

const STATE_WORDS = (t: TransportView, size: number | undefined): string => {
  switch (t.state) {
    case "preparing":
      return `Preparing ${t.peerLabel}…`;
    case "waiting-helpers":
      return `Waiting for ${t.ext?.waiting ?? 0} helpers to finish`;
    case "packing":
    case "sending":
      return `Sending ${sizeText(t.pkg?.size ?? size ?? 0)}…`;
    case "checking":
      return "Checking what arrived…";
    case "switching":
      return "Switching…";
    case "done":
      return t.mode === "move" ? `Moved to ${t.peerLabel}.` : `Copied to ${t.peerLabel}.`;
    case "needs-you":
      return t.needsYou?.reason ?? `Transport to ${t.peerLabel} stopped. The chat carries on here.`;
    case "cancelled":
      return "Cancelled. Nothing moved.";
  }
};

export function TransportDialog(props: { path: string; onClose(): void }) {
  const [mode, setMode] = createSignal<Mode>("move");
  const [peer, setPeer] = createSignal<string>("");
  const [base] = createResource(() => transportPreview(props.path));
  const [preview] = createResource(peer, (p) => (p ? transportPreview(props.path, p) : Promise.resolve(undefined)));
  const view = () => preview() ?? base();
  const [folder, setFolder] = createSignal("");
  const [untick, setUntick] = createSignal<Set<string>>(new Set());
  const [include, setInclude] = createSignal<Set<string>>(new Set());
  const [busy, setBusy] = createSignal<BusyChoice>("safe");
  const [model, setModel] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const [running, setRunning] = createSignal<TransportView | null>(null);

  // A transport of this chat already under way (or needing you) shows its progress, Retry and Cancel.
  createEffect(() => {
    const b = base();
    if (!b) return;
    void transportsOf(b.chat.id)
      .then(({ transports }) => {
        const t = [...transports].reverse().find((x) => x.side === "source" && x.state !== "done" && x.state !== "cancelled");
        if (t && !running()) {
          setRunning(t);
          if (t.state !== "needs-you") follow(t.tid);
        }
      })
      .catch(() => {});
  });
  createEffect(() => {
    const b = base();
    if (b && !folder()) setFolder(b.folder);
    if (b && !peer()) setPeer(b.devices[0]?.id ?? "");
  });
  createEffect(() => {
    const p = preview();
    if (p && model() === null) setModel(p.agentModelDefault);
  });

  // Following a started transport: one read every 1.5 s while it is under way.
  let timer: ReturnType<typeof setInterval> | undefined;
  const follow = (tid: string) => {
    clearInterval(timer);
    timer = setInterval(async () => {
      const t = await transportOf(tid).catch(() => null);
      if (!t) return;
      setRunning(t);
      if (t.state === "done" || t.state === "cancelled" || t.state === "needs-you") {
        clearInterval(timer);
        if (t.state === "done") {
          const line = STATE_WORDS(t, undefined);
          toast(line);
          announce(line);
        }
      }
    }, 1500);
  };
  onCleanup(() => clearInterval(timer));

  const key = (f: { tree: string; path: string }) => `${f.tree}/${f.path}`;
  const toggle = (set: () => Set<string>, put: (s: Set<string>) => void, k: string) => {
    const s = new Set(set());
    if (s.has(k)) s.delete(k);
    else s.add(k);
    put(s);
  };
  const refusal = () => view()?.refusal ?? null;
  const ready = () => !!view() && !!peer() && !refusal() && !!folder().trim() && !running();
  const close = () => !pending() && props.onClose();

  const start = async (e: Event) => {
    e.preventDefault();
    if (!ready() || pending()) return;
    setPending(true);
    setError(null);
    try {
      const r = await startTransport({
        path: props.path,
        peer: peer(),
        mode: mode(),
        folder: folder().trim(),
        untick: [...untick()],
        include: [...include()],
        ...(mode() === "move" ? { busyChoice: busy() } : {}),
        ...(model() ? { agentModel: model()! } : {}),
      });
      setRunning(r.transport);
      follow(r.tid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const act = async (a: "retry" | "cancel" | "interrupt") => {
    const t = running();
    if (!t) return;
    try {
      await transportAct(t.tid, a);
      if (a === "cancel") setRunning({ ...t, state: "cancelled" });
      else follow(t.tid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deviceLabel = (id: string) => view()?.devices.find((d) => d.id === id)?.label ?? id;
  const stateWord = (s: string) => (s === "ready" ? "" : s === "offline" ? " · offline" : s === "update" ? " · needs an update" : " · doesn't allow chats from here");

  return (
    <>
      <div class="scrim" onClick={close} />
      <div class="modal transport-dialog" role="dialog" aria-modal="true" aria-labelledby="tr-title" ref={(el) => trapFocus(el)} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div class="modal-head">
          <h2 class="modal-title" id="tr-title">
            Transport This Chat
          </h2>
        </div>
        <form class="modal-body stack" id="tr-form" onSubmit={start}>
          <Show when={error()}>{(e) => <Banner tone="error" title="Nothing was sent." body={e()} />}</Show>
          <Show when={base.error}>
            <Banner tone="error" title="Couldn't read this chat." body={String(base.error?.message ?? base.error)} />
          </Show>
          <Show when={running()}>
            {(t) => (
              <div class="stack" role="status" aria-live="polite">
                <Show
                  when={t().state === "needs-you"}
                  fallback={
                    <Show when={t().state === "waiting-helpers"} fallback={<p class="text-body">{STATE_WORDS(t(), undefined)}</p>}>
                      <TransportWaiting waiting={t().ext?.waiting ?? 0} onInterrupt={() => void act("interrupt")} />
                    </Show>
                  }
                >
                  <Banner tone="warn" title={`Transport to ${t().peerLabel} needs you.`} body={STATE_WORDS(t(), undefined)} />
                </Show>
              </div>
            )}
          </Show>
          <Show when={!running()}>
            <div class="tabs" role="tablist" aria-label="Move or Copy" style={{ flex: "none" }}>
              <For each={MODES}>
                {(m) => (
                  <button
                    type="button"
                    role="tab"
                    class={mode() === m.id ? "tab tab-active" : "tab"}
                    id={`tr-tab-${m.id}`}
                    aria-selected={mode() === m.id ? "true" : "false"}
                    aria-controls="tr-panel"
                    tabindex={mode() === m.id ? 0 : -1}
                    onClick={() => setMode(m.id)}
                  >
                    {m.label}
                  </button>
                )}
              </For>
            </div>
            <div class="stack" role="tabpanel" id="tr-panel" aria-labelledby={`tr-tab-${mode()}`}>
              <p class="text-caption text-muted">{MODES.find((m) => m.id === mode())!.line}</p>
              <Show when={refusal()}>{(r) => <Banner tone="info" title={r()} body="Start Transport stays off until that changes." />}</Show>
              <Select
                label="Device"
                value={peer()}
                onChange={(v) => setPeer(v)}
                options={(view()?.devices ?? []).map((d) => ({ value: d.id, label: `${d.label}${stateWord(d.state)}` }))}
                hint={(view()?.devices.length ?? 1) === 0 ? "Pair another device on the Mesh page first." : undefined}
              />
              <TextField label="Folder on that device" value={folder()} onInput={setFolder} inputClass="input-mono" spellcheck={false} autocomplete="off" />
              <Show when={view()}>
                {(v) => (
                  <>
                    <section class="card stack transport-card" aria-labelledby="tr-travels">
                      <h3 class="card-title" id="tr-travels">
                        Travels
                      </h3>
                      <ul class="text-caption transport-list">
                        <li>Conversation, title, tags, images, memory · {sizeText(v().travels.conversationBytes)}</li>
                        <For each={v().travels.code}>{(c) => <li>Code: {c.branch ?? "detached HEAD"} and unfinished changes · {sizeText(c.bytes)}</li>}</For>
                        <Show when={v().travels.helpers > 0}>
                          <li>Team: {v().travels.helpers} helpers and their inboxes</li>
                        </Show>
                        <Show when={v().travels.scratch.length > 0}>
                          <li>
                            Scratch folders: {v().travels.scratch.map((s) => s.dir).join(", ")} · {sizeText(v().travels.scratch.reduce((n, s) => n + s.size, 0))}
                          </li>
                        </Show>
                      </ul>
                    </section>
                    <Show when={v().privateFiles.length > 0}>
                      <section class="card stack transport-card" aria-labelledby="tr-private">
                        <h3 class="card-title" id="tr-private">
                          Private files git ignores
                        </h3>
                        <For each={v().privateFiles}>
                          {(f) => (
                            <Toggle label={<span class="text-mono">{`${f.path} · ${sizeText(f.size)}`}</span>} checked={!untick().has(key(f))} onChange={() => toggle(untick, setUntick, key(f))} />
                          )}
                        </For>
                      </section>
                    </Show>
                    <Show when={v().large.length > 0}>
                      <section class="card stack transport-card" aria-label="Large files">
                        <For each={v().large}>
                          {(f) => (
                            <Toggle label={<span class="text-mono">{`${f.path} · ${sizeText(f.size)}: over 50 MB. Tick it to send it.`}</span>} checked={include().has(key(f))} onChange={() => toggle(include, setInclude, key(f))} />
                          )}
                        </For>
                      </section>
                    </Show>
                    <section class="card stack transport-card" aria-labelledby="tr-stays">
                      <h3 class="card-title" id="tr-stays">
                        Stays here
                      </h3>
                      <ul class="text-caption transport-list">
                        <li>
                          Build output and dependencies: rebuilt there
                          <Show when={v().staysHere.left.length > 0}>
                            {" "}({v().staysHere.left.join(", ")} · {sizeText(v().staysHere.leftBytes)})
                          </Show>
                        </li>
                        <li>Share links to this chat end</li>
                        <Show when={mode() === "move"}>
                          <For each={v().staysHere.jobs}>{(j) => <li>Background job {j}: stopped at the switch</li>}</For>
                        </Show>
                      </ul>
                    </section>
                    <TransportDeviceNeeds needs={v().needs} models={v().agentModels} model={model()} onModel={setModel} />
                    <Show when={mode() === "move"}>
                      <TransportBusyHelpers helpers={v().busyHelpers} choice={busy()} onChoice={setBusy} />
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </Show>
        </form>
        <div class="modal-foot">
          <Show
            when={running()}
            fallback={
              <button type="submit" form="tr-form" class="button button-primary" aria-disabled={!ready() || pending() ? "true" : undefined} title={refusal() ?? undefined}>
                {pending() ? "Starting…" : "Start Transport"}
              </button>
            }
          >
            {(t) => (
              <Show when={t().state === "needs-you"}>
                <button type="button" class="button button-primary" onClick={() => void act("retry")}>
                  Retry
                </button>
              </Show>
            )}
          </Show>
          <span class="modal-spacer" />
          <Show
            when={running() && running()!.state !== "done" && running()!.state !== "cancelled"}
            fallback={
              <button type="button" class="button button-ghost" onClick={close}>
                {running() ? "Close" : "Cancel"}
              </button>
            }
          >
            <button type="button" class="button button-ghost" onClick={() => void act("cancel")} title={`Removes what arrived on ${deviceLabel(running()!.peer)}. The chat carries on here.`}>
              Cancel
            </button>
          </Show>
        </div>
      </div>
    </>
  );
}

/**
 * A Moved row opened here (§app.transport/moved-row): where it went, Open There, and while nothing happened
 * there Move Back (else Copy Back). No transcript and no composer: it runs on that device now.
 */
export function MovedPanel(props: { moved: { to: string; peer: string; tid: string; path?: string } }) {
  const [back, { refetch }] = createResource(() => props.moved.tid, (tid) => transportBack(tid).catch((err: unknown) => ({ can: null, reason: err instanceof Error ? err.message : String(err), peer: props.moved.peer, to: props.moved.to }) as BackState));
  const [pending, setPending] = createSignal(false);
  const [said, setSaid] = createSignal<string | null>(null);
  const there = () => (props.moved.path ? sessionHrefOn(props.moved.peer, props.moved.path) : null);
  const doBack = async () => {
    setPending(true);
    setSaid(null);
    try {
      await moveBack(props.moved.tid);
      const line = `Moved back from ${props.moved.to}.`;
      toast(line);
      announce(line);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
      void refetch();
    } finally {
      setPending(false);
    }
  };
  return (
    <div class="empty">
      <Icon name="external" class="empty-mark" />
      <p class="empty-body">This chat moved to {props.moved.to}.</p>
      <Show when={said()}>{(s) => <p class="empty-body text-error">{s()}</p>}</Show>
      <div class="empty-action cluster">
        <Show when={there()}>
          {(href) => (
            <a class="button" href={href()}>
              Open There
            </a>
          )}
        </Show>
        <Show when={back()?.can === "move"}>
          <button type="button" class="button button-primary" aria-disabled={pending() ? "true" : undefined} title={`Bring it back here. Nothing has happened to it on ${props.moved.to} yet.`} onClick={() => !pending() && void doBack()}>
            {pending() ? "Moving Back…" : "Move Back"}
          </button>
        </Show>
        <Show when={back()?.can === "copy" && there()}>
          {(href) => (
            <a class="button" href={href()} title={`It has changed on ${props.moved.to}, so this copies it back as a new chat.`} onClick={() => toast(`Open its ⋯ menu on ${props.moved.to} and choose Transport…, then Copy.`)}>
              Copy Back
            </a>
          )}
        </Show>
        <Show when={back()?.can === null && back()?.reason}>{(r) => <p class="text-caption text-muted">{r()}</p>}</Show>
      </div>
    </div>
  );
}
