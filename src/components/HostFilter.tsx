import { For, Show } from "solid-js";
import { meshPeers, meshState, peerUnavailable, SELF_FILTER } from "../lib/mesh";

interface Option {
  /** The stored value; null is All. */
  value: string | null;
  label: string;
  /** Whether its host answers; undefined for All, which is no host. */
  up?: boolean;
  /** Why it doesn't, for the title and the accessible name. */
  why?: string;
}

// Styles: src/mesh.css, loaded app-wide by MeshView. Not imported here: lib code that reaches this
// file through the Sidebar (fork-stage's sessionHref) runs under node in tests, which can't load CSS.

/**
 * The session pane's host filter: `All · <this host> · <peer> …`, one of them on. Only rendered
 * while the mesh is on with a peer (the caller decides), so with one host the pane is unchanged.
 * A radio group: one tab stop, arrow keys move the choice, and the choice is the filter.
 */
export function HostFilter(props: { value: string | null; onChange(value: string | null): void }) {
  const options = (): Option[] => [
    { value: null, label: "All" },
    { value: SELF_FILTER, label: meshState()?.self.label || meshState()?.self.hostname || "This host", up: true },
    ...meshPeers().map((p) => ({ value: p.id, label: p.label || p.id, up: p.state === "up", why: peerUnavailable(p) ?? undefined })),
  ];
  const buttons: HTMLButtonElement[] = [];
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = options().length;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (i + 1) % n
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    props.onChange(options()[next]!.value);
    buttons[next]?.focus();
  };
  return (
    <div class="host-filter" role="radiogroup" aria-label="Host">
      <For each={options()}>
        {(o, i) => {
          const on = () => props.value === o.value;
          return (
            <button
              type="button"
              role="radio"
              class="host-filter-option"
              aria-checked={on() ? "true" : "false"}
              tabindex={on() ? 0 : -1}
              title={o.why ?? (o.value === null ? "Sessions on every host" : `Only sessions on ${o.label}`)}
              ref={(el) => (buttons[i()] = el)}
              onClick={() => props.onChange(o.value)}
              onKeyDown={(e) => onKey(e, i())}
            >
              <span class="host-filter-pill">
                <Show when={o.up !== undefined}>
                  <span class="chip-dot" classList={{ "host-filter-up": o.up, "host-filter-down": !o.up }} />
                </Show>
                <span class="host-filter-label">{o.label}</span>
                {/* Down is said in a word as well as the dot's colour. */}
                <Show when={o.up === false}>
                  <span class="host-filter-state">down</span>
                </Show>
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
}
