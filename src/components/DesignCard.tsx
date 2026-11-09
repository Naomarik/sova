import { createContext, createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, useContext } from "solid-js";
import { Portal } from "solid-js/web";
import type { DesignCaps, DesignChatView, DesignRecord, DesignSetup } from "../../shared/design";
import { DESIGN_ASK_ABOVE, DESIGN_BATCH_DEFAULT, DESIGN_BATCH_MAX, DESIGN_CONCURRENT } from "../../shared/design";
import type { DesignSpendAsk } from "../lib/design-api";
import { designsOfRun, useDesignStore, type DesignStore } from "../lib/design-store";
import {
  batchLine,
  briefTitle,
  coordinatorOf,
  designCanOpen,
  designCanRefine,
  designGroups,
  designLatest,
  designMeta,
  moveCoordinator,
  parentsLine,
  setupBlocked,
  setupCount,
  setupSummary,
  STATUS_WORD,
  statusCounts,
  toggleDirection,
  toggleGroup,
  toggleModel,
  type DesignRunView,
} from "../lib/design-ui";
import { designPageText } from "../lib/design-store";
import { DesignCoordinatorPanel } from "./DesignCoordinator";
import { createNearViewport, DesignScale, DesignSealedFrame, DesignStreamFrame } from "./DesignFrame";
import { DesignOpen, DesignRefinePanel } from "./DesignOpen";
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

