// The markdown viewer's state (§app/markdown-viewer): one viewer app-wide, opened from anywhere
// with openMarkdown. MarkdownViewer (mounted once, in GlobalRegions) draws whatever this holds.
// No DOM here beyond reading the focused element, so it tests under tsx.

import { createSignal } from "solid-js";

export type MarkdownView = "rendered" | "source";

export interface MarkdownDoc {
  title: string;
  markdown: string;
  subtitle?: string;
  /** The view it opens on; Rendered unless the caller asks for Source. */
  view?: MarkdownView;
}

export interface MarkdownViewerState extends MarkdownDoc {
  view: MarkdownView;
  /** Bumped on every open, so a replacing document resets the view and scroll. */
  seq: number;
  /** What had focus before the viewer opened; focused again on close. */
  opener: HTMLElement | null;
}

const [state, setState] = createSignal<MarkdownViewerState | null>(null);

/** The open document, or null when the viewer is closed. */
export const markdownViewer = state;

let seq = 0;

/** Opens the viewer on `doc`. While it is open, this replaces the document in place; the opener
    stays the one from the first open, since focus is inside the viewer by then. */
export function openMarkdown(doc: MarkdownDoc): void {
  const current = state();
  const focused = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  setState({
    title: doc.title,
    markdown: doc.markdown,
    subtitle: doc.subtitle,
    view: doc.view ?? "rendered",
    seq: ++seq,
    opener: current ? current.opener : focused,
  });
}

export function closeMarkdown(): void {
  setState(null);
}
