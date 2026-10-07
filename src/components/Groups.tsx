import { createSignal, For, onMount, Show } from "solid-js";
import { GROUP_NAME_MAX, type SessionSummary } from "../../shared/protocol";
import { createGroup, groupNameOf, loadSessionGroups, quoted, sessionGroups, setSessionGroup } from "../lib/session-groups";
import { announce, toast } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/**
 * One inline name field, used for "New group" in the pane and for renaming a group in place.
 * Enter saves, Escape cancels, and leaving the field saves what's
 * there — clicking away after typing a name must not lose it. An empty field cancels.
 */
export function GroupNameField(props: {
  /** The field's accessible name; `initial` pre-fills it when renaming. */
  label: string;
  initial?: string;
  onDone(name: string): void;
  onCancel(): void;
}) {
  // One settlement per field: saving unmounts the field, and that must not also fire the blur
  // handler's save (or a cancel after a save) on top.
  let settled = false;
  const [value, setValue] = createSignal(props.initial ?? "");
  let input!: HTMLInputElement;
  onMount(() => {
    input.focus();
    input.select();
  });
  const finish = (act: () => void) => {
    if (settled) return;
    settled = true;
    act();
  };
  const save = () => {
    const name = value().trim();
    finish(() => (name ? props.onDone(name) : props.onCancel()));
  };
  return (
    <form
      class="group-field"
      aria-label={props.label}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        ref={input}
        class="input"
        type="text"
        maxlength={GROUP_NAME_MAX}
        placeholder="Group name"
        aria-label={props.label}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          finish(() => props.onCancel());
        }}
        onBlur={save}
      />
      <button type="submit" class="button button-sm">
        Save
      </button>
    </form>
  );
}

interface Row {
  /** The group to move into; null is "No group", which clears the assignment. */
  id: string | null;
  name: string;
}

/** Popover ids must be unique: the session list shows one of this control per row. */
let seq = 0;

/**
 * The session pane's way to group a session without dragging: a
 * "Move into group" trigger and a popover menu. One group per session, so the list is a set of
 * radio rows plus "No group", and "New group…" creates a group and moves this session into it in
 * one step. Same popover shell, rows and keyboard handling as the mode menu, anchored below
 * the trigger instead of above it.
 */
