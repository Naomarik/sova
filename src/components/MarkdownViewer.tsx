import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { closeMarkdown, markdownViewer, type MarkdownView } from "../lib/markdown-viewer";
import { ReaderDoc, ReaderTools } from "./ReaderDoc";
import { Icon } from "./ui";
import "../design/markdown-viewer.css";

/**
 * The one reader (§app/markdown-viewer): a native <dialog> opened with showModal(), like the
 * Lightbox, so it sits in the top layer over any dialog already open. Mounted once; what it shows
 * comes from openMarkdown: markdown, or a file in the shape its type calls for. Esc closes only this
 * dialog: it never reaches the document, where Settings and the changes viewer listen. The document
 * is only rendered while it is open.
 */
export function MarkdownViewer() {
  let dialog!: HTMLDialogElement;
  let closeButton: HTMLButtonElement | undefined;
  let scroller: HTMLDivElement | undefined;
  let opener: HTMLElement | null = null;
  let pressedOnBackdrop = false;
  const [view, setView] = createSignal<MarkdownView>("rendered");
  // Equality-gated: a replacing document resets the view and scroll, nothing else does.
  const seq = createMemo(() => markdownViewer()?.seq);
  createEffect(
    on(seq, (n) => {
      if (n === undefined) return;
      setView(markdownViewer()!.view);
      if (scroller) scroller.scrollTop = 0;
    }),
  );

  createEffect(() => {
    const s = markdownViewer();
    if (s && !dialog.open) {
      opener = s.opener;
      dialog.showModal();
      closeButton?.focus();
    } else if (!s && dialog.open) dialog.close();
  });

  // Native, not Solid's delegated onKeyDown: stopping it here keeps Esc from the document.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeMarkdown();
    };
    dialog.addEventListener("keydown", onKey);
    onCleanup(() => dialog.removeEventListener("keydown", onKey));
  });

  return (
    <dialog
      ref={dialog}
      class="md-viewer"
      aria-labelledby="md-viewer-title"
      onClose={() => {
        closeMarkdown();
        // Don't rely on the browser to restore focus.
        if (opener?.isConnected) opener.focus();
        opener = null;
      }}
      onCancel={(e) => {
        e.preventDefault();
        closeMarkdown();
      }}
      onMouseDown={(e) => (pressedOnBackdrop = e.target === e.currentTarget)}
      onClick={(e) => {
        // The backdrop is the dialog itself: its content fills the box. A drag that started on
        // the document (selecting text) and ended outside doesn't count.
        if (e.target === e.currentTarget && pressedOnBackdrop) return closeMarkdown();
        const link = (e.target as HTMLElement).closest("a.md-app-link");
        // After the browser follows it: a detached link navigates nowhere.
        if (link) setTimeout(closeMarkdown, 0);
      }}
    >
      <Show when={markdownViewer()}>
        {(s) => (
          <div class="md-viewer-frame">
            <div class="md-viewer-head">
              <div class="md-viewer-titles">
                <h2 class="md-viewer-title" id="md-viewer-title">
                  {s().title}
                </h2>
                <Show when={s().subtitle}>
                  <p class="md-viewer-subtitle">{s().subtitle}</p>
                </Show>
              </div>
              <div class="md-viewer-actions">
                <ReaderTools shape={s().shape} markdown={s().markdown} view={view()} onView={setView} />
                <button ref={closeButton} type="button" class="button button-icon button-ghost" aria-label="Close" title="Close" onClick={() => closeMarkdown()}>
                  <Icon name="close" />
                </button>
              </div>
            </div>
            <div class="md-viewer-scroll" ref={scroller} tabindex="0" aria-labelledby="md-viewer-title">
              <ReaderDoc shape={s().shape} markdown={s().markdown} view={view()} truncated={s().truncated} />
            </div>
          </div>
        )}
      </Show>
    </dialog>
  );
}
