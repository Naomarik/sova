import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { appTheme } from "../../../lib/explain";
import { visIcon } from "../../icons";
import type { ViewProps } from "../../types";
import { estimateHeight, MIN_FRAME_HEIGHT, rememberHeight } from "./height";
import type { FrameSpec } from "./parse";
import { buildSrcdoc, FRAME_MESSAGE, MAX_FRAME_HEIGHT, readTokens, tokenCss } from "./srcdoc";
import "./frame.css";

let frameSeq = 0;

/**
 * `vis html` / `vis svg`: the model's own document in a sandboxed, network-less iframe. The frame
 * reports its height; the app sends it new theme tokens when the theme changes. Nothing from the
 * frame is trusted beyond a clamped number and a "a script threw" flag, which shows a fixed line.
 *
 * `host`: a share or owner page, whose CSP runs no inline script, so no srcdoc. The frame loads that
 * static frame host (shared/vis-frame-host.ts) instead, still sandboxed, and is posted the same
 * document once, on its first load; everything after that is as with srcdoc.
 */
export default function FrameView(props: ViewProps<FrameSpec> & { host?: string }) {
  const id = `f${++frameSeq}-${Math.random().toString(36).slice(2, 8)}`;
  const root = document.documentElement;
  // The frame element's color-scheme must match the document's inside it, or the browser paints the
  // frame opaque: both follow the app's theme.
  const [theme, setTheme] = createSignal(appTheme());
  const css = () => tokenCss(readTokens(root), theme());
  const srcdoc = buildSrcdoc(props.spec.kind, props.spec.source, id, css());
  // Until the frame reports, it takes the height this source had before, or an svg's computed one
  // (height.ts): set in onMount, once the frame's width is known, before the first paint.
  const [height, setHeight] = createSignal(MIN_FRAME_HEIGHT);
  const [failed, setFailed] = createSignal(false);
  let frame!: HTMLIFrameElement;
  // The frame host takes the first document only: a later load (the frame navigating itself) gets none.
  let posted = false;
  const onHostLoad = () => {
    if (posted || !props.host) return;
    posted = true;
    frame.contentWindow?.postMessage({ type: FRAME_MESSAGE, doc: srcdoc }, "*");
  };

  onMount(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data as { type?: unknown; id?: unknown; height?: unknown; failed?: unknown } | null;
      if (!d || d.type !== FRAME_MESSAGE || d.id !== id) return;
      if (d.failed === true) setFailed(true);
      // The first report can be h=0, sent before the frame's body is laid out; the real height
      // follows a few ms later. Taking it would collapse the frame to its minimum for a frame or two.
      if (typeof d.height === "number" && Number.isFinite(d.height) && d.height >= 1) {
        const h = Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.ceil(d.height)));
        setHeight(h);
        rememberHeight(props.spec, frame.clientWidth, h);
      }
    };
    setHeight(estimateHeight(props.spec, frame.clientWidth));
    window.addEventListener("message", onMessage);
    // Theme changes (data-theme, or a custom theme's inline tokens) reach the frame as new tokens.
    const mo = new MutationObserver(() => {
      setTheme(appTheme());
      frame.contentWindow?.postMessage({ type: FRAME_MESSAGE, css: css() }, "*");
    });
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
    onCleanup(() => {
      window.removeEventListener("message", onMessage);
      mo.disconnect();
    });
  });

  return (
    <>
      <iframe
        ref={frame}
        class="vis-frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        title={props.label}
        src={props.host}
        srcdoc={props.host ? undefined : srcdoc}
        onLoad={onHostLoad}
        style={{ height: `${height()}px`, "color-scheme": theme() }}
      />
      <Show when={failed()}>
        <p class="vis-frame-failed" role="status">
          <span class="icon icon-sm" style={{ "--icon": `url("${visIcon("alert-circle")}")` }} aria-hidden="true" />
          This visual's script failed, so parts of it may not respond. Source shows the code.
        </p>
      </Show>
    </>
  );
}
