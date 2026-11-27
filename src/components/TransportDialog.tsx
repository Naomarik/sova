// The Transport dialog (§app.transport/dialog, words in §design.copy-deck/transport): Move or Copy, the
// device and its folder, what travels and what stays, the private files git ignores (ticked), the large
// untracked files (unticked), what that device still needs, and busy helpers at a Move. Start Transport is
// your click; then the dialog follows the transport until it is done or needs you (Retry, Cancel).
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { sessionHrefOn } from "../lib/mesh";
import { type BackState, moveBack, type TransportView, sizeText, startTransport, transportAct, transportBack, transportPreview } from "../lib/transport-api";
import { doneLine, followAgain, followTransport, lookForTransport, putTransport, transportById } from "../lib/transport-follow";
import { announce, toast } from "../lib/ui-state";
import { type TransportErrorFrom, transportErrorBanner } from "../lib/transport-dialog-error";
import { Select, TextField, Toggle } from "./form";
import { type BusyChoice, TransportBusyHelpers, TransportDeviceNeeds, TransportRow } from "./TransportHelpers";
import { TransportSteps } from "./TransportProgress";
import { Banner, Icon, trapFocus } from "./ui";
import "./TransportDialog.css";

type Mode = "move" | "copy";
const MODES: readonly { id: Mode; label: string; line: string }[] = [
  { id: "move", label: "Move", line: "Hands the chat to that device. Here it becomes a Moved row." },
  { id: "copy", label: "Copy", line: "Leaves this chat here as it is." },
];

