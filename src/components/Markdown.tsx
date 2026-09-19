import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { renderMarkdown, type RenderedMarkdown } from "../lib/markdown";
import { announce, openLightbox } from "../lib/ui-state";

/**
 * An assistant-text body rendered as markdown (DESIGN_NOTES §4e). The HTML comes only from
 * renderMarkdown, which escapes all model text (markdown-it html:false). While `streaming`, the
 * whole text is re-rendered at most once per animation frame, and an open fence shows as an
 * unhighlighted code block.
 */
export function Markdown(props: { text: string; streaming?: boolean }) {
  const [rendered, setRendered] = createSignal<RenderedMarkdown>(renderMarkdown(props.text, !!props.streaming));
  let frame = 0;
  onCleanup(() => cancelAnimationFrame(frame));
  createEffect(
    on(
      () => [props.text, !!props.streaming] as const,
      ([text, streaming]) => {
        if (!streaming) {
          cancelAnimationFrame(frame);
          frame = 0;
          setRendered(renderMarkdown(text, false));
          return;
        }
        if (frame) return; // one parse per frame; the latest text wins
        frame = requestAnimationFrame(() => {
          frame = 0;
          setRendered(renderMarkdown(props.text, !!props.streaming));
        });
      },
      { defer: true },
    ),
  );
  const html = createMemo(() => rendered().html);

  const copy = async (button: HTMLButtonElement) => {
    const source = rendered().codes[Number(button.dataset.codeIndex)];
    if (source === undefined) return;
    const label = button.querySelector<HTMLElement>(".md-code-copy-label");
    const icon = button.querySelector<HTMLElement>(".icon");
    let ok = true;
    try {
      await navigator.clipboard.writeText(source);
    } catch {
      ok = false;
    }
    if (label) label.textContent = ok ? "Copied" : "Couldn't copy";
    if (icon && ok) icon.style.setProperty("--icon", "url(/icons/check.svg)");
    if (ok) announce("Copied code.");
    setTimeout(() => {
      if (label) label.textContent = "Copy Code";
      icon?.style.setProperty("--icon", "url(/icons/copy.svg)");
    }, 1500);
  };

  return (
    <div
      class="message-body md"
      innerHTML={html()}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        const copyButton = target.closest<HTMLButtonElement>(".md-code-copy");
        if (copyButton) return void copy(copyButton);
        const thumb = target.closest<HTMLButtonElement>("button.thumb[data-md-image]");
        const img = thumb?.querySelector("img");
        if (thumb && img) openLightbox([{ src: img.src, alt: img.alt }], 0, thumb);
      }}
    />
  );
}
