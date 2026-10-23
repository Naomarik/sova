import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { TmpAttachment } from "../../shared/protocol";
import { renderMarkdown, type RenderedMarkdown, type RenderedVisual } from "../lib/markdown";
import { activatePathChip } from "../lib/path-attachments";
import { sessionIndexVersion } from "../lib/session-links";
import { announce, openLightbox, toast } from "../lib/ui-state";
import { scrollToCardId, useCardJump } from "../lib/card-refs";
import { render } from "solid-js/web";
import { createMarkdownPatcher } from "../vis/hydrate";
import { Visual } from "../vis/Visual";

/**
 * An assistant-text body rendered as markdown. The HTML comes only from
 * renderMarkdown, which escapes all model text (markdown-it html:false). While `streaming`, the
 * whole text is re-rendered at most once per animation frame, and an open fence shows as an
 * unhighlighted code block. `attachments` turns those /tmp image paths in prose into chips.
 * The HTML reaches the DOM one top-level block at a time (vis/hydrate.tsx): unchanged blocks, and
 * the `vis` drawings mounted in them, survive each streaming frame.
 */
export function Markdown(props: { text: string; streaming?: boolean; attachments?: TmpAttachment[] }) {
  const jumpToCard = useCardJump();
  const [rendered, setRendered] = createSignal<RenderedMarkdown>(renderMarkdown(props.text, !!props.streaming, props.attachments));
  let frame = 0;
  onCleanup(() => cancelAnimationFrame(frame));
  createEffect(
    on(
      // A session link resolves against the session list: re-render when that changes, but only
      // for a message that has one — every other message ignores the list's polls.
      () => [props.text, !!props.streaming, props.attachments, props.text.includes("sova://") && sessionIndexVersion()] as const,
      ([text, streaming, attachments]) => {
        if (!streaming) {
          cancelAnimationFrame(frame);
          frame = 0;
          setRendered(renderMarkdown(text, false, attachments));
          return;
        }
        if (frame) return; // one parse per frame; the latest text wins
        frame = requestAnimationFrame(() => {
          frame = 0;
          setRendered(renderMarkdown(props.text, !!props.streaming, props.attachments));
        });
      },
      { defer: true },
    ),
  );
  let el!: HTMLDivElement;
  let patcher: ReturnType<typeof createMarkdownPatcher<RenderedVisual>> | undefined;
  createEffect(() => {
    const r = rendered();
    patcher ??= createMarkdownPatcher(el, (ph, v) => render(() => <Visual kind={v.kind} spec={v.spec} fence={v.fence} body={v.body} />, ph));
    patcher.patch(r);
  });
  onCleanup(() => patcher?.dispose());

  // A markdown block's Rendered side (§chat.markdown/view-rendered): its source drawn by this same
  // component, in place of its `pre`. Kept per block while that block is on screen; a block the
  // patcher replaced takes its drawing with it.
  const drawn = new Map<HTMLElement, () => void>();
  const sweep = () => {
    for (const [block, dispose] of drawn) {
      if (el.contains(block)) continue;
      dispose();
      drawn.delete(block);
    }
  };
  createEffect(() => {
    rendered();
    queueMicrotask(sweep);
  });
  onCleanup(() => {
    for (const dispose of drawn.values()) dispose();
    drawn.clear();
  });
  const toggleRendered = (button: HTMLButtonElement) => {
    const block = button.closest<HTMLElement>(".md-code");
    const pre = block?.querySelector<HTMLElement>(":scope > pre");
    const source = rendered().codes[Number(button.dataset.codeIndex)];
    if (!block || !pre || source === undefined) return;
    const on = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(on));
    const label = button.querySelector<HTMLElement>(".md-code-render-label");
    if (label) label.textContent = on ? "Source" : "Rendered";
    button.querySelector<HTMLElement>(".icon")?.style.setProperty("--icon", `url(/icons/${on ? "terminal" : "eye"}.svg)`);
    pre.hidden = on;
    if (on) {
      const host = document.createElement("div");
      host.className = "md-code-rendered";
      block.appendChild(host);
      const dispose = render(() => <Markdown text={source} />, host);
      drawn.set(block, () => {
        dispose();
        host.remove();
      });
    } else {
      drawn.get(block)?.();
      drawn.delete(block);
    }
  };

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
      ref={el}
      class="message-body md"
      onClick={(e) => {
        const target = e.target as HTMLElement;
        // A markdown block drawn in place is a Markdown of its own: its clicks are its own.
        if (target.closest(".md") !== el) return;
        const copyButton = target.closest<HTMLButtonElement>(".md-code-copy");
        if (copyButton) return void copy(copyButton);
        const renderButton = target.closest<HTMLButtonElement>(".md-code-render");
        if (renderButton) return toggleRendered(renderButton);
        const chip = target.closest<HTMLElement>(".path-chip");
        if (chip) return activatePathChip(chip);
        // A card ref jumps to the card in this chat's thread; it never moves the route.
        const ref = target.closest<HTMLAnchorElement>("a[data-card-ref]");
        if (ref) {
          e.preventDefault();
          const id = ref.dataset.cardRef!;
          if (jumpToCard) jumpToCard(id);
          else if (!scrollToCardId(id)) toast("That card isn't in the transcript on screen.");
          return;
        }
        const thumb = target.closest<HTMLButtonElement>("button.thumb[data-md-image]");
        const img = thumb?.querySelector("img");
        if (thumb && img) openLightbox([{ src: img.src, alt: img.alt }], 0, thumb);
      }}
    />
  );
}
