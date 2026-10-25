import { For, Show } from "solid-js";
import { type AbilityLine, lineText, PHOTOS_NOTE } from "../lib/owner-abilities";

/** A row's chevron: where a tap goes on. */
export function Chevron() {
  return (
    <svg class="owner-row-go" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** The card's lines (§app.project-assistant/abilities), each a button that starts the chat's message box. */
export function AbilityList(props: { lines: AbilityLine[]; photos?: boolean; pick(l: AbilityLine): void }) {
  return (
    <>
      <ul class="owner-abilities">
        <For each={props.lines}>
          {(l) => (
            <li>
              <button type="button" class="owner-ability" classList={{ "owner-ability-named": l.named }} aria-label={lineText(l)} onClick={() => props.pick(l)}>
                <span class="owner-ability-text">
                  <span class="owner-ability-name">
                    {l.name}
                    {l.named ? ":" : ""}
                  </span>{" "}
                  <span class="owner-ability-how">{l.how}</span>
                </span>
                <Chevron />
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.photos}>
        <p class="owner-meta owner-abilities-note">{PHOTOS_NOTE}</p>
      </Show>
    </>
  );
}
