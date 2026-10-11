import { Show, createSignal, lazy, type Component } from "solid-js";
import { highlight } from "../lib/markdown";
import { announce, copyText } from "../lib/ui-state";
import type { VisBase } from "./core/grammar";
import { Figure } from "./Figure";
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
 * fence as written). Mounted by vis/hydrate.tsx into markdown.ts's placeholder.
 */
export function Visual(props: { kind: string; spec: VisBase; fence: string; body: string }) {
  const [source, setSource] = createSignal(false);
  const entry = KINDS[props.kind]!;
  return (
    <Figure
      kind={props.kind}
      spec={props.spec}
      view={viewFor(props.kind)}
      hidden={source()}
      warnings
      actions={
        <>
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
