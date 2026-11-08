import { For, type JSX, Show, Suspense, createMemo, createSignal, onMount, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { emphasisNotes } from "./core/emphasis";
import type { VisBase } from "./core/grammar";
import { EmBadge } from "./emphasis";
import { KINDS } from "./registry";
import type { ViewProps } from "./types";
import "./vis.css";

/** Before a kind's View first arrives, what the drawing will need: the kind's own estimate. */
const DEFAULT_RESERVE = 160;

/**
 * Holds the drawing's place while its View loads: a blank box as tall as the kind estimates for
 * this width, so the notes, caption and everything after the figure are already where they'll stay.
 * Measured in onMount, which runs after the figure is in the page and before it is painted.
 */
function Reserve(props: { kind: string; spec: VisBase }) {
  const [width, setWidth] = createSignal(0);
  let el!: HTMLDivElement;
  onMount(() => setWidth(el.getBoundingClientRect().width));
  // Follows the spec: a chart the reader switched to another view reserves that view's height.
  const height = createMemo(() => {
    const size = KINDS[props.kind]!.size;
    const w = width();
    if (!size || w <= 0) return DEFAULT_RESERVE;
    try {
      return Math.max(0, Math.round(size(props.spec, w)));
    } catch {
      // An estimate that throws only costs the reserve its accuracy.
      return DEFAULT_RESERVE;
    }
  });
  return <div ref={el} class="vis-reserve" style={{ height: `${height()}px` }} aria-hidden="true" />;
}

/** Prose from a fence (a caption, a note): `backticks` become inline code, the rest stays text. */
function Prose(props: { text: string }) {
  return <For each={props.text.split(/`([^`\n]+)`/)}>{(part, i) => (i() % 2 ? <code>{part}</code> : part)}</For>;
}

/**
 * The shell every drawing sits in: its title (or the kind's eyebrow) with the caller's `actions`
 * beside it, `before` (the chat's Source view), the kind's `view`, the numbered notes of its `mark`
 * lines, and the caption. `hidden` hides the drawing and its notes without unmounting it. Used by
 * the chat's <Visual> and the share page's figure, which has no actions. `warnings` (the chat's)
 * adds one muted line after the caption listing what the parser cut or dropped (parse.ts). Everything
 * follows `spec`: a chart's view switch hands it a new one while the figure stays mounted.
 */
export function Figure(props: { kind: string; spec: VisBase; view: Component<ViewProps<VisBase>>; actions?: JSX.Element; before?: JSX.Element; hidden?: boolean; warnings?: boolean }) {
  const entry = () => KINDS[props.kind]!;
  const s = () => props.spec;
  const label = () => s().title ?? s().caption ?? entry().label;
  const notes = createMemo(() => emphasisNotes(s()));
  return (
    <figure class={`vis vis-kind-${props.kind}`} aria-label={label()}>
      <div class="vis-head">
        <Show when={s().title} fallback={<span class="vis-eyebrow">{entry().label}</span>}>
          {/* A chart's head may cut a long title to its lines: the whole of it on hover. */}
          <span class="vis-title" title={props.kind === "chart" ? s().title : undefined}>
            {s().title}
          </span>
        </Show>
        {props.actions}
      </div>
      {props.before}
      {/* Hidden, not unmounted: an interactive frame keeps its state across a look at the source. */}
      <div class="vis-body" hidden={props.hidden}>
        <Suspense fallback={<Reserve kind={props.kind} spec={s()} />}>
          <Dynamic component={props.view} spec={s()} label={label()} />
        </Suspense>
      </div>
      <Show when={notes().length && !props.hidden}>
        <ol class="vis-notes" aria-label="Notes">
          <For each={notes()}>
            {(n) => (
              <li class={`vis-tone-${n.tone}`}>
                <EmBadge e={{ key: "", tone: n.tone, n: n.n, note: n.note }} />
                <span>
                  <Prose text={n.note} />
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={s().caption}>
        <figcaption class="vis-caption">
          <Prose text={s().caption!} />
        </figcaption>
      </Show>
      <Show when={props.warnings && s().warnings?.length}>
        <p class="vis-warning">Drawn with warnings: {s().warnings!.map((w) => (w.line > 0 ? `line ${w.line}: ${w.message}` : w.message)).join("; ")}.</p>
      </Show>
    </figure>
  );
}
