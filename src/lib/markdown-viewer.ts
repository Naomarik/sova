// The reader's state (§app/markdown-viewer): one viewer app-wide, opened from anywhere with
// openMarkdown. MarkdownViewer (mounted once, in GlobalRegions) draws whatever this holds. No DOM
// here beyond reading the focused element, so it tests under tsx.

import { createSignal } from "solid-js";
import { fileKind, withoutFrontMatter, type FolderItem } from "./folder-viewer";
import { languageForPath } from "./markdown";

export type MarkdownView = "rendered" | "source";

export interface MarkdownDoc {
  title: string;
  markdown: string;
  subtitle?: string;
  /** The view it opens on; Rendered unless the caller asks for Source. */
  view?: MarkdownView;
  /** The file's name: `markdown` is then a file's exact text, shown the best way for its type (fileShape). */
  name?: string;
  /** A language word for when the name can't say. */
  lang?: string;
  /** What the source said about the file when it listed it. */
  said?: FolderItem["kind"];
  /** The source cut the text at its size cap. */
  truncated?: boolean;
  /** Gets focus on close, when focus may have moved by the time this opens (a read came first). */
  opener?: HTMLElement | null;
}

/** Past this many characters a file is plain text: colouring it would hold up the page. */
export const COLOUR_MAX = 200 * 1024;

/** How the reader shows a text: `body` is what it draws (the exact text is the doc's `markdown`);
    `lang` colours it; `note` says why nothing is shown. */
export type FileShape = { kind: "markdown"; body: string } | { kind: "code"; body: string; lang: string } | { kind: "text" } | { kind: "note"; note: string };

/** Picks how a file is shown from its name and contents. Pure. */
export function fileShape(name: string, text: string, lang?: string, said?: FolderItem["kind"]): FileShape {
  const kind = fileKind(name, text, said);
  if (kind === "binary") return { kind: "note", note: "Not a text file, so it isn't shown." };
  if (kind === "too-large") return { kind: "note", note: "Too large to show here." };
  if (text.length > COLOUR_MAX) return { kind: "text" };
  const word = lang ?? languageForPath(name);
  if (word === "markdown") return { kind: "markdown", body: withoutFrontMatter(text) };
  if (word === "plaintext") return { kind: "text" };
  if (word !== "json") return { kind: "code", body: text, lang: word };
  try {
    return { kind: "code", body: JSON.stringify(JSON.parse(text), null, 2), lang: word };
  } catch {
    return { kind: "text" };
  }
}

export interface MarkdownViewerState extends MarkdownDoc {
  view: MarkdownView;
  shape: FileShape;
  /** Bumped on every open, so a replacing document resets the view and scroll. */
  seq: number;
  /** The doc's opener, or what had focus before the viewer opened; focused again on close. */
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
    ...doc,
    view: doc.view ?? "rendered",
    shape: doc.name === undefined ? { kind: "markdown", body: doc.markdown } : fileShape(doc.name, doc.markdown, doc.lang, doc.said),
    seq: ++seq,
    opener: current ? current.opener : (doc.opener ?? focused),
  });
}

export function closeMarkdown(): void {
  setState(null);
}
