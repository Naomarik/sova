import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { SessionShareDesign, SessionShareLookbook } from "../../shared/session-share";
import { DESIGN_FRAME_LEFT, DESIGN_PAGE_HEIGHT, DESIGN_PAGE_WIDTH, DESIGN_SHARE_SHELL_ATTRS, fromDesignFrame } from "../lib/design-frame";
import {
  designDirection,
  latestVersion,
  lookbookTitle,
  runsDesigns,
  STILL_LINE,
  stepDesign,
  versionLabel,
  versionOption,
  versionShown,
  designKind,
  type DesignAddress,
  type DesignUrls,
} from "./lookbook-model";
import { Select } from "../components/form";
import "./lookbook.css";

/**
 * A shared session's Lookbooks (§app.session-share/content): each one a block in the conversation,
 * a tile per design, and a full-size view of one design with its every finished version. Read only:
 * no chat, status, cost or menu. A design runs only where the browser can wall off its code
 * (Chrome-family); everywhere else it is a still page with no scripts, said once in a quiet line.
 * Every page is drawn from the addresses `urls` names, never from text this page holds.
 */

/** Whether this browser runs designs, once. */
export const RUNS: boolean = runsDesigns(typeof HTMLIFrameElement === "undefined" ? undefined : HTMLIFrameElement.prototype);

// ---- one page in its frame ----------------------------------------------------------------------

/**
 * A design's page in a frame named by `src`. Running: the share's sealed shell (its sandbox and
 * required policy on the element before its address is named). Still: an empty sandbox, inert, so
 * neither a script nor a click goes anywhere. `tile`: a held picture nobody scrolls.
 */
export function DesignPicture(props: { src: string; load?: () => Promise<string>; runs: boolean; title: string; tile?: boolean }) {
  const [shown, setShown] = createSignal(false);
  const [left, setLeft] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  createEffect(
    on(
      () => props.src,
      () => {
        setShown(false);
        setLeft(false);
        setFailed(false);
      },
      { defer: true },
    ),
  );
  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      const said = fromDesignFrame(e, frame?.contentWindow);
      if (said === "left") setLeft(true);
      if (said === "drawn") setShown(true);
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });
  const seal = (el: HTMLIFrameElement, src: string) => {
    frame = el;
    if (props.runs) {
      el.setAttribute("sandbox", DESIGN_SHARE_SHELL_ATTRS.sandbox);
      el.setAttribute("csp", DESIGN_SHARE_SHELL_ATTRS.csp);
    } else {
      el.setAttribute("sandbox", "");
      el.setAttribute("inert", "");
    }
    el.setAttribute("referrerpolicy", "no-referrer");
    if (props.tile) el.setAttribute("scrolling", "no");
    if (!props.load) return void (el.src = src);
    // Framed by its text (a peer's Preview): the same attributes, named before the document is.
    const asked = src;
    props
      .load()
      .then((doc) => {
        if (asked === props.src) el.srcdoc = doc;
      })
      .catch(() => asked === props.src && setFailed(true));
  };
  return (
    <Show when={!left()} fallback={<div class="lb-frame-note">{DESIGN_FRAME_LEFT}</div>}>
      <Show when={props.src} keyed>
        {(src) => <iframe class="lb-frame" classList={{ "lb-frame-shown": shown() }} title={props.title} ref={(el) => seal(el, src)} onLoad={() => setShown(true)} />}
      </Show>
      <Show when={!shown()}>
        <div class="lb-frame-note" role="status">
          {failed() ? "This page couldn't be loaded." : "Loading the page"}
        </div>
      </Show>
    </Show>
  );
}

/** A 1280px-wide page scaled to cover its box (a tile's 16:10, or a phone row's taller one). */
function ScaledPage(props: { children: JSX.Element; label: string }) {
  let box!: HTMLDivElement;
  const [scale, setScale] = createSignal(0.25);
  onMount(() => {
    const fit = () => setScale(Math.max(box.clientWidth / DESIGN_PAGE_WIDTH, box.clientHeight / DESIGN_PAGE_HEIGHT) || 0.25);
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    fit();
    onCleanup(() => ro.disconnect());
  });
  return (
    <div class="lb-scale" ref={box} role="img" aria-label={props.label}>
      <div class="lb-scale-page" inert style={{ width: `${DESIGN_PAGE_WIDTH}px`, height: `${DESIGN_PAGE_HEIGHT}px`, transform: `scale(${scale()})`, "--lb-scale": scale() }}>
        {props.children}
      </div>
    </div>
  );
}

/** Every ancestor that scrolls, innermost first (the Preview's sheet scrolls; the share page, the window). */
function scrollers(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") out.push(p);
  }
  return out;
}

/** Whether a box is within about a screen of being seen, through every scroller around it. A tile's
    frame is there only while this holds. */
