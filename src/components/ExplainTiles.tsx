import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ExplanationInfo } from "../../shared/protocol";
import { stampTime } from "../lib/format";
import { appTheme, explainCaption, explainHref, explainModel, THUMB_WIDTH } from "../lib/explain";
import type { ExplainSessionRef } from "../lib/explanations";
import { requestExplainJump } from "../lib/jump";
import { Chip } from "./ui";
import "../explain.css";

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
 * thumbnails in a dark app. `color-scheme` on the embedder propagates to the embedded document
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

/**
 * Where the page came from, under the card: the session's title and a separate "Open in Session"
 * link (never inside the page link), or a plain line when the session is gone. The link queues a
 * jump to the explanation's own row, which the session's transcript claims once it has loaded.
 */
function SessionFoot(props: { item: ExplanationInfo; session: ExplainSessionRef }) {
  return (
    <Show when={props.session.kind !== "gone" && props.session} fallback={<p class="explain-tile-foot">Session no longer on disk</p>}>
      {(s) => {
        const ref = () => s() as Exclude<ExplainSessionRef, { kind: "gone" }>;
        return (
          <p class="explain-tile-foot">
            <span class="explain-tile-from">
              From <span class="explain-tile-session" title={ref().title}>{ref().title}</span>
            </span>
            <Show when={ref().kind === "known" && (ref() as { archived: boolean }).archived}>
              <Chip>Archived</Chip>
            </Show>
            <span aria-hidden="true">·</span>
            <a
              class="explain-tile-open"
              href={ref().href}
              onClick={() => {
                const r = ref();
                requestExplainJump({ explainId: props.item.id, sessionId: r.id, path: r.kind === "known" ? r.path : null });
              }}
            >
              Open in Session
            </a>
          </p>
        );
      }}
    </Show>
  );
}

/**
 * One explanation as a card: the page (thumbnail on desktop, topic, caption, summary, note) is one
 * plain same-tab link to /explain/<id>; the session foot, when given, is a sibling below it.
 */
export function ExplainTile(props: { item: ExplanationInfo; now: number; thumbs: boolean; session?: ExplainSessionRef }) {
  const at = () => props.item.createdAt;
  /** A guard: the lists carry openable pages only, so `error` should never reach a tile. If one
      ever does, there is no page at /explain/<id> — no link, no thumbnail, the reason instead. */
  const failed = () => props.item.error;
  const body = () => (
    <div class="explain-tile-body">
      <div class="explain-tile-head">
        <h3 class="explain-tile-topic">{props.item.topic}</h3>
        <Show when={failed()}>
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
    <li class="card explain-tile" classList={{ "explain-tile-failed": !!failed() }}>
      <Show when={!failed()} fallback={body()}>
        <a class="explain-tile-link" href={explainHref(props.item.id)}>
          <Show when={props.thumbs}>
            <Thumb id={props.item.id} />
          </Show>
          {body()}
        </a>
      </Show>
      <Show when={props.session}>{(s) => <SessionFoot item={props.item} session={s()} />}</Show>
    </li>
  );
}

/** Explanations as one card grid, in the order given. `session` resolves each card's foot. */
export function ExplainGrid(props: { explanations: ExplanationInfo[]; now: number; session?(item: ExplanationInfo): ExplainSessionRef; class?: string }) {
  const thumbs = createMediaQuery("(min-width: 768px)");
  return (
    <ul class={`explain-grid${props.class ? ` ${props.class}` : ""}`}>
      <For each={props.explanations}>{(item) => <ExplainTile item={item} now={props.now} thumbs={thumbs()} session={props.session?.(item)} />}</For>
    </ul>
  );
}
