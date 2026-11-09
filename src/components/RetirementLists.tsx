import { createSignal, For, Show } from "solid-js";
import type { HeldRow, RetiredRow, RetirementView } from "../../shared/protocol";
import { fetchRetirement, restoreWorktree } from "../lib/api";
import { relativeTime } from "../lib/format";
import { lockLine } from "../lib/worktree-cleanup";
import { announce, toast } from "../lib/ui-state";
import { RowHead, type ChatOf } from "./MergeQueueTab";

/** Why retirement doesn't run here, said once, even with no rows: nothing retires by itself. */
export function RetirementOff(props: { view?: RetirementView }) {
  return <Show when={props.view?.off}>{(off) => <p class="text-caption text-muted" data-testid="mq-retire-off">{off()}</p>}</Show>;
}

/** The Held tab's rows, which are all its label counts. */
export const heldCount = (v: RetirementView | undefined): number => v?.held.length ?? 0;
/** Whether the Held tab has anything to show: a lock's line or a waiting line is not a row, but is worth saying. */
export const heldHasContent = (v: RetirementView | undefined): boolean => !!v && (v.held.length > 0 || v.waiting > 0 || !!v.lockTaken);

/** The Held tab's contents (§app.merge-queue/view): the lock's line, the rows, then how many only wait. */
export function HeldList(props: { projectId: string; view: RetirementView; chatOf?: ChatOf }) {
  const v = () => props.view;
  return (
    <div class="stack-2" data-testid="mq-held">
      <Show when={v().lockTaken}>{(who) => <p class="text-caption text-muted">{lockLine(who())}</p>}</Show>
      <Show when={v().held.length > 0}>
        <ul class="list mq-list">
          <For each={v().held}>{(h) => <HeldItem projectId={props.projectId} row={h} chatOf={props.chatOf} />}</For>
        </ul>
      </Show>
      <Show when={v().waiting > 0}>
        <p class="text-caption text-muted" title={v().waitingWhy} aria-label={v().waitingWhy ? `${v().waiting} more waiting until quiet: ${v().waitingWhy}` : undefined}>
          {v().waiting} more waiting until quiet
        </p>
      </Show>
    </div>
  );
}

/** The Retired list, under the landings in Landed; newest 20, then Show All reads the rest. */
export function RetiredList(props: { root: string; view: RetirementView; onChanged?(): void }) {
  const v = () => props.view;
  const [all, setAll] = createSignal<RetiredRow[] | null>(null);
  const [showingAll, setShowingAll] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const retired = () => (showingAll() && all() ? all()! : v().retired);
  const showAll = async () => {
    setError(null);
    try {
      setAll((await fetchRetirement(props.root, true)).retired);
      setShowingAll(true);
    } catch (err) {
      setError(`Couldn't read every retired branch. ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  /** After a Restore: the rows are read again, the full list too when it's open. */
  const reread = () => {
    props.onChanged?.();
    if (showingAll()) void fetchRetirement(props.root, true).then((r) => setAll(r.retired), () => {});
  };
  return (
    <Show when={v().retiredTotal > 0}>
      <div class="stack-2" data-testid="mq-retired">
        <h3 class="text-heading-s">Retired · {v().retiredTotal}</h3>
        <ul class="list mq-list">
          <For each={retired()}>{(r) => <RetiredItem root={props.root} row={r} onRestored={reread} />}</For>
        </ul>
        <Show when={error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
        <Show when={!showingAll() && v().retiredTotal > v().retired.length}>
          <div class="button-row">
            <button type="button" class="button button-sm button-ghost" onClick={() => void showAll()}>
              Show All
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}

/**
 * Held and Retired as two plain sections, for a project the queue doesn't serve (§app.merge-queue/view): retirement
 * covers every listed project. `view` is the queue view's own copy, which its poll keeps fresh.
 */
export function RetirementLists(props: { projectId: string; root: string; view?: RetirementView; chatOf?: ChatOf; onChanged?(): void }) {
  return (
    <Show when={props.view}>
      {(v) => (
        <>
          <RetirementOff view={v()} />
          <Show when={heldHasContent(v())}>
            <div class="stack-2">
              <h3 class="text-heading-s">Held · {heldCount(v())}</h3>
              <HeldList projectId={props.projectId} view={v()} chatOf={props.chatOf} />
            </div>
          </Show>
          <RetiredList root={props.root} view={v()} onChanged={props.onChanged} />
        </>
      )}
    </Show>
  );
}

function HeldItem(props: { projectId: string; row: HeldRow; chatOf?: ChatOf }) {
  const r = () => props.row;
  return (
    <li class="list-row mq-row" data-branch={r().branch ?? r().path} data-state="held">
      <div class="list-main">
        <RowHead projectId={props.projectId} branch={r().branch ?? r().path} session={r().session?.id} chatOf={props.chatOf} />
        <p class="list-meta">{r().reason}</p>
      </div>
    </li>
  );
}

function RetiredItem(props: { root: string; row: RetiredRow; onRestored(): void }) {
  const r = () => props.row;
  const [busy, setBusy] = createSignal(false);
  const [refused, setRefused] = createSignal<string | null>(null);
  const restore = async () => {
    if (busy()) return;
    setBusy(true);
    setRefused(null);
    try {
      await restoreWorktree(props.root, { path: r().path, branch: r().branch, tip: r().tip });
      const done = `Restored ${r().branch}.`;
      toast(done);
      announce(done);
      props.onRestored();
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="list-row mq-row" data-branch={r().branch} data-state="retired">
      <div class="list-main">
        <p class="list-title mq-head-line">
          <span class="mq-branch text-mono">{r().branch}</span>
        </p>
        <p class="list-meta">Retired {relativeTime(r().at)}</p>
        <Show when={refused()}>{(m) => <p class="list-meta mq-retired-refused" role="alert">{m()}</p>}</Show>
      </div>
      <Show when={r().restorable}>
        <div class="button-row mq-row-act">
          <button type="button" class="button button-sm" aria-label={`Restore ${r().branch}`} disabled={busy()} aria-busy={busy() ? "true" : undefined} onClick={() => void restore()}>
            Restore
          </button>
        </div>
      </Show>
    </li>
  );
}