/** A ticked-or-not file: its box, its path, its size at the line's end; the whole row is the target. */
function FileToggle(props: { path: string; size: number; checked: boolean; onChange(): void }) {
  return (
    <li>
      <Toggle
        label={
          <span class="transport-file">
            <span class="transport-file-path">{props.path}</span>
            <span class="transport-size">{sizeText(props.size)}</span>
          </span>
        }
        checked={props.checked}
        onChange={() => props.onChange()}
      />
    </li>
  );
}

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
  const [error, setError] = createSignal<{ from: TransportErrorFrom; text: string } | null>(null);
  const [pending, setPending] = createSignal(false);
  // The transport this dialog follows, as the page's follower last read it (the chat's head reads the same one).
  const [tid, setTid] = createSignal<string | null>(null);
  const running = (): TransportView | null => transportById(tid());

  // A transport of this chat already under way (or needing you) shows its progress, Retry and Cancel.
  createEffect(() => {
    const b = base();
    if (!b) return;
    void lookForTransport(b.chat.id, true).then((t) => {
      if (t && !tid()) setTid(t.tid);
    });
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

  // A refused action's reason ("It is opening on Laptop right now…") is over once the transport ended.
  createEffect(() => {
    const t = running();
    if (t && (t.state === "done" || t.state === "cancelled") && error() && error()!.from !== "start") setError(null);
  });

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
      followTransport(r.transport);
      setTid(r.tid);
    } catch (err) {
      setError({ from: "start", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  };

  const act = async (a: "retry" | "cancel" | "interrupt") => {
    const t = running();
    if (!t) return;
    setError(null);
    try {
      await transportAct(t.tid, a);
      if (a === "cancel") putTransport({ ...t, state: "cancelled" });
      else followAgain(t.tid);
    } catch (err) {
      setError({ from: a, text: err instanceof Error ? err.message : String(err) });
      // A refused Cancel: it goes on (opening there, say), so the dialog keeps following it to its end.
      if (a === "cancel") followAgain(t.tid);
    }
  };

  const deviceLabel = (id: string) => view()?.devices.find((d) => d.id === id)?.label ?? id;
  const stateWord = (s: string) => (s === "ready" ? "" : s === "offline" ? " · offline" : s === "update" ? " · needs an update" : " · doesn't allow chats from here");

  return (
    <Portal>
      <div class="scrim" onClick={close} />
      <div class="modal transport-dialog" role="dialog" aria-modal="true" aria-labelledby="tr-title" ref={(el) => trapFocus(el)} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div class="modal-head">
          <h2 class="modal-title" id="tr-title">
            Transport This Chat
          </h2>
        </div>
        <form class="modal-body" id="tr-form" onSubmit={start}>
          <Show when={error()}>
            {(e) => {
              const b = () => transportErrorBanner(e().from, e().text);
              return <Banner tone="error" title={b().title} body={b().body} />;
            }}
          </Show>
          <Show when={base.error}>
            <Banner tone="error" title="Couldn't read this chat." body={String(base.error?.message ?? base.error)} />
          </Show>
          <Show when={running()}>
            {(t) => (
              <div class="stack-2">
                <Show when={t().state === "cancelled"} fallback={<TransportSteps t={t()} onInterrupt={() => void act("interrupt")} />}>
                  <p class="transport-status" role="status">
                    Cancelled. Nothing moved.
                  </p>
                </Show>
                <Show when={t().state === "done"}>
                  <p class="transport-status" role="status">
                    {doneLine(t())}
                  </p>
                </Show>
              </div>
            )}
          </Show>
          <Show when={!running()}>
            <div class="stack-2">
              <div class="tabs" role="tablist" aria-label="Move or Copy">
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
              <p class="field-hint">{MODES.find((m) => m.id === mode())!.line}</p>
            </div>
            <div class="transport-panel" role="tabpanel" id="tr-panel" aria-labelledby={`tr-tab-${mode()}`}>
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
                    <section class="stack-2" aria-labelledby="tr-travels">
                      <h3 class="text-eyebrow" id="tr-travels">
                        Travels
                      </h3>
                      <ul class="transport-rows">
                        <TransportRow size={sizeText(v().travels.conversationBytes)}>Conversation, title, tags, images, memory</TransportRow>
                        <For each={v().travels.code}>{(c) => <TransportRow size={sizeText(c.bytes)}>Code: {c.branch ?? "detached HEAD"} and unfinished changes</TransportRow>}</For>
                        <Show when={v().travels.helpers > 0}>
                          <TransportRow>Team: {v().travels.helpers} helpers and their inboxes</TransportRow>
                        </Show>
                        <Show when={v().travels.scratch.length > 0}>
                          <TransportRow size={sizeText(v().travels.scratch.reduce((n, s) => n + s.size, 0))} sub={v().travels.scratch.map((s) => s.dir).join(", ")}>
                            Scratch folders
                          </TransportRow>
                        </Show>
                      </ul>
                    </section>
                    <Show when={v().privateFiles.length > 0}>
                      <section class="stack-2" aria-labelledby="tr-private">
                        <h3 class="text-eyebrow" id="tr-private">
                          Private files git ignores
                        </h3>
                        <ul class="transport-files">
                          <For each={v().privateFiles}>{(f) => <FileToggle path={f.path} size={f.size} checked={!untick().has(key(f))} onChange={() => toggle(untick, setUntick, key(f))} />}</For>
                        </ul>
                      </section>
                    </Show>
                    <Show when={v().large.length > 0}>
                      <section class="stack-2" aria-labelledby="tr-large">
                        <h3 class="text-eyebrow" id="tr-large">
                          Large new files
                        </h3>
                        <p class="field-hint">Over 50 MB, so each stays here unless you tick it.</p>
                        <ul class="transport-files">
                          <For each={v().large}>{(f) => <FileToggle path={f.path} size={f.size} checked={include().has(key(f))} onChange={() => toggle(include, setInclude, key(f))} />}</For>
                        </ul>
                      </section>
                    </Show>
                    <section class="stack-2" aria-labelledby="tr-stays">
                      <h3 class="text-eyebrow" id="tr-stays">
                        Stays here
                      </h3>
                      <ul class="transport-rows">
                        <TransportRow size={v().staysHere.left.length > 0 ? sizeText(v().staysHere.leftBytes) : null} sub={v().staysHere.left.length > 0 ? v().staysHere.left.join(", ") : undefined}>
                          Build output and dependencies: rebuilt there
                        </TransportRow>
                        <TransportRow>Share links to this chat end</TransportRow>
                        <Show when={mode() === "move"}>
                          <For each={v().staysHere.jobs}>{(j) => <TransportRow>Background job {j}: stopped at the switch</TransportRow>}</For>
                          <For each={v().staysHere.copies ?? []}>{(c) => <TransportRow>Running copy {c}: stopped at the switch</TransportRow>}</For>
                        </Show>
                      </ul>
                    </section>
                    <TransportDeviceNeeds needs={v().needs} fromHere={v().projectFromHere ? sizeText(v().projectFromHere!.bytes) : null} afterArrival={v().afterArrival ?? []} models={v().agentModels} model={model()} onModel={setModel} />
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
        </div>
      </div>
    </Portal>
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
    <div class="center-fill">
      <div class="empty">
        <Icon name="external" class="empty-mark" />
        <p class="empty-title">This chat moved to {props.moved.to}.</p>
        {/* Why Move Back is or isn't offered, said on the page: a button's title never shows on a phone. */}
        <p class="empty-body">
          <Show when={back()?.can === null && back()?.reason} fallback={back()?.can === "copy" ? `It has changed on ${props.moved.to}, so Copy Back brings it here as a new chat.` : "It runs there now."}>
            {(r) => r()}
          </Show>
        </p>
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
        </div>
      </div>
    </div>
  );
}
