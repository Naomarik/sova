import { createMemo, createSignal, For, Show } from "solid-js";
import { useDesignOpen } from "../lib/design-history";
import { hostOf } from "../lib/mesh";
import { useDesignStore } from "../lib/design-store";
import { coordinatorOf } from "../lib/design-ui";
import { designGrid, DesignTile } from "./DesignCard";
import { DesignOpenSlot, DesignRefinePanel } from "./DesignOpen";
import { createFontsSettled } from "./DesignFrame";
import "./DesignCard.css";

/** The Gallery tab's prototypes: every design of this chat, in the order they were made. */
export function DesignGallery(props: { path: string }) {
  const store = useDesignStore(props.path, hostOf(props.path));
  // Shared with the chat's Lookbook card, and kept in the browser's history.
  const nav = useDesignOpen(props.path, hostOf(props.path));
  const [refining, setRefining] = createSignal<string | null>(null);
  const designs = () => designGrid(store.view());
  const labels = createMemo(() => designs().map((d) => d.label), undefined, {
    equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });
  const fontsSettled = createFontsSettled();
  const refined = () => designs().find((d) => d.label === refining());
  return (
    <section class="gallery-section" aria-labelledby="gallery-prototypes">
      <div class="gallery-head">
        <h3 class="text-eyebrow" id="gallery-prototypes">
          Prototypes
        </h3>
        <Show when={coordinatorOf(store.view())}>
          <button
            type="button"
            class="button button-sm"
            onClick={() => nav.open({ kind: "coordinator" })}
          >
            Open Creative Director
          </button>
        </Show>
      </div>
      <Show when={fontsSettled()}>
        <div class="gallery-scroll">
          <Show
            when={designs().length > 0}
            fallback={
              <Show when={store.view()}>
                <div class="empty gallery-empty">
                  <p class="empty-body">
                    {(store.view()?.runs.length ?? 0) > 0
                      ? "0 prototypes yet. They show up here once you press Start on the brief."
                      : "0 designs in this chat. Turn on vis and ask for a Lookbook to make some."}
                  </p>
                </div>
              </Show>
            }
          >
            <div class="design-grid gallery-grid">
              <For each={labels()}>
                {(label) => (
                  <Show when={designs().find((d) => d.label === label)}>
                    {(d) => (
                      <DesignTile
                        d={d()}
                        store={store}
                        cacheKey={props.path}
                        onOpen={() => nav.open({ kind: "design", label })}
                        onRefine={() => setRefining(label)}
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={refined()}>
        {(d) => (
          <div class="design-card-refine">
            <DesignRefinePanel
              d={d()}
              store={store}
              onClose={() => setRefining(null)}
            />
          </div>
        )}
      </Show>
      <DesignOpenSlot nav={nav} store={store} path={props.path} />
    </section>
  );
}
