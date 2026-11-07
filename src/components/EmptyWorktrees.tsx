import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { WorktreeCleanupKept, WorktreeCleanupPlan, WorktreeCleanupResult, WorktreesSummary } from "../../shared/protocol";
import { fetchWorktreesSummary, previewWorktreeCleanup, removeWorktreeAnyway, removeWorktrees } from "../lib/api";
import { tildePath } from "../lib/format";
import { announce, home, toast } from "../lib/ui-state";
import {
  anywayBody,
  anywayDone,
  anywayHeading,
  anywayLabel,
  anywayMore,
  anywayTitle,
  branchFate,
  confirmBody,
  confirmTitle,
  doneText,
  doneTitle,
  nestedLine,
  offersCleanup,
  removeLabel,
  showsLine,
  summaryLine,
} from "../lib/worktree-cleanup";
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

/** The kept rows; one kept only for what it holds offers Remove Anyway (`onAnyway`, before a removal only). */
function KeptRows(props: { rows: WorktreeCleanupKept[]; home: string | null; onAnyway?: (k: WorktreeCleanupKept) => void }) {
  return (
    <ul class="worktree-cleanup-list">
      <For each={props.rows}>
        {(k) => (
          <li>
            <code class="worktree-cleanup-path">{tildePath(k.path, props.home)}</code>
            <span class="text-caption text-muted">{k.reason}</span>
            <Show when={props.onAnyway && k.removeAnyway}>
              <button type="button" class="button button-sm button-destructive worktree-cleanup-anyway" aria-haspopup="dialog" onClick={() => props.onAnyway!(k)}>
                Remove Anyway
              </button>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

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

/** The dry run's confirm; after it, the result in the same place until closed. */
function CleanupDialog(props: { path: string; plan: WorktreeCleanupPlan; onClose(attempted: boolean): void }) {
  const [pending, setPending] = createSignal(false);
  const [result, setResult] = createSignal<WorktreeCleanupResult | null>(null);
  // The kept rows: a tree Remove Anyway took leaves them, one it couldn't take shows its new reason.
  const [keep, setKeep] = createSignal(props.plan.keep);
  // The tree whose listing is open (Remove Anyway), and whether anything was removed that way.
  const [anyway, setAnyway] = createSignal<WorktreeCleanupKept | null>(null);
  const [took, setTook] = createSignal(false);
  let cancel!: HTMLButtonElement;
  let back: HTMLButtonElement | undefined;
  // Destructive: focus starts on Cancel, never on Remove.
  onMount(() => cancel.focus());
  const n = () => props.plan.remove.length;
  /** Paths with `~`: the server's home, else the one the app found. */
  const homeDir = () => props.plan.home ?? home();

  const close = () => {
    if (pending()) return;
    if (anyway()) return leaveAnyway();
    props.onClose(result() !== null || took());
  };
  const openAnyway = (k: WorktreeCleanupKept) => {
    setAnyway(k);
    queueMicrotask(() => back?.focus());
  };
  const leaveAnyway = () => {
    setAnyway(null);
    queueMicrotask(() => cancel.focus());
  };
  /** Remove Anyway, confirmed: exactly the listing shown; a tree whose contents changed since stays. */
  const confirmAnyway = async () => {
    const k = anyway();
    if (pending() || !k?.removeAnyway) return;
    setPending(true);
    try {
      const r = await removeWorktreeAnyway(props.path, k.path, k.removeAnyway.digest);
      setTook(true);
      if (r.removed.some((x) => x.path === k.path)) {
        setKeep((rows) => rows.filter((x) => x.path !== k.path));
        const text = anywayDone(tildePath(k.path, homeDir()));
        toast(text);
        announce(text);
      } else {
        const why = r.kept.find((x) => x.path === k.path)?.reason ?? "It wasn't removed.";
        setKeep((rows) => rows.map((x) => (x.path === k.path ? { path: x.path, ...(x.branch ? { branch: x.branch } : {}), reason: why } : x)));
        toast(why);
        announce(why);
      }
    } catch (err) {
      toast(`Couldn't remove ${tildePath(k.path, homeDir())}. It may be gone; the count is read again. ${(err as Error).message}`);
      setTook(true);
    }
    setPending(false);
    leaveAnyway();
  };
  const confirm = async () => {
    if (pending() || n() === 0) return;
    setPending(true);
    try {
      // Exactly the previewed paths: a tree that changed since is kept, never removed.
      const r = await removeWorktrees(props.path, props.plan.remove.map((x) => x.path));
      setResult(r);
      const text = doneText(r.removed.length, r.kept.length + keep().length);
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
            {anyway() ? anywayTitle(tildePath(anyway()!.path, homeDir())) : result() ? doneTitle(result()!.removed.length, result()!.kept.length + keep().length) : confirmTitle(n())}
          </h2>
        </div>
        <div class="modal-body" id="worktree-cleanup-body">
          <Show when={anyway()?.removeAnyway}>
            {(a) => (
              <>
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
                            <span class="text-caption text-muted">{nestedLine(r.of ? { ...r, of: tildePath(r.of, homeDir()) } : r)}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={anywayMore(a().nested.length, a().counts.nested)}>{(m) => <p class="text-caption text-muted">{m()}</p>}</Show>
                  </section>
                </Show>
                <AnywayList label="Rebuildable, also goes" rows={a().rebuildable} total={a().counts.rebuildable} />
              </>
            )}
          </Show>
          <Show when={!anyway()}>
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
                <Show when={keep().length > 0}>
                  <section aria-label={`Stays · ${keep().length}`}>
                    <h3 class="text-eyebrow">Stays · {keep().length}</h3>
                    <KeptRows rows={keep()} home={homeDir()} onAnyway={openAnyway} />
                  </section>
                </Show>
              </>
            }
          >
            {(r) => (
              <Show when={r().kept.length + keep().length > 0}>
                <section aria-label="Kept">
                  <h3 class="text-eyebrow">Stays · {r().kept.length + keep().length}</h3>
                  <KeptRows rows={[...r().kept, ...keep()]} home={homeDir()} />
                </section>
              </Show>
            )}
          </Show>
          </Show>
        </div>
        <Show when={anyway()?.removeAnyway}>
          {(_a) => (
            <div class="modal-foot">
              <button type="button" class="button button-destructive" aria-disabled={pending() ? "true" : undefined} onClick={() => void confirmAnyway()}>
                {pending() ? "Removing…" : anywayLabel}
              </button>
              <span class="modal-spacer" />
              <button ref={back} type="button" class="button button-ghost" aria-disabled={pending() ? "true" : undefined} onClick={() => !pending() && leaveAnyway()}>
                Back
              </button>
            </div>
          )}
        </Show>
        <Show when={!anyway()}>
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
        </Show>
      </div>
    </>
  );
}
