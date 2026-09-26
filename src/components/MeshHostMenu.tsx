import { createSignal, For, onCleanup, Show } from "solid-js";
import { connectedCount, openMeshDetails } from "../lib/mesh-details";
import { meshPeers, meshState, peerUnavailable, SELF_FILTER } from "../lib/mesh";
import { Icon } from "./ui";

interface Option {
  /** The stored value; null is All. */
  value: string | null;
  label: string;
  /** Whether its host answers; undefined for All, which is no host. */
  up?: boolean;
  /** Why it doesn't, for the title. */
  why?: string;
}

// Styles: src/mesh.css, loaded app-wide by MeshView. Not imported here: lib code that reaches this
// file through the Sidebar (fork-stage's sessionHref) runs under node in tests, which can't load CSS.

/** The gap the panel keeps from the viewport edges and from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;

/**
 * The session pane's host row, the first row of its foot (above the usage row): `All hosts ▾` with
 * `2/3 connected` at its right end, the whole row the menu's trigger. The menu picks one host's sessions (or All) — the choice is the filter — and ends with
 * "Mesh details…". Only rendered while the mesh is on with a peer (the caller decides), so with
 * one host the pane is unchanged.
 */
export function MeshHostMenu(props: { value: string | null; onChange(value: string | null): void }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  /** The menu closed because of a choice: focus is placed by the choice, not the toggle. */
  let chose = false;

  const selfName = () => meshState()?.self.label || meshState()?.self.hostname || "This host";
  const options = (): Option[] => [
    { value: null, label: "All hosts" },
    { value: SELF_FILTER, label: selfName(), up: true },
    ...meshPeers().map((p) => ({ value: p.id, label: p.label || p.id, up: p.state === "up", why: peerUnavailable(p) ?? undefined })),
  ];
  const current = () => options().find((o) => o.value === props.value) ?? options()[0]!;
  const count = () => connectedCount(meshPeers());

  const items = () => [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")];
  const focusItem = (i: number) => {
    const list = items();
    if (!list.length) return;
    list[((i % list.length) + list.length) % list.length]!.focus();
  };

  /** Below the trigger if it fits, else above (the foot's case), left edges aligned, clamped inside
   *  the window (measured, not guessed). */
  const place = () => {
    if (!menu.isConnected || !menu.matches(":popover-open")) return;
    const r = trigger.getBoundingClientRect();
    const below = innerHeight - EDGE_GAP - (r.bottom + TRIGGER_GAP);
    const above = r.top - TRIGGER_GAP - EDGE_GAP;
    menu.style.setProperty("--menu-max", `${Math.round(Math.max(below, above, 140))}px`);
    const box = menu.getBoundingClientRect();
    const top = box.height <= below ? r.bottom + TRIGGER_GAP : r.top - TRIGGER_GAP - box.height;
    menu.style.setProperty("--menu-top", `${Math.round(Math.min(Math.max(top, EDGE_GAP), Math.max(EDGE_GAP, innerHeight - EDGE_GAP - box.height)))}px`);
    menu.style.setProperty("--menu-left", `${Math.round(Math.min(Math.max(r.left, EDGE_GAP), Math.max(EDGE_GAP, innerWidth - EDGE_GAP - box.width)))}px`);
  };

  const openMenu = () => {
    chose = false;
    menu.showPopover();
    place();
    const at = options().findIndex((o) => o.value === props.value);
    queueMicrotask(() => focusItem(Math.max(0, at)));
  };
  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const choose = (value: string | null) => {
    chose = true;
    closeMenu();
    trigger.focus();
    props.onChange(value);
  };
  const details = () => {
    chose = true;
    closeMenu();
    openMeshDetails();
  };

  // Listeners exist only while the menu is open.
  const follow = () => place();
  const listen = (on: boolean) => {
    if (on) {
      addEventListener("resize", follow);
      addEventListener("scroll", follow, true);
    } else {
      removeEventListener("resize", follow);
      removeEventListener("scroll", follow, true);
    }
  };
  onCleanup(() => listen(false));

  const onKeyDown = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusItem(at + 1),
      ArrowUp: () => focusItem(at - 1),
      Home: () => focusItem(0),
      End: () => focusItem(list.length - 1),
      Enter: () => (document.activeElement as HTMLElement | null)?.click(),
      " ": () => (document.activeElement as HTMLElement | null)?.click(),
      Tab: closeMenu,
    };
    const act = keys[e.key];
    if (!act) return;
    if (e.key !== "Tab") e.preventDefault();
    act();
  };

  return (
    // The row is one button; the panel is its sibling, since a button can't hold interactive content.
    <div class="host-menu">
      <button
        ref={trigger}
        type="button"
        class="list-row list-row-interactive insights-row host-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={`Host filter: ${current().label}. ${count().up} of ${count().total} hosts connected`}
        title={current().value === null ? "Sessions on every host" : `Only sessions on ${current().label}`}
        onClick={() => (open() ? closeMenu() : openMenu())}
      >
        <Icon name="network" />
        <span class="insights-row-text host-menu-text">
          <Show when={current().up !== undefined}>
            <span class="chip-dot" classList={{ "host-filter-up": current().up, "host-filter-down": !current().up }} />
          </Show>
          <span class="host-menu-label">{current().label}</span>
          <Icon name="chevron-down" small />
        </span>
        <span class="host-menu-count" aria-hidden="true">
          {count().up}/{count().total} connected
        </span>
      </button>
      <div
        ref={menu}
        class="model-menu action-menu host-menu-panel"
        popover="auto"
        onKeyDown={onKeyDown}
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          listen(isOpen);
          if (!isOpen && !chose && menu.contains(document.activeElement)) trigger.focus();
        }}
      >
        <div class="model-menu-list" role="menu" aria-label="Host">
          <For each={options()}>
            {(o) => (
              <div
                class="mode-option group-option host-menu-option"
                role="menuitemradio"
                aria-checked={props.value === o.value ? "true" : "false"}
                tabindex={-1}
                title={o.why ?? (o.value === null ? "Sessions on every host" : `Only sessions on ${o.label}`)}
                onClick={() => choose(o.value)}
              >
                <Icon name="check" small class="mode-option-check" />
                <span class="mode-option-text host-menu-option-text">
                  <Show when={o.up !== undefined}>
                    <span class="chip-dot" classList={{ "host-filter-up": o.up, "host-filter-down": !o.up }} />
                  </Show>
                  <span class="mode-option-id">{o.label}</span>
                  {/* Down is said in a word as well as the dot's colour. */}
                  <Show when={o.up === false}>
                    <span class="host-filter-state">down</span>
                  </Show>
                </span>
              </div>
            )}
          </For>
          <div class="host-menu-sep" role="separator" />
          <div class="mode-option group-option" role="menuitem" tabindex={-1} onClick={details}>
            <Icon name="info" small class="group-option-icon" />
            <span class="mode-option-text">
              <span class="mode-option-id">Mesh details…</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
