import { Show } from "solid-js";
import { useDesignOpen } from "../lib/design-history";
import { hostOf } from "../lib/mesh";
import { useDesignStore } from "../lib/design-store";
import { coordinatorOf } from "../lib/design-ui";
import { designGrid, DesignTiles } from "./DesignCard";
import { DesignOpenSlot } from "./DesignOpen";
import { createFontsSettled } from "./DesignFrame";
import "./DesignCard.css";

/** The Gallery tab's prototypes: every design of this chat, in the order they were made. */
export function DesignGallery(props: { path: string }) {
  const store = useDesignStore(props.path, hostOf(props.path));
  // Shared with the chat's Lookbook card, and kept in the browser's history.
  const nav = useDesignOpen(props.path, hostOf(props.path));
  const designs = () => designGrid(store.view());
  const fontsSettled = createFontsSettled();
  return (
    <section class="gallery-section gallery-prototypes" aria-labelledby="gallery-prototypes">
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
            <DesignTiles
              designs={designs()}
              store={store}
              cacheKey={props.path}
              class="gallery-grid"
              onOpen={(label) => nav.open({ kind: "design", label })}
            />
          </Show>
        </div>
      </Show>
      <DesignOpenSlot nav={nav} store={store} path={props.path} />
    </section>
  );
}
