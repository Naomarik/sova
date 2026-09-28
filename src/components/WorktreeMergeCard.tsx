import { createSignal, Show } from "solid-js";
import type { WorktreeMergeInfo } from "../../shared/protocol";
import { clockTime, tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { mergeNumbers, shortSha } from "../lib/worktrees";
import { ChangesViewer, useChangesSession } from "./ChangesViewer";
import { Icon } from "./ui";

/**
 * A merge this session recorded (§chat.worktrees/merge-card): which worktree's branch went into
 * which branch, the resulting commit, and what it brought. The model read the same fact as one line.
 * Its chevron unfolds the changes viewer inside the card on that commit against its first parent
 * (§chat.changes/entry), when the card knows its session.
 */
export function WorktreeMergeCard(props: { merge: WorktreeMergeInfo; time?: string }) {
  const m = () => props.merge;
  const session = useChangesSession();
  const [open, setOpen] = createSignal(false);
  const viewerId = `merge-changes-${m().sha.slice(0, 12)}-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div
      class="card worktree-merge"
      classList={{ "worktree-merge-open": open() }}
      role="group"
      aria-label={`Merged ${m().branch} into ${m().target} at ${shortSha(m().sha)}: ${mergeNumbers(m())}`}
    >
      <div class="worktree-merge-head">
        <Show when={session}>
          <button
            type="button"
            class="button button-icon button-ghost worktree-merge-toggle"
            aria-expanded={open()}
            aria-controls={viewerId}
            aria-label={open() ? "Hide This Merge's Changes" : "Show This Merge's Changes"}
            title={open() ? "Hide the changes" : "Show the changes this merge brought"}
            onClick={() => setOpen(!open())}
          >
            <Icon name={open() ? "chevron-down" : "chevron-right"} small />
          </button>
        </Show>
        <span class="icon icon-sm" style={{ "--icon": "url(/icons/branch.svg)" }} aria-hidden="true" />
        <span class="chip chip-success">
          <span class="chip-dot" aria-hidden="true" />
          Merged
        </span>
        <span class="worktree-merge-title">
          <span class="text-mono">{m().branch}</span> into <span class="text-mono">{m().target}</span>
        </span>
        <span class="text-mono text-caption" title={m().sha}>
          {shortSha(m().sha)}
        </span>
      </div>
      <p class="worktree-merge-numbers text-caption">
        <span class="text-num">
          {m().commits} {m().commits === 1 ? "commit" : "commits"}
        </span>
        <span class="text-muted"> · </span>
        <span class="text-mono text-num" aria-label={`${m().added} added, ${m().removed} removed`}>
          <span class="git-add">+{m().added}</span> <span class="git-del">−{m().removed}</span>
        </span>
        <span class="text-muted"> · </span>
        {m().fastForward ? "fast-forward" : "merge commit"}
        <Show when={m().how === "detected"}>
          <span class="text-muted" title="Merged with git during this turn; the session saw it once the turn ended.">
            {" "}
            · seen after the turn
          </span>
        </Show>
        <Show when={props.time}>{(t) => <span class="text-muted"> · {clockTime(t())}</span>}</Show>
      </p>
      <p class="worktree-merge-path text-caption text-mono text-muted" title={m().path}>
        {tildePath(m().path, home())}
      </p>
      <Show when={open() && session}>
        {(s) => (
          <div id={viewerId} class="worktree-merge-changes">
            <ChangesViewer
              inline
              scope={{ kind: "commit", sessionPath: s().path, repoPath: m().path, sha: m().sha }}
              cwd={s().cwd}
            />
          </div>
        )}
      </Show>
    </div>
  );
}
