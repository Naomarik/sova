import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { ExplanationInfo } from "../../shared/protocol";
import { stampTime } from "../lib/format";
import { appTheme, explainCaption, explainHref, explainModel, galleryTitle, newestFirst, THUMB_WIDTH } from "../lib/explain";
import { Chip, Icon, trapFocus } from "./ui";
import "../explain.css";

let seq = 0;

/** Live `matchMedia`: thumbnails are a desktop affordance, so the iframes are never created below 768px. */
function createMediaQuery(query: string) {
  const mql = window.matchMedia(query);
  const [matches, setMatches] = createSignal(mql.matches);
  const onChange = () => setMatches(mql.matches);
  mql.addEventListener("change", onChange);
  onCleanup(() => mql.removeEventListener("change", onChange));
  return matches;
}

/**
 * The page itself, laid out at desktop width and scaled into a 16:10 clip box. Inert by every
 * means available: an empty `sandbox` (no scripts, no forms, no navigation), out of the tab
 * order, hidden from the a11y tree, and no pointer target — the card's link is the only target.
 *
 * The empty sandbox also drops the page's one inline script, the `?theme=` handler, so the page
 * would otherwise fall back to the viewer's OS scheme and a light-OS user would get light
 * thumbnails in a dark modal. `color-scheme` on the embedder propagates to the embedded document
 * (CSS Color Adjust; the page ships `<meta name="color-scheme" content="dark light">` to accept
 * it), which matches the app's theme without relaxing the sandbox. Needs confirming in the
 * browser QA pass; if it doesn't hold, thumbnails follow the OS and only their colour is off.
 *
 * `src` already carries `?theme=`, and it is inert here by construction, not by bug: the param
 * only does anything where the page's script runs — the standalone tab and phones. Don't "fix" a
 * mistimed thumbnail by adding a param that is already on the URL. The only honest levers are
 * `sandbox="allow-scripts"` (locked shut: the sandbox takes no flags) and accepting OS-scheme
 * thumbnails. Not a server-side rewrite: /explain/<id> serves the stored bytes untouched, and a
 * thumbnail-only variant would put a second, uninspectable document under one URL.
 */
function Thumb(props: { id: string }) {
  let box!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      box.style.setProperty("--explain-thumb-scale", String(w / THUMB_WIDTH));
    });
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div class="explain-thumb" ref={box} aria-hidden="true">
      <iframe
        class="explain-thumb-frame"
        src={explainHref(props.id)}
        sandbox=""
        loading="lazy"
        tabindex="-1"
        aria-hidden="true"
        style={{ "color-scheme": appTheme() }}
      />
    </div>
  );
}

function Tile(props: { item: ExplanationInfo; now: number; thumbs: boolean }) {
  const at = () => props.item.createdAt;
  /** A guard: the lists carry openable pages only, so `error` should never reach a tile. If one
      ever does, there is no page at /explain/<id> — no link, no thumbnail, the reason instead. */
  const failed = () => props.item.error;
  const body = () => (
    <div class="explain-tile-body">
      <div class="explain-tile-head">
        <h3 class="explain-tile-topic">{props.item.topic}</h3>
        <Show when={failed()} fallback={<Icon name="external" small class="explain-tile-external" />}>
          <Chip tone="error">Failed</Chip>
        </Show>
      </div>
      {/* "2h ago · glm-5.3". The page carries the same byline under its title, but that one is
          only legible at full size; this is the copy that survives the thumbnail's scale. */}
      <p class="explain-tile-meta" title={[stampTime(at(), props.now), explainModel(props.item)].filter(Boolean).join(" · ")}>
        {explainCaption(props.item, props.now)}
      </p>
      <Show when={failed()} fallback={<Show when={props.item.summary}><p class="explain-tile-summary">{props.item.summary}</p></Show>}>
        {(err) => <p class="explain-tile-error">{err()}</p>}
      </Show>
      {/* The page opens and is worth reading; the run just didn't end cleanly, so it may be unfinished. */}
      <Show when={props.item.note}>{(note) => <p class="explain-tile-note">{note()}</p>}</Show>
    </div>
  );
  return (
    <li>
      <Show
        when={!failed()}
        fallback={<div class="card explain-tile explain-tile-failed">{body()}</div>}
      >
        <a class="card explain-tile" href={explainHref(props.item.id)} target="_blank" rel="noopener">
          <Show when={props.thumbs}>
            <Thumb id={props.item.id} />
          </Show>
          {body()}
        </a>
      </Show>
    </li>
  );
}

/** Every explanation in the list as one card grid, newest first. Used inline on the landing page
    and inside the gallery modal. */
export function ExplainGrid(props: { explanations: ExplanationInfo[]; now: number }) {
  const items = () => newestFirst(props.explanations);
  const thumbs = createMediaQuery("(min-width: 768px)");
  return (
    <ul class="explain-grid">
      <For each={items()}>{(item) => <Tile item={item} now={props.now} thumbs={thumbs()} />}</For>
    </ul>
  );
}

/**
 * Every explanation in one scope as a card grid, newest first, over whatever opened it (the
 * AlignView pattern: portal, scrim, trapFocus, Esc). Each card that has a page is one link to it
 * in a new tab — nothing here navigates this app away from the session; the rest say why not.
 */
export function ExplainGallery(props: { explanations: ExplanationInfo[]; scope: "session" | "all"; now: number; onClose(): void }) {
  const titleId = `explain-title-${++seq}`;
  let close!: HTMLButtonElement;
  onMount(() => close.focus());

  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal explain-gallery"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onClose();
        }}
      >
        <div class="modal-head explain-gallery-head">
          <h2 class="modal-title" id={titleId}>
            {galleryTitle(props.explanations.length, props.scope)}
          </h2>
          <button type="button" class="button button-icon button-ghost" aria-label="Close" title="Close" ref={close} onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body explain-gallery-body">
          <Show
            when={props.explanations.length > 0}
            fallback={
              <div class="empty">
                <p class="empty-title">0 explanations yet.</p>
                <p class="empty-body">
                  Run <code>/explain</code> in a session and its page shows up here.
                </p>
              </div>
            }
          >
            <ExplainGrid explanations={props.explanations} now={props.now} />
          </Show>
        </div>
      </div>
    </Portal>
  );
}