function createNear(el: () => HTMLElement | undefined): () => boolean {
  const [near, setNear] = createSignal(false);
  onMount(() => {
    const box = el();
    if (!box) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const roots: (HTMLElement | null)[] = [...scrollers(box), null];
    const seen = roots.map(() => false);
    const ios = roots.map(
      (root, i) =>
        new IntersectionObserver(
          (rows) => {
            seen[i] = rows.at(-1)!.isIntersecting;
            setNear(seen.every(Boolean));
          },
          { root, rootMargin: "600px 0px" },
        ),
    );
    ios.forEach((io) => io.observe(box));
    onCleanup(() => ios.forEach((io) => io.disconnect()));
  });
  return near;
}

// ---- the block ----------------------------------------------------------------------------------

const designName = (d: SessionShareDesign) => {
  const dir = designDirection(d);
  return dir ? `Design ${d.label}, ${dir}` : `Design ${d.label}`;
};
const versionsWord = (n: number) => (n === 1 ? "1 version" : `${n} versions`);

/** One design's tile: its newest page, scaled down, drawn only near the screen; the whole tile opens it. */
function LookbookTile(props: { d: SessionShareDesign; urls: DesignUrls; runs: boolean; onOpen(): void }) {
  let box: HTMLDivElement | undefined;
  const near = createNear(() => box);
  const v = () => latestVersion(props.d);
  const src = () => props.urls.doc(props.d.label, v(), designKind(props.runs, true));
  const load = () => (props.urls.load ? () => props.urls.load!(props.d.label, v(), designKind(props.runs, true)) : undefined);
  return (
    <article class="lb-tile" aria-label={`Design ${props.d.label}`}>
      <div class="lb-tile-page" ref={box}>
        <ScaledPage label={designName(props.d)}>
          <Show when={near()}>
            <DesignPicture src={src()} load={load()} runs={props.runs} title={designName(props.d)} tile />
          </Show>
        </ScaledPage>
      </div>
      <div class="lb-tile-info">
        <div class="lb-tile-title">
          <span class="lb-tile-label">{props.d.label}</span>
          <span class="lb-tile-direction" title={designDirection(props.d) || undefined}>
            {designDirection(props.d)}
          </span>
        </div>
        <p class="text-caption text-muted lb-tile-meta" title={props.d.modelName || undefined}>
          {[props.d.modelName, versionsWord(props.d.versions.length)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <button type="button" class="lb-tile-open" aria-label={`Open design ${props.d.label}`} aria-haspopup="dialog" onClick={() => props.onOpen()} />
    </article>
  );
}

/** A Lookbook in the conversation: its title, and a tile per design (one column on a phone). */
export function LookbookBlock(props: { lookbook: SessionShareLookbook; urls: DesignUrls; onOpen(a: DesignAddress): void; runs?: boolean }) {
  const runs = () => props.runs ?? RUNS;
  return (
    <section class="lb-block" id={`lookbook-${props.lookbook.id}`} aria-label={lookbookTitle(props.lookbook.designs.length)}>
      <h2 class="lb-title">{lookbookTitle(props.lookbook.designs.length)}</h2>
      <Show when={!runs()}>
        <p class="ss-note">{STILL_LINE}</p>
      </Show>
      <div class="lb-grid">
        <For each={props.lookbook.designs}>{(d) => <LookbookTile d={d} urls={props.urls} runs={runs()} onOpen={() => props.onOpen({ label: d.label })} />}</For>
      </div>
    </section>
  );
}

// ---- the full-size page -------------------------------------------------------------------------

export type DesignSize = "desktop" | "phone";

/** The page at full size: the box's own width on Desktop, a phone's width on Phone. */
export function DesignStage(props: { d: SessionShareDesign; v: number; size: DesignSize; urls: DesignUrls; runs: boolean }) {
  const src = () => props.urls.doc(props.d.label, props.v, designKind(props.runs, false));
  const load = () => (props.urls.load ? () => props.urls.load!(props.d.label, props.v, designKind(props.runs, false)) : undefined);
  return (
    <div class="lb-stage" data-size={props.size}>
      <div class="lb-stage-page">
        <DesignPicture src={src()} load={load()} runs={props.runs} title={`Design ${versionLabel(props.d.label, props.v)}`} />
      </div>
    </div>
  );
}

/** Desktop and Phone, on a wide screen only (a phone is already a phone's width). */
export function SizeSwitch(props: { size: DesignSize; onSize(s: DesignSize): void }) {
  return (
    <div class="lb-size" role="group" aria-label="Page size">
      <For each={["desktop", "phone"] as const}>
        {(s) => (
          <button type="button" class="button button-sm button-ghost" aria-pressed={props.size === s} onClick={() => props.onSize(s)}>
            {s === "phone" ? "Phone" : "Desktop"}
          </button>
        )}
      </For>
    </div>
  );
}

/** A design's version picker: every finished version, newest last. */
export function VersionPicker(props: { d: SessionShareDesign; v: number; onPick(v: number): void }) {
  return (
    <Select
      class="lb-version"
      label="Version"
      hideLabel
      value={String(props.v)}
      disabled={props.d.versions.length < 2}
      options={props.d.versions.map((x) => ({ value: String(x.n), label: versionOption(x) }))}
      onChange={(v) => props.onPick(Number(v))}
    />
  );
}

/**
 * One design at full size over the page (a native <dialog>, so the page behind is inert): Back,
 * Previous and Next across the Lookbook's designs, its Version picker, Desktop/Phone on a wide
 * screen, and Open in New Tab where the page has its own address (`urls.page`). `at` names what is
 * open; every move goes through `onMove` so the caller can keep it in the address.
 */
export function DesignOverlay(props: { lookbook: SessionShareLookbook; at: DesignAddress; urls: DesignUrls; runs?: boolean; onMove(a: DesignAddress): void; onBack(): void }) {
  let dialog!: HTMLDialogElement;
  const runs = () => props.runs ?? RUNS;
  const [size, setSize] = createSignal<DesignSize>("desktop");
  const d = createMemo(() => props.lookbook.designs.find((x) => x.label === props.at.label) ?? props.lookbook.designs[0]!);
  const v = () => versionShown(d(), props.at.v);
  const step = (by: -1 | 1) => {
    const next = stepDesign(props.lookbook, d().label, by);
    if (next) props.onMove({ label: next.label });
  };
  const opener = document.activeElement as HTMLElement | null;
  onMount(() => {
    // Native, not Solid's delegated keydown: Esc goes Back here and no key reaches a sheet around
    // the thread (the operator's Preview), whose own Esc and focus trap would act behind it.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key !== "Escape") return;
      e.preventDefault();
      props.onBack();
    };
    dialog.addEventListener("keydown", onKey);
    onCleanup(() => dialog.removeEventListener("keydown", onKey));
    dialog.showModal();
  });
  onCleanup(() => {
    if (dialog.open) dialog.close();
    opener?.focus?.();
  });
  const title = () => {
    const dir = designDirection(d());
    return dir ? `${versionLabel(d().label, v())} · ${dir}` : `Design ${versionLabel(d().label, v())}`;
  };
  return (
    <dialog
      ref={dialog}
      class="lb-open"
      aria-label={`Design ${versionLabel(d().label, v())}`}
      onCancel={(e) => {
        e.preventDefault();
        props.onBack();
      }}
    >
      <div class="lb-open-head">
        <button type="button" class="button button-sm button-ghost lb-open-back" onClick={() => props.onBack()}>
          <span class="icon icon-sm lb-icon-back" aria-hidden="true" />
          Back
        </button>
        <div class="lb-open-titles">
          <p class="lb-open-title" title={title()}>
            {title()}
          </p>
          <Show when={d().modelName}>
            <p class="text-caption text-muted lb-open-meta">{d().modelName}</p>
          </Show>
        </div>
        <div class="lb-open-tools">
          <Show when={props.lookbook.designs.length > 1}>
            <button type="button" class="button button-sm button-icon" aria-label="Previous design" title="Previous design" onClick={() => step(-1)}>
              <span class="icon icon-sm lb-icon-prev" aria-hidden="true" />
            </button>
            <button type="button" class="button button-sm button-icon" aria-label="Next design" title="Next design" onClick={() => step(1)}>
              <span class="icon icon-sm lb-icon-next" aria-hidden="true" />
            </button>
          </Show>
          <VersionPicker d={d()} v={v()} onPick={(n) => props.onMove({ label: d().label, v: n })} />
          <SizeSwitch size={size()} onSize={setSize} />
          <Show when={props.urls.page}>
            {(page) => (
              <a class="button button-sm lb-open-tab" href={page()({ label: d().label, v: props.at.v ? v() : undefined })} target="_blank" rel="noopener noreferrer">
                <span class="icon icon-sm lb-icon-external" aria-hidden="true" />
                Open in New Tab
              </a>
            )}
          </Show>
        </div>
      </div>
      <Show when={!runs()}>
        <p class="ss-note lb-open-still">{STILL_LINE}</p>
      </Show>
      <DesignStage d={d()} v={v()} size={size()} urls={props.urls} runs={runs()} />
    </dialog>
  );
}

// ---- where the open design is kept ----------------------------------------------------------------

/**
 * Which design is open. `remember` (the share page): in the address, so Back closes it and a reload
 * opens it again; a move inside the overlay replaces the entry instead of adding one. Otherwise (the
 * operator's Preview, inside the app's own routes): local state only.
 */
export function createOpenDesign(remember: boolean, read: () => DesignAddress | null, write: { push(a: DesignAddress): void; replace(a: DesignAddress | null): void; back(): void }) {
  const [open, setOpen] = createSignal<DesignAddress | null>(remember ? read() : null);
  let pushed = false;
  if (remember) {
    const sync = () => setOpen(read());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    onCleanup(() => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    });
  }
  createEffect(on(open, (a) => a === null && (pushed = false), { defer: true }));
  return {
    open,
    show(a: DesignAddress) {
      if (remember) {
        if (open()) write.replace(a);
        else {
          write.push(a);
          pushed = true;
        }
      }
      setOpen(a);
    },
    close() {
      if (remember) {
        if (pushed) {
          pushed = false;
          write.back();
        } else write.replace(null);
      }
      setOpen(null);
    },
  };
}
