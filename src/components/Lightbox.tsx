import { createEffect, Show } from "solid-js";
import { lightbox, setLightbox } from "../lib/ui-state";
import { Icon } from "./ui";

/**
 * Full-size image viewer (DESIGN_NOTES §4b "Lightbox"): one native <dialog> opened with
 * showModal(), so it sits in the top layer with the page inert behind it and Esc for free.
 * Arrow keys step through one row's images, wrapping. Focus returns to the opening thumb.
 */
export function Lightbox() {
  let dialog!: HTMLDialogElement;
  let closeButton: HTMLButtonElement | undefined;
  let opener: HTMLElement | null = null;
  const count = () => lightbox()?.images.length ?? 0;
  const current = () => {
    const s = lightbox();
    return s ? s.images[s.index] : undefined;
  };
  const step = (d: number) => {
    const s = lightbox();
    if (!s || count() < 2) return;
    setLightbox({ ...s, index: (s.index + d + count()) % count() });
  };

  createEffect(() => {
    const s = lightbox();
    if (s && !dialog.open) {
      opener = s.opener;
      dialog.showModal();
      closeButton?.focus();
    } else if (!s && dialog.open) dialog.close();
  });

  return (
    <dialog
      ref={dialog}
      class="lightbox"
      aria-labelledby="lightbox-caption"
      onClose={() => {
        setLightbox(null);
        // Don't rely on the browser to restore focus.
        if (opener?.isConnected) opener.focus();
        opener = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "ArrowRight") step(1);
      }}
      onClick={(e) => {
        // The backdrop and the empty stage close it; the image itself does nothing.
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.classList.contains("lightbox-stage")) dialog.close();
      }}
    >
      <div class="lightbox-bar">
        <p class="lightbox-caption" id="lightbox-caption">
          {current()?.alt}
        </p>
        <Show when={count() > 1}>
          <span class="lightbox-count" aria-hidden="true">
            {(lightbox()?.index ?? 0) + 1} / {count()}
          </span>
        </Show>
        <button ref={closeButton} type="button" class="button button-icon button-ghost" aria-label="Close Image" autofocus onClick={() => dialog.close()}>
          <Icon name="close" />
        </button>
      </div>
      <div class="lightbox-stage">
        <Show when={current()}>{(img) => <img class="lightbox-img" src={img().src} alt={img().alt} />}</Show>
        <Show when={count() > 1}>
          <button type="button" class="button button-icon lightbox-prev" aria-label="Previous Image" onClick={() => step(-1)}>
            <Icon name="chevron-left" />
          </button>
          <button type="button" class="button button-icon lightbox-next" aria-label="Next Image" onClick={() => step(1)}>
            <Icon name="chevron-right" />
          </button>
        </Show>
      </div>
    </dialog>
  );
}
