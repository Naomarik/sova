import { createSignal, For, onCleanup, Show } from "solid-js";
import { fetchMeshResync } from "../lib/api";
import { connectedCount, hostTone, openMeshDetails } from "../lib/mesh-details";
import { meshPeers, meshState, peerReading, peerUnavailable, SELF_FILTER } from "../lib/mesh";
import type { HostReading } from "../lib/mesh-compat";
import { jobRunning, type MeshResync, RESYNC_POLL_MS, resyncNote, resyncView } from "../lib/mesh-resync";
import { createPopoverMenu } from "../lib/popover-menu";
import { MeshResyncSheet } from "./MeshResyncSheet";
import { Icon } from "./ui";

interface Option {
  /** The stored value; null is All. */
  value: string | null;
  label: string;
  /** Its host's reading; undefined for All, which is no host. */
  state?: HostReading | "self";
  /** Why it doesn't, for the title. */
  why?: string;
}

// Styles: src/mesh.css, loaded app-wide by MeshView. Not imported here: lib code that reaches this
// file through the Sidebar (its sessionHref) runs under node in tests, which can't load CSS.

/**
 * The session pane's host row, the first row of its foot (above the usage row): `All hosts ▾` with
 * `2/3 connected` at its right end, the whole row the menu's trigger. The menu picks one host's sessions (or All) — the choice is the filter — and ends with
 * "Mesh details…". Only rendered while the mesh is on with a peer (the caller decides), so with
 * one host the pane is unchanged. A host on another build, in any state, says under its name where
 * its build sits against this host's, and one that is behind has Resync beside it (§mesh.peers/resync):
 * /api/mesh/resync is read when the menu opens with a host that answers, and again while a job runs.
 */
export function MeshHostMenu(props: { value: string | null; onChange(value: string | null): void }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;

  const selfName = () => meshState()?.self.label || meshState()?.self.hostname || "This host";
  const options = (): Option[] => [
    { value: null, label: "All hosts" },
    { value: SELF_FILTER, label: selfName(), state: "self" },
    ...meshPeers().map((p): Option => ({ value: p.id, label: p.label || p.id, state: peerReading(p), why: peerUnavailable(p) ?? undefined })),
  ];
  const current = () => options().find((o) => o.value === props.value) ?? options()[0]!;
  const count = () => connectedCount(meshPeers());

  // Placement, the keyboard walk and focus on close: the pane foot's menu (src/lib/popover-menu.ts).
  const m = createPopoverMenu({
    trigger: () => trigger,
    menu: () => menu,
    startAt: () => options().findIndex((o) => o.value === props.value),
    onOpen: () => readResync(),
  });
  const { open, place, openMenu, closeMenu } = m;

  const [resync, setResync] = createSignal<MeshResync | null>(null);
  const [sheet, setSheet] = createSignal<string | null>(null);
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(resyncTimer));
  const readResync = () => {
    clearTimeout(resyncTimer);
    if (!meshPeers().some((p) => p.state === "up" || p.state === "skewed") && !resync()?.hosts.some((h) => jobRunning(h.job))) return;
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
    m.closeChosen();
    setSheet(id);
  };

  const choose = (value: string | null) => m.choose(() => props.onChange(value));
  const details = () => {
    m.closeChosen();
    openMeshDetails();
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
        onKeyDown={m.onKeyDown}
        onToggle={m.onToggle}
      >
        <div class="model-menu-list" role="menu" aria-label="Host">
          <For each={options()}>
            {(o) => {
              const view = () => viewOf(o.value);
              return (
                <div class="host-menu-row" data-testid="host-menu-row" data-host-id={o.value ?? undefined} data-host-state={o.state}>
                  <div
                    class="popover-item host-menu-option"
                    classList={{ "popover-item-detail": !!view().line }}
                    role="menuitemradio"
                    aria-checked={props.value === o.value ? "true" : "false"}
                    tabindex={-1}
                    title={o.why ?? (o.value === null ? "Sessions on every host" : `Only sessions on ${o.label}`)}
                    onClick={() => choose(o.value)}
                  >
                    <Icon name="check" small class="popover-item-check" />
                    <span class="host-menu-option-main">
                      <span class="popover-item-text host-menu-option-text">
                        <Show when={o.state}>{(st) => <span class={`chip-dot host-filter-${hostTone(st()).tone}`} />}</Show>
                        <span class="popover-item-label">{o.label}</span>
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
          <div class="popover-sep" role="separator" />
          <div class="popover-item" role="menuitem" tabindex={-1} onClick={details}>
            <Icon name="info" small />
            <span class="popover-item-text">
              <span class="popover-item-label">Mesh details…</span>
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
