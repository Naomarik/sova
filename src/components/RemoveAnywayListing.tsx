import { For, Show } from "solid-js";
import type { WorktreeRemoveAnyway } from "../../shared/protocol";
import { tildePath } from "../lib/format";
import { anywayBody, anywayHeading, anywayMore, nestedLine } from "../lib/worktree-cleanup";

/** One of Remove Anyway's lists: its heading with the exact total, its rows, and how many more weren't sent. */
function AnywayList(props: { label: string; rows: string[]; total: number }) {
  return (
    <Show when={props.total > 0}>
      <section aria-label={anywayHeading(props.label, props.total)}>
        <h3 class="text-eyebrow">{anywayHeading(props.label, props.total)}</h3>
        <ul class="worktree-cleanup-files">
          <For each={props.rows}>{(f) => <li><code>{f}</code></li>}</For>
        </ul>
        <Show when={anywayMore(props.rows.length, props.total)}>{(m) => <p class="text-caption text-muted">{m()}</p>}</Show>
      </section>
    </Show>
  );
}

/**
 * What Remove Anyway deletes from a kept worktree (§chat.worktrees/leftovers): the sentence, then each kind with its
 * exact total. The project page's Remove Worktree shows it.
 */
export function RemoveAnywayListing(props: { listing: WorktreeRemoveAnyway; home: string | null }) {
  const a = () => props.listing;
  return (
    <div class="remove-anyway-listing">
      <p class="message-text">{anywayBody(a())}</p>
      <AnywayList label="Uncommitted" rows={a().uncommitted} total={a().counts.uncommitted} />
      <AnywayList label="Ignored, not rebuildable" rows={a().ignored} total={a().counts.ignored} />
      <Show when={a().counts.nested > 0}>
        <section aria-label={anywayHeading("Nested repositories", a().counts.nested)}>
          <h3 class="text-eyebrow">{anywayHeading("Nested repositories", a().counts.nested)}</h3>
          <ul class="worktree-cleanup-list">
            <For each={a().nested}>
              {(r) => (
                <li>
                  <code class="worktree-cleanup-path">{r.path}</code>
                  <span class="text-caption text-muted">{nestedLine(r.of ? { ...r, of: tildePath(r.of, props.home) } : r)}</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={anywayMore(a().nested.length, a().counts.nested)}>{(m) => <p class="text-caption text-muted">{m()}</p>}</Show>
        </section>
      </Show>
      <AnywayList label="Rebuildable, also goes" rows={a().rebuildable} total={a().counts.rebuildable} />
    </div>
  );
}
