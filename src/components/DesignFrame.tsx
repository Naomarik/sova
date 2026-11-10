import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { cardBoxSupported } from "../lib/card-box";
import type { DesignApi } from "../lib/design-api";
import { DESIGN_FRAME_LEFT, DESIGN_PAGE_HEIGHT, DESIGN_PAGE_WIDTH, DESIGN_SHELL_ATTRS, DESIGN_STREAM_ATTRS, designHasFirstPaint, designHasStyles, designPageDoc, designShellDoc, fromDesignFrame, tokensOfText } from "../lib/design-frame";
import { designLiveSlots } from "../lib/design-live-slots";

/** Every ancestor that scrolls, innermost first, with the element to watch in each. */
function scrollChain(el: HTMLElement): { root: HTMLElement; target: HTMLElement }[] {
  const out: { root: HTMLElement; target: HTMLElement }[] = [];
  let target = el;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o !== "auto" && o !== "scroll") continue;
    out.push({ root: p, target });
    target = p;
  }
  return out;
}

const NEAR_MARGIN = "600px 0px";

/**
 * Whether a box is within about a screen of being seen, through every scroller around it (a tile
 * sits in a card's scroller inside the transcript's). A frame is held only while this is true.
 */
export function createNearViewport(el: () => HTMLElement | undefined): () => boolean {
  const [near, setNear] = createSignal(false);
  onMount(() => {
    const box = el();
    if (!box) return;
    const chain = scrollChain(box);
    if (!chain.length) return setNear(true);
    const seen = chain.map(() => false);
    const ios = chain.map(
      ({ root, target }, i) =>
        new IntersectionObserver(
          (rows) => {
            seen[i] = rows.at(-1)!.isIntersecting;
            setNear(seen.every(Boolean));
          },
          { root, rootMargin: NEAR_MARGIN },
        ),
    );
    ios.forEach((io, i) => io.observe(chain[i]!.target));
    onCleanup(() => ios.forEach((io) => io.disconnect()));
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
      <div class="design-scale-page" inert style={{ width: `${DESIGN_PAGE_WIDTH}px`, height: `${DESIGN_PAGE_HEIGHT}px`, transform: `scale(${scale()})`, "--design-scale": scale() }}>
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
      if (said === "drawn") props.onDrawn?.();
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

/** Long enough after a frame is named for its replay to have painted, so a returning card never shows it blank. */
const FIRST_PAINT_MS = 250;

/**
 * A page being written: one document in one empty sandbox, served as it arrives, so it fills in with
 * no reload. The response names its own policy; the frame's attributes ask for at least as much.
 * A page shows nothing until its styles are closed and its body has begun, so that wait reads as
 * progress, and the note goes only once the frame has had time to paint. When the response ends the connection is
 * given back and the document stays, so the last picture holds until the finished page has drawn.
 */
export function DesignStreamFrame(props: { api: DesignApi; label: string; version: number | undefined; text: string; title: string; waiting?: string; priority?: boolean }) {
  const [src, setSrc] = createSignal("");
  const [turn, setTurn] = createSignal(false);
  const [painted, setPainted] = createSignal(false);
  let release: (() => void) | undefined;
  let since = 0;
  let asked = 0;
  const giveBack = () => {
    release?.();
    release = undefined;
  };
  const connect = (ask: number) => {
    setTurn(false);
    props.api
      .liveUrl(props.label)
      .then((live) => {
        if (ask !== asked) return;
        if (!live) return giveBack();
        since = performance.now();
        setSrc(live.url);
      })
      .catch(() => {
        if (ask === asked) giveBack();
      });
  };
  // A memo: the live text changes many times a second, its version only at a new page.
  const version = createMemo(() => props.version);
  createEffect(
    on(
      version,
      (v) => {
        // The page's end takes its version away; the document on show stays.
        if (v === undefined) return;
        giveBack();
        const ask = ++asked;
        setSrc("");
        setPainted(false);
        setTurn(true);
        release = designLiveSlots.ask({
          priority: !!props.priority,
          grant: () => connect(ask),
          revoke: () => {
            ++asked;
            setSrc("");
            setPainted(false);
            setTurn(true);
          },
        });
      },
    ),
  );
  onCleanup(() => {
    ++asked;
    giveBack();
  });
  const drawable = createMemo(() => !!src() && designHasFirstPaint(props.text));
  createEffect(() => {
    if (!drawable() || painted()) return;
    let frame = 0;
    const hold = setTimeout(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setPainted(true));
      });
    }, Math.max(0, since + FIRST_PAINT_MS - performance.now()));
    onCleanup(() => {
      clearTimeout(hold);
      cancelAnimationFrame(frame);
    });
  });
  // The policy and sandbox have to be on the element before its document is named.
  const seal = (el: HTMLIFrameElement, url: string) => {
    el.setAttribute("sandbox", DESIGN_STREAM_ATTRS.sandbox);
    el.setAttribute("csp", DESIGN_STREAM_ATTRS.csp);
    el.setAttribute("referrerpolicy", DESIGN_STREAM_ATTRS.referrerpolicy);
    el.src = url;
  };
  const tokens = () => tokensOfText(props.text.length).toLocaleString("en-US");
  const note = () => {
    if (!props.text) return props.waiting ?? "Starting the page";
    if (turn()) return `Waiting for a free preview · about ${tokens()} tokens written`;
    return `${designHasStyles(props.text) ? "Writing the page" : "Writing styles"} · about ${tokens()} tokens`;
  };
  return (
    <>
      <Show when={src()} keyed>
        {(url) => <iframe class="design-frame" title={props.title} ref={(el) => seal(el, url)} onLoad={giveBack} />}
      </Show>
      <Show when={!painted()}>
        <div class="design-frame-note" role="status">
          {note()}
        </div>
      </Show>
    </>
  );
}
