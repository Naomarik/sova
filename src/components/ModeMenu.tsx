import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { ChatServerMessage, ModeApplies, ModeInfo } from "../../shared/protocol";
import { getMode, getSubagentProfiles, pickSubagentProfile, postMode, putSubagentProfiles, saveModeDefault } from "../lib/api";
import type { SubagentProfilesInfo } from "../../shared/subagent-profiles";
import { filterProfiles, FOOT_NOTE, isDefaultAll, isDefaultMode, modeSummary, noProfileMatch, nextSetup, savedAnnounce, saveLabel, saveTitle, type ShownMode } from "../lib/mode-menu";
import { useHostScope } from "../lib/host-scope";
import { usePaneId } from "../lib/pane-scope";
import { openSettings, setSubagentSettingsPath } from "../lib/settings-nav";
import { announce } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/** This chat's last WS "mode" message: the mode of THIS chat and how a switch applies here. Before
    that message, the mode known from the list or this tab's last visit (lib/composer-known), whose
    `applies` is absent unless its source said it: then nothing says when a switch applies. */
export type ModeState = Omit<Extract<ChatServerMessage, { type: "mode" }>, "type" | "applies"> & { applies?: ModeApplies };

/** What the chat view hands its composer so the foot can show and switch this chat's mode. */
export interface ModeControl {
  state: Accessor<ModeState | null>;
  /** This chat's session file: POST /api/mode?path= switches this chat and no other. */
  path: string;
}

/** radio: the major mode; check: a minor mode; action: opens a settings screen or the picker, switches nothing. */
type Item = { kind: "radio" | "check" | "action"; id: string; description: string; label?: string };

/** The gear actions: Delegate's row and spec's, since both settings live in Settings → Subagents. */
const CONFIGURE_DELEGATE: Item = {
  kind: "action",
  id: "configure-delegate",
  label: "Configure Delegate",
  description: "Which worker each kind of work goes to",
};
const CONFIGURE_SPEC: Item = {
  kind: "action",
  id: "configure-spec",
  label: "Configure Spec",
  description: "Which worker writes the spec",
};
/** The Subagents group row: opens the profile picker panel. */
const SUBAGENTS: Item = {
  kind: "action",
  id: "subagents",
  label: "Subagents",
  description: "Choose this chat's subagent profile",
};

const itemId = (it: Item) => `mode-${it.kind}-${it.id}`;

// Lists of what exists (and the default for new sessions); fetched on first open, refreshed on
// every open. Only `modes`/`minors` are read from it: what is checked comes from this chat.
const [info, setInfo] = createSignal<ModeInfo | null>(null);
/**
 * What new sessions start from, as mode.json says: written ONLY by GET /api/mode (each open) and by
 * the save's answer (the file as written). Never by a switch — a switch's reply is THIS chat's mode,
 * and reading it here made the footer say "Already the default" after any minor toggle. null when
 * the last read failed: unknown is never "already the default".
 */
const [defaultMode, setDefaultMode] = createSignal<ShownMode | null>(null);
const shownOf = (m: Pick<ModeInfo, "mode" | "minorModes" | "strict">): ShownMode => ({ mode: m.mode, minorModes: [...m.minorModes], strict: m.strict });

/**
 * The composer foot's mode switch: a trigger plus a native popover menu. One major mode
 * (menuitemradio, picking stays open), any minor modes (menuitemcheckbox, toggling stays open) and the
 * Subagents group, whose one row swaps the menu for the profile picker panel (the composer
 * flyout's panel pattern) and back. The mode and the pick are per chat: only this chat follows.
 */
