import { createContext, createEffect, createMemo, createSignal, For, on, Show, useContext } from "solid-js";
import { Portal } from "solid-js/web";
import type { DesignCaps, DesignChatView, DesignRecord } from "../../shared/design";
import { DESIGN_ASK_ABOVE, DESIGN_BATCH_DEFAULT, DESIGN_BATCH_MAX, DESIGN_CONCURRENT } from "../../shared/design";
import { briefStatus, setupLinks, withLinkUse } from "../lib/design-brief";
import { designsOfRun, useDesignStore, type DesignStore } from "../lib/design-store";
import {
  batchLine,
  briefTitle,
  coordinatorOf,
  designCanOpen,
  designCanRefine,
  designFixLine,
  designIsBusy,
  designLatest,
  designMeta,
  designStatusWord,
  parentsLine,
  setupBlocked,
  setupCount,
  setupSummary,
  STATUS_WORD,
  statusCounts,
  type DesignRunView,
} from "../lib/design-ui";
import { designPageText } from "../lib/design-store";
import { DesignBriefCollapsed, DesignBriefStep } from "./DesignBrief";
import { DesignCoordinatorPanel } from "./DesignCoordinator";
import { createSetupDraft, DesignLinkRow, DesignSetupPickers } from "./DesignSetupControls";
import { createNearViewport, DesignScale, DesignSealedFrame, DesignStreamFrame } from "./DesignFrame";
import { DesignOpen, DesignRefinePanel } from "./DesignOpen";
import { TextArea } from "./form";
import { Chip, Icon } from "./ui";
import "./DesignCard.css";

/** The chat a Design card or the Gallery reads. Only a chat you can write to provides it. */
export interface DesignSessionHost {
  path(): string | undefined;
  host(): string | null;
}
export const DesignSessionContext = createContext<DesignSessionHost | null>(null);

export const CAPS_FALLBACK: DesignCaps = { batchDefault: DESIGN_BATCH_DEFAULT, askAbove: DESIGN_ASK_ABOVE, batchMax: DESIGN_BATCH_MAX, concurrent: DESIGN_CONCURRENT };

export type DesignOpenTarget = { kind: "design"; label: string } | { kind: "coordinator" };

/** What a page with no text yet says instead. */
export function designWaiting(d: DesignRecord): string | undefined {
  return d.status === "fixing" ? "Fixing the page" : d.thinking ? "Thinking about the page" : undefined;
}

export function designStatusTone(d: DesignRecord): "success" | "accent" | "error" | "warn" | undefined {
  if (d.status === "fixing") return "warn";
  if (d.status === "ready" && d.workerState === "working") return "accent";
  return d.status === "ready" ? "success" : d.status === "writing" ? "accent" : d.status === "failed" ? "error" : undefined;
}

/** The transcript card. One per run: it follows the run through Setup, Confirm and the finished grid. */
export function DesignCard(props: { runId: string }) {
  const host = useContext(DesignSessionContext);
  return (
    <Show when={host?.path()} fallback={<p class="field-hint">Open this conversation in its chat to see its designs.</p>} keyed>
      {(path) => <DesignCardIn runId={props.runId} path={path} host={host!.host()} />}
    </Show>
  );
}

