import { For, Show, createSignal, lazy, type Component } from "solid-js";
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
        <Dynamic component={viewFor(props.kind)} spec={s} label={label} />
      </div>
      <Show when={notes.length && !source()}>
        <ol class="vis-notes" aria-label="Notes">
          <For each={notes}>
            {(n) => (
              <li class={`vis-tone-${n.tone}`}>
                <EmBadge e={{ key: "", tone: n.tone, n: n.n, note: n.note }} />
                <span>{n.note}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={s.caption}>
        <figcaption class="vis-caption">{s.caption}</figcaption>
      </Show>
    </figure>
  );
}
