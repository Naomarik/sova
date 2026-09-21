import { createEffect, createMemo, For, on, Show } from "solid-js";
import type { MentionEntry } from "../lib/files";
import { Icon } from "./ui";

/** `file-` + the name with anything outside [a-z0-9-] as "-", suffixed when two names collide.
    Same rule as SlashMenu's commandOptionIds (that one is "cmd-"): stable per row, unique in the
    list, so aria-activedescendant can point at it. */
export function mentionOptionIds(entries: MentionEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const base = `file-${e.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  });
}

/** What the listbox is showing besides entries: still reading the folder, or why it can't. */
export type FileMenuStatus = { state: "loading" } | { state: "error"; error: string } | { state: "ready" };

/**
 * The composer's @-mention listbox (spec/04h-file-mentions.md), the slash menu's twin: focus
 * stays in the textarea, the active row is aria-activedescendant, rows insert on mousedown.
 * Shows ONE level — the token's current directory — with directories first; a directory pick
 * appends "/" and the menu keeps drilling in, a file pick inserts the path and closes.
 */
export function FileMenu(props: {
  entries: MentionEntry[];
  ids: string[];
  active: number;
  /** The token's current segment, for the no-match line. */
  segment: string;
  /** The directory being listed relative to the session cwd; "" is the cwd itself. */
  dir: string;
  status: FileMenuStatus;
  /** The index was cut at the server's cap, so rare files may be missing (shown in the head). */
  truncated?: boolean;
  /** The absolute session cwd, in the head's title. */
  root?: string;
  onPick(index: number): void;
  onHover(index: number): void;
}) {
  createEffect(
    on(
      () => props.ids[props.active],
      (id) => id && queueMicrotask(() => document.getElementById(id)?.scrollIntoView({ block: "nearest" })),
    ),
  );
  const count = createMemo(() => props.entries.length);

  return (
    <div class="command-menu" id="file-menu" title={props.root}>
      <p class="command-menu-head" id="file-menu-head" aria-hidden="true">
        Files · {count()}
        <Show when={props.truncated}>
          <span class="file-menu-truncated" title="Large folder — rare files may be missing from the list">
            {" "}
            · partial
          </span>
        </Show>
      </p>
      <Show
        when={props.status.state === "ready" && count() > 0}
        fallback={
          <p class="command-menu-empty">
            <Show
              when={props.status.state === "loading"}
              fallback={
                <Show
                  when={props.status.state === "error"}
                  fallback={<>Nothing in {props.dir || "."} matches “{props.segment}”.</>}
                >
                  {props.status.error}
                </Show>
              }
            >
              Reading the folder…
            </Show>
          </p>
        }
      >
        <div class="command-list" id="file-listbox" role="listbox" aria-label="Files">
          <For each={props.entries}>
            {(entry, i) => (
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
                <span class="command-option-name">
                  {entry.name}
                  <Show when={entry.dir}>
                    <span class="file-option-slash" aria-hidden="true">
                      /
                    </span>
                  </Show>
                </span>
                <Show when={entry.dir}>
                  <Icon name="chevron-right" small class="file-option-chevron" />
                </Show>
                <span class="command-option-location" title={entry.path}>
                  {entry.path}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <p class="command-menu-foot">
        <kbd>Enter</kbd> or <kbd>Tab</kbd> to complete · <kbd>Esc</kbd> to close
      </p>
    </div>
  );
}