export function ModeMenu(props: { control: ModeControl }) {
  const paneId = usePaneId();
  /** A peer session's profiles and library are its host's. */
  const host = useHostScope();
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let searchInput!: HTMLInputElement;
  let nameInput!: HTMLInputElement;
  let closedByChoice = false;
  let tabbedAway = false;

  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ title: string; body: string } | null>(null);
  const [active, setActive] = createSignal(0);
  /** The save's own request. `busy` is the rows' (a switch): the button says "Saving…" only for this. */
  const [saving, setSaving] = createSignal(false);
  // The picker panel: the library this chat picks from, its own
  // roving row, and the inline flow that saves what this chat uses now as a new profile.
  const [profiles, setProfiles] = createSignal<SubagentProfilesInfo | null>(null);
  const [picker, setPicker] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [pActive, setPActive] = createSignal(0);
  const [saveName, setSaveName] = createSignal<string | null>(null);

  const profileName = () => profiles()?.current.name ?? "…";
  const listed = createMemo(() => profiles()?.profiles ?? []);
  const matches = createMemo(() => filterProfiles(listed(), search()));
  /** Save Current is for a chat ON something: Off configures nothing. A legacy or malformed file saves nothing server-side, and the refusal says so in place. */
  const canSaveCurrent = () => profiles() !== null && profiles()!.current.id !== "off";

  // This chat's own state only: its WS "mode" message, or before it the mode known from the list or
  // this tab's last visit. With neither there is nothing to show: the default in `info()` is not
  // this chat's mode, so the label stays "Mode" and nothing is checked.
  const current = () => props.control.state();
  const items = createMemo<Item[]>(() => {
    const i = info();
    if (!i) return [SUBAGENTS];
    // Each gear follows its row in the roving order, as it follows it on the row. Subagents is the
    // one row of its own group, last.
    return [
      ...i.modes.flatMap((m) => (m.id === "delegate" ? [{ kind: "radio" as const, ...m }, CONFIGURE_DELEGATE] : [{ kind: "radio" as const, ...m }])),
      ...i.minors.flatMap((m) => (m.id === "spec" ? [{ kind: "check" as const, ...m }, CONFIGURE_SPEC] : [{ kind: "check" as const, ...m }])),
      SUBAGENTS,
    ];
  });
  const checked = (it: Item) => {
    const c = current();
    if (!c || it.kind === "action") return false;
    return it.kind === "radio" ? c.mode === it.id : c.minorModes.includes(it.id);
  };
  const label = () => {
    const c = current();
    return c ? [c.mode, ...c.minorModes].join(" · ") : "Mode";
  };
  const name = () => `Mode: ${label()}${current()?.applies === "after-turn" ? ", applies after this turn" : ""}`;

  /** This chat's mode as the footer reads it, or null before its "mode" message arrives. */
  const shown = (): ShownMode | null => {
    const c = current();
    return c ? shownOf(c) : null;
  };
  /**
   * Is what this chat is on already what new sessions start from? Read off the file's own
   * `mode`/`strict`/`minorModes` (`defaultMode`: GET /api/mode on every open, or the save's answer)
   * and the library's own `default`, so the answer is the file's, not a guess from the last press
   * or from a switch's reply.
   */
  const alreadyDefault = () => isDefaultAll(defaultMode(), shown(), profiles());
  const saveState = (): "idle" | "saving" | "done" => (saving() ? "saving" : alreadyDefault() ? "done" : "idle");

  const focusItem = (i: number) => {
    setActive(i);
    queueMicrotask(() => menu.querySelectorAll<HTMLElement>("[role^=menuitem]")[i]?.focus());
  };
  const focusChoice = (i: number) => {
    setPActive(i);
    queueMicrotask(() => menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[i]?.focus());
  };

  const openPicker = () => {
    setPicker(true);
    setSaveName(null);
    // The current row first (or Off's: the list's own start), never the input: focusing it would
    // raise a phone's keyboard. Typing from a row moves into the input (onKeyDown below).
    const at = Math.max(0, matches().findIndex((p) => p.id === profiles()?.current.id));
    focusChoice(at);
  };
  const closePicker = () => {
    setPicker(false);
    focusItem(items().findIndex((it) => it.id === SUBAGENTS.id));
  };

  const openMenu = async (keepError = false) => {
    if (open()) return;
    const r = trigger.getBoundingClientRect();
    // The foot is pinned to the pane's bottom edge, so the menu grows upward from the trigger.
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.round(innerWidth - r.right)}px`);
    closedByChoice = false;
    tabbedAway = false;
    if (!keepError) setError(null);
    setPicker(false);
    setSearch("");
    setSaveName(null);
    menu.showPopover();
    try {
      setProfiles(await getSubagentProfiles(props.control.path, host()));
    } catch (err) {
      setProfiles(null);
      setError({ title: "Couldn't load subagent profiles.", body: String(err) });
    }
    try {
      const read = await getMode(host());
      setInfo(read);
      setDefaultMode(shownOf(read));
    } catch {
      setDefaultMode(null);
      if (!info()) setError({ title: "Couldn't load the modes.", body: "Your mode is unchanged. Close this and try again." });
    }
    const at = items().findIndex((it) => it.kind === "radio" && checked(it));
    focusItem(Math.max(0, at));
  };
  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };

  const activate = async (it: Item) => {
    if (it.id === SUBAGENTS.id) {
      openPicker();
      return;
    }
    if (it.kind === "action") {
      setSubagentSettingsPath(host() ? undefined : props.control.path);
      // Opens Settings at Subagents (→ the spec writer for spec's gear). This chat's mode is left as it is.
      closedByChoice = true;
      closeMenu();
      openSettings("subagents", it.id === CONFIGURE_SPEC.id ? "spec" : null);
      return;
    }
    const c = current();
    if (!c || busy()) return;
    let patch: { mode?: string; minorModes?: string[] };
    // A pick, like a toggle, keeps the menu open: the check moves and focus stays on the row.
    if (it.kind === "radio") {
      if (it.id === c.mode) return;
      patch = { mode: it.id };
    } else {
      patch = { minorModes: checked(it) ? c.minorModes.filter((m) => m !== it.id) : [...c.minorModes, it.id] };
    }
    setBusy(true);
    setError(null);
    try {
      setInfo(await postMode(patch, props.control.path)); // this chat's "mode" message follows over the socket
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't switch the mode.", body: `${why}. Your mode is unchanged.` });
    } finally {
      setBusy(false);
      // The rows re-render as the mode arrives, which can drop focus to <body>: once that settles,
      // put it back on the row just chosen, unless the menu closed or focus moved elsewhere in it.
      requestAnimationFrame(() => {
        if (!menu.matches(":popover-open") || menu.contains(document.activeElement)) return;
        const at = items().findIndex((x) => x.id === it.id);
        if (at >= 0) focusItem(at);
      });
    }
  };

  /**
   * `Save as default`: make THIS chat's mode and subagent profile the ones new sessions start
   * from. Nothing else moves — the chat keeps both, and no other chat hears about it. The mode
   * extension re-reads mode.json at each session_start, so the next session starts on it, TUI
   * included; the subagent library's default is read again at each turn boundary, the same way.
   *
   * The press is what the files get: the request carries no mode of its own (the server takes this
   * chat's, and this chat's pick), so a switch that lands between the click and the request cannot
   * make the default something the user never saw. On success the answers — the files as written —
   * become `defaultMode` and `profiles`, so `alreadyDefault` says so from the server's own copies.
   */
  const saveAsDefault = async () => {
    if (busy() || saving() || alreadyDefault()) return;
    setSaving(true);
    setError(null);
    try {
      const written = await saveModeDefault(props.control.path); // the file as written, not this chat's copy
      setDefaultMode(shownOf(written));
      setInfo((i) => i ?? written); // the lists, in case the open-time read failed
      setProfiles(await getSubagentProfiles(props.control.path, host()));
      announce(savedAnnounce(shown(), profiles()?.current.name ?? null));
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't save the default.", body: `${why}.` });
    } finally {
      setSaving(false);
    }
  };

  /** A profile pick: this chat only; the main panel returns, focus on the Subagents row. */
  const chooseProfile = async (id: string) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await pickSubagentProfile(props.control.path, id, host());
      setProfiles(r);
      closePicker();
      announce(`Subagent profile: ${r.current.name}.${r.applies === "after-turn" ? " Applies from your next message." : ""} Running workers keep their models.`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't switch subagent profiles.", body: `${why}. Your profile is unchanged.` });
    } finally {
      setBusy(false);
    }
  };

  /** Save Current as Profile: what this chat uses now, as a new profile in the library. */
  const saveCurrent = async () => {
    const i = profiles();
    const chosen = saveName()?.trim();
    if (!i || !chosen || busy() || !canSaveCurrent()) return;
    const source = i.settings.profiles.find((p) => p.id === i.current.id) ?? (i.current.source === "legacy" ? i.template : null);
    if (!source) return;
    const next = nextSetup(i.settings.profiles);
    setBusy(true);
    setError(null);
    try {
      await putSubagentProfiles({ ...i.settings, profiles: [...i.settings.profiles, { ...source, id: next.id, name: chosen }] }, host());
      // The library answered from its default view; read again for THIS chat, so the current pick
      // and the footprints come from the same place a fresh open would read them.
      setProfiles(await getSubagentProfiles(props.control.path, host()));
      setSaveName(null);
      announce(`Saved subagent profile "${chosen}".`);
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't save the subagent profile.", body: `${why}. Nothing was saved.` });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (picker()) {
      const target = e.target as HTMLElement | null;
      if (target === nameInput) return; // the name field keeps its own keys
      const radios = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
      if (target === searchInput) {
        // In the field, Home/End and Space are the caret's; only ↓/↑ leave it, and Enter takes the
        // one match when the list has been narrowed to exactly one.
        if (e.key === "ArrowDown" && radios.length > 0) {
          e.preventDefault();
          focusChoice(0);
        } else if (e.key === "ArrowUp" && radios.length > 0) {
          e.preventDefault();
          focusChoice(radios.length - 1);
        } else if (e.key === "Enter" && matches().length === 1) {
          e.preventDefault();
          void chooseProfile(matches()[0]!.id);
        }
        return;
      }
      const radio = target?.closest?.("[role=menuitemradio]") as HTMLElement | null;
      if (!radio) return; // the head's Back and the footer's buttons keep their Enter and Space
      const i = radios.indexOf(radio);
      const typeahead = (append: string | null) => {
        // Typing from a row goes into the search field, which takes focus (the user chose to type).
        e.preventDefault();
        setSearch(append === null ? search().slice(0, -1) : search() + append);
        setPActive(0);
        searchInput.focus();
        const end = searchInput.value.length;
        searchInput.setSelectionRange(end, end);
      };
      const keys: Record<string, () => void> = {
        ArrowDown: () => focusChoice((i + 1) % radios.length),
        ArrowUp: () => focusChoice((i - 1 + radios.length) % radios.length),
        Home: () => focusChoice(0),
        End: () => focusChoice(radios.length - 1),
        Enter: () => void chooseProfile(radio.dataset.profile!),
        " ": () => void chooseProfile(radio.dataset.profile!),
      };
      const act = radios.length > 0 ? keys[e.key] : undefined;
      if (act) {
        e.preventDefault();
        act();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeahead(e.key);
      else if (e.key === "Backspace" && search()) typeahead(null);
      return;
    }
    // Only the menu's own items take keys here: the footer's button is a button, and Enter or Space
    // on it must press IT, not whichever row was last focused.
    if (!(e.target as HTMLElement | null)?.closest?.("[role^=menuitem]")) return;
    const n = items().length;
    if (n === 0) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusItem((active() + 1) % n),
      ArrowUp: () => focusItem((active() - 1 + n) % n),
      Home: () => focusItem(0),
      End: () => focusItem(n - 1),
      Enter: () => void activate(items()[active()]!),
      " ": () => void activate(items()[active()]!),
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };

  const Row = (p: { it: Item; index: number }) => (
    <div
      class="popover-item popover-item-detail popover-item-mono"
      role={p.it.kind === "radio" ? "menuitemradio" : "menuitemcheckbox"}
      id={itemId(p.it)}
      tabindex={active() === p.index ? 0 : -1}
      aria-checked={checked(p.it) ? "true" : "false"}
      aria-disabled={busy() ? "true" : undefined}
      onClick={() => {
        setActive(p.index);
        void activate(p.it);
      }}
      onFocus={() => setActive(p.index)}
    >
      <Icon name="check" small class="popover-item-check" />
      <span class="popover-item-text">
        <span class="popover-item-label">{p.it.label ?? p.it.id}</span>
        <span class="popover-item-desc">{p.it.id === "delegate" ? `Profile: ${profileName()}` : p.it.description}</span>
      </span>
    </div>
  );
  // A sibling of its row, not inside it: a button nested in a menuitemradio (or menuitemcheckbox) loses its role.
  const Gear = (p: { it: Item; index: number }) => (
    <button
      type="button"
      class="button button-ghost button-icon mode-menu-gear"
      role="menuitem"
      id={itemId(p.it)}
      tabindex={active() === p.index ? 0 : -1}
      aria-label={p.it.label}
      title={p.it.label}
      onClick={() => {
        setActive(p.index);
        void activate(p.it);
      }}
      onFocus={() => setActive(p.index)}
    >
      <Icon name="settings" small />
    </button>
  );
  /** A row, with its gear beside it when an action follows it in the roving order. */
  const WithGear = (p: { it: Item; index: number }) => {
    const gear = () => (items()[p.index + 1]?.kind === "action" && items()[p.index + 1]?.id !== SUBAGENTS.id ? items()[p.index + 1]! : null);
    return (
      <Show when={gear()} fallback={<Row it={p.it} index={p.index} />}>
        {(g) => (
          <div class="mode-menu-row" role="none">
            <Row it={p.it} index={p.index} />
            <Gear it={g()} index={p.index + 1} />
          </div>
        )}
      </Show>
    );
  };
  const group = (kind: Item["kind"]) => items().map((it, index) => ({ it, index })).filter((x) => x.it.kind === kind);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-ghost mode-trigger"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={paneId("mode-popover")}
        aria-label={name()}
        title={name()}
        data-applies={current()?.applies}
        onClick={() => (open() ? closeMenu() : void openMenu())}
      >
        <Icon name="sliders" small />
        {/* Two parts, so a narrow foot ellipsizes the minor modes before the major one. */}
        <span class="mode-trigger-label">{current()?.mode ?? "Mode"}</span>
        <Show when={current()?.minorModes.length}>
          <span class="mode-trigger-label mode-trigger-minor">· {current()!.minorModes.join(" · ")}</span>
        </Show>
        <Icon name="chevron-down" small />
      </button>

      <div
        ref={menu}
        class="model-menu mode-menu"
        id={paneId("mode-popover")}
        popover="auto"
        onKeyDown={onKeyDown}
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (!isOpen && !closedByChoice && !tabbedAway) trigger.focus();
        }}
        onFocusOut={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !menu.contains(to) && to !== trigger) {
            tabbedAway = true;
            closeMenu();
          }
        }}
      >
        <Show when={current()?.applies === "after-turn"}>
          <Banner
            tone="info"
            title="Applies after this turn."
            body="This turn keeps the old mode, and so do messages queued during it. Your next message follows the new one."
          />
        </Show>
        <Show when={current()?.applies === "new-chats"}>
          <Banner
            tone="warn"
            title="This chat can't switch."
            body="This chat can't switch: the mode extension isn't loaded here, or another program wrote this session."
          />
        </Show>
        <Show when={error()}>{(e) => <Banner tone="error" title={e().title} body={e().body} />}</Show>

        <Show
          when={!picker()}
          fallback={
            <>
              {/* The picker panel: Back, search, the profiles with
                  their footprints — Off first — then Manage and Save Current. */}
              <div class="composer-flyout-head">
                <button type="button" class="button button-sm button-ghost composer-flyout-back" onClick={closePicker}>
                  <Icon name="chevron-left" small />
                  Back
                </button>
                <span class="model-menu-head-title">Subagent profiles</span>
              </div>
              <div class="model-menu-search">
                <div class="search">
                  <Icon name="search" />
                  <input
                    ref={searchInput}
                    class="input"
                    type="search"
                    aria-label="Find a subagent profile"
                    placeholder="Search subagent profiles"
                    autocomplete="off"
                    spellcheck={false}
                    value={search()}
                    onInput={(e) => {
                      setSearch(e.currentTarget.value);
                      setPActive(0);
                    }}
                  />
                </div>
              </div>
              <div class="model-menu-list" role="menu" aria-label="Subagent profiles">
                <For
                  each={matches()}
                  fallback={<p class="model-menu-empty">{profiles() ? (search() ? noProfileMatch(search()) : "No subagent profiles yet — Save Current as Profile makes one.") : "Couldn't load them."}</p>}
                >
                  {(p, i) => (
                    <div
                      class="popover-item popover-item-detail"
                      role="menuitemradio"
                      id={paneId(`subagent-choice-${p.id}`)}
                      data-profile={p.id}
                      tabindex={pActive() === i() ? 0 : -1}
                      aria-checked={profiles()?.current.id === p.id ? "true" : "false"}
                      aria-disabled={busy() ? "true" : undefined}
                      onClick={() => void chooseProfile(p.id)}
                      onFocus={() => setPActive(i())}
                    >
                      <Icon name="check" small class="popover-item-check" />
                      <span class="popover-item-text">
                        <span class="popover-item-label">{p.name}</span>
                        <span class="popover-item-desc" classList={{ "text-mono": p.id !== "off" }}>
                          {p.footprint}
                        </span>
                      </span>
                    </div>
                  )}
                </For>
              </div>
              <div class="mode-menu-foot">
                <p class="mode-menu-foot-line">This chat only, from your next message. Running workers keep their models.</p>
                <div class="button-row">
                  <button
                    type="button"
                    class="button button-ghost button-sm"
                    onClick={() => {
                      setSubagentSettingsPath(host() ? undefined : props.control.path);
                      closedByChoice = true;
                      closeMenu();
                      openSettings("subagents");
                    }}
                  >
                    Manage Profiles…
                  </button>
                  <Show when={canSaveCurrent()}>
                    <button
                      type="button"
                      class="button button-ghost button-sm"
                      disabled={busy() || saveName() !== null}
                      onClick={() => {
                        setSaveName("");
                        queueMicrotask(() => nameInput?.focus());
                      }}
                    >
                      Save Current as Profile
                    </button>
                  </Show>
                </div>
                <Show when={saveName() !== null}>
                  <form
                    class="mode-menu-save-as"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveCurrent();
                    }}
                  >
                    <div class="field">
                      <label class="field-label" for={paneId("subagent-name")}>
                        Profile name
                      </label>
                      <input
                        ref={nameInput}
                        class="input"
                        id={paneId("subagent-name")}
                        maxlength={48}
                        placeholder={(() => {
                          const i = profiles();
                          return i ? nextSetup(i.settings.profiles).name : "Setup 1";
                        })()}
                        value={saveName() ?? ""}
                        disabled={busy()}
                        onInput={(e) => setSaveName(e.currentTarget.value)}
                      />
                    </div>
                    <div class="button-row">
                      <button type="submit" class="button button-sm" disabled={busy() || !saveName()?.trim()}>
                        Save Profile
                      </button>
                      <button type="button" class="button button-ghost button-sm" disabled={busy()} onClick={() => setSaveName(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                </Show>
              </div>
            </>
          }
        >
          <div class="model-menu-list" role="menu" id={paneId("mode-menu")} aria-label="Mode">
            <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-major")}>
              <div class="list-group-label" id={paneId("mode-group-major")}>
                Major mode
              </div>
              <For each={group("radio")}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
            </div>
            <Show when={group("check").length > 0}>
              <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-minor")}>
                <div class="list-group-label" id={paneId("mode-group-minor")}>
                  Minor modes
                </div>
                <For each={group("check")}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
              </div>
            </Show>
            <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-subagents")}>
              <div class="list-group-label" id={paneId("mode-group-subagents")}>
                Subagents
              </div>
              <div
                class="popover-item"
                role="menuitem"
                id={itemId(SUBAGENTS)}
                tabindex={active() === items().findIndex((it) => it.id === SUBAGENTS.id) ? 0 : -1}
                aria-haspopup="true"
                onClick={() => {
                  setActive(items().findIndex((it) => it.id === SUBAGENTS.id));
                  void activate(SUBAGENTS);
                }}
                onFocus={() => setActive(items().findIndex((it) => it.id === SUBAGENTS.id))}
              >
                <Icon name="worker" small />
                <span class="popover-item-text">
                  <span class="popover-item-label">Subagents · {profileName()}</span>
                </span>
                <Icon name="chevron-right" small class="popover-item-end" />
              </div>
            </div>
          </div>

          <div class="mode-menu-foot">
            <p class="mode-menu-foot-line">
              <span class="text-mono">strict: {current()?.strict ? "on" : "off"}</span> · {FOOT_NOTE}
            </p>
            <button
              type="button"
              class="button button-ghost button-sm mode-menu-save"
              aria-disabled={busy() || saving() || alreadyDefault() ? "true" : undefined}
              title={saveTitle(shown(), alreadyDefault())}
              onClick={() => void saveAsDefault()}
            >
              <Show when={alreadyDefault() && !saving()}>
                <Icon name="check" small />
              </Show>
              {saveLabel(saveState())}
            </button>
          </div>
        </Show>
      </div>
    </>
  );
}
