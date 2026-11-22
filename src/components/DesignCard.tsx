import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  useContext,
} from "solid-js";
import type {
  DesignCaps,
  DesignChatView,
  DesignRecord,
} from "../../shared/design";
import {
  DESIGN_ASK_ABOVE,
  DESIGN_BATCH_DEFAULT,
  DESIGN_BATCH_MAX,
  DESIGN_CONCURRENT,
  designDirectionLine,
} from "../../shared/design";
import { briefStatus, setupLinks, withLinkUse } from "../lib/design-brief";
import {
  designsOfRun,
  useDesignStore,
  type DesignStore,
} from "../lib/design-store";
import {
  batchLine,
  briefTitle,
  lookbookTitle,
  coordinatorOf,
  designCanOpen,
  designCanStartAgain,
  designCanStop,
  designNoteLine,
  designIsBusy,
  designLatest,
  designMeta,
  designNeverStarted,
  designQueuedLine,
  designsRemoved,
  designsShown,
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
import { rememberDesignCardHeight } from "../lib/design-card-size";
import { DesignBriefRow, DesignBriefStep } from "./DesignBrief";
import { coordinatorChip, DesignAskPanel, DesignDeliveryLine } from "./DesignCoordinator";
import { DesignCardFoot } from "./DesignCardFoot";
import { ActionMenu } from "./ActionMenu";
import { Markdown } from "./Markdown";
import {
  createSetupDraft,
  DesignLinkRow,
  DesignRequestField,
  DesignSetupPickers,
} from "./DesignSetupControls";
import {
  createFontsSettled,
  createNearViewport,
  DesignScale,
  DesignSealedFrame,
  DesignStreamFrame,
} from "./DesignFrame";
import { DesignOpenSlot } from "./DesignOpen";
import { DesignSkillsLine } from "./DesignSkills";
import { DesignSetupImages } from "./DesignBriefImages";
import { useDesignOpen } from "../lib/design-history";
import { hostOf } from "../lib/mesh";
import { Chip, Icon } from "./ui";
import "./DesignCard.css";

/** The chat a Design card or the Gallery reads. Only a chat you can write to provides it. */
export interface DesignSessionHost {
  path(): string | undefined;
  host(): string | null;
}
export const DesignSessionContext = createContext<DesignSessionHost | null>(
  null,
);

export const CAPS_FALLBACK: DesignCaps = {
  batchDefault: DESIGN_BATCH_DEFAULT,
  askAbove: DESIGN_ASK_ABOVE,
  batchMax: DESIGN_BATCH_MAX,
  concurrent: DESIGN_CONCURRENT,
};

export type { DesignOpenTarget } from "../lib/design-history";

/** What a page with no text yet says instead. */
export function designWaiting(d: DesignRecord): string | undefined {
  return d.status === "fixing"
    ? "Fixing the page"
    : d.readingSkill
      ? "Reading the design skill"
      : d.thinking
      ? "Thinking about the page"
      : undefined;
}

export function designStatusTone(
  d: DesignRecord,
): "success" | "accent" | "error" | "warn" | undefined {
  if (d.status === "fixing") return "warn";
  if (d.status === "ready" && d.workerState === "working") return "accent";
  if (d.status === "queued" && d.sessionId && !d.sessionEnded) return "accent";
  return d.status === "ready"
    ? "success"
    : d.status === "writing"
      ? "accent"
      : d.status === "failed"
        ? "error"
        : undefined;
}

/** The transcript card. One per run: it follows the run through Setup, Confirm and the finished grid. */
export function DesignCard(props: { runId: string }) {
  const host = useContext(DesignSessionContext);
  return (
    <Show
      when={host?.path()}
      fallback={
        <p class="field-hint">
          Open this conversation in its chat to see its designs.
        </p>
      }
      keyed
    >
      {(path) => (
        <DesignCardIn runId={props.runId} path={path} host={host!.host()} />
      )}
    </Show>
  );
}

function DesignCardIn(props: {
  runId: string;
  path: string;
  host: string | null;
}) {
  const store = useDesignStore(props.path, props.host);
  const run = createMemo(
    () =>
      store.view()?.runs.find((r) => r.id === props.runId) as
        DesignRunView | undefined,
  );
  const newest = () => store.view()?.runs.at(-1)?.id === props.runId;
  const fontsSettled = createFontsSettled();
  let card!: HTMLElement;
  // The card takes the height it needs; the transcript estimates it at the height last seen here.
  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (run()) rememberDesignCardHeight(props.runId, card.getBoundingClientRect().height);
    });
    ro.observe(card);
    onCleanup(() => ro.disconnect());
  });
  return (
    <section
      ref={card}
      class="card design-card"
      aria-label={`Lookbook: ${run() ? briefTitle(run()!.setup.brief) : "loading"}`}
    >
      <Show when={fontsSettled()}>
        <Show
          when={run()}
          fallback={
            <div class="design-card-body">
              <Show
                when={store.error()}
                fallback={
                  <div class="skeleton skeleton-row" aria-busy="true" />
                }
              >
                <p class="field-error" role="alert">
                  {store.error()}{" "}
                  <button
                    type="button"
                    class="button button-ghost button-sm"
                    onClick={() => store.refresh()}
                  >
                    Retry
                  </button>
                </p>
              </Show>
              <Show when={store.view() && !run()}>
                <p class="text-muted">
                  This design run isn't in this chat anymore.
                </p>
              </Show>
            </div>
          }
        >
          {(r) => (
            <Show
              when={r().phase === "setup"}
              fallback={
                <DesignRunBody
                  run={r()}
                  store={store}
                  newest={newest()}
                  cacheKey={props.path}
                />
              }
            >
              <DesignSetupCard run={r()} store={store} />
            </Show>
          )}
        </Show>
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
      setError(
        e instanceof Error
          ? e.message
          : "The Creative Director couldn't start. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  // Why Start can't be pressed, or a save that failed: under the count, only when there is one.
  const reason = () =>
    setup.saving() === "error"
      ? "This selection couldn't be saved. Your clicks are still here."
      : error() || blocked() || "";
  // Rows are keyed by address, so choosing a use keeps its row.
  const linkUrls = () => setupLinks(draft()).map((l) => l.url);
  return (
    <>
      <div class="card-head">
        <h3 class="card-title">Lookbook</h3>
        <Chip>Setup</Chip>
      </div>
      <div class="design-card-body design-setup">
        <div class="design-request-group">
          <DesignRequestField setup={setup} openKey={`${props.run.id}:setup`} />
          {/* The links in the request, each with how it's used, and the run's design skills, under its preview. */}
          <Show when={linkUrls().length > 0}>
            <div class="design-setup-links" aria-label="Links">
              <For each={linkUrls()}>
                {(url) => (
                  <DesignLinkRow
                    url={url}
                    use={setupLinks(draft()).find((l) => l.url === url)?.use ?? null}
                    onUse={(use) => setup.change(withLinkUse(draft(), url, use))}
                  />
                )}
              </For>
            </div>
          </Show>
          <DesignSkillsLine run={props.run} />
        </div>
        <DesignSetupImages run={props.run} store={props.store} />
        <DesignSetupPickers setup={setup} run={props.run} store={props.store} openKey={`${props.run.id}:setup`} currentCoordinator={props.store.view()?.coordinator?.model} />
      </div>
      <DesignCardFoot class="design-setup-foot">
        <div class="design-setup-summary">
          <span class="design-setup-count">{setupSummary(count())}</span>
          <Show when={reason()}>
            <span
              class={`design-setup-reason ${setup.saving() === "error" || error() ? "field-error" : "text-muted"}`}
              title={reason()}
              role={error() ? "alert" : undefined}
            >
              {reason()}
            </span>
          </Show>
        </div>
        <button
          type="button"
          class="button button-primary design-setup-start"
          disabled={busy() || !!blocked()}
          onClick={() => void start()}
        >
          Start Creative Director
        </button>
      </DesignCardFoot>
    </>
  );
}

// ---- After Setup ------------------------------------------------------------------------------

function DesignRunBody(props: {
  run: DesignRunView;
  store: DesignStore;
  newest: boolean;
  cacheKey: string;
}) {
  // What this chat has open is shared with its other surfaces and kept in the browser's history.
  const nav = useDesignOpen(props.cacheKey, hostOf(props.cacheKey));
  const designs = createMemo(() =>
    designsOfRun(props.store.view(), props.run.id, props.run.labels),
  );
  const shown = createMemo(() => designsShown(designs()));
  const counts = () => statusCounts(designs());
  const anyLive = () => shown().some(designIsBusy);
  const coordinator = () => coordinatorOf(props.store.view());
  const waitingChip = () =>
    props.run.phase === "brief" && props.run.brief
      ? briefStatus(props.run)
      : props.run.phase === "stopped"
        ? { text: "Stopped", live: false }
        : props.run.phase === "researching" || props.run.phase === "brief"
          ? { text: "Preparing the brief", live: true }
          : { text: "Starting the designs", live: true };
  const briefOpen = () => props.run.phase === "brief" && !!props.run.brief;
  const openCoordinator = () => nav.open({ kind: "coordinator" });
  return (
    <>
      <div class="card-head design-run-head">
        <h3 class="card-title design-run-title">
          {lookbookTitle(shown().length)}
          <span class="text-muted"> · {briefTitle(props.run.setup.brief)}</span>
        </h3>
        <div class="design-run-sub">
          <span class="text-caption text-muted design-run-batch">
            {shown().length > 0 ? batchLine(designs(), props.run.setup.combine) : ""}
          </span>
          <Show
            when={designs().length > 0}
            fallback={
              <Chip live={waitingChip().live}>{waitingChip().text}</Chip>
            }
          >
            <Chip live={anyLive()} tone={anyLive() ? "accent" : undefined}>
              <span class="design-run-counts" title={counts()}>
                {counts()}
              </span>
            </Chip>
          </Show>
        </div>
      </div>
      <Show
        when={briefOpen()}
        fallback={
          <>
            <Show
              when={
                props.run.phase === "researching" ||
                (props.run.phase === "brief" && !props.run.brief)
              }
            >
              <div class="empty design-card-waiting">
                <p class="empty-body">
                  The Creative Director is preparing your brief. Nothing is designed
                  until you press Start.
                </p>
              </div>
            </Show>
            <DesignBriefRow run={props.run} store={props.store} nav={nav} />
            <Show when={designs().length > 0}>
              <div class="design-card-body design-card-designs">
                <DesignTiles
                  designs={designs()}
                  store={props.store}
                  cacheKey={props.cacheKey}
                  onOpen={(label) => nav.open({ kind: "design", label })}
                />
              </div>
            </Show>
            <Show
              when={props.newest && coordinator()}
              fallback={
                <Show when={props.run.error}>
                  {(e) => <RunError text={e()} />}
                </Show>
              }
            >
              {(c) => (
                <>
                  <section class="design-card-coordinator" aria-label="The Creative Director's notes">
                    <Show when={props.run.error}>
                      {(e) => <RunError text={e()} />}
                    </Show>
                    <Show when={c().ask}>
                      {(a) => <DesignAskPanel ask={a()} store={props.store} />}
                    </Show>
                    <Show
                      when={c().card}
                      fallback={
                        <p class="text-muted design-coordinator-empty">
                          Nothing on its card yet. It writes here as it goes.
                        </p>
                      }
                    >
                      <div class="design-coordinator-notes">
                        <Markdown text={c().card} />
                      </div>
                    </Show>
                  </section>
                  <DesignCardFoot class="design-run-foot" label="Creative Director">
                    <CoordinatorLine store={props.store} />
                    <button
                      type="button"
                      class="button button-primary design-run-chat"
                      onClick={openCoordinator}
                    >
                      Chat with the Creative Director
                    </button>
                  </DesignCardFoot>
                </>
              )}
            </Show>
          </>
        }
      >
        <DesignBriefStep
          run={props.run}
          store={props.store}
          nav={nav}
          onOpenCoordinator={openCoordinator}
        />
      </Show>
      <DesignOpenSlot nav={nav} store={props.store} path={props.cacheKey} />
    </>
  );
}

function RunError(props: { text: string }) {
  return (
    <div class="banner banner-compact banner-error design-run-error" role="alert">
      <Icon name="alert-circle" small class="banner-icon" />
      <p class="banner-body">{props.text}</p>
    </div>
  );
}

/** The bar's words: who it is, its status, and where a message to it stands. */
export function CoordinatorLine(props: { store: DesignStore }) {
  const c = () => coordinatorOf(props.store.view());
  return (
    <Show when={c()}>
      {(co) => {
        const chip = () => coordinatorChip(co(), props.store.view());
        return (
          <div class="design-run-foot-line">
            <span class="design-run-foot-name">
              <strong>Creative Director</strong>
              <Chip live={chip().live} tone={chip().tone}>
                {chip().text}
              </Chip>
            </span>
            <span class="text-caption design-run-foot-note">
              <DesignDeliveryLine delivery={co().delivery} name="the Creative Director" />
            </span>
          </div>
        );
      }}
    </Show>
  );
}

// ---- The grid ---------------------------------------------------------------------------------

/**
 * A run's (or a chat's) designs: the grid, then the designs set aside, folded under "Removed · n".
 * Keyed by label: a record changing never rebuilds its tile or the frame in it. Only a click, a
 * design added, Remove and Restore change what the grid holds.
 */
export function DesignTiles(props: {
  designs: readonly DesignRecord[];
  store: DesignStore;
  cacheKey: string;
  onOpen(label: string): void;
  class?: string;
}) {
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const shown = createMemo(() => designsShown(props.designs).map((d) => d.label), undefined, { equals: sameList });
  const removed = createMemo(() => designsRemoved(props.designs).map((d) => d.label), undefined, { equals: sameList });
  const [open, setOpen] = createSignal(false);
  const recordOf = (label: string) => props.designs.find((d) => d.label === label);
  const tile = (label: string) => (
    <Show when={recordOf(label)}>
      {(d) => (
        <DesignTile
          d={d()}
          store={props.store}
          cacheKey={props.cacheKey}
          onOpen={() => props.onOpen(label)}
        />
      )}
    </Show>
  );
  return (
    <>
      <Show when={shown().length > 0}>
        <div class={`design-grid${props.class ? ` ${props.class}` : ""}`}>
          <For each={shown()}>{tile}</For>
        </div>
      </Show>
      <Show when={removed().length > 0}>
        <section class="design-removed" aria-label="Removed designs">
          <div class="design-removed-head">
            <button
              type="button"
              class="design-removed-fold"
              aria-expanded={open()}
              onClick={() => setOpen(!open())}
            >
              <Icon name="chevron-right" small class={`icon-twist${open() ? " design-removed-twist-open" : ""}`} />
              <span class="design-removed-title">Removed · {removed().length}</span>
            </button>
            <span class="text-caption text-muted design-removed-hint">
              Set aside, not deleted. Restore puts one back.
            </span>
          </div>
          <Show when={open()}>
            <div class={`design-grid${props.class ? ` ${props.class}` : ""}`}>
              <For each={removed()}>{tile}</For>
            </div>
          </Show>
        </section>
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

const stillCache = new Map<string, Promise<string>>();
/** A stopped design's still, fetched once per browser while it is wanted. */
function designStillText(store: DesignStore, cacheKey: string, label: string, n: number, images: "small" | "full"): Promise<string> {
  const key = `${cacheKey}|${label}|${n}|${images}`;
  const held = stillCache.get(key);
  if (held) return held;
  const fetched = store.api.stillPage(label, n, images);
  fetched.catch(() => stillCache.delete(key));
  stillCache.set(key, fetched);
  while (stillCache.size > 24) stillCache.delete(stillCache.keys().next().value!);
  return fetched;
}

/** One design's picture in a grid: the page as far as it has been written, then finished. */
export function DesignThumb(props: {
  d: DesignRecord;
  store: DesignStore;
  cacheKey: string;
}) {
  let box: HTMLDivElement | undefined;
  const near = createNearViewport(() => box);
  const live = () => props.store.live(props.d.label);
  const version = createMemo(() => designLatest(props.d));
  // A design stopped before its first page shows what it had written, held still.
  const still = createMemo(() => (props.d.status === "stopped" ? (props.d.stopped?.still?.n ?? 0) : 0));
  const [stillHtml, setStillHtml] = createSignal<string | null>(null);
  const [slots, setSlots] = createSignal<PageSlot[]>([]);
  const [front, setFront] = createSignal(0);
  const [failed, setFailed] = createSignal("");
  const [streamed, setStreamed] = createSignal(false);
  const writing = () =>
    !!props.d.live ||
    props.d.status === "writing" ||
    props.d.status === "fixing";
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
      designPageText(props.store, props.cacheKey, props.d.label, v, "small")
        .then((html) => {
          if (v === version())
            setSlots((list) => [
              ...list.filter((s) => s.v === front()),
              { v, html },
            ]);
        })
        .catch((e) =>
          setFailed(
            e instanceof Error ? e.message : "This page couldn't be loaded.",
          ),
        );
    }),
  );
  createEffect(
    on([still, near], ([n, isNear]) => {
      if (!n || !isNear) return setStillHtml(null);
      designStillText(props.store, props.cacheKey, props.d.label, n, "small")
        .then((html) => {
          if (n === still()) setStillHtml(html);
        })
        .catch((e) => setFailed(e instanceof Error ? e.message : "What it had written couldn't be loaded."));
    }),
  );
  const drawn = (slot: PageSlot) => {
    if (slot.v < front()) return;
    setFront(slot.v);
    if (!writing()) setStreamed(false);
    setSlots((list) => list.filter((s) => s.v === slot.v));
  };
  // Writing to finished keeps the last picture until the finished page has drawn. During a Refine the
  // earlier version stays on show, with no note over it, until the new page has something to see.
  const showStream = () =>
    writing() || (streamed() && version() > 0 && front() < version());
  const title = () => `Design ${props.d.label}, ${designDirectionLine(props.d)}`;
  return (
    <div class="design-tile-page" ref={box}>
      <DesignScale label={`${title()}: ${STATUS_WORD[props.d.status]}`}>
        <Show when={near()}>
          <For each={slots()}>
            {(slot) => (
              <div
                class="design-frame-layer"
                style={{ "z-index": front() === slot.v ? 2 : 1 }}
              >
                <DesignSealedFrame
                  html={slot.html}
                  motion={false}
                  title={title()}
                  onDrawn={() => drawn(slot)}
                />
              </div>
            )}
          </For>
          <Show when={stillHtml()} keyed>
            {(html) => (
              <div class="design-frame-layer" style={{ "z-index": 2 }}>
                <DesignSealedFrame html={html} motion={false} title={`${title()}, stopped`} />
              </div>
            )}
          </Show>
          <Show when={showStream()}>
            <div class="design-frame-layer" style={{ "z-index": 3 }}>
              <DesignStreamFrame
                api={props.store.api}
                label={props.d.label}
                version={live()?.version}
                draw={live()?.draw}
                text={live()?.text ?? ""}
                title={title()}
                waiting={designWaiting(props.d)}
                over={version() > 0}
                still
              />
            </div>
          </Show>
        </Show>
      </DesignScale>
      {/* A new node for each wording: new words re-centred in the old node count as a layout shift. */}
      <Show when={designQueuedLine(props.d)}>
        {(line) => (
          <div class="design-tile-state">
            <Show when={line()} keyed>
              {(words) => <span>{words}</span>}
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.d.status === "stopped" && !props.d.stopped?.still}>
        <div class="design-tile-state">{designNeverStarted(props.d) ? "Not started yet" : "Stopped before it wrote anything"}</div>
      </Show>
      <Show when={props.d.status === "failed" && props.d.versions.length === 0}>
        <div class="design-tile-state design-tile-state-error">
          No page was written
        </div>
      </Show>
      <Show when={failed()}>
        <div class="design-tile-state design-tile-state-error">{failed()}</div>
      </Show>
    </div>
  );
}

const STOPPED_BY = { user: "Stopped by you.", coordinator: "Stopped by the Creative Director.", main: "Stopped from your chat." } as const;

/** Why Stop can't run on a design, in its menu row; "" when it can. */
function stopWhyNot(d: DesignRecord): string {
  if (designCanStop(d)) return "";
  if (designNeverStarted(d)) return "It hasn't started.";
  if (d.status === "stopped") return "It's already stopped.";
  if (d.status === "failed") return "It isn't running.";
  return "It's finished: nothing is being written.";
}

/**
 * A design's More menu, on its tile and in its open view: Stop and Remove (Restore once removed). A
 * menu, so the tile's buttons never change in number or size. The failure, if any, goes to `onError`.
 */
export function DesignActionsMenu(props: {
  d: DesignRecord;
  store: DesignStore;
  class?: string;
  /** An Open row, for a place whose own Open button is taken by Start Again. */
  onOpen?(): void;
  onError(text: string): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    props.onError("");
    try {
      await run();
      props.store.refresh();
    } catch (e) {
      props.onError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  const label = () => props.d.label;
  const waiting = () => (busy() ? "Working on your last click." : "");
  return (
    <ActionMenu
      label={`More for design ${label()}`}
      title="More"
      ghost={false}
      class={props.class}
      menuName={`Design ${label()}`}
      returnFocus
    >
      {(menu) => (
        <Show
          when={!props.d.removed}
          fallback={
            <menu.Item
              label={`Restore ${label()}`}
              aria={`Restore design ${label()}`}
              disabled={waiting()}
              description="Puts it back in the grid as it was."
              onRun={() => void act(() => props.store.api.restore(label()), `${label()} couldn't be restored. Try again.`)}
            />
          }
        >
          <Show when={props.onOpen}>
            <menu.Item label="Open" aria={`Open design ${label()}`} onRun={() => props.onOpen!()} />
          </Show>
          <menu.Item
            label={`Stop ${label()}`}
            aria={`Stop design ${label()}`}
            disabled={stopWhyNot(props.d) || waiting()}
            description="Keeps what it has written. Start Again writes it afresh."
            onRun={() => void act(() => props.store.api.stop(label()), `${label()} couldn't be stopped. Try again.`)}
          />
          <div class="popover-sep" role="separator" />
          <menu.Item
            label={`Remove ${label()}`}
            aria={`Remove design ${label()}`}
            disabled={waiting()}
            description={designCanStop(props.d) ? "Stops it, then sets it aside under Removed." : "Sets it aside under Removed. Restore puts it back."}
            onRun={() => void act(() => props.store.api.remove(label()), `${label()} couldn't be removed. Try again.`)}
          />
        </Show>
      )}
    </ActionMenu>
  );
}

export function DesignTile(props: {
  d: DesignRecord;
  store: DesignStore;
  cacheKey: string;
  onOpen(): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError("");
    try {
      await run();
      props.store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  };
  const retry = () => act(() => props.store.api.retry(props.d.label), "That didn't go through. Try again.");
  const restore = () => act(() => props.store.api.restore(props.d.label), `${props.d.label} couldn't be restored. Try again.`);
  const meta = () =>
    designMeta(props.d, props.store.live(props.d.label)?.text.length);
  const removed = () => !!props.d.removed;
  // One two-line place for why a design isn't simply fine: nothing around it ever moves for it.
  const reason = () => {
    if (error()) return { text: error(), error: true, alert: true };
    if (props.d.status === "failed" && props.d.error)
      return { text: props.d.error, error: true, alert: false };
    if (designNeverStarted(props.d))
      return { text: "It waits until you or the Creative Director start it.", error: false, alert: false };
    if (props.d.status === "stopped")
      return { text: `${STOPPED_BY[props.d.stopped?.by ?? "user"]} Start Again writes the page afresh.`, error: false, alert: false };
    if (props.d.delivery?.state === "undelivered")
      return {
        text:
          props.d.delivery.error ||
          "That message couldn't be delivered. Your text is still in the box.",
        error: true,
        alert: false,
      };
    return { text: designNoteLine(props.d), error: false, alert: false };
  };
  // The first place is the design's next step: Open, or Start Again for one that ended with no page.
  const startAgain = () => !removed() && designCanStartAgain(props.d);
  const openButton = () => (
    <button
      type="button"
      class="button button-sm"
      disabled={!designCanOpen(props.d)}
      title={
        designCanOpen(props.d)
          ? undefined
          : "Opens once a page is being written."
      }
      onClick={() => props.onOpen()}
    >
      Open
    </button>
  );
  return (
    <article class="design-tile" aria-label={`Design ${props.d.label}`} data-removed={removed() ? "" : undefined}>
      <DesignThumb d={props.d} store={props.store} cacheKey={props.cacheKey} />
      <div class="design-tile-info">
        <div class="design-tile-title">
          <span class="design-tile-label">{props.d.label}</span>
          <span class="design-tile-direction" title={designDirectionLine(props.d)}>
            {designDirectionLine(props.d)}
          </span>
          <span class="design-tile-chip">
            <Chip
              tone={
                props.d.delivery?.state === "queued"
                  ? "accent"
                  : designStatusTone(props.d)
              }
              live={
                designIsBusy(props.d) && props.d.delivery?.state !== "queued"
              }
            >
              {designStatusWord(props.d)}
            </Chip>
          </span>
        </div>
        <p class="text-caption text-muted design-tile-meta" title={meta()}>
          {meta()}
          <Show when={props.d.parents.length > 0}>
            {" "}
            · {parentsLine(props.d.parents)}
          </Show>
        </p>
        <p
          class={`text-caption design-tile-note${reason().error ? " design-tile-error" : " text-muted"}`}
          role={reason().alert ? "alert" : undefined}
          title={reason().text || undefined}
        >
          {reason().text}
        </p>
        <div class="design-tile-actions">
          <Show when={startAgain()} fallback={openButton()}>
            <button
              type="button"
              class="button button-sm"
              disabled={busy()}
              onClick={() => void retry()}
            >
              {designNeverStarted(props.d) ? "Start" : props.d.status === "stopped" ? "Start Again" : "Retry"}
            </button>
          </Show>
          <button
            type="button"
            class="button button-sm"
            disabled={!props.d.sessionFile}
            title={
              props.d.sessionFile ? undefined : "Its session hasn't started."
            }
            onClick={() => props.onOpen()}
          >
            Chat
          </button>
          <Show
            when={!removed()}
            fallback={
              <button
                type="button"
                class="button button-sm"
                disabled={busy()}
                onClick={() => void restore()}
              >
                Restore
              </button>
            }
          >
            <DesignActionsMenu
              d={props.d}
              store={props.store}
              class="button-sm design-tile-more"
              onOpen={startAgain() && designCanOpen(props.d) ? () => props.onOpen() : undefined}
              onError={setError}
            />
          </Show>
        </div>
      </div>
    </article>
  );
}

/** The grid of designs the Gallery shows, one chat's every run. */
export function designGrid(view: DesignChatView | null): DesignRecord[] {
  return [...(view?.designs ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

