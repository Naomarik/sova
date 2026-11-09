import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { cardBoxSupported } from "../lib/card-box";
import { DESIGN_FRAME_LEFT, DESIGN_PAGE_HEIGHT, DESIGN_PAGE_WIDTH, DESIGN_SHELL_ATTRS, DESIGN_STREAM_ATTRS, designHasStyles, designPageDoc, designShellDoc, designStreamDoc, fromDesignFrame, tokensOfText } from "../lib/design-frame";

const STREAM_MS = 340;

/** The first ancestor that scrolls: what "near the viewport" has to be measured against. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/** Whether a box is within a screenful of being seen. A frame is held only while this is true. */
export function createNearViewport(el: () => HTMLElement | undefined): () => boolean {
  const [near, setNear] = createSignal(false);
  onMount(() => {
    const box = el();
    if (!box) return;
    const io = new IntersectionObserver((rows) => setNear(rows.at(-1)!.isIntersecting), { root: scroller(box), rootMargin: "600px 0px" });
    io.observe(box);
    onCleanup(() => io.disconnect());
  });
  return near;
}

/** A 1280px-wide page scaled into whatever box holds it. */
export function DesignScale(props: { children: JSX.Element; label: string }) {
  let box!: HTMLDivElement;
  const [scale, setScale] = createSignal(0.25);
  onMount(() => {
    const ro = new ResizeObserver(() => setScale(box.clientWidth / DESIGN_PAGE_WIDTH));
    ro.observe(box);
    setScale(box.clientWidth / DESIGN_PAGE_WIDTH);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div class="design-scale" ref={box} aria-label={props.label} role="img">
      <div class="design-scale-page" inert style={{ width: `${DESIGN_PAGE_WIDTH}px`, height: `${DESIGN_PAGE_HEIGHT}px`, transform: `scale(${scale()})` }}>
        {props.children}
      </div>
    </div>
  );
}

/** A finished page, in its sealed frames. `motion` runs its animations; a grid card holds them. */
export function DesignSealedFrame(props: { html: string; motion: boolean; title: string; onDrawn?: () => void }) {
  let frame: HTMLIFrameElement | undefined;
  const [left, setLeft] = createSignal(false);
  const supported = cardBoxSupported(typeof HTMLIFrameElement === "undefined" ? undefined : HTMLIFrameElement.prototype);
  const doc = createMemo(() => designShellDoc(designPageDoc(props.html, { motion: props.motion })));
  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      const said = fromDesignFrame(e, frame?.contentWindow);
      if (said === "left") setLeft(true);
      if (said === "loaded") props.onDrawn?.();
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });
  // The policy and sandbox have to be on the element before its document is named.
  const seal = (el: HTMLIFrameElement) => {
    frame = el;
    el.setAttribute("sandbox", DESIGN_SHELL_ATTRS.sandbox);
    el.setAttribute("csp", DESIGN_SHELL_ATTRS.csp);
    el.setAttribute("referrerpolicy", DESIGN_SHELL_ATTRS.referrerpolicy);
    el.srcdoc = doc();
  };
  return (
    <Show when={supported} fallback={<div class="design-frame-note">This browser can't wall off a page's code, so it isn't run.</div>}>
      <Show when={!left()} fallback={<div class="design-frame-note">{DESIGN_FRAME_LEFT}</div>}>
        <iframe class="design-frame" ref={seal} title={props.title} />
      </Show>
    </Show>
  );
}

/**
 * A page being written, as a still picture: an empty sandbox redrawn about 3 times a second, in two
 * frames swapped on load, so each redraw replaces a finished picture and never blanks the card.
 * Before its first style block closes a page shows nothing, so that wait reads as progress instead.
 */
export function DesignStreamFrame(props: { text: string; title: string; thinking?: boolean }) {
  let a!: HTMLIFrameElement;
  let b!: HTMLIFrameElement;
  const [front, setFront] = createSignal<"a" | "b">("a");
  const drawable = () => designHasStyles(props.text);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let drawn = "";
  const draw = () => {
    timer = undefined;
    if (loading || !a || !b) return;
    const text = props.text;
    if (text === drawn) return;
    drawn = text;
    loading = true;
    (front() === "a" ? b : a).srcdoc = designStreamDoc(text);
  };
  const onLoad = (which: "a" | "b") => {
    if (!loading) return; // a frame's first blank document
    loading = false;
    setFront(which);
    if (!timer) timer = setTimeout(draw, STREAM_MS);
  };
  createEffect(
    on(
      () => [props.text, drawable()] as const,
      ([, can]) => {
        if (can && !timer && !loading) timer = setTimeout(draw, drawn ? STREAM_MS : 0);
      },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  const attrs = (which: "a" | "b") => ({
    class: `design-frame design-frame-stream${front() === which ? " design-frame-front" : ""}`,
    title: props.title,
    sandbox: DESIGN_STREAM_ATTRS.sandbox,
    csp: DESIGN_STREAM_ATTRS.csp,
    referrerpolicy: DESIGN_STREAM_ATTRS.referrerpolicy,
    onLoad: () => onLoad(which),
  });
  return (
    <>
      <Show when={drawable()}>
        <iframe ref={a} {...attrs("a")} />
        <iframe ref={b} {...attrs("b")} />
      </Show>
      <Show when={!drawable()}>
        <div class="design-frame-note" role="status">
          {props.text ? `Writing styles · about ${tokensOfText(props.text.length).toLocaleString("en-US")} tokens` : props.thinking ? "Thinking about the page" : "Starting the page"}
        </div>
      </Show>
    </>
  );
}
