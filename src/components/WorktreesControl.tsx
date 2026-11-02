import { createMemo, createSignal, Show } from "solid-js";
import { controlWords, queueRow, rowsSummary } from "../lib/merge-queue";
import { Icon } from "./ui";
import { WorktreesModal, type QueueWorktree } from "./WorktreesModal";

/**
 * The composer status row's worktrees control, just left of "N inputs": a branch icon, a dot when
 * something is ready, needs a fix or waits for you, and the one most useful fact ("2 ready"). It opens
 * the Worktrees modal. Hidden while the chat tracks none.
 */
export function WorktreesControl(props: { rows: QueueWorktree[]; title: string; class?: string; onChanged?(): void }) {
  const [open, setOpen] = createSignal(false);
  const rows = createMemo(() => props.rows.map((w) => queueRow(w)));
  const words = createMemo(() => controlWords(rows()));
  const summary = () => rowsSummary(rows());
  return (
    <Show when={words()}>
      {(c) => (
        <>
          <button
            type="button"
            class={`run-status-link run-status-worktrees${props.class ? ` ${props.class}` : ""}`}
            aria-haspopup="dialog"
            aria-expanded={open() ? "true" : "false"}
            aria-label={`Worktrees: ${summary()}`}
            title={`This chat's worktrees: ${summary()}`}
            onClick={() => setOpen(true)}
          >
            <Icon name="branch" small />
            <Show when={c().dot}>{(d) => <span class={`wt-dot wt-dot-${d()}`} aria-hidden="true" />}</Show>
            <span class="text-num">{c().text}</span>
          </button>
          <Show when={open()}>
            <WorktreesModal title={props.title} rows={props.rows} onClose={() => setOpen(false)} onChanged={props.onChanged} />
          </Show>
        </>
      )}
    </Show>
  );
}
