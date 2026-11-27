/**
 * What Sova draws from the list place's declaration (src/lib/list-place.ts, §app.extensions/list-place):
 * the owner mark on a session row and the person menu in the pane's foot. Both are Sova's own
 * markup over the declaration's data, drawn as plain text: never the extension's markup. The mark
 * is not a control (the row is the link to its session); the menu is Sova's, like the host menu.
 * Neither exists in the DOM while no extension declares people.
 */
import { For, Show } from "solid-js";
import type { ListDeclaration, ListPerson } from "../lib/list-place";
import { createPopoverMenu } from "../lib/popover-menu";
import { Icon } from "./ui";

// Styles: src/extensions.css, loaded with the row place (src/components/RowPlace.tsx). Not imported
// here: lib code that reaches this file through the Sidebar runs under node in tests.

/** A person's name as the page says it: "(you)" after yours. */
const nameOf = (p: ListPerson, self: string | undefined) => (p.id === self ? `${p.name} (you)` : p.name);

/** A row's owner: 2 letters in a round mark, yours highlighted. The name is its tooltip and the row's
    words; `quiet` beside a name that already says it (the menu), where it is decoration only. */
export function OwnerMark(props: { person: ListPerson; self: boolean; quiet?: boolean }) {
  return (
    <span
      class={props.self ? "owner-mark owner-mark-self" : "owner-mark"}
      data-person-id={props.person.id}
      title={props.quiet ? undefined : props.self ? `${props.person.name} (you)` : props.person.name}
      aria-hidden={props.quiet ? "true" : undefined}
    >
      <span aria-hidden="true">{props.person.initials}</span>
      <Show when={!props.quiet}>
        <span class="visually-hidden">{props.self ? "Yours. " : `${props.person.name}'s. `}</span>
      </Show>
    </span>
  );
}

/** The gap the panel keeps from the viewport edges and from its trigger, with its placement and its keys, is the
    host menu's own (createPopoverMenu, src/lib/popover-menu.ts). */

interface Option {
  /** The stored value; null is Everyone. */
  value: string | null;
  person?: ListPerson;
}

/**
 * The person row of the pane's foot, beside the host row: `Everyone ▾`, or the chosen person's mark
 * and name, the whole row the menu's trigger. The menu picks one person's chats (by the owner label
 * the declaration names) or Everyone, which is first. Only rendered while a declaration exists.
 */
export function PersonMenu(props: { declaration: ListDeclaration; value: string | null; onChange(value: string | null): void }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;

  const options = (): Option[] => [{ value: null }, ...props.declaration.people.map((p): Option => ({ value: p.id, person: p }))];
  const current = () => options().find((o) => o.value === props.value) ?? options()[0]!;
  const labelOf = (o: Option) => (o.person ? nameOf(o.person, props.declaration.self) : "Everyone");

  const m = createPopoverMenu({
    trigger: () => trigger,
    menu: () => menu,
    startAt: () => options().findIndex((o) => o.value === props.value),
  });
  const { open, openMenu, closeMenu } = m;
  const choose = (value: string | null) => m.choose(() => props.onChange(value));

  const titleOf = (o: Option) => (o.person ? `Only chats ${o.person.id === props.declaration.self ? "you own" : `${o.person.name} owns`}` : "Chats of every owner");

  return (
    // The row is one button; the panel is its sibling, since a button can't hold interactive content.
    <div class="person-menu">
      <button
        ref={trigger}
        type="button"
        class="list-row list-row-interactive insights-row person-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={`Person filter: ${labelOf(current())}`}
        title={titleOf(current())}
        onClick={() => (open() ? closeMenu() : openMenu())}
      >
        <Show when={current().person} fallback={<Icon name="worker" />}>
          {(p) => <OwnerMark person={p()} self={p().id === props.declaration.self} quiet />}
        </Show>
        <span class="insights-row-text person-menu-text">
          <span class="person-menu-label">{labelOf(current())}</span>
          <Icon name="chevron-down" small />
        </span>
      </button>
      <div
        ref={menu}
        class="model-menu action-menu person-menu-panel"
        popover="auto"
        onKeyDown={m.onKeyDown}
        onToggle={m.onToggle}
      >
        <div class="model-menu-list" role="menu" aria-label="Person">
          <For each={options()}>
            {(o) => (
              <div
                class="popover-item person-menu-option"
                data-testid="person-menu-row"
                data-person-id={o.value ?? undefined}
                role="menuitemradio"
                aria-checked={props.value === o.value ? "true" : "false"}
                tabindex={-1}
                title={titleOf(o)}
                onClick={() => choose(o.value)}
              >
                <Icon name="check" small class="popover-item-check" />
                <span class="popover-item-text person-menu-option-text">
                  <Show
                    when={o.person}
                    fallback={
                      <span class="owner-mark owner-mark-all" aria-hidden="true">
                        <Icon name="worker" small />
                      </span>
                    }
                  >
                    {(p) => <OwnerMark person={p()} self={p().id === props.declaration.self} quiet />}
                  </Show>
                  <span class="popover-item-label">{labelOf(o)}</span>
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