function DesignCardIn(props: { runId: string; path: string; host: string | null }) {
  const store = useDesignStore(props.path, props.host);
  const run = createMemo(() => store.view()?.runs.find((r) => r.id === props.runId) as DesignRunView | undefined);
  const newest = () => store.view()?.runs.at(-1)?.id === props.runId;
  return (
    <section class="card design-card" aria-label={`Design: ${run() ? briefTitle(run()!.setup.brief) : "loading"}`}>
      <Show
        when={run()}
        fallback={
          <div class="design-card-body">
            <Show when={store.error()} fallback={<div class="skeleton skeleton-row" aria-busy="true" />}>
              <p class="field-error" role="alert">
                {store.error()}{" "}
                <button type="button" class="button button-ghost button-sm" onClick={() => store.refresh()}>
                  Retry
                </button>
              </p>
            </Show>
            <Show when={store.view() && !run()}>
              <p class="text-muted">This design run isn't in this chat anymore.</p>
            </Show>
          </div>
        }
      >
        {(r) => (
          <>
            <Show when={r().phase === "setup"} fallback={<DesignRunBody run={r()} store={store} newest={newest()} cacheKey={props.path} />}>
              <DesignSetupCard run={r()} store={store} />
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

// ---- Setup ------------------------------------------------------------------------------------

function DesignSetupCard(props: { run: DesignRunView; store: DesignStore }) {
  const setup = createSetupDraft(() => props.run, props.store);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const caps = () => props.store.view()?.caps ?? CAPS_FALLBACK;
  const draft = setup.draft;
  const count = () => setupCount(draft());
  const blocked = () => setupBlocked(draft(), caps());
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await setup.flush();
      await props.store.api.start(props.run.id);
      props.store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The coordinator couldn't start. Try again.");
    } finally {
      setBusy(false);
    }
  };
  // Rows are keyed by address, so choosing a use keeps its row.
  const linkUrls = () => setupLinks(draft()).map((l) => l.url);
  return (
    <>
      <div class="card-head">
        <h3 class="card-title">Design</h3>
        <Chip>Setup</Chip>
      </div>
      <div class="design-card-scroll">
      <div class="design-card-body design-setup">
        <TextArea label="What Do You Want to Design" rows="2" value={draft().brief} onInput={(brief) => setup.change({ ...draft(), brief })} />
        <Show when={linkUrls().length > 0}>
          <div class="design-setup-links">
            <For each={linkUrls()}>{(url) => <DesignLinkRow url={url} use={setupLinks(draft()).find((l) => l.url === url)?.use ?? null} onUse={(use) => setup.change(withLinkUse(draft(), url, use))} />}</For>
          </div>
        </Show>
        <DesignSetupPickers setup={setup} />
      </div>
      </div>
      <div class="card-foot design-setup-foot">
        <div class="design-setup-summary">
          <span>{setupSummary(count())}</span>
          <span class={setup.saving() === "error" || error() ? "field-error" : "text-muted"} role={error() ? "alert" : undefined}>
            {setup.saving() === "error" ? "This selection couldn't be saved. Your clicks are still here." : error() || blocked() || ""}
          </span>
        </div>
        <button type="button" class="button button-primary" disabled={busy() || !!blocked()} onClick={() => void start()}>
          Start Coordinator
        </button>
      </div>
    </>
  );
}

// ---- After Setup ------------------------------------------------------------------------------

function DesignRunBody(props: { run: DesignRunView; store: DesignStore; newest: boolean; cacheKey: string }) {
  const [refining, setRefining] = createSignal<string | null>(null);
  const [opened, setOpened] = createSignal<DesignOpenTarget | null>(null);
  const designs = createMemo(() => designsOfRun(props.store.view(), props.run.id, props.run.labels));
  // Keyed by label: a record changing never rebuilds its tile or the frame in it.
  const labels = createMemo(() => designs().map((d) => d.label), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const counts = () => statusCounts(designs());
  const anyLive = () => designs().some(designIsBusy);
  const coordinator = () => coordinatorOf(props.store.view());
  const refined = () => designs().find((d) => d.label === refining());
  const waitingChip = () => (props.run.phase === "brief" && props.run.brief ? briefStatus(props.run) : props.run.phase === "stopped" ? { text: "Stopped", live: false } : props.run.phase === "researching" || props.run.phase === "brief" ? { text: "Preparing the brief", live: true } : { text: "Starting the designs", live: true });
  const briefOpen = () => props.run.phase === "brief" && !!props.run.brief;
  return (
    <>
      <div class="card-head design-run-head">
        <h3 class="card-title design-run-title">{briefTitle(props.run.setup.brief)}</h3>
        <div class="design-run-sub">
          <span class="text-caption text-muted design-run-batch">{designs().length > 0 ? batchLine(designs()) : ""}</span>
          <Show when={designs().length > 0} fallback={<Chip live={waitingChip().live}>{waitingChip().text}</Chip>}>
            <Chip live={anyLive()} tone={anyLive() ? "accent" : undefined}>
              <span class="design-run-counts" title={counts()}>
                {counts()}
              </span>
            </Chip>
          </Show>
        </div>
      </div>
      <Show when={briefOpen()} fallback={<>
      <div class="design-card-scroll">
      <Show when={props.run.error}>
        {(e) => (
          <div class="design-run-error">
            <div class="banner banner-compact banner-error" role="alert">
              <Icon name="alert-circle" small class="banner-icon" />
              <p class="banner-body">{e()}</p>
            </div>
          </div>
        )}
      </Show>
      <Show when={props.run.phase === "researching" || (props.run.phase === "brief" && !props.run.brief)}>
        <div class="empty design-card-waiting">
          <p class="empty-body">The coordinator is preparing your brief. Nothing is designed until you press Start.</p>
        </div>
      </Show>
      <DesignBriefCollapsed run={props.run} store={props.store} />
      <Show when={designs().length > 0}>
        <div class="design-card-body">
          <div class="design-grid">
            <For each={labels()}>
              {(label) => (
                <Show when={designs().find((d) => d.label === label)}>
                  {(d) => <DesignTile d={d()} store={props.store} cacheKey={props.cacheKey} onOpen={() => setOpened({ kind: "design", label })} onRefine={() => setRefining(label)} />}
                </Show>
              )}
            </For>
          </div>
        </div>
      </Show>
      </div>
      <Show when={props.newest && coordinator()}>
        {(c) => (
          <div class="design-card-coordinator">
            <DesignCoordinatorPanel coordinator={c()} view={props.store.view()} store={props.store} onOpen={() => setOpened({ kind: "coordinator" })} />
          </div>
        )}
      </Show>
      </>}>
        <DesignBriefStep run={props.run} store={props.store} onOpenCoordinator={() => setOpened({ kind: "coordinator" })} />
      </Show>
      <Show when={refined()}>
        {(d) => (
          <div class="design-card-refine">
            <DesignRefinePanel d={d()} store={props.store} onClose={() => setRefining(null)} />
          </div>
        )}
      </Show>
      <Show when={opened()}>
        {(target) => (
          <Portal>
            <DesignOpen target={target()} store={props.store} path={props.cacheKey} onClose={() => setOpened(null)} onSwitch={setOpened} />
          </Portal>
        )}
      </Show>
    </>
  );
}

// ---- One design -------------------------------------------------------------------------------

/** One finished page in a tile's frame: at most two at once, the newest taking over only once drawn. */
interface PageSlot {
  v: number;
  html: string;
}

/** One design's picture in a grid: the page as far as it has been written, then finished. */
export function DesignThumb(props: { d: DesignRecord; store: DesignStore; cacheKey: string }) {
  let box: HTMLDivElement | undefined;
  const near = createNearViewport(() => box);
  const live = () => props.store.live(props.d.label);
  const version = createMemo(() => designLatest(props.d));
  const [slots, setSlots] = createSignal<PageSlot[]>([]);
  const [front, setFront] = createSignal(0);
  const [failed, setFailed] = createSignal("");
  const [streamed, setStreamed] = createSignal(false);
  const writing = () => !!props.d.live || props.d.status === "writing" || props.d.status === "fixing";
  createEffect(
    on(near, (isNear) => {
      if (isNear) return;
      setSlots([]);
      setFront(0);
      setStreamed(false);
    }),
  );
  createEffect(() => {
    if (writing() && near() && live()) setStreamed(true);
  });
  createEffect(
    on([version, near], ([v, isNear]) => {
      if (!v || !isNear || slots().some((s) => s.v === v)) return;
      setFailed("");
      designPageText(props.store, props.cacheKey, props.d.label, v)
        .then((html) => {
          if (v === version()) setSlots((list) => [...list.filter((s) => s.v === front()), { v, html }]);
        })
        .catch((e) => setFailed(e instanceof Error ? e.message : "This page couldn't be loaded."));
    }),
  );
  const drawn = (slot: PageSlot) => {
    if (slot.v < front()) return;
    setFront(slot.v);
    if (!writing()) setStreamed(false);
    setSlots((list) => list.filter((s) => s.v === slot.v));
  };
  // Writing to finished keeps the last picture until the finished page has drawn.
  const showStream = () => writing() || (streamed() && version() > 0 && front() < version());
  const title = () => `Design ${props.d.label}, ${props.d.direction}`;
  return (
    <div class="design-tile-page" ref={box}>
      <DesignScale label={`${title()}: ${STATUS_WORD[props.d.status]}`}>
        <Show when={near()}>
          <For each={slots()}>
            {(slot) => (
              <div class="design-frame-layer" style={{ "z-index": front() === slot.v ? 2 : 1 }}>
                <DesignSealedFrame html={slot.html} motion={false} title={title()} onDrawn={() => drawn(slot)} />
              </div>
            )}
          </For>
          <Show when={showStream()}>
            <div class="design-frame-layer" style={{ "z-index": 3 }}>
              <DesignStreamFrame api={props.store.api} label={props.d.label} version={live()?.version} text={live()?.text ?? ""} title={title()} waiting={designWaiting(props.d)} />
            </div>
          </Show>
        </Show>
      </DesignScale>
      <Show when={props.d.status === "queued"}>
        <div class="design-tile-state">Waiting for a free session</div>
      </Show>
      <Show when={props.d.status === "failed" && props.d.versions.length === 0}>
        <div class="design-tile-state design-tile-state-error">No page was written</div>
      </Show>
      <Show when={failed()}>
        <div class="design-tile-state design-tile-state-error">{failed()}</div>
      </Show>
    </div>
  );
}

export function DesignTile(props: { d: DesignRecord; store: DesignStore; cacheKey: string; onOpen(): void; onRefine(): void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const retry = async () => {
    setBusy(true);
    setError("");
    try {
      await props.store.api.retry(props.d.label);
      props.store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const meta = () => designMeta(props.d, props.store.live(props.d.label)?.text.length);
  // One two-line place for why a design isn't simply fine: nothing around it ever moves for it.
  const reason = () => {
    if (error()) return { text: error(), error: true, alert: true };
    if (props.d.status === "failed" && props.d.error) return { text: props.d.error, error: true, alert: false };
    if (props.d.delivery?.state === "undelivered") return { text: props.d.delivery.error || "That message couldn't be delivered. Your text is still in the box.", error: true, alert: false };
    return { text: designFixLine(props.d), error: false, alert: false };
  };
  return (
    <article class="design-tile" aria-label={`Design ${props.d.label}`}>
      <DesignThumb d={props.d} store={props.store} cacheKey={props.cacheKey} />
      <div class="design-tile-info">
        <div class="design-tile-title">
          <span class="design-tile-label">{props.d.label}</span>
          <span class="design-tile-direction" title={props.d.direction}>
            {props.d.direction}
          </span>
          <span class="design-tile-chip">
            <Chip tone={props.d.delivery?.state === "queued" ? "accent" : designStatusTone(props.d)} live={designIsBusy(props.d) && props.d.delivery?.state !== "queued"}>
              {designStatusWord(props.d)}
            </Chip>
          </span>
        </div>
        <p class="text-caption text-muted design-tile-meta" title={meta()}>
          {meta()}
          <Show when={props.d.parents.length > 0}> · {parentsLine(props.d.parents)}</Show>
        </p>
        <p class={`text-caption design-tile-note${reason().error ? " design-tile-error" : " text-muted"}`} role={reason().alert ? "alert" : undefined} title={reason().text || undefined}>
          {reason().text}
        </p>
        <div class="design-tile-actions">
          <button type="button" class="button button-sm" disabled={!designCanOpen(props.d)} title={designCanOpen(props.d) ? undefined : "Opens once the page is finished."} onClick={() => props.onOpen()}>
            Open
          </button>
          <Show
            when={props.d.status === "failed"}
            fallback={
              <button type="button" class="button button-sm" disabled={!designCanRefine(props.d)} title={designCanRefine(props.d) ? undefined : "Refine waits for a finished page."} onClick={() => props.onRefine()}>
                Refine
              </button>
            }
          >
            <button type="button" class="button button-sm" disabled={busy()} onClick={() => void retry()}>
              Retry
            </button>
          </Show>
          <button type="button" class="button button-sm" disabled={!props.d.sessionFile} title={props.d.sessionFile ? undefined : "Its session hasn't started."} onClick={() => props.onOpen()}>
            Chat
          </button>
        </div>
      </div>
    </article>
  );
}

/** The grid of designs the Gallery shows, one chat's every run. */
export function designGrid(view: DesignChatView | null): DesignRecord[] {
  return [...(view?.designs ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
