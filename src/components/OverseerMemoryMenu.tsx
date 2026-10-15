import { createSignal, Show } from "solid-js";
import type { MemoryType, OverseerMemoryInfo } from "../../shared/protocol";
import { getOverseerMemory, getProjectOverseerMemory, putOverseerMemory, putProjectOverseerMemory } from "../lib/api";
import { memoryRowText } from "../lib/memory-ui";
import { usePaneId } from "../lib/pane-scope";
import { announce } from "../lib/ui-state";
import { focusPanel, MemoryTypePanel, panelKeys } from "./MemoryTypePanel";
import { Banner, Icon } from "./ui";

/** Whose switch it is: the Overseer's, or one project overseer's. */
export interface OverseerMemoryScope {
  /** Its name in copy: "Overseer" / "project overseer". */
  who: string;
  read(): Promise<OverseerMemoryInfo>;
  write(patch: { on?: boolean; type?: MemoryType; size?: number }): Promise<OverseerMemoryInfo>;
}

export const MAIN_OVERSEER_MEMORY: OverseerMemoryScope = { who: "Overseer", read: getOverseerMemory, write: putOverseerMemory };

export const projectOverseerMemory = (projectId: string): OverseerMemoryScope => ({
  who: "project overseer",
  read: () => getProjectOverseerMemory(projectId),
  write: (patch) => putProjectOverseerMemory(projectId, patch),
});

/**
 * An overseer's memory switch (the Overseer's, or a project overseer's): it has no mode menu, so its
 * memory has this button in its composer foot (the Overseer's before Quick Actions). The
 * popover holds a Memory checkbox row and the same type and size rows as the mode menu's panel; each pick
 * writes that overseer's switch at once and reaches it from its next turn.
 */
export function OverseerMemoryMenu(props: { scope?: OverseerMemoryScope }) {
  const scope = () => props.scope ?? MAIN_OVERSEER_MEMORY;
  /** "Overseer" at a sentence start, "project overseer" mid-sentence; capitalised where it leads. */
  const Who = () => scope().who.charAt(0).toUpperCase() + scope().who.slice(1);
  const paneId = usePaneId();
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let rows: HTMLDivElement | undefined;
  const [info, setInfo] = createSignal<OverseerMemoryInfo | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ title: string; body: string } | null>(null);
  const [open, setOpen] = createSignal(false);

  // Read once for the trigger's label, then again at each opening.
  const read = async () => {
    try {
      setInfo(await scope().read());
      return true;
    } catch (err) {
      setError({ title: `Couldn't read the ${scope().who}'s memory.`, body: `${String(err instanceof Error ? err.message : err).replace(/\.$/, "")}. Close this and try again.` });
      return false;
    }
  };
  void read().then(() => setError(null));

  const openMenu = async () => {
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.round(innerWidth - r.right)}px`);
    setError(null);
    menu.showPopover();
    await read();
    queueMicrotask(() => focusPanel(rows));
  };
  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };

  const write = async (patch: { on?: boolean; type?: MemoryType; size?: number }) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await scope().write(patch);
      setInfo(next);
      if (patch.on !== undefined) announce(`${Who()} memory ${next.on ? "on" : "off"}, from its next turn.`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: `Couldn't change the ${scope().who}'s memory.`, body: `${why}. Its memory is unchanged.` });
    } finally {
      setBusy(false);
    }
  };

  const on = () => info()?.on ?? false;
  const row = () => memoryRowText(info()?.types, info() ?? undefined, on());
  const name = () => `${Who()} memory: ${on() ? "on" : "off"}`;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-ghost mode-trigger overseer-memory-trigger"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={paneId("overseer-memory-popover")}
        aria-label={name()}
        title={name()}
        onClick={() => (open() ? closeMenu() : void openMenu())}
      >
        <Show when={on()} fallback={<Icon name="clock" small />}>
          <Icon name="check" small />
        </Show>
        <span class="mode-trigger-label">memory</span>
        <Icon name="chevron-down" small />
      </button>
      <div
        ref={menu}
        class="model-menu mode-menu"
        id={paneId("overseer-memory-popover")}
        popover="auto"
        onKeyDown={(e) => rows && panelKeys(e, rows)}
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (!isOpen) trigger.focus();
        }}
      >
        <Show when={error()}>{(e) => <Banner tone="error" title={e().title} body={e().body} />}</Show>
        <div ref={rows}>
          <div class="model-menu-list" role="menu" aria-label={`${Who()} memory`}>
            <div
              class="popover-item popover-item-detail popover-item-mono"
              role="menuitemcheckbox"
              id={paneId("overseer-memory-on")}
              tabindex="-1"
              aria-checked={on() ? "true" : "false"}
              aria-disabled={busy() || !info() ? "true" : undefined}
              onClick={() => info() && void write({ on: !on() })}
            >
              <Icon name="check" small class="popover-item-check" />
              <span class="popover-item-text">
                <span class="popover-item-label">memory</span>
                <span class="popover-item-desc">{row().description}</span>
                <Show when={row().detail}>{(d) => <span class="popover-item-desc mode-menu-detail">{d()}</span>}</Show>
              </span>
            </div>
          </div>
          <MemoryTypePanel
            idPrefix={paneId("overseer-memory")}
            types={info()?.types}
            sizes={info()?.sizes}
            choice={info()}
            busy={busy() || !info()}
            onPick={(patch) => {
              const i = info();
              if (i && (patch.type ?? i.type) === i.type && (patch.size ?? i.size) === i.size) return;
              void write(patch);
            }}
          />
        </div>
        <div class="mode-menu-foot">
          <p class="mode-menu-foot-line">From the {scope().who}'s next turn. Its coding sessions never get memory.</p>
        </div>
      </div>
    </>
  );
}
