import { createEffect, createMemo, createResource, createSignal, createUniqueId, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { designDirectionLine, type DesignHistoryItem, type DesignRecord } from "../../shared/design";
import type { TranscriptItem } from "../../shared/protocol";
import { foldedCalls, historyRows, mergeHistory } from "../lib/lookbook-history";
import { createChatFold, type ChatFold } from "../lib/design-chat-fold";
import { versionLabel } from "../lib/design-frame";
import type { DesignOpener } from "../lib/design-history";
import { createPageSlots } from "../lib/design-page-slots";
import { designPageText, type DesignStore } from "../lib/design-store";
import { coordinatorOf, designHoldEnds, designIsBusy, designIsWriting, designNoteLine, designLatest, designMeta, designStatusWord, parentsLine } from "../lib/design-ui";
import { DesignActionsMenu, designStatusTone, DesignTiles, designGrid, designWaiting, type DesignOpenTarget } from "./DesignCard";
import { DesignCoordinatorPanel, DesignMessageBox } from "./DesignCoordinator";
import { DesignSealedFrame, DesignStreamFrame } from "./DesignFrame";
import { WorkerTranscript } from "./SubagentPane";
import { Select } from "./form";
import { Chip, Icon } from "./ui";

function PageFrame(props: { d: DesignRecord; version: number; following: boolean; store: DesignStore; cacheKey: string }) {
  // Keyed on the version on show by value: every other design's progress, and this one's status and
  // costs, hand in a fresh record and must leave the page (and its scroll) alone.
  const pages = createPageSlots(
    () => ({ label: props.d.label, v: props.version }),
    (label, v) => designPageText(props.store, props.cacheKey, label, v, "full"),
  );
  const title = () => `Design ${versionLabel(props.d.label, props.version)}`;
  const live = () => props.store.live(props.d.label);
  const streaming = () => props.following && designIsWriting(props.d);
  // The page being written stays on show until the finished one has drawn over it; the version it
  // started from says whether a new one is coming at all.
  const [held, setHeld] = createSignal(false);
  let from = 0;
  createEffect(() => {
    if (streaming()) {
      if (!held()) from = designLatest(props.d);
      setHeld(true);
    } else if (!props.following || designHoldEnds(props.d, from)) setHeld(false);
  });
  return (
    <div class="design-open-frame">
      <For each={pages.slots()}>
        {(slot) => (
          <div class="design-frame-layer" style={{ "z-index": pages.front() === slot.key ? 2 : 1 }}>
            <DesignSealedFrame
              html={slot.html}
              motion
              title={title()}
              onDrawn={() => {
                pages.drawn(slot);
                if (slot.key === pages.key()) setHeld(false);
              }}
            />
          </div>
        )}
      </For>
      <Show when={streaming() || held()}>
        <div inert class="design-frame-layer" style={{ "z-index": 3 }}>
          <DesignStreamFrame api={props.store.api} label={props.d.label} version={live()?.version} draw={live()?.draw} text={live()?.text ?? ""} title={title()} waiting={designWaiting(props.d)} over={props.version > 0} priority />
        </div>
      </Show>
      <Show when={props.version === 0 && !designIsWriting(props.d)}>
        <div class="design-frame-note">No page has been written yet.</div>
      </Show>
      <Show when={pages.error()}>
        <div class="design-frame-note">{pages.error()}</div>
      </Show>
    </div>
  );
}

/**
 * The view's chat. Always mounted, so its typed words, its scroll place and its bar's line live as long
 * as the view: on a phone it starts folded to a bar (the newest message on one line) that shows it.
 */
function ChatPane(props: { sessionFile?: string; host: string | null; name: string; author: string; streaming: boolean; children: any; note?: string; rows?: (items: TranscriptItem[]) => TranscriptItem[]; fold: ChatFold; empty: string }) {
  const id = createUniqueId();
  const line = createMemo(() => props.fold.line(props.author));
  let bar!: HTMLButtonElement;
  let hide!: HTMLButtonElement;
  return (
    <section class="design-open-chat" aria-label={`Chat with ${props.name}`}>
      {/* Showing the chat moves focus to Hide Chat, never into the message box (a phone's keyboard stays down). */}
      <button
        type="button"
        class="design-open-bar"
        ref={bar}
        title="Show Chat"
        aria-expanded={props.fold.folded() ? "false" : "true"}
        aria-controls={id}
        onClick={() => {
          props.fold.setFolded(false);
          hide.focus();
        }}
      >
        <span class="visually-hidden">Show Chat: </span>
        <Icon name="chat" class="design-open-bar-icon" />
        <Show when={line()} fallback={<span class="design-open-bar-text text-muted">{props.empty}</span>}>
          {(l) => (
            <>
              <b class="design-open-bar-who">{l().who}</b>
              <span class="design-open-bar-text">{l().text}</span>
            </>
          )}
        </Show>
        <Icon name="chevron-down" small class="design-open-bar-up" />
      </button>
      <div class="design-open-chat-body" id={id}>
        <div class="design-open-chat-head">
          <h3 class="design-open-chat-title">Chat with {props.name}</h3>
          <button
            type="button"
            class="button button-sm button-ghost design-open-fold"
            ref={hide}
            aria-expanded={props.fold.folded() ? "false" : "true"}
            aria-controls={id}
            onClick={() => {
              props.fold.setFolded(true);
              bar.focus();
            }}
          >
            Hide Chat
          </button>
        </div>
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
            {(file) => <WorkerTranscript source={{ kind: "pi", path: file }} host={props.host} name={props.name} author={props.author} streaming={props.streaming} onContext={() => {}} rows={props.rows} onLatest={props.fold.onLatest} />}
          </Show>
        </div>
        <Show when={props.note}>
          <p class="field-hint design-open-note">{props.note}</p>
        </Show>
        <div class="composer design-open-composer">{props.children}</div>
      </div>
    </section>
  );
}

/** A design's page, or the Creative Director's card, with its own chat beside it (stacked on a phone). */
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
  // The Creative Director's chat lists what each design was told among its messages: fetched again
  // whenever the history's count or newest item moves (it rides on the design events, its items don't).
  const historyMark = createMemo(() => (props.target.kind === "coordinator" ? `h:${view()?.history?.count ?? 0}:${view()?.history?.last ?? ""}` : false));
  const [history] = createResource(historyMark, () => props.store.api.history().then((h) => h.items).catch(() => [] as DesignHistoryItem[]));
  const promptItems = createMemo(() => {
    const items = history.latest ?? [];
    return { rows: historyRows(items), folded: foldedCalls(items) };
  });
  const withPromptItems = (list: TranscriptItem[]) => mergeHistory(list, promptItems().rows, promptItems().folded);
  const [hideChat, setHideChat] = createSignal(false);
  // Below 768px the chat folds to a bar instead, and every view starts folded: nothing is remembered.
  const chat = createChatFold();
  // What the More menu's last click came to, when it didn't go through: said in the head's line.
  const [actError, setActError] = createSignal("");
  const [pick, setPick] = createSignal<number | null>(null);
  const version = () => pick() ?? (d() ? designLatest(d()!) : 0);
  const title = () => (d() ? `${d()!.label} · ${designDirectionLine(d()!)}` : "Creative Director");
  return (
    <dialog
      ref={dialog}
      class="design-open"
      aria-label={title()}
      onClose={() => props.onClose()}
    >
      <header class="design-open-head">
        {/* One flex row on a wide screen (this box adds nothing there); on a phone, the title over its line. */}
        <div class="design-open-titles">
          <h2 class="design-open-title">{title()}</h2>
          <Show when={d()}>
            {(x) => (
              <span class={`text-caption design-open-meta${actError() ? " field-error" : " text-muted"}`} role={actError() ? "alert" : undefined} title={actError() || designNoteLine(x()) || designMeta(x())}>
                {actError() || designNoteLine(x()) || designMeta(x())}
                <Show when={!actError() && x().parents.length && !designNoteLine(x())}> · {parentsLine(x().parents)}</Show>
              </span>
            )}
          </Show>
        </div>
        <Show when={d()}>
          {(x) => (
            <>
              <span class="design-open-chip">
                <Chip tone={designStatusTone(x())} live={designIsBusy(x())}>
                  {designStatusWord(x())}
                </Chip>
              </span>
              {/* Always there, so a new version arriving moves nothing beside it. */}
              <Select class="design-open-version" label="Version" hideLabel disabled={x().versions.length < 2} value={String(version())} options={x().versions.length ? x().versions.map((v) => ({ value: String(v.n), label: versionLabel(x().label, v.n) })) : [{ value: "0", label: x().label }]} onChange={(v) => setPick(Number(v))} />
              <DesignActionsMenu d={x()} store={props.store} class="button-sm design-open-more" onError={setActError} />
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
      <div class="design-open-body" data-chat={hideChat() ? "hidden" : "shown"} data-fold={chat.folded() ? "folded" : "shown"}>
        <Show when={d()}>
          {(x) => (
            <>
              <div class="design-open-page">
                <PageFrame d={x()} version={version()} following={pick() === null} store={props.store} cacheKey={props.path} />
              </div>
              <ChatPane
                fold={chat}
                empty={`Message ${x().label}`}
                sessionFile={x().sessionFile}
                host={hostOf()}
                name={x().label}
                author={x().label}
                streaming={x().status === "writing"}
                note={x().workerState === "stopped" ? `${x().label}'s session has shut down. A message starts it again.` : x().sessionEnded ? `${x().label}'s session has ended. A message starts a fresh one from its stored page.` : undefined}
              >
                <DesignMessageBox label={`Message ${x().label}`} placeholder={`Message ${x().label}`} delivery={x().delivery} name={x().label} send={(text, key) => props.store.api.message(x().label, text, key)} onSent={() => props.store.refresh()} />
              </ChatPane>
            </>
          )}
        </Show>
        <Show when={props.target.kind === "coordinator" && coordinator()}>
          {(c) => (
            <>
              <div class="design-open-page design-open-page-scroll">
                <DesignCoordinatorPanel coordinator={c()} view={view()} store={props.store} bare />
                <DesignTiles designs={designGrid(view())} store={props.store} cacheKey={props.path} class="design-open-grid" onOpen={(label) => props.onSwitch({ kind: "design", label })} />
              </div>
              <ChatPane fold={chat} empty="Message the Creative Director" sessionFile={c().sessionFile} host={hostOf()} name="the Creative Director" author="Creative Director" streaming={c().status === "running"} note="It knows each design and can open its saved page." rows={withPromptItems}>
                <DesignMessageBox label="Message the Creative Director" placeholder="Message the Creative Director" delivery={c().delivery} name="the Creative Director" send={(text, key, images) => props.store.api.coordinatorMessage(text, key, images)} upload={props.store.api.uploadImage} onSent={() => props.store.refresh()} />
              </ChatPane>
            </>
          )}
        </Show>
      </div>
    </dialog>
  );
}

/**
 * A chat's open Lookbook view, drawn by one of its surfaces (the card or the Gallery) from the shared
 * opener, which keeps it in the browser's history and the address. An address naming a design (or a
 * coordinator) this chat doesn't have shows the chat alone, and stops naming it.
 */
export function DesignOpenSlot(props: { nav: DesignOpener; store: DesignStore; path: string }) {
  const shown = createMemo(() => {
    const t = props.nav.target();
    const view = props.store.view();
    if (!t || !view) return null;
    const there = t.kind === "coordinator" ? !!coordinatorOf(view) : t.kind === "brief" ? view.runs.some((r) => r.id === t.runId && !!r.brief) : view.designs.some((x) => x.label === t.label);
    return there ? t : "gone";
  });
  createEffect(() => shown() === "gone" && props.nav.drop());
  const target = () => {
    const t = shown();
    return props.nav.draws() && t && t !== "gone" ? t : null;
  };
  // Each view is its own dialog: going from the Creative Director to a design (or Back) never reflows
  // one in place, so nothing in it moves; the next one opens where the last one was.
  const key = createMemo(() => {
    const t = target();
    // A run's brief is drawn by its own card, as a dialog over the chat, not here.
    return t && t.kind !== "brief" ? (t.kind === "design" ? `design:${t.label}` : "coordinator") : null;
  });
  return (
    <Show when={key()} keyed>
      {(_view) => {
        const t = untrack(target)!;
        return (
          <Portal>
            <DesignOpen target={t} store={props.store} path={props.path} onClose={() => props.nav.close()} onSwitch={(x) => props.nav.open(x)} />
          </Portal>
        );
      }}
    </Show>
  );
}