export function MoveToGroupMenu(props: {
  session: SessionSummary;
  /** After a change: the app re-reads the session list, which is what carries the new groupId. */
  onChanged(): void;
  /** A row's trigger: the folder icon alone, named by its label (a table cell has no room for words). */
  iconOnly?: boolean;
  /** A heading row's trigger: the folder icon alone at the small control size, named "Move into group". */
  compact?: boolean;
}) {
  const uid = `move-to-group-${++seq}`;
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let closedByChoice = false;
  let tabbedAway = false;

  const [open, setOpen] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [active, setActive] = createSignal(0);

  /** An organization's session is never grouped (§app.session-list/organizations; the server refuses too). */
  const orgRefusal = () => (props.session.org ? "Organization sessions stay with their project." : null);
  const current = () => props.session.groupId ?? null;
  const currentName = () => groupNameOf(sessionGroups(), props.session.groupId ?? undefined);
  /** The radio rows in keyboard order: "No group" first, then each group in creation order. */
  const rows = (): Row[] => [{ id: null, name: "No group" }, ...sessionGroups().map((g) => ({ id: g.id, name: g.name }))];
  /** Only the radio rows are a radiogroup; the "New group…" item follows them in the tab order. */
  const items = () => [...menu.querySelectorAll<HTMLElement>("[role^=menuitem]")];
  const rowIndex = () => (current() === null ? 0 : rows().findIndex((r) => r.id === current()));

  const focusItem = (i: number) => {
    const list = items();
    if (list.length === 0) return;
    const at = ((i % list.length) + list.length) % list.length;
    setActive(at);
    queueMicrotask(() => items()[at]?.focus());
  };
  /** The session's own row — or "New group…" when the list changed under us. */
  const focusCurrent = () => focusItem(Math.max(0, rowIndex()));

  const openMenu = () => {
    if (open()) return;
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    // A session list row can sit near the bottom of a tall window: with no room for the
    // list below the trigger, the menu anchors above it instead (base.css `.model-menu.group-menu-up`,
    // which is compound so it wins the cascade). Both custom properties are always set; the class
    // and the media query decide which one applies, so the sheet band keeps owning the position
    // under 768px.
    const up = innerHeight - r.bottom < 320;
    menu.classList.toggle("group-menu-up", up);
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    // The panel is as tall as its rows, up to the room on the side it opens towards (and 70dvh,
    // base.css `.model-menu.group-menu`): eight groups fit a desktop window without a scrollbar.
    const room = up ? r.top - 4 - 8 : innerHeight - r.bottom - 4 - 8;
    menu.style.setProperty("--menu-max", `${Math.round(Math.max(room, 140))}px`);
    closedByChoice = false;
    tabbedAway = false;
    setError(null);
    setCreating(false);
    menu.showPopover();
    // The list may have moved on (another tab, another server); the store keeps what it has while
    // this lands, so the menu is never empty for a group the user can see.
    void loadSessionGroups().then(() => queueMicrotask(focusCurrent));
  };

  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };

  /** Move the session (or clear its group with null), then close and say what happened. */
  const choose = async (id: string | null) => {
    if (busy() || id === current()) {
      closedByChoice = true;
      closeMenu();
      trigger.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const before = currentName();
    if (await setSessionGroup(props.session.path, id)) {
      const after = groupNameOf(sessionGroups(), id ?? undefined);
      const done =
        id === null
          ? `Removed from ${before ? quoted(before) : "the group"}.`
          : `${before ? "Moved" : "Added"} to ${quoted(after ?? "the group")}.`;
      closedByChoice = true;
      closeMenu();
      trigger.focus();
      toast(done);
      announce(done);
      props.onChanged();
    } else {
      setError("This session's group is unchanged.");
    }
    setBusy(false);
  };

  /** "New group…": create it, then move this session in — one action, two requests. */
  const createAndMove = async (name: string) => {
    setBusy(true);
    const group = await createGroup(name);
    // The field closes as soon as the group exists: if the move then fails, the menu is still open
    // with its error banner, and saving again can't create the same group a second time. Clearing
    // busy first matters too — `choose` refuses while another change is in flight.
    setBusy(false);
    setCreating(false);
    if (group) await choose(group.id);
  };

  /** Enter/Space activates the focused row: a group row moves the session, the last row starts "New group…". */
  const activateCurrent = () => {
    const at = active();
    const row = rows()[at];
    if (row) void choose(row.id);
    else if (at === rows().length) {
      setCreating(true);
      setError(null);
    }
  };

  /**
   * ↑ ↓ Home End walk the rows; Enter and Space activate the focused one. Never while the name
   * field has focus — the caret lives there.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    const n = items().length;
    if (n === 0) return;
    const at = active();
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusItem(at + 1),
      ArrowUp: () => focusItem(at - 1),
      Home: () => focusItem(0),
      End: () => focusItem(n - 1),
      Enter: activateCurrent,
      " ": activateCurrent,
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };

  const onFocusOut = (e: FocusEvent) => {
    const to = e.relatedTarget as Node | null;
    if (to && !menu.contains(to) && to !== trigger) {
      tabbedAway = true;
      closeMenu();
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={props.iconOnly ? "button button-icon button-ghost" : props.compact ? "button button-sm session-action" : "button"}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={uid}
        aria-label={props.compact ? "Move into group" : props.iconOnly ? `Move ${quoted(props.session.title)} into a group` : undefined}
        aria-disabled={orgRefusal() ? "true" : undefined}
        title={
          orgRefusal() ??
          (props.compact ? "Move into group" : currentName() ? `In the group ${quoted(currentName()!)}` : "Move into group")
        }
        onClick={() => {
          const refused = orgRefusal();
          if (refused) {
            toast(refused);
            announce(refused);
            return;
          }
          if (open()) closeMenu();
          else openMenu();
        }}
      >
        <Icon name="folder" small={props.compact} />
        <Show when={!props.iconOnly && !props.compact}>
          Move into group
          <Icon name="chevron-down" small />
        </Show>
      </button>

      <div
        ref={menu}
        class="model-menu group-menu"
        id={uid}
        popover="auto"
        onKeyDown={onKeyDown}
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (!isOpen && !closedByChoice && !tabbedAway) trigger.focus();
        }}
        onFocusOut={onFocusOut}
      >
        <Show when={error()}>{(m) => <Banner tone="error" title="Couldn't move this session." body={m()} />}</Show>
        {/* The mode menu's shape: one role=menu list, role=group sections inside it. While the
            name field is showing there is no menu at all — a form is not menu content. */}
        <div
          class="model-menu-list"
          role={creating() ? undefined : "menu"}
          aria-label={creating() ? undefined : "Move into group"}
        >
          <Show
            when={!creating()}
            fallback={
              <div class="model-menu-group" role="group" aria-label="New group">
                <div class="list-group-label">New group</div>
                <div class="group-field-row">
                  <GroupNameField label="New group name" onDone={(name) => void createAndMove(name)} onCancel={() => setCreating(false)} />
                </div>
              </div>
            }
          >
            <div class="model-menu-group" role="group" aria-labelledby={`${uid}-groups`}>
              <div class="list-group-label" id={`${uid}-groups`}>
                Groups
              </div>
              <For each={rows()}>
                {(row, i) => (
                  <div
                    class="popover-item popover-item-mono"
                    role="menuitemradio"
                    aria-checked={row.id === current() ? "true" : "false"}
                    aria-disabled={busy() ? "true" : undefined}
                    tabindex={active() === i() ? 0 : -1}
                    onFocus={() => setActive(i())}
                    onClick={() => void choose(row.id)}
                  >
                    <Icon name="check" small class="popover-item-check" />
                    <span class="popover-item-text">
                      <span class="popover-item-label">{row.name}</span>
                    </span>
                  </div>
                )}
              </For>
            </div>
            <div class="model-menu-group" role="group" aria-label="New group">
              <div
                class="popover-item popover-item-mono"
                role="menuitem"
                tabindex={active() === rows().length ? 0 : -1}
                onFocus={() => setActive(rows().length)}
                onClick={() => {
                  setCreating(true);
                  setError(null);
                }}
              >
                <Icon name="plus" small />
                <span class="popover-item-text">
                  <span class="popover-item-label">New group…</span>
                </span>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
