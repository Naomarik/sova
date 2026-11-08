import { Show, createSignal, lazy, type Component } from "solid-js";
import { highlight } from "../lib/markdown";
import { copyCard } from "./copy";
import { COPY_LABEL, copyWhat } from "./copy-plan";
import type { FrameSpec } from "./kinds/frame/parse";
import type { VisBase } from "./core/grammar";
import { Figure } from "./Figure";
import { ChartControls, createChartState } from "./kinds/chart/ChartControls";
import { fenceKey } from "./kinds/chart/memory";
import type { ChartSpec } from "./kinds/chart/parse";
import { KINDS } from "./registry";
import type { ViewProps } from "./types";

/** One lazy component per View module (several fence words share one View); the help card draws with it too. */
const views = new Map<unknown, Component<ViewProps<VisBase>>>();
export function viewFor(kind: string): Component<ViewProps<VisBase>> {
  const entry = KINDS[kind]!;
  let view = views.get(entry.view);
  if (!view) {
    view = lazy(entry.view);
    views.set(entry.view, view);
  }
  return view;
}

/**
 * One `vis` fence, drawn in the chat: the figure (Figure.tsx) with a Source toggle and Copy (the
 * fence as written), and on a chart the reader's view switch and toggles (kept for the tab per
 * fence), which Source hides. Mounted by vis/hydrate.tsx into markdown.ts's placeholder.
 */
export function Visual(props: { kind: string; spec: VisBase; fence: string; body: string }) {
  const [source, setSource] = createSignal(false);
  const entry = KINDS[props.kind]!;
  // Copy follows the card: a picture of the drawing, or the fence while Source is open (copy-plan.ts).
  const copy = () => copyWhat({ sourceOpen: source(), kind: props.kind });
  // A drawing's props never change (a new fence is a new drawing), so the chart's state is made once.
  const chart = props.kind === "chart" ? createChartState(props.spec as ChartSpec, fenceKey(props.fence)) : null;
  return (
    <Figure
      kind={props.kind}
      spec={chart ? chart.drawn() : props.spec}
      view={viewFor(props.kind)}
      hidden={source()}
      warnings
      actions={
        <>
          <Show when={chart && !source()}>
            <ChartControls state={chart!} />
          </Show>
          <button class="button button-sm button-ghost vis-action" type="button" aria-pressed={source()} onClick={() => setSource(!source())}>
            <span class="icon icon-sm" style={{ "--icon": `url(/icons/${source() ? "eye" : "terminal"}.svg)` }} aria-hidden="true" />
            {source() ? "Visual" : "Source"}
          </button>
          <button
            class="button button-sm button-ghost vis-action"
            type="button"
            aria-label={COPY_LABEL[copy()]}
            onClick={(e) => copyCard(e.currentTarget, { what: copy(), fence: props.fence, label: props.spec.title ?? props.spec.caption ?? entry.label, svgSource: props.kind === "svg" ? (props.spec as FrameSpec).source : undefined })}
          >
            <span class="icon icon-sm" style={{ "--icon": "url(/icons/copy.svg)" }} aria-hidden="true" />
            Copy
          </button>
        </>
      }
      before={
        <Show when={source()}>
          <pre class="vis-source">
            <code class="hljs" innerHTML={highlight(props.body, entry.framed ? "xml" : "plaintext")} />
          </pre>
        </Show>
      }
    />
  );
}