export function designStatusTone(d: DesignRecord): "success" | "accent" | "error" | undefined {
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
  const [draft, setDraft] = createSignal<DesignSetup>(untrack(() => props.run.setup));
  const [saving, setSaving] = createSignal<"" | "saving" | "error">("");
  const [ask, setAsk] = createSignal<DesignSpendAsk | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const caps = () => props.store.view()?.caps ?? CAPS_FALLBACK;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // What the main chat changed comes in here; what you're changing stays yours until it is saved.
  createEffect(
    on(
      () => props.run.setup,
      (s) => {
        if (!dirty) setDraft(s);
      },
    ),
  );
  const save = () => {
    timer = undefined;
    const sent = draft();
    setSaving("saving");
    props.store.api
      .setup(props.run.id, sent)
      .then(() => {
        if (sent === draft()) dirty = false;
        setSaving("");
      })
      .catch(() => setSaving("error"));
  };
  const change = (next: DesignSetup) => {
    setDraft(next);
    setAsk(null);
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(save, 300);
  };
  onCleanup(() => {
    if (timer) {
      clearTimeout(timer);
      save();
    }
  });
  const count = () => setupCount(draft());
  const blocked = () => setupBlocked(draft(), caps());
  const start = async (confirmSpend: boolean) => {
    setBusy(true);
    setError("");
    try {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        await props.store.api.setup(props.run.id, draft());
      }
      dirty = false;
      const asks = await props.store.api.start(props.run.id, confirmSpend);
      if (asks) setAsk(asks);
      else props.store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The coordinator couldn't start. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const groups = () => designGroups(draft().models);
  return (
    <>
      <div class="card-head">
        <h3 class="card-title">Design</h3>
        <Chip>Setup</Chip>
      </div>
      <div class="design-card-body design-setup">
        <label class="field">
          <span class="field-label">Brief</span>
          <textarea class="input textarea" rows="2" value={draft().brief} onInput={(e) => change({ ...draft(), brief: e.currentTarget.value })} />
        </label>
        <div class="stack-2">
          <h4 class="design-setup-label">Models</h4>
          <div class="design-setup-groups" role="group" aria-label="Model groups">
            <For each={groups()}>
              {(g) => (
                <label class="toggle design-toggle-inline">
                  <input
                    type="checkbox"
                    checked={g.on === g.count}
                    ref={(el) => createEffect(() => (el.indeterminate = g.on > 0 && g.on < g.count))}
                    onChange={(e) => change(toggleGroup(draft(), g.id, e.currentTarget.checked))}
                  />
                  <span class="toggle-box" />
                  <span>{g.name}</span>
                </label>
              )}
            </For>
          </div>
          <ul class="list design-model-list" aria-label="Models">
            <For each={draft().models}>
              {(m) => (
                <li class="design-model-row">
                  <span class="design-model-name">
                    {m.name}
                    <Show when={!m.vision}>
                      <span class="text-muted design-model-note" title="This model can't read images. It works from a text outline of the page.">
                        {" "}
                        · text only
                      </span>
                    </Show>
                  </span>
                  <label class="toggle toggle-switch design-model-toggle">
                    <span>Design</span>
                    <input type="checkbox" checked={m.design} onChange={(e) => change(toggleModel(draft(), m.ref, e.currentTarget.checked))} />
                    <span class="toggle-box" />
                  </label>
                  <label class="toggle design-model-toggle" title="1 model coordinates the team. It can coordinate without designing.">
                    <span>Coordinator</span>
                    <input
                      type="checkbox"
                      checked={m.coordinator}
                      onChange={(e) => {
                        e.currentTarget.checked = true;
                        change(moveCoordinator(draft(), m.ref));
                      }}
                    />
                    <span class="toggle-box" />
                  </label>
                </li>
              )}
            </For>
          </ul>
        </div>
        <div class="stack-2">
          <h4 class="design-setup-label">Directions</h4>
          <div class="design-directions">
            <For each={draft().directions}>
              {(d) => (
                <label class="toggle design-toggle-inline">
                  <input type="checkbox" checked={d.on} onChange={(e) => change(toggleDirection(draft(), d.name, e.currentTarget.checked))} />
                  <span class="toggle-box" />
                  <span>{d.name}</span>
                </label>
              )}
            </For>
          </div>
        </div>
      </div>
      <Show when={ask()}>
        {(a) => (
          <div class="design-card-body design-spend" role="group" aria-label="Confirm the spend">
            <p>
              {a().designs} designs{a().estimateUsd ? `, about $${a().estimateUsd!.toFixed(2)}` : ""}. That's more than {caps().askAbove}, so we ask before starting.
            </p>
            <div class="button-row">
              <button type="button" class="button button-ghost" disabled={busy()} onClick={() => setAsk(null)}>
                Cancel
              </button>
              <button type="button" class="button button-primary" disabled={busy()} onClick={() => void start(true)}>
                Start {a().designs} Designs
              </button>
            </div>
          </div>
        )}
      </Show>
      <div class="card-foot design-setup-foot">
        <div class="design-setup-summary">
          <span>{setupSummary(count())}</span>
          <Show when={saving() === "error"}>
            <span class="field-error">This selection couldn't be saved. Your clicks are still here.</span>
          </Show>
          <Show when={blocked()}>{(why) => <span class="text-muted">{why()}</span>}</Show>
          <Show when={error()}>
            <span class="field-error" role="alert">
              {error()}
            </span>
          </Show>
        </div>
        <Show when={!ask()}>
          <button type="button" class="button button-primary" disabled={busy() || !!blocked()} onClick={() => void start(false)}>
            Start Coordinator
          </button>
        </Show>
      </div>
    </>
  );
}

// ---- After Setup ------------------------------------------------------------------------------

function DesignRunBody(props: { run: DesignRunView; store: DesignStore; newest: boolean; cacheKey: string }) {
  const [refining, setRefining] = createSignal<string | null>(null);
  const [opened, setOpened] = createSignal<DesignOpenTarget | null>(null);
  const designs = createMemo(() => designsOfRun(props.store.view(), props.run.id, props.run.labels));
  const counts = () => statusCounts(designs());
  const anyLive = () => designs().some((d) => d.status === "writing");
  const coordinator = () => coordinatorOf(props.store.view());
  const refined = () => designs().find((d) => d.label === refining());
  return (
    <>
      <div class="card-head design-run-head">
        <div class="design-run-title">
          <h3 class="card-title">{briefTitle(props.run.setup.brief)}</h3>
          <Show when={designs().length > 0}>
            <span class="text-caption text-muted">{batchLine(designs())}</span>
          </Show>
        </div>
        <Show when={designs().length > 0} fallback={<Chip live={props.run.phase === "researching"}>{props.run.phase === "confirm" ? "Waiting on you" : props.run.phase === "stopped" ? "Stopped" : "Looking for the screen"}</Chip>}>
          <Chip live={anyLive()} tone={anyLive() ? "accent" : undefined}>
            {counts()}
          </Chip>
        </Show>
      </div>
      <Show when={props.run.error}>
        {(e) => (
          <div class="design-card-body">
            <p class="field-error">{e()}</p>
          </div>
        )}
      </Show>
      <Show when={props.run.phase === "confirm" && props.run.confirm}>{(c) => <DesignConfirmPanel run={props.run} confirm={c()} store={props.store} />}</Show>
      <Show when={props.run.phase === "researching"}>
        <div class="design-card-body">
          <p class="text-muted">The coordinator is finding the screen to design. It stops here to show you what it found.</p>
        </div>
      </Show>
      <Show when={designs().length > 0}>
        <div class="design-card-body">
          <div class="design-grid">
            <For each={designs()}>
              {(d) => (
                <DesignTile
                  d={d}
                  store={props.store}
                  cacheKey={props.cacheKey}
                  onOpen={() => setOpened({ kind: "design", label: d.label })}
                  onRefine={() => setRefining(d.label)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={refined()}>
        {(d) => (
          <div class="design-card-body design-card-refine">
            <DesignRefinePanel d={d()} store={props.store} onClose={() => setRefining(null)} />
          </div>
        )}
      </Show>
      <Show when={props.newest && coordinator()}>
        {(c) => (
          <div class="design-card-body design-card-coordinator">
            <DesignCoordinatorPanel coordinator={c()} view={props.store.view()} store={props.store} onOpen={() => setOpened({ kind: "coordinator" })} />
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

function DesignConfirmPanel(props: { run: DesignRunView; confirm: NonNullable<DesignRunView["confirm"]>; store: DesignStore }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const answer = async (verdict: "design" | "not-this") => {
    setBusy(true);
    setError("");
    try {
      await props.store.api.confirm(props.run.id, verdict, text().trim() || undefined);
      setText("");
      props.store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't reach the coordinator. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="design-card-body design-confirm">
      <p>{props.confirm.text}</p>
      <Show when={props.confirm.url}>{(u) => <code class="design-confirm-url">{u()}</code>}</Show>
      <For each={props.confirm.screenshots}>{(src) => <img class="design-confirm-shot" src={props.store.api.shotUrl(src)} alt="The screen the coordinator found" />}</For>
      <Show when={props.confirm.outline}>{(o) => <pre class="design-confirm-outline">{o()}</pre>}</Show>
      <label class="field">
        <span class="field-label">Or tell it which screen or address to use</span>
        <textarea class="input textarea" rows="2" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      </label>
      <Show when={error()}>
        <p class="field-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="button-row design-confirm-actions">
        <button type="button" class="button" disabled={busy()} onClick={() => void answer("not-this")}>
          Not This Screen
        </button>
        <button type="button" class="button button-primary" disabled={busy()} onClick={() => void answer("design")}>
          Design This Screen
        </button>
      </div>
    </div>
  );
}

// ---- One design -------------------------------------------------------------------------------

/** One design's picture in a grid: the page as far as it has been written, then finished. */
export function DesignThumb(props: { d: DesignRecord; store: DesignStore; cacheKey: string }) {
  let box: HTMLDivElement | undefined;
  const near = createNearViewport(() => box);
  const live = () => props.store.live(props.d.label);
  const version = createMemo(() => designLatest(props.d));
  const writing = () => !!props.d.live;
  const [html, setHtml] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal("");
  const [drawn, setDrawn] = createSignal(false);
  createEffect(
    on([version, near], ([v, isNear]) => {
      if (!v || !isNear || html() !== null) return;
      setFailed("");
      designPageText(props.store, props.cacheKey, props.d.label, v)
        .then((t) => setHtml(t))
        .catch((e) => setFailed(e instanceof Error ? e.message : "This page couldn't be loaded."));
    }),
  );
  createEffect(
    on(version, () => {
      setHtml(null);
      setDrawn(false);
    }, { defer: true }),
  );
  const title = () => `Design ${props.d.label}, ${props.d.direction}`;
  return (
    <div class="design-tile-page" ref={box}>
      <DesignScale label={`${title()}: ${STATUS_WORD[props.d.status]}`}>
        <Show when={near()}>
          <Show when={html() !== null && !writing()} fallback={null}>
            <div class={drawn() ? "design-frame-layer" : "design-frame-layer design-frame-layer-hidden"}>
              <DesignSealedFrame html={html()!} motion={false} title={title()} onDrawn={() => setDrawn(true)} />
            </div>
          </Show>
          <Show when={writing() || (html() !== null && !drawn() && live())}>
            <DesignStreamFrame text={live()?.text ?? ""} title={title()} />
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
  return (
    <article class="design-tile" aria-label={`Design ${props.d.label}`}>
      <DesignThumb d={props.d} store={props.store} cacheKey={props.cacheKey} />
      <div class="design-tile-info">
        <div class="design-tile-title">
          <span class="design-tile-label">{props.d.label}</span>
          <span class="design-tile-direction">{props.d.direction}</span>
          <Show when={props.d.delivery?.state === "queued"} fallback={<Chip tone={designStatusTone(props.d)} live={props.d.status === "writing"}>{STATUS_WORD[props.d.status]}</Chip>}>
            <Chip tone="accent">Queued</Chip>
          </Show>
        </div>
        <p class="text-caption text-muted design-tile-meta">
          {meta()}
          <Show when={props.d.parents.length > 0}> · {parentsLine(props.d.parents)}</Show>
        </p>
        <Show when={props.d.status === "failed" && props.d.error}>
          <p class="text-caption design-tile-error">{props.d.error}</p>
        </Show>
        <Show when={props.d.delivery?.state === "undelivered"}>
          <p class="text-caption design-tile-error">{props.d.delivery?.error || "That message couldn't be delivered. Your text is still in the box."}</p>
        </Show>
        <Show when={error()}>
          <p class="text-caption design-tile-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="design-tile-actions">
          <Show when={props.d.status === "failed"}>
            <button type="button" class="button button-sm" disabled={busy()} onClick={() => void retry()}>
              <Icon name="refresh" small />
              Retry
            </button>
          </Show>
          <button type="button" class="button button-sm" disabled={!designCanOpen(props.d)} title={designCanOpen(props.d) ? undefined : "Opens once the page is finished."} onClick={() => props.onOpen()}>
            Open
          </button>
          <button type="button" class="button button-sm" disabled={!designCanRefine(props.d)} title={designCanRefine(props.d) ? undefined : "Refine waits for a finished page."} onClick={() => props.onRefine()}>
            Refine
          </button>
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
