import { createEffect, createMemo, For, on, Show } from "solid-js";
import type { SlashCommand } from "../../shared/protocol";

const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  extension: "ext",
  prompt: "prompt",
  skill: "skill",
};

/** `cmd-` + the name with anything outside [a-z0-9-] as "-", suffixed when two names collide. */
export function commandOptionIds(commands: SlashCommand[]): string[] {
  const seen = new Map<string, number>();
  return commands.map((c) => {
    const base = `cmd-${c.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  });
}

/**
 * The composer's slash-command listbox (DESIGN_NOTES §4d). The textarea keeps focus and points
 * at the active row with aria-activedescendant (combobox pattern); this renders the rows and
 * reports picks. Rows insert on mousedown so the textarea never loses focus.
 */
export function SlashMenu(props: {
  commands: SlashCommand[];
  ids: string[];
  active: number;
  query: string;
  onPick(index: number): void;
  onHover(index: number): void;
}) {
  createEffect(
    on(
      () => props.ids[props.active],
      (id) => id && queueMicrotask(() => document.getElementById(id)?.scrollIntoView({ block: "nearest" })),
    ),
  );
  const count = createMemo(() => props.commands.length);

  return (
    <div class="command-menu" id="command-menu">
      <p class="command-menu-head" id="command-menu-head" aria-hidden="true">
        Commands · {count()}
      </p>
      <Show
        when={count() > 0}
        fallback={
          <p class="command-menu-empty">
            0 commands match “/{props.query}”. Enter sends it as a message.
          </p>
        }
      >
        <div class="command-list" id="command-listbox" role="listbox" aria-label="Commands">
          <For each={props.commands}>
            {(cmd, i) => (
              <div
                class="command-option"
                role="option"
                id={props.ids[i()]}
                aria-selected={i() === props.active ? "true" : "false"}
                data-active={i() === props.active ? "" : undefined}
                onMouseEnter={() => props.onHover(i())}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus and the caret in the textarea
                  props.onPick(i());
                }}
              >
                <span class="command-option-name">/{cmd.name}</span>
                <span class="chip">{SOURCE_LABEL[cmd.source]}</span>
                <Show when={cmd.description}>
                  <span class="command-option-desc" title={cmd.description}>
                    {cmd.description}
                  </span>
                </Show>
                <Show when={cmd.location}>
                  <span class="command-option-location" title={cmd.path ?? cmd.location}>
                    {cmd.location}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <p class="command-menu-foot">
        <kbd>Enter</kbd> or <kbd>Tab</kbd> to insert · <kbd>Esc</kbd> to close
      </p>
    </div>
  );
}
