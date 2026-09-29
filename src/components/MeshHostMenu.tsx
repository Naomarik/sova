import { createSignal, For, onCleanup, Show } from "solid-js";
import { fetchMeshResync } from "../lib/api";
import { connectedCount, hostTone, openMeshDetails } from "../lib/mesh-details";
import { meshPeers, meshState, peerUnavailable, SELF_FILTER, type PeerState } from "../lib/mesh";
import { jobRunning, type MeshResync, RESYNC_POLL_MS, resyncNote, resyncView } from "../lib/mesh-resync";
import { MeshResyncSheet } from "./MeshResyncSheet";
import { Icon } from "./ui";

interface Option {
  /** The stored value; null is All. */
  value: string | null;
  label: string;
  /** Its host's state; undefined for All, which is no host. */
  state?: PeerState | "self";
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
 * one host the pane is unchanged. A host on another version says, under its name, where its build
 * sits against this host's, and one that is behind has Resync beside it (§mesh.peers/resync):
 * /api/mesh/resync is read when the menu opens with a skewed host, and again while a job runs.
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
    { value: SELF_FILTER, label: selfName(), state: "self" },
    ...meshPeers().map((p): Option => ({ value: p.id, label: p.label || p.id, state: p.state, why: peerUnavailable(p) ?? undefined })),
  ];
  const current = () => options().find((o) => o.value === props.value) ?? options()[0]!;
  const count = () => connectedCount(meshPeers());

  const [resync, setResync] = createSignal<MeshResync | null>(null);
  const [sheet, setSheet] = createSignal<string | null>(null);
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(resyncTimer));
  const readResync = () => {
    clearTimeout(resyncTimer);
    if (!meshPeers().some((p) => p.state === "skewed") && !resync()?.hosts.some((h) => jobRunning(h.job))) return;
    fetchMeshResync().then(
      (r) => {
        setResync(r);
        queueMicrotask(place);
        if (open() && r.hosts.some((h) => jobRunning(h.job))) resyncTimer = setTimeout(readResync, RESYNC_POLL_MS);
      },
      () => {
        // no line and no button: the menu is what it was without resync
      },
    );
  };
  const viewOf = (id: string | null) => {
    const r = resync();
    return r && id !== null && id !== SELF_FILTER ? resyncView(r.hosts.find((h) => h.id === id), r.self) : { line: null, button: null };
  };
  const openSheet = (id: string) => {
    chose = true;
    closeMenu();
    setSheet(id);
  };

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
    readResync();
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
          <Show when={current().state}>{(st) => <span class={`chip-dot host-filter-${hostTone(st()).tone}`} />}</Show>
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
            {(o) => {
              const view = () => viewOf(o.value);
              return (
                <div class="host-menu-row">
                  <div
                    class="mode-option group-option host-menu-option"
                    role="menuitemradio"
                    aria-checked={props.value === o.value ? "true" : "false"}
                    tabindex={-1}
                    title={o.why ?? (o.value === null ? "Sessions on every host" : `Only sessions on ${o.label}`)}
                    onClick={() => choose(o.value)}
                  >
                    <Icon name="check" small class="mode-option-check" />
                    <span class="host-menu-option-main">
                      <span class="mode-option-text host-menu-option-text">
                        <Show when={o.state}>{(st) => <span class={`chip-dot host-filter-${hostTone(st()).tone}`} />}</Show>
                        <span class="mode-option-id">{o.label}</span>
                        {/* Any state but up is said in a word as well as the dot's colour. */}
                        <Show when={o.state && hostTone(o.state).word}>
                          {(word) => <span class={`host-filter-state host-filter-${hostTone(o.state!).tone}`}>{word()}</span>}
                        </Show>
                      </span>
                      <Show when={view().line}>{(line) => <span class="host-menu-resync-line">{line()}</span>}</Show>
                    </span>
                  </div>
                  {/* Its own item beside the host (a menu item can't hold another): the keyboard walk reaches it. */}
                  <Show when={view().button}>
                    {(b) => (
                      <button
                        type="button"
                        class="button button-sm host-menu-resync"
                        role="menuitem"
                        tabindex={-1}
                        aria-label={`Resync ${o.label}`}
                        aria-disabled={b().reason ? "true" : undefined}
                        aria-describedby={resyncNote(resync()) ? "host-menu-resync-note" : undefined}
                        title={b().reason ?? `Bring ${o.label} up to this host's build`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!b().reason && o.value) openSheet(o.value);
                        }}
                      >
                        Resync
                      </button>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={resyncNote(resync())}>
            {(note) => (
              <p class="host-menu-note" id="host-menu-resync-note">
                {note()}
              </p>
            )}
          </Show>
          <div class="host-menu-sep" role="separator" />
          <div class="mode-option group-option" role="menuitem" tabindex={-1} onClick={details}>
            <Icon name="info" small class="group-option-icon" />
            <span class="mode-option-text">
              <span class="mode-option-id">Mesh details…</span>
            </span>
          </div>
        </div>
      </div>
      <Show when={sheet() ? resync() : null}>
        {(r) => (
          <MeshResyncSheet
            hostId={sheet()!}
            info={r()}
            onChanged={setResync}
            onClose={() => {
              setSheet(null);
              trigger.focus();
            }}
          />
        )}
      </Show>
    </div>
  );
}
