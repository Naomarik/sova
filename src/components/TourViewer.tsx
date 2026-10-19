import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { TourPresentation, TourSize, TourView } from "../../shared/tour";
import { tourPin } from "../lib/tour-geometry";
import { tourCoverageQuestion, tourParagraphs, tourPosition, tourQuestion, tourShowsSizeSwitch, type TourPosition } from "../lib/tour-state";
import { Icon } from "./ui";
import "./TourViewer.css";

export interface TourViewerProps {
  manifest: TourPresentation;
  assetUrl(file: string): string;
  initialProgress?: TourPosition;
  onProgress?(position: TourPosition): void | Promise<void>;
  progressNote?: string;
  onAsk?(question: string): void;
  onRequestCoverage?(question: string): void;
  /** A host supplies only separately permitted, device-usable destinations. Never infer from route. */
  openPage?(view: TourView, size: TourSize): { href: string; label?: string } | undefined;
  onShare?(): void;
  onContinueAcrossDevices?(): void;
  onClose(): void;
}

/** Shared reader: no ownership routes, recording, storage, or composer DOM lookup. */
export function TourViewer(props: TourViewerProps) {
  let dialog!: HTMLDialogElement;
  let closeButton!: HTMLButtonElement;
  let content!: HTMLDivElement;
  const saved = tourPosition(props.manifest, props.initialProgress);
  const [index, setIndex] = createSignal(saved.step);
  const [viewIndex, setViewIndex] = createSignal(saved.view);
  const [size, setSize] = createSignal<TourSize>("desktop");
  const [outline, setOutline] = createSignal(false);
  const [keys, setKeys] = createSignal(false);
  const [activeMark, setActiveMark] = createSignal<number>();
  const [saveError, setSaveError] = createSignal(false);
  const [imageError, setImageError] = createSignal<string>();
  const current = createMemo(() => props.manifest.steps[index()]!);
  const view = createMemo(() => current().views[viewIndex()]!);
  const capture = () => view().captures[size()];
  const viewport = () => props.manifest.viewports[size()];
  const chapter = () => props.manifest.chapters.find(c => c.id === current().chapter)?.title;
  const destination = () => {
    const link = props.openPage?.(view(), size());
    if (!link) return;
    if (link.href.startsWith("#/")) return link;
    try { if (["http:", "https:"].includes(new URL(link.href).protocol)) return link; } catch { /* unsupported destination */ }
  };
  let saveSequence = 0;
  const persist = () => {
    const seq = ++saveSequence;
    const position = { stepId: current().id, viewId: view().id, size: size() };
    void Promise.resolve().then(() => props.onProgress?.(position))
      .then(() => { if (seq === saveSequence) setSaveError(false); }, () => { if (seq === saveSequence) setSaveError(true); });
  };
  const pickStep = (i: number) => {
    const n = Math.max(0, Math.min(props.manifest.steps.length - 1, i));
    if (n === index()) return;
    setIndex(n); setViewIndex(0); setActiveMark(undefined); persist(); setOutline(false); content?.scrollTo(0, 0);
  };
  const pickView = (i: number) => { setViewIndex(i); setActiveMark(undefined); persist(); };
  const pickSize = (s: TourSize) => { setSize(s); setActiveMark(undefined); persist(); };
  const onArrow = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable='true']"))) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); pickStep(index() + (e.key === "ArrowLeft" ? -1 : 1)); }
    if (e.key === "?") { e.preventDefault(); setKeys(v => !v); }
  };
  let afterClose: (() => void) | undefined;
  const closeThen = (fn?: () => void) => { afterClose = fn; dialog.close(); };
  onMount(() => {
    dialog.showModal(); closeButton.focus();
    const mq = matchMedia("(max-width: 767px)");
    setSize(mq.matches ? "phone" : "desktop");
    const resize = () => pickSize(mq.matches ? "phone" : "desktop");
    mq.addEventListener("change", resize);
    dialog.addEventListener("keydown", onArrow);
    onCleanup(() => { mq.removeEventListener("change", resize); dialog.removeEventListener("keydown", onArrow); });
  });
  onCleanup(() => { if (dialog.open) dialog.close(); });
  const ask = () => {
    const question = tourQuestion(props.manifest, index(), viewIndex());
    closeThen(() => props.onAsk?.(question));
  };
  return <dialog ref={dialog} class="tour-viewer" aria-label={`Guided tour: ${props.manifest.title}`} onClose={() => { const next = afterClose; props.onClose(); if (next) requestAnimationFrame(next); }}>
    <header class="tour-bar"><div class="tour-bar-title"><span class="text-eyebrow text-muted">Guided tour</span><p>{props.manifest.title}</p></div>
      <div class="tour-bar-actions"><button type="button" class="button button-ghost" aria-expanded={outline()} onClick={() => setOutline(v => !v)}><Icon name="grid" /><span>Steps</span></button><Show when={props.onShare}><button type="button" class="button button-ghost" onClick={() => closeThen(props.onShare)}><Icon name="share" /><span>Share Tour</span></button></Show><button ref={closeButton} type="button" class="button button-ghost" onClick={() => closeThen()}><Icon name="close" /><span>Close</span></button></div>
    </header>
    <div class="tour-progress-head"><span class="text-mono" aria-live="polite">Step {index() + 1} of {props.manifest.steps.length}</span><span class="text-caption text-muted">{chapter()} · {viewIndex() + 1}/{current().views.length} views</span></div>
    <div class="tour-progress" role="progressbar" aria-label="Tour progress" aria-valuemin={1} aria-valuemax={props.manifest.steps.length} aria-valuenow={index() + 1}><span style={{ width: `${(index() + 1) / props.manifest.steps.length * 100}%` }} /></div>
    <div class="tour-content" ref={content}>
      <Show when={outline()}><nav class="tour-outline" aria-label="Tour steps"><div class="tour-outline-head"><h2>Steps</h2><button type="button" class="button button-icon button-ghost" aria-label="Close Steps" onClick={() => setOutline(false)}><Icon name="close" /></button></div><For each={props.manifest.chapters}>{c => <section><h3>{c.title}</h3><For each={props.manifest.steps.filter(s => s.chapter === c.id)}>{s => <button type="button" class="tour-outline-step" aria-current={s.n === index() + 1 ? "step" : undefined} aria-label={`Step ${s.n}: ${s.title}`} onClick={() => { pickStep(s.n - 1); setOutline(false); }}><span class="text-mono">{String(s.n).padStart(2, "0")}</span><span>{s.title}<small>{s.views.length} {s.views.length === 1 ? "view" : "views"}</small></span></button>}</For></section>}</For><Show when={props.progressNote}><p class="text-caption text-muted">{props.progressNote}</p></Show><Show when={props.onContinueAcrossDevices}><button type="button" class="button" onClick={props.onContinueAcrossDevices}>Continue Across Devices</button></Show></nav></Show>
      <div class="tour-stage">
        <div class="tour-visual">
          <Show when={tourShowsSizeSwitch(view())}><div class="tour-size-picker" role="group" aria-label="Recording size"><For each={["desktop", "phone"] as const}>{s => <button type="button" class="button button-ghost" aria-pressed={size() === s} onClick={() => pickSize(s)}>{s === "phone" ? "Phone" : "Desktop"}</button>}</For></div></Show>
          <Show when={capture()} fallback={<div class="tour-reference" classList={{ "tour-reference-words": view().kind === "reference" }}><span class="chip">{view().kind === "reference" ? "Explained in words · not pictured" : `${size() === "phone" ? "Phone" : "Desktop"} view unavailable`}</span><Icon name="file" /><h3>{view().title}</h3><div class="tour-reference-text"><For each={tourParagraphs(view().reference ?? view().unavailableReason)}>{para => <p>{para}</p>}</For></div></div>}>{cap => <>
            <div class={`tour-picture tour-picture-${size()}`} style={{ "aspect-ratio": `${viewport().w} / ${viewport().h}` }}>
              <img src={props.assetUrl(cap().image)} alt={`${current().title}—${view().title}, ${size()} recording`} draggable={false} onError={() => setImageError(cap().image)} onLoad={() => setImageError(undefined)} />
              <Show when={imageError() !== cap().image}><svg class="tour-marks" viewBox={`0 0 ${viewport().w} ${viewport().h}`} aria-hidden="true"><For each={cap().marks}>{mark => { const p = () => tourPin(mark, viewport()); return <g classList={{ "tour-mark-active": activeMark() === mark.n }}><rect class="tour-target-halo" x={mark.x * viewport().w} y={mark.y * viewport().h} width={mark.w * viewport().w} height={mark.h * viewport().h} rx="5" vector-effect="non-scaling-stroke" /><line class="tour-leader-halo" x1={p().px} y1={p().py} x2={p().tx} y2={p().ty} vector-effect="non-scaling-stroke" /><rect class="tour-target" x={mark.x * viewport().w} y={mark.y * viewport().h} width={mark.w * viewport().w} height={mark.h * viewport().h} rx="5" vector-effect="non-scaling-stroke" /><line class="tour-leader" x1={p().px} y1={p().py} x2={p().tx} y2={p().ty} vector-effect="non-scaling-stroke" /><circle class="tour-pin" cx={p().px} cy={p().py} r={p().radius} vector-effect="non-scaling-stroke" /><text class="tour-pin-number" x={p().px} y={p().py} font-size={String(p().radius * 1.2)} text-anchor="middle" dominant-baseline="central">{mark.n}</text></g>; }}</For></svg></Show>
            </div>
            <p class="tour-picture-caption"><span>{size() === "phone" ? "Phone" : "Desktop"} recording · {viewport().w} × {viewport().h}</span></p>
            <Show when={imageError() === cap().image}><p class="field-error" role="alert">This picture couldn't be loaded. Reopen the tour to try again.</p></Show>
          </>}</Show>
        </div>
        <section class="tour-panel" aria-label={`Step ${current().n}: ${current().title}`}><span class="text-eyebrow text-muted">{chapter()} / {String(current().n).padStart(2, "0")}</span><h2>{current().title}</h2><p class="tour-summary">{current().summary}</p>
          <div class="tour-view-chips" role="group" aria-label="Step views"><For each={current().views}>{(v, i) => <button type="button" class="button tour-view-chip" aria-pressed={viewIndex() === i()} onClick={() => pickView(i())}>{v.comparison ? `${v.comparison.phase === "before" ? "Before" : "After"}: ` : ""}{v.title}<Show when={v.kind === "reference"}><Icon name="file" small /></Show><Show when={v.kind === "page" && !v.captures[size()]}><small>{size() === "phone" ? "Desktop only" : "Phone only"}</small></Show></button>}</For></div>
          <Show when={view().note}><p class="tour-view-note">{view().note}</p></Show>
          <Show when={capture()?.marks.length}><ol class="tour-callouts"><For each={capture()!.marks}>{mark => <li><button type="button" class="tour-callout" aria-pressed={activeMark() === mark.n} onClick={() => setActiveMark(n => n === mark.n ? undefined : mark.n)}><span>{mark.n}</span><p>{mark.label}</p></button></li>}</For></ol></Show>
          <div class="tour-panel-actions"><Show when={props.onAsk}><button type="button" class="button" title="Adds a question to your draft. Nothing is sent." onClick={ask}><Icon name="chat" />Ask About This Step</button></Show><Show when={props.onRequestCoverage}><button type="button" class="button button-ghost" onClick={() => { const question = tourCoverageQuestion(props.manifest, index(), viewIndex()); closeThen(() => props.onRequestCoverage?.(question)); }}>Request More Coverage</button></Show><Show when={destination()}>{link => <a class="button button-ghost" href={link().href} target={link().href.startsWith("#/") ? undefined : "_blank"} rel="noopener noreferrer" onClick={() => { if (link().href.startsWith("#/")) closeThen(); }}><Icon name="external" />{link().label ?? "Open This Page"}</a>}</Show></div>
          <Show when={props.onAsk}><p class="tour-draft-hint">Questions go into your draft, never straight to the agent.</p></Show>
          <Show when={saveError()}><p class="field-error" role="status">Your place couldn't be saved. <button type="button" class="button button-ghost" onClick={persist}>Retry Saving</button></p></Show>
        </section>
      </div>
    </div>
    <footer class="tour-footer"><button type="button" class="button" disabled={index() === 0} onClick={() => pickStep(index() - 1)}><Icon name="chevron-left" />Back</button><button type="button" class="button button-ghost tour-key-trigger" aria-label="Keyboard Shortcuts" aria-expanded={keys()} onClick={() => setKeys(v => !v)}><Icon name="command" /><span class="tour-key-label">Keyboard Shortcuts</span></button><span class="tour-next-label text-caption text-muted">{props.manifest.steps[index() + 1]?.title ?? "You're at the last step"}</span><button type="button" class="button button-primary" onClick={() => index() === props.manifest.steps.length - 1 ? closeThen() : pickStep(index() + 1)}>{index() === props.manifest.steps.length - 1 ? "Finish Tour" : "Next"}<Icon name="chevron-right" /></button></footer>
    <Show when={keys()}><div class="tour-keys" role="status"><span><kbd>←</kbd> <kbd>→</kbd> Main steps</span><span><kbd>Esc</kbd> Close tour</span><span><kbd>?</kbd> Shortcuts</span></div></Show>
  </dialog>;
}
