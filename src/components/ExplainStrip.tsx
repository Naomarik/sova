import { createSignal, Show } from "solid-js";
import type { ExplanationInfo } from "../../shared/protocol";
import { newestFirst } from "../lib/explain";
import { ExplainGallery } from "./ExplainGallery";
import { Icon } from "./ui";

/**
 * "Explained · 3 · Why the watcher restarts" under the session head, next to the outline strip.
 * Absent until this session has an explanation. The whole strip opens the gallery, so its
 * chevron never twists — it's a dialog, not a disclosure.
 */
export function ExplainStrip(props: { explanations: ExplanationInfo[] | undefined; now: number }) {
  const [open, setOpen] = createSignal(false);
  const items = () => newestFirst(props.explanations ?? []);
  const latest = () => items()[0];
  return (
    <Show when={items().length > 0}>
      <div class="explain-strip">
        <button type="button" class="explain-strip-summary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <Icon name="chevron-right" small />
          <span class="explain-strip-label">Explained</span>
          <span class="explain-strip-count">· {items().length}</span>
          <Show when={latest()}>{(l) => <span class="explain-strip-topic">· {l().topic}</span>}</Show>
        </button>
        <Show when={open()}>
          <ExplainGallery explanations={items()} scope="session" now={props.now} onClose={() => setOpen(false)} />
        </Show>
      </div>
    </Show>
  );
}
