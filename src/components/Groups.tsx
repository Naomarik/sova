import { createSignal, For, onMount, Show } from "solid-js";
import { GROUP_NAME_MAX, type SessionSummary } from "../../shared/protocol";
import { createGroup, groupNameOf, loadSessionGroups, quoted, sessionGroups, setSessionGroup } from "../lib/session-groups";
import { groupHref } from "../lib/group-route";
import { announce, toast } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/**
 * One inline name field, used for "New group" in the pane and for renaming a group in place
 * (spec/02-session-list.md §2 "Groups"). Enter saves, Escape cancels, and leaving the field saves what's
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

/** Popover ids must be unique: the session pane and the info modal can show this control at once. */
let seq = 0;

/**
 * The session pane's way to group a session without dragging (spec/02-session-list.md §2 "Groups"): a
 * "Move into group" trigger and a popover menu. One group per session, so the list is a set of
 * radio rows plus "No group", and "New group…" creates a group and moves this session into it in
 * one step. Same popover shell, rows and keyboard handling as the mode menu (§4g), anchored below
 * the trigger instead of above it.
 */
export function MoveToGroupMenu(props: {
  session: SessionSummary;
  /** After a change: the app re-reads the session list, which is what carries the new groupId. */
  onChanged(): void;
  /**
   * "move" (the default) files the session and stays where it is. "beside" is the same gesture
   * read as a place to work: it files the session and then opens that group's workspace with this
   * session the focused pane. Choosing the group it is already in just opens the workspace, and
   * "No group" isn't offered — there is no workspace to open.
   */
  variant?: "move" | "beside";
}) {
  const beside = () => props.variant === "beside";
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

  const current = () => props.session.groupId ?? null;
  const currentName = () => groupNameOf(sessionGroups(), props.session.groupId ?? undefined);
  /** The radio rows in keyboard order: "No group" first, then each group in creation order. */
  const rows = (): Row[] =>
    beside() ? sessionGroups().map((g) => ({ id: g.id, name: g.name })) : [{ id: null, name: "No group" }, ...sessionGroups().map((g) => ({ id: g.id, name: g.name }))];
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
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    // The Session tab's own controls sit near the bottom of a tall window: with no room for the
    // list below the trigger, the menu anchors above it instead (base.css `.group-menu-up`).
    if (innerHeight - r.bottom < 320) {
      menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
      menu.classList.add("group-menu-up");
    } else {
      menu.classList.remove("group-menu-up");
    }
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
      // Already in this group: there is nothing to change, but "Open beside" still opens it.
      if (beside() && id) location.hash = groupHref(id, props.session.path);
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
      if (beside() && id) location.hash = groupHref(id, props.session.path);
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
        class="button"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={uid}
        title={
          beside()
            ? "Open this session in a group's workspace, beside the sessions already in it"
            : currentName()
              ? `In the group ${quoted(currentName()!)}`
              : "Move into group"
        }
        onClick={() => (open() ? closeMenu() : openMenu())}
      >
        <Icon name={beside() ? "external" : "folder"} />
        {beside() ? "Open beside" : "Move into group"}
        <Icon name="chevron-down" small />
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
        <Show when={beside() && sessionGroups().length === 0 && !creating()}>
          <p class="sidebar-region-note">No groups yet. Make one to open this session beside another.</p>
        </Show>
        {/* The mode menu's shape (§4g): one role=menu list, role=group sections inside it. While the
            name field is showing there is no menu at all — a form is not menu content. */}
        <div
          class="model-menu-list"
          role={creating() ? undefined : "menu"}
          aria-label={creating() ? undefined : beside() ? "Open beside" : "Move into group"}
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
                    class="mode-option group-option"
                    role="menuitemradio"
                    aria-checked={row.id === current() ? "true" : "false"}
                    aria-disabled={busy() ? "true" : undefined}
                    tabindex={active() === i() ? 0 : -1}
                    onFocus={() => setActive(i())}
                    onClick={() => void choose(row.id)}
                  >
                    <Icon name="check" small class="mode-option-check" />
                    <span class="mode-option-text">
                      <span class="mode-option-id">{row.name}</span>
                    </span>
                  </div>
                )}
              </For>
            </div>
            <div class="model-menu-group" role="group" aria-label="New group">
              <div
                class="mode-option group-option"
                role="menuitem"
                tabindex={active() === rows().length ? 0 : -1}
                onFocus={() => setActive(rows().length)}
                onClick={() => {
                  setCreating(true);
                  setError(null);
                }}
              >
                <Icon name="plus" small class="group-option-icon" />
                <span class="mode-option-text">
                  <span class="mode-option-id">New group…</span>
                </span>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
