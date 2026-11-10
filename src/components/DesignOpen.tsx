import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { DesignRecord } from "../../shared/design";
import { versionLabel } from "../lib/design-frame";
import { designPageText, type DesignStore } from "../lib/design-store";
import { coordinatorOf, designCanRefine, designIsBusy, designNoteLine, designLatest, designMeta, designStatusWord, parentsLine, QUICK_PROMPTS } from "../lib/design-ui";
import { designStatusTone, DesignTile, designGrid, designWaiting, type DesignOpenTarget } from "./DesignCard";
import { DesignCoordinatorPanel, designKey, DesignMessageBox } from "./DesignCoordinator";
import { DesignSealedFrame, DesignStreamFrame } from "./DesignFrame";
import { WorkerTranscript } from "./SubagentPane";
import { Select, TextArea } from "./form";
import { Chip, Icon } from "./ui";

/** Refine: your words and quick prompts go back to the design's own session, which looks and fixes. */
export function DesignRefinePanel(props: { d: DesignRecord; store: DesignStore; onClose(): void }) {
  const [text, setText] = createSignal("");
  const [quick, setQuick] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let key = designKey();
  const pick = (q: string) => setQuick((list) => (list.includes(q) ? list.filter((x) => x !== q) : [...list, q]));
  const send = async () => {
    setBusy(true);
    setError("");
    try {
      await props.store.api.refine(props.d.label, text().trim(), quick(), key);
      key = designKey();
      props.store.refresh();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? `${e.message} Your text is still in the box.` : "That didn't go through. Your text is still in the box.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="design-refine"
      aria-label={`Refine ${props.d.label}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <strong>Refine {props.d.label}</strong>
      <TextArea label={`What should ${props.d.label} change?`} hideLabel rows="2" placeholder="What should it change?" value={text()} onInput={setText} />
      <div class="design-refine-quick" role="group" aria-label="Quick prompts">
        <For each={QUICK_PROMPTS}>
          {(q) => (
            <button type="button" class="button button-sm" aria-pressed={quick().includes(q) ? "true" : "false"} onClick={() => pick(q)}>
              {q}
            </button>
          )}
        </For>
      </div>
      <Show when={!props.d.vision}>
        <p class="field-hint">This model can't read images, so it checks a text outline of the page instead of screenshots.</p>
      </Show>
      <Show when={props.d.sessionEnded}>
        <p class="field-hint">This design's session has ended. Refine starts a fresh one from the stored page.</p>
      </Show>
      <Show when={error()}>
        <p class="field-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="button-row design-refine-actions">
        <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
          Cancel
        </button>
        <button type="submit" class="button button-primary" disabled={busy() || (!text().trim() && quick().length === 0)}>
          Send to Design
        </button>
      </div>
    </form>
  );
}

function PageFrame(props: { d: DesignRecord; version: number; store: DesignStore; cacheKey: string }) {
  const [html, setHtml] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  createEffect(
    on(
      () => [props.d.label, props.version] as const,
      ([label, v]) => {
        setHtml(null);
        setError("");
        if (v > 0) {
          designPageText(props.store, props.cacheKey, label, v, "full")
            .then((t) => setHtml(t))
            .catch((e) => setError(e instanceof Error ? e.message : "This page couldn't be loaded."));
        }
      },
    ),
  );
  const title = () => `Design ${versionLabel(props.d.label, props.version)}`;
  const live = () => props.store.live(props.d.label);
  const streaming = () => (!!props.d.live || props.d.status === "writing" || props.d.status === "fixing") && props.version === 0;
  // The page being written stays on show until the finished one has drawn over it.
  const [held, setHeld] = createSignal(false);
  createEffect(() => {
    if (streaming()) setHeld(true);
    else if (props.version === 0) setHeld(false);
  });
  return (
    <div class="design-open-frame">
      <Show when={html() !== null}>
        <DesignSealedFrame html={html()!} motion title={title()} onDrawn={() => setHeld(false)} />
      </Show>
      <Show when={streaming() || held()}>
        <div inert class="design-frame-layer" style={{ "z-index": 3 }}>
          <DesignStreamFrame api={props.store.api} label={props.d.label} version={live()?.version} text={live()?.text ?? ""} title={title()} waiting={designWaiting(props.d)} priority />
        </div>
      </Show>
      <Show when={props.version === 0 && !props.d.live && props.d.status !== "writing" && props.d.status !== "fixing"}>
        <div class="design-frame-note">No page has been written yet.</div>
      </Show>
      <Show when={error()}>
        <div class="design-frame-note">{error()}</div>
      </Show>
    </div>
  );
}

function ChatPane(props: { sessionFile?: string; host: string | null; name: string; author: string; streaming: boolean; children: any; note?: string }) {
  return (
    <section class="design-open-chat" aria-label={`Chat with ${props.name}`}>
      <h3 class="design-open-chat-title">Chat with {props.name}</h3>
      <div class="design-open-transcript">
        <Show
          when={props.sessionFile}
          keyed
          fallback={
            <div class="empty subagents-empty">
              <p class="empty-body">Its session hasn't started yet. Your messages can wait until it does.</p>
            </div>
          }
        >
          {(file) => <WorkerTranscript source={{ kind: "pi", path: file }} host={props.host} name={props.name} author={props.author} streaming={props.streaming} onContext={() => {}} />}
        </Show>
      </div>
      <Show when={props.note}>
        <p class="field-hint design-open-note">{props.note}</p>
      </Show>
      <div class="composer design-open-composer">{props.children}</div>
    </section>
  );
}

/** A design's page, or the coordinator's card, with its own chat beside it (stacked on a phone). */
export function DesignOpen(props: { target: DesignOpenTarget; store: DesignStore; path: string; onClose(): void; onSwitch(t: DesignOpenTarget): void }) {
  let dialog!: HTMLDialogElement;
  const opener = document.activeElement as HTMLElement | null;
  const hostOf = () => null as string | null;
  onMount(() => {
    dialog.showModal();
  });
  onCleanup(() => {
    if (opener?.isConnected) opener.focus();
  });
  const view = () => props.store.view();
  const d = createMemo(() => (props.target.kind === "design" ? view()?.designs.find((x) => x.label === (props.target as { label: string }).label) : undefined));
  const coordinator = () => coordinatorOf(view());
  const labels = createMemo(() => designGrid(view()).map((x) => x.label), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const [hideChat, setHideChat] = createSignal(false);
  const [refine, setRefine] = createSignal(false);
  const [pick, setPick] = createSignal<number | null>(null);
  const version = () => pick() ?? (d() ? designLatest(d()!) : 0);
  const title = () => (d() ? `${d()!.label} · ${d()!.direction}` : "Coordinator");
  return (
    <dialog
      ref={dialog}
      class="design-open"
      aria-label={title()}
      onClose={() => props.onClose()}
    >
      <header class="design-open-head">
        <h2 class="design-open-title">{title()}</h2>
        <Show when={d()}>
          {(x) => (
            <>
              <span class="text-caption text-muted design-open-meta" title={designNoteLine(x()) || designMeta(x())}>
                {designNoteLine(x()) || designMeta(x())}
                <Show when={x().parents.length && !designNoteLine(x())}> · {parentsLine(x().parents)}</Show>
              </span>
              <Chip tone={designStatusTone(x())} live={designIsBusy(x())}>
                {designStatusWord(x())}
              </Chip>

              <Show when={x().versions.length > 1}>
                <Select class="design-open-version" label="Version" hideLabel value={String(version())} options={x().versions.map((v) => ({ value: String(v.n), label: versionLabel(x().label, v.n) }))} onChange={(v) => setPick(Number(v))} />
              </Show>
              <button type="button" class="button button-sm" disabled={!designCanRefine(x())} onClick={() => setRefine(!refine())}>
                Refine
              </button>
            </>
          )}
        </Show>
        <span class="design-open-spacer" />
        <button type="button" class="button button-sm button-ghost design-open-hide" onClick={() => setHideChat(!hideChat())}>
          {hideChat() ? "Show Chat" : "Hide Chat"}
        </button>
        <button type="button" class="button button-icon button-ghost design-open-close" aria-label="Close" autofocus onClick={() => dialog.close()}>
          <Icon name="close" />
        </button>
      </header>
      <div class="design-open-body" data-chat={hideChat() ? "hidden" : "shown"}>
        <Show when={d()}>
          {(x) => (
            <>
              <div class="design-open-page">
                <PageFrame d={x()} version={version()} store={props.store} cacheKey={props.path} />
                <Show when={refine()}>
                  <div class="design-open-refine">
                    <DesignRefinePanel d={x()} store={props.store} onClose={() => setRefine(false)} />
                  </div>
                </Show>
              </div>
              <Show when={!hideChat()}>
                <ChatPane
                  sessionFile={x().sessionFile}
                  host={hostOf()}
                  name={x().label}
                  author={x().label}
                  streaming={x().status === "writing"}
                  note={x().workerState === "stopped" ? `${x().label}'s session has shut down. A message starts it again.` : x().sessionEnded ? `${x().label}'s session has ended. Refine starts a fresh one from the stored page.` : undefined}
                >
                  <DesignMessageBox label={`Message ${x().label}`} placeholder={`Message ${x().label}`} delivery={x().delivery} name={x().label} send={(text, key) => props.store.api.message(x().label, text, key)} onSent={() => props.store.refresh()} />
                </ChatPane>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.target.kind === "coordinator" && coordinator()}>
          {(c) => (
            <>
              <div class="design-open-page design-open-page-scroll">
                <DesignCoordinatorPanel coordinator={c()} view={view()} store={props.store} bare />
                <div class="design-grid design-open-grid">
                  <For each={labels()}>
                    {(label) => (
                      <Show when={designGrid(view()).find((x) => x.label === label)}>
                        {(item) => <DesignTile d={item()} store={props.store} cacheKey={props.path} onOpen={() => props.onSwitch({ kind: "design", label })} onRefine={() => props.onSwitch({ kind: "design", label })} />}
                      </Show>
                    )}
                  </For>
                </div>
              </div>
              <Show when={!hideChat()}>
                <ChatPane sessionFile={c().sessionFile} host={hostOf()} name="the coordinator" author="Coordinator" streaming={c().status === "running"} note="It knows what each design is, not its code.">
                  <DesignMessageBox label="Message the coordinator" placeholder="Message the coordinator" delivery={c().delivery} name="the coordinator" send={(text, key, images) => props.store.api.coordinatorMessage(text, key, images)} upload={props.store.api.uploadImage} onSent={() => props.store.refresh()} />
                </ChatPane>
              </Show>
            </>
          )}
        </Show>
      </div>
    </dialog>
  );
}
