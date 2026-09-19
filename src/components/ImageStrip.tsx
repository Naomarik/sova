import { For, Show } from "solid-js";
import { openLightbox } from "../lib/ui-state";

/**
 * Thumbnails on a user row or in a tool card (DESIGN_NOTES §4b). One image keeps its own shape;
 * two or more are square tiles. Each opens the lightbox at that image, scoped to this row.
 * `where` completes the alt text: "in your message" or "from tool result read".
 */
export function ImageStrip(props: { images?: string[]; where: string }) {
  const count = () => props.images?.length ?? 0;
  const alt = (i: number) => (count() === 1 ? `Image ${props.where}` : `Image ${i + 1} of ${count()} ${props.where}`);
  return (
    <Show when={count() > 0}>
      <ul class="message-images" classList={{ "message-images-single": count() === 1 }} aria-label={`${count()} ${count() === 1 ? "image" : "images"}`}>
        <For each={props.images}>
          {(src, i) => (
            <li>
              <button
                type="button"
                class="thumb"
                aria-haspopup="dialog"
                onClick={(e) => openLightbox(props.images!.map((s, j) => ({ src: s, alt: alt(j) })), i(), e.currentTarget)}
              >
                <img src={src} alt={alt(i())} loading="lazy" decoding="async" />
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
