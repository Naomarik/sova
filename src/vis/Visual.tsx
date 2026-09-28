import { For, Show, Suspense, createSignal, lazy, onMount, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { highlight } from "../lib/markdown";
import { announce, copyText } from "../lib/ui-state";
import { emphasisNotes } from "./core/emphasis";
import type { VisBase } from "./core/grammar";
import { EmBadge } from "./emphasis";
import { KINDS } from "./registry";
import type { ViewProps } from "./types";
import "./vis.css";

/** One lazy component per View module (several fence words share one View). */
const views = new Map<unknown, Component<ViewProps<VisBase>>>();
function viewFor(kind: string): Component<ViewProps<VisBase>> {
  const entry = KINDS[kind]!;
  let view = views.get(entry.view);
  if (!view) {
    view = lazy(entry.view);
    views.set(entry.view, view);
  }
  return view;
}

/** Before a kind's View first arrives, what the drawing will need: the kind's own estimate. */
const DEFAULT_RESERVE = 160;

/**
 * Holds the drawing's place while its View loads: a blank box as tall as the kind estimates for
 * this width, so the notes, caption and everything after the figure are already where they'll stay.
 * Measured in onMount, which runs after the figure is in the page and before it is painted.
 */
function Reserve(props: { kind: string; spec: VisBase }) {
  const [height, setHeight] = createSignal(DEFAULT_RESERVE);
  let el!: HTMLDivElement;
  onMount(() => {
    const size = KINDS[props.kind]!.size;
    const width = el.getBoundingClientRect().width;
    if (size && width > 0) {
      try {
        setHeight(Math.max(0, Math.round(size(props.spec, width))));
      } catch {
        // An estimate that throws only costs the reserve its accuracy.
      }
    }
  });
  return <div ref={el} class="vis-reserve" style={{ height: `${height()}px` }} aria-hidden="true" />;
}

/** Prose from a fence (a caption, a note): `backticks` become inline code, the rest stays text. */
function Prose(props: { text: string }) {
  return <For each={props.text.split(/`([^`\n]+)`/)}>{(part, i) => (i() % 2 ? <code>{part}</code> : part)}</For>;
}

/**
 * One `vis` fence, drawn: a figure with its title (or the kind's eyebrow), a Source toggle and Copy
 * (the fence as written), the kind's View, the numbered notes of its `mark` lines, and the caption.
 * The shell is the same for every kind; a View draws only the picture. Mounted by vis/hydrate.tsx
 * into markdown.ts's placeholder.
 */
export function Visual(props: { kind: string; spec: VisBase; fence: string; body: string }) {
  const [source, setSource] = createSignal(false);
  const entry = KINDS[props.kind]!;
  const s = props.spec;
  const label = s.title ?? s.caption ?? entry.label;
  const notes = emphasisNotes(s);
  return (
    <figure class={`vis vis-kind-${props.kind}`} aria-label={label}>
      <div class="vis-head">
        <Show when={s.title} fallback={<span class="vis-eyebrow">{entry.label}</span>}>
          <span class="vis-title">{s.title}</span>
        </Show>
        <button class="button button-sm button-ghost vis-action" type="button" aria-pressed={source()} onClick={() => setSource(!source())}>
          <span class="icon icon-sm" style={{ "--icon": `url(/icons/${source() ? "eye" : "terminal"}.svg)` }} aria-hidden="true" />
          {source() ? "Visual" : "Source"}
        </button>
        <button
          class="button button-sm button-ghost vis-action"
          type="button"
          onClick={async () => {
            if (await copyText(props.fence, "Copied the visual's source.")) announce("Copied the visual's source.");
          }}
        >
          <span class="icon icon-sm" style={{ "--icon": "url(/icons/copy.svg)" }} aria-hidden="true" />
          Copy
        </button>
      </div>
      <Show when={source()}>
        <pre class="vis-source">
          <code class="hljs" innerHTML={highlight(props.body, entry.framed ? "xml" : "plaintext")} />
        </pre>
      </Show>
      {/* Hidden, not unmounted: an interactive frame keeps its state across a look at the source. */}
      <div class="vis-body" hidden={source()}>
        <Suspense fallback={<Reserve kind={props.kind} spec={s} />}>
          <Dynamic component={viewFor(props.kind)} spec={s} label={label} />
        </Suspense>
      </div>
      <Show when={notes.length && !source()}>
        <ol class="vis-notes" aria-label="Notes">
          <For each={notes}>
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
      <Show when={s.caption}>
        <figcaption class="vis-caption">
          <Prose text={s.caption!} />
        </figcaption>
      </Show>
    </figure>
  );
}
