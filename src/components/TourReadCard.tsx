import { createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { TourPresentation, TourSize } from "../../shared/tour";
import { tourChapterRows, tourPosition, type TourChapterRow, type TourPosition } from "../lib/tour-state";
import { Icon } from "./ui";
import { TourViewer, type TourViewerProps } from "./TourViewer";
import "./TourViewer.css";

export interface TourReadCardProps {
  title: string; summary?: string; steps: number;
  loadManifest(): Promise<TourPresentation>;
  assetUrl(file: string): string;
  loadProgress?(): Promise<TourPosition | null>;
  saveProgress?(position: TourPosition): Promise<unknown>;
  onAsk?(question: string): void;
  onRequestCoverage?(question: string): void;
  loadDestinations?(): Promise<Record<string, Record<string, Partial<Record<TourSize, string>>>>>;
  openPage?: TourViewerProps["openPage"];
  onShare?(): void;
  onContinueAcrossDevices?(): void;
  actions?: JSX.Element;
}

/** First rows a narrow card shows before "Show all N". */
export const TOUR_CHAPTERS_FOLDED = 4;
/** "In this tour": one chapter per line, each a button opening the viewer at its first step. */
export function TourChapterList(props: { manifest: Pick<TourPresentation, "chapters" | "steps">; disabled?: boolean; onOpen(row: TourChapterRow, button: HTMLButtonElement): void }) {
  const [all, setAll] = createSignal(false);
  const rows = () => tourChapterRows(props.manifest);
  const headingId = `tour-chapters-${createUniqueId()}`;
  return <nav class="tour-card-chapters" aria-labelledby={headingId}><h4 id={headingId}>In this tour</h4>
    <ol class="tour-chapter-list" classList={{ "tour-chapter-list-wide": rows().length > 5 }} style={{ "--tour-chapter-rows": String(Math.ceil(rows().length / 2)) }}><For each={rows()}>{(row, i) => <li classList={{ "tour-chapter-folded": !all() && i() >= TOUR_CHAPTERS_FOLDED }}><button type="button" class="tour-chapter-row" disabled={props.disabled} aria-label={`${row.title}, ${row.label}`} onClick={e => props.onOpen(row, e.currentTarget)}><span class="tour-chapter-num" aria-hidden="true">{row.n}</span><span class="tour-chapter-title">{row.title}</span><span class="tour-chapter-steps" aria-hidden="true">{row.label}</span></button></li>}</For></ol>
    <Show when={!all() && rows().length > TOUR_CHAPTERS_FOLDED}><button type="button" class="button button-ghost tour-chapter-more" aria-expanded="false" onClick={() => setAll(true)}>Show all {rows().length}</button></Show>
  </nav>;
}

/** Shared checked-edition card. All authorization, asset paths and capabilities come from its host. */
export function TourReadCard(props: TourReadCardProps) {
  const [open, setOpen] = createSignal(false);
  const [manifest, setManifest] = createSignal<TourPresentation>();
  const [progress, setProgress] = createSignal<TourPosition>();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [progressError, setProgressError] = createSignal(false);
  const [destinations, setDestinations] = createSignal<Record<string, Record<string, Partial<Record<TourSize, string>>>>>({});
  const [startAt, setStartAt] = createSignal<TourPosition>();
  let opener!: HTMLButtonElement;
  let returnTo: HTMLButtonElement | undefined;
  let disposed = false;
  const loadProgress = async () => {
    if (!props.loadProgress) return;
    try { const p = await props.loadProgress(); if (!disposed) { setProgress(p ?? undefined); setProgressError(false); } }
    catch { if (!disposed) setProgressError(true); }
  };
  const load = async () => {
    setBusy(true); setError("");
    try { const m = await props.loadManifest(); if (!disposed) setManifest(m); }
    catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "This tour couldn't be loaded. Try again."); }
    finally { if (!disposed) setBusy(false); }
  };
  onMount(() => { void load(); void loadProgress(); });
  onCleanup(() => { disposed = true; });
  const title = () => manifest()?.title ?? props.title;
  const steps = () => manifest()?.steps.length ?? props.steps;
  const views = () => manifest()?.steps.reduce((n, s) => n + s.views.length, 0);
  const cover = () => manifest()?.steps.flatMap(s => s.views).flatMap(v => v.captures.desktop ?? v.captures.phone ?? [])[0]?.image;
  const position = () => manifest() && progress() ? tourPosition(manifest()!, progress()) : undefined;
  const close = () => { setOpen(false); setStartAt(undefined); const back = returnTo?.isConnected ? returnTo : opener; returnTo = undefined; if (back?.isConnected) back.focus(); };
  const openTour = async (at?: TourPosition, from?: HTMLButtonElement) => {
    if (!manifest()) return;
    setStartAt(at); returnTo = from;
    setBusy(true);
    await loadProgress();
    if (props.loadDestinations) {
      try { const links = await props.loadDestinations(); if (!disposed) setDestinations(links); }
      catch { if (!disposed) setDestinations({}); }
    }
    if (!disposed) { setBusy(false); setOpen(true); }
  };
  const openPage: TourViewerProps["openPage"] = (view, size) => {
    if (props.openPage) return props.openPage(view, size);
    const step = manifest()?.steps.find(s => s.views.includes(view));
    const href = step ? destinations()[step.id]?.[view.id]?.[size] : undefined;
    return typeof href === "string" ? { href } : undefined;
  };
  let progressWrites: Promise<unknown> = Promise.resolve();
  const save = async (p: TourPosition) => {
    const write = progressWrites.catch(() => {}).then(() => props.saveProgress?.(p));
    progressWrites = write;
    await write;
    if (!disposed) { setProgress(p); setProgressError(false); }
  };
  return <section class="tour-card card" aria-label={`Tour: ${title()}`}>
    <div class="tour-card-main"><Show when={cover()}>{file => <div class="tour-cover-wrap"><img class="tour-cover" src={props.assetUrl(file())} alt={`Preview of ${title()}`} loading="lazy" /><span class="tour-cover-label"><Icon name="eye" small />Recorded tour</span></div>}</Show>
      <div class="tour-card-copy"><span class="text-caption text-muted">Tour · {steps()} steps<Show when={views()}> · {views()} views</Show></span><h3>{title()}</h3><Show when={manifest()?.summary ?? props.summary}>{summary => <p>{summary()}</p>}</Show>
        <div class="tour-card-badges"><span class="chip">Desktop + phone</span><span class="text-caption text-muted">Read at your own pace</span></div>
        <Show when={error()}><p class="field-error" role="alert">{error()}</p></Show><Show when={progressError()}><p role="status">Your saved place couldn't be loaded. You can still read from step 1.</p></Show>
        <div class="button-row"><button ref={opener} type="button" class="button button-primary" disabled={busy() || !manifest()} onClick={() => void openTour()}>{busy() ? "Loading Tour…" : position() ? `Continue at step ${position()!.step + 1}` : "View Tour"}<Icon name="arrow-right" /></button><Show when={error()}><button type="button" class="button" disabled={busy()} onClick={() => void load()}>Retry Loading</button></Show><Show when={props.onShare}><button type="button" class="button button-ghost" onClick={props.onShare}><Icon name="share" />Share</button></Show>{props.actions}</div>
      </div>
    </div>
    <Show when={manifest()}>{m => <><TourChapterList manifest={m()} disabled={busy()} onOpen={(row, button) => void openTour({ stepId: row.firstStepId, viewId: row.firstViewId, size: progress()?.size ?? "desktop" }, button)} /><details class="tour-recording-report"><summary>Recording report</summary><p>{m().steps.length} main steps · {views()} named views · {m().steps.flatMap(s => s.views).reduce((n, v) => n + Object.keys(v.captures).length, 0)} pictures. Reference views are labelled text. Recorded {new Date(m().recordedAt).toLocaleString()}.</p><Show when={props.saveProgress}><p>Your place is saved on the server across devices.</p></Show></details></>}</Show>
    <Show when={open() && manifest()}><Portal><TourViewer manifest={manifest()!} assetUrl={props.assetUrl} initialProgress={startAt() ?? progress()} onProgress={props.saveProgress ? save : undefined} progressNote={props.saveProgress ? "Your place is saved across devices." : undefined} onAsk={props.onAsk} onRequestCoverage={props.onRequestCoverage} openPage={openPage} onShare={props.onShare} onContinueAcrossDevices={props.onContinueAcrossDevices} onClose={close} /></Portal></Show>
  </section>;
}

