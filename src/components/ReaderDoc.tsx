import { Match, Show, Switch } from "solid-js";
import type { FileShape, MarkdownView } from "../lib/markdown-viewer";
import { highlight } from "../lib/markdown";
import { copyText } from "../lib/ui-state";
import { Markdown } from "./Markdown";
import { Icon } from "./ui";
import "../design/markdown-viewer.css";

/** The shape, when it is that kind. */
const shaped = <K extends FileShape["kind"]>(s: FileShape, kind: K) => (s.kind === kind ? (s as Extract<FileShape, { kind: K }>) : undefined);

/**
 * The reader's own buttons (§app/markdown-viewer): Source on a markdown document, Copy on anything
 * with text. Shared by the reading window (MarkdownViewer) and the Context tab's sheet, so a document
 * reads the same wherever it opens.
 */
export function ReaderTools(props: { shape: FileShape; markdown: string; view: MarkdownView; onView(v: MarkdownView): void; /** Full 44px targets, for a touch surface. */ full?: boolean }) {
  const cls = () => (props.full ? "button button-ghost" : "button button-sm button-ghost");
  return (
    <>
      <Show when={props.shape.kind === "markdown"}>
        <button class={cls()} type="button" aria-pressed={props.view === "source"} onClick={() => props.onView(props.view === "source" ? "rendered" : "source")}>
          <Icon name="terminal" small />
          Source
        </button>
      </Show>
      <Show when={props.shape.kind !== "note"}>
        <button class={cls()} type="button" onClick={() => void copyText(props.markdown, props.shape.kind === "markdown" ? "Copied markdown." : "Copied the file.")}>
          <Icon name="copy" small />
          Copy
        </button>
      </Show>
    </>
  );
}

/** The document itself, drawn in its shape: rendered markdown (or its source), coloured code, plain
    text, or the note saying why nothing is shown. */
export function ReaderDoc(props: { shape: FileShape; markdown: string; view: MarkdownView; truncated?: boolean }) {
  return (
    <div class="md-viewer-doc">
      <Show when={props.truncated}>
        <p class="md-viewer-note">The file is longer; this is its start.</p>
      </Show>
      <Switch fallback={<pre class="md-viewer-source">{props.markdown}</pre>}>
        <Match when={shaped(props.shape, "note")}>{(n) => <p class="md-viewer-note">{n().note}</p>}</Match>
        <Match when={shaped(props.shape, "code")}>
          {(c) => (
            <pre class="md-viewer-source">
              <code class="hljs" innerHTML={highlight(c().body, c().lang)} />
            </pre>
          )}
        </Match>
        <Match when={props.view === "rendered" && shaped(props.shape, "markdown")}>{(m) => <Markdown text={m().body} />}</Match>
      </Switch>
    </div>
  );
}
