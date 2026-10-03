import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { WorktreeCleanupKept, WorktreeCleanupPlan, WorktreeCleanupResult, WorktreesSummary } from "../../shared/protocol";
import { fetchWorktreesSummary, previewWorktreeCleanup, removeWorktrees } from "../lib/api";
import { tildePath } from "../lib/format";
import { announce, home, toast } from "../lib/ui-state";
import { branchFate, confirmBody, confirmTitle, doneText, doneTitle, offersCleanup, removeLabel, showsLine, summaryLine } from "../lib/worktree-cleanup";
import { trapFocus } from "./ui";

/**
 * A new session's worktrees line (§chat.transcript/empty-worktrees): "{total} worktrees · {merged}
 * merged" for the repository its folder is in, and `Clean Up Merged`, which previews with a dry run
 * and removes exactly what the user confirmed (§chat.worktrees/cleanup). Read when it appears and
 * after a removal; nothing polls. Outside the setup card, which never waits for it.
 */
export function EmptyWorktrees(props: { path: string }) {
  const [summary, setSummary] = createSignal<{ path: string; value: WorktreesSummary } | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [plan, setPlan] = createSignal<WorktreeCleanupPlan | null>(null);
  let button: HTMLButtonElement | undefined;

  const read = (path: string) => {
    fetchWorktreesSummary(path).then(
      // An answer for a session this no longer shows is dropped.
      (value) => props.path === path && setSummary({ path, value }),
      () => props.path === path && setSummary(null),
    );
  };
  createEffect(on(() => props.path, (path) => {
    setSummary(null);
    setPlan(null);
    read(path);
  }));

  const shown = () => {
    const s = summary();
    return s && s.path === props.path && showsLine(s.value) ? s.value : null;
  };

  const preview = async () => {
    if (checking() || plan()) return;
    setChecking(true);
    const path = props.path;
    try {
      const p = await previewWorktreeCleanup(path);
      if (props.path === path) setPlan(p);
    } catch (err) {
      toast(`Couldn't check which worktrees can go. Nothing was removed. ${(err as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  /** The dialog closed; the count is read again only when something was removed (or tried). */
  const closed = (attempted: boolean) => {
    setPlan(null);
    if (attempted) read(props.path);
    button?.focus();
  };

  return (
    <Show when={shown()}>
      {(s) => (
        <div class="empty-worktrees">
          <p class="empty-worktrees-line">{summaryLine(s())}</p>
          <Show when={offersCleanup(s())}>
            <button
              ref={button}
              type="button"
              class="button button-destructive"
              aria-haspopup="dialog"
              aria-disabled={checking() || plan() ? "true" : undefined}
              onClick={() => void preview()}
            >
              {checking() ? "Checking…" : "Clean Up Merged"}
            </button>
          </Show>
          <Show when={plan()}>
            {(p) => (
              <Portal>
                <CleanupDialog path={props.path} plan={p()} onClose={closed} />
              </Portal>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

function KeptRows(props: { rows: WorktreeCleanupKept[]; home: string | null }) {
  return (
    <ul class="worktree-cleanup-list">
      <For each={props.rows}>
        {(k) => (
          <li>
            <code class="worktree-cleanup-path">{tildePath(k.path, props.home)}</code>
            <span class="text-caption text-muted">{k.reason}</span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** The dry run's confirm; after it, the result in the same place until closed. */
function CleanupDialog(props: { path: string; plan: WorktreeCleanupPlan; onClose(attempted: boolean): void }) {
  const [pending, setPending] = createSignal(false);
  const [result, setResult] = createSignal<WorktreeCleanupResult | null>(null);
  let cancel!: HTMLButtonElement;
  // Destructive: focus starts on Cancel, never on Remove.
  onMount(() => cancel.focus());
  const n = () => props.plan.remove.length;
  /** Paths with `~`: the server's home, else the one the app found. */
  const homeDir = () => props.plan.home ?? home();

  const close = () => !pending() && props.onClose(result() !== null);
  const confirm = async () => {
    if (pending() || n() === 0) return;
    setPending(true);
    try {
      // Exactly the previewed paths: a tree that changed since is kept, never removed.
      const r = await removeWorktrees(props.path, props.plan.remove.map((x) => x.path));
      setResult(r);
      const text = doneText(r.removed.length, r.kept.length + props.plan.keep.length);
      toast(text);
      announce(text);
    } catch (err) {
      toast(`Couldn't remove worktrees. Some may be gone; the count is read again. ${(err as Error).message}`);
      setPending(false);
      props.onClose(true);
      return;
    }
    setPending(false);
    cancel.focus();
  };

  return (
    <>
      <div class="scrim" onClick={close} />
      <div
        class="modal worktree-cleanup"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="worktree-cleanup-title"
        aria-describedby="worktree-cleanup-body"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="worktree-cleanup-title">
            {result() ? doneTitle(result()!.removed.length, result()!.kept.length + props.plan.keep.length) : confirmTitle(n())}
          </h2>
        </div>
        <div class="modal-body" id="worktree-cleanup-body">
          <Show
            when={result()}
            fallback={
              <>
                <p class="message-text">{confirmBody(n(), props.plan.mainBranch)}</p>
                <Show when={n() > 0}>
                  <section aria-label={`Goes · ${n()}`}>
                    <h3 class="text-eyebrow">Goes · {n()}</h3>
                    <ul class="worktree-cleanup-list">
                      <For each={props.plan.remove}>
                        {(r) => (
                          <li>
                            <code class="worktree-cleanup-path">{tildePath(r.path, homeDir())}</code>
                            <Show when={branchFate(r)}>
                              <span class="text-caption text-muted">{branchFate(r)}</span>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>
                <Show when={props.plan.keep.length > 0}>
                  <section aria-label={`Stays · ${props.plan.keep.length}`}>
                    <h3 class="text-eyebrow">Stays · {props.plan.keep.length}</h3>
                    <KeptRows rows={props.plan.keep} home={homeDir()} />
                  </section>
                </Show>
              </>
            }
          >
            {(r) => (
              <Show when={r().kept.length + props.plan.keep.length > 0}>
                <section aria-label="Kept">
                  <h3 class="text-eyebrow">Stays · {r().kept.length + props.plan.keep.length}</h3>
                  <KeptRows rows={[...r().kept, ...props.plan.keep]} home={homeDir()} />
                </section>
              </Show>
            )}
          </Show>
        </div>
        <div class="modal-foot">
          <Show when={!result() && n() > 0}>
            <button type="button" class="button button-destructive" aria-disabled={pending() ? "true" : undefined} onClick={() => void confirm()}>
              {pending() ? "Removing…" : removeLabel(n())}
            </button>
          </Show>
          <span class="modal-spacer" />
          <button ref={cancel} type="button" class="button button-ghost" aria-disabled={pending() ? "true" : undefined} onClick={close}>
            {!result() && n() > 0 ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </>
  );
}
