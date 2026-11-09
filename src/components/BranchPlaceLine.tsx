import { createSignal, createUniqueId, For, Show } from "solid-js";
import { clauseText, placeFold, placeIsFolder, placeOf, type BranchPlaceRow } from "../lib/branch-place";
import { copyText, home } from "../lib/ui-state";
import { CopyButton, Icon } from "./ui";

/** A branch's place: "{place} · merges into {target}", a button that unfolds to its exact folder. Its clicks stay
    inside it, so it sits safely in a row or card that is clickable itself. */
export function BranchPlaceLine(props: { row: BranchPlaceRow }) {
  const [open, setOpen] = createSignal(false);
  const foldId = createUniqueId();
  const fold = () => placeFold(props.row, home());
  return (
    <Show when={placeOf(props.row)}>
      {(place) => (
        <div class="branch-place" onClick={(e) => e.stopPropagation()}>
          <button type="button" class="branch-place-line text-caption" aria-expanded={open()} aria-controls={foldId} onClick={() => setOpen(!open())}>
            <Icon name={open() ? "chevron-down" : "chevron-right"} small />
            <span class="branch-place-words">
              <span classList={{ "text-mono": placeIsFolder(place()) }}>{place()}</span>
              {clauseText(props.row)}
            </span>
          </button>
          <div id={foldId} class="branch-place-fold text-caption" hidden={!open()}>
            <Show when={open()}>
              <For each={fold().lines}>
                {(l) => (
                  <p class="branch-place-fact">
                    <span class="text-muted">{l.label}:</span> <span class="text-mono">{l.value}</span>
                  </p>
                )}
              </For>
              <Show when={fold().copy}>
                {(folder) => <CopyButton label="Copy Folder" title="Copies this branch's folder." text={folder} onCopy={(t) => copyText(t, "Folder copied.")} />}
              </Show>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
