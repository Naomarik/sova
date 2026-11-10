import { createEffect, createSignal, on, Show } from "solid-js";
import type { WorktreesSummary } from "../../shared/protocol";
import { fetchWorktreesSummary } from "../lib/api";
import { showsLine, summaryLine } from "../lib/worktree-cleanup";

/**
 * A new session's worktrees line (§chat.transcript/empty-worktrees): "160 worktrees · 12 held" for the repository its
 * folder is in. Plain status with nothing to press: finished worktrees retire by themselves. Read when it appears;
 * nothing polls. Outside the setup card, which never waits for it.
 */
export function EmptyWorktrees(props: { path: string }) {
  const [summary, setSummary] = createSignal<{ path: string; value: WorktreesSummary } | null>(null);
  createEffect(
    on(
      () => props.path,
      (path) => {
        setSummary(null);
        fetchWorktreesSummary(path).then(
          // An answer for a session this no longer shows is dropped.
          (value) => props.path === path && setSummary({ path, value }),
          () => props.path === path && setSummary(null),
        );
      },
    ),
  );
  const shown = () => {
    const s = summary();
    return s && s.path === props.path && showsLine(s.value) ? s.value : null;
  };
  return <Show when={shown()}>{(s) => <p class="empty-worktrees-line">{summaryLine(s())}</p>}</Show>;
}
