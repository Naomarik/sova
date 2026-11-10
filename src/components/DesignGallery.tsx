import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { hostOf } from "../lib/mesh";
import { useDesignStore } from "../lib/design-store";
import { coordinatorOf } from "../lib/design-ui";
import { designGrid, DesignTile, type DesignOpenTarget } from "./DesignCard";
import { DesignOpen, DesignRefinePanel } from "./DesignOpen";
import "./DesignCard.css";

/** The Gallery tab's prototypes: every design of this chat, in the order they were made. */
export function DesignGallery(props: { path: string }) {
  const store = useDesignStore(props.path, hostOf(props.path));
  const [opened, setOpened] = createSignal<DesignOpenTarget | null>(null);
  const [refining, setRefining] = createSignal<string | null>(null);
  const designs = () => designGrid(store.view());
  const labels = createMemo(() => designs().map((d) => d.label), undefined, { equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) });
  const refined = () => designs().find((d) => d.label === refining());
  return (
    <section class="gallery-section" aria-labelledby="gallery-prototypes">
      <div class="gallery-head">
        <h3 class="text-eyebrow" id="gallery-prototypes">
          Prototypes
        </h3>
        <Show when={coordinatorOf(store.view())}>
          <button type="button" class="button button-sm" onClick={() => setOpened({ kind: "coordinator" })}>
            Open Coordinator
          </button>
        </Show>
      </div>
      <div class="gallery-scroll">
      <Show when={designs().length > 0} fallback={<Show when={store.view()}><p class="text-muted">0 prototypes in this chat. Turn on Design in the mode menu to make some.</p></Show>}>
        <div class="design-grid gallery-grid">
          <For each={labels()}>
            {(label) => <Show when={designs().find((d) => d.label === label)}>{(d) => <DesignTile d={d()} store={store} cacheKey={props.path} onOpen={() => setOpened({ kind: "design", label })} onRefine={() => setRefining(label)} />}</Show>}
          </For>
        </div>
      </Show>
      </div>
      <Show when={refined()}>
        {(d) => (
          <div class="design-card-refine">
            <DesignRefinePanel d={d()} store={store} onClose={() => setRefining(null)} />
          </div>
        )}
      </Show>
      <Show when={opened()}>
        {(target) => (
          <Portal>
            <DesignOpen target={target()} store={store} path={props.path} onClose={() => setOpened(null)} onSwitch={setOpened} />
          </Portal>
        )}
      </Show>
    </section>
  );
}
