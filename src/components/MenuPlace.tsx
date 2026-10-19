/**
 * Draws a menu place (src/lib/menu-place.ts) inside an ActionMenu: Sova's built-ins with
 * `MenuBuiltIns`, where the menu stands them, then what extensions add with `MenuAdded`, after
 * every one of Sova's items. Extension content is data drawn as ordinary menu rows, never markup.
 */
import { createUniqueId, For } from "solid-js";
import type { ActionMenuApi } from "./ActionMenu";
import { entryTitle, type MenuBuiltIn, type MenuEntry, type MenuGroup } from "../lib/menu-place";
import { Icon } from "./ui";

/** Every built-in's rows, in order, as rows of the menu they stand in. */
export function MenuBuiltIns<T>(props: { menu: ActionMenuApi; builtIns: readonly MenuBuiltIn<T>[]; subject: T }) {
  return (
    <For each={props.builtIns.flatMap((b) => b.rows(props.subject))}>
      {(r) => (
        <props.menu.Item
          label={r.label}
          aria={r.aria}
          title={r.title}
          description={r.description}
          icon={r.icon ? <Icon name={r.icon} small /> : undefined}
          onRun={() => r.run()}
        />
      )}
    </For>
  );
}

/** What extensions add: one group per extension, headed by its title. Nothing at all with none. */
export function MenuAdded(props: {
  menu: ActionMenuApi;
  groups: readonly MenuGroup[];
  /** What the rows act on, as their accessible names say it: the session's quoted title. */
  subject: string;
  run(entry: MenuEntry): void;
}) {
  return (
    <For each={props.groups}>
      {(g) => {
        const head = createUniqueId();
        return (
          <div class="model-menu-group" role="group" aria-labelledby={head}>
            <div class="list-group-label" id={head}>
              {g.title}
            </div>
            <For each={g.entries}>
              {(e) => (
                <props.menu.Item
                  label={e.label}
                  aria={`${e.label} for ${props.subject} · From ${e.extensionTitle}`}
                  title={entryTitle(e)}
                  description={e.summary}
                  icon={<Icon name="command" small />}
                  onRun={() => props.run(e)}
                />
              )}
            </For>
          </div>
        );
      }}
    </For>
  );
}
