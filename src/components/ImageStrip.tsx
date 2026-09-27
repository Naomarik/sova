import { createSignal, For, Show } from "solid-js";
import { dataUrlSize, thumbWidth } from "../lib/image-size";
import { openLightbox } from "../lib/ui-state";

/**
 * Thumbnails on a user row or in a tool card. One image keeps its own shape;
 * two or more are square tiles. Each opens the lightbox at that image, scoped to this row.
 * `where` completes the alt text: "in your message" or "from tool result read". `noun` replaces
 * "Image" in it (a path attachment: "Attachment pi-clipboard-….png").
 * A single image whose header gives its size (lib/image-size) holds its final box until it has
 * loaded (or failed), then lays out by the same rules as any other: the reserved box is that
 * layout's size, and the loaded image is drawn exactly as it would be without one.
 */
export function ImageStrip(props: { images?: string[]; where: string; noun?: string }) {
  const count = () => props.images?.length ?? 0;
  const noun = () => props.noun ?? "Image";
  const alt = (i: number) => (count() === 1 ? `${noun()} ${props.where}` : `${noun()} ${i + 1} of ${count()} ${props.where}`);
  const size = () => (count() === 1 ? dataUrlSize(props.images![0]!) : null);
  return (
    <Show when={count() > 0}>
      <ul class="message-images" classList={{ "message-images-single": count() === 1 }} aria-label={`${count()} ${count() === 1 ? "image" : "images"}`}>
        <For each={props.images}>
          {(src, i) => {
            const [loaded, setLoaded] = createSignal(false);
            const held = () => (loaded() ? null : size());
            return (
              <li
                class={held() ? "thumb-sized" : undefined}
                style={held() ? { "--thumb-w": `${thumbWidth(held()!)}px`, "--thumb-ratio": `${held()!.w} / ${held()!.h}` } : undefined}
              >
                <button
                  type="button"
                  class="thumb"
                  aria-haspopup="dialog"
                  onClick={(e) => openLightbox(props.images!.map((s, j) => ({ src: s, alt: alt(j) })), i(), e.currentTarget)}
                >
                  <img src={src} alt={alt(i())} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </Show>
  );
}
