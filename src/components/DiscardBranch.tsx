import { createSignal, For, onMount, Show } from "solid-js";
import type { DiscardBranchPreview } from "../../shared/merge-queue";
import { discardBranch } from "../lib/api";
import { discardConfirmWords, discardDoneToast, discardFileCount, discardPartialLine } from "../lib/discard-branch";
import { tildePath } from "../lib/format";
import { noteMergeChanged } from "../lib/merge-queue-client";
import { announce, home, toast } from "../lib/ui-state";
import { RemoveAnywayListing } from "./RemoveAnywayListing";

/** Which branch a row discards: its project, the branch and the tip the row shows. */
export interface DiscardTarget {
  project: string;
  branch: string;
  commit: string;
  /** The chat the list belongs to (its file): its own archive reads "This chat". */
  here?: string;
}

/** Partial stops by project and branch: a list refresh draws the row anew (a folder gone turns it into a branch-only
    row), and its line stays with it. Kept for this page's life. */
const [partials, setPartials] = createSignal<Record<string, string>>({});
const partialKey = (t: Pick<DiscardTarget, "project" | "branch">) => `${t.project}\n${t.branch}`;

/**
 * One row's Discard Branch…: the dry run (asked when the ▾ opens, so the menu item knows whether it may run), the
 * confirm's state, and the discard itself, which sends the dry run's digest so a change in between asks again.
 */
export function createDiscard(target: () => DiscardTarget | undefined, onChanged?: () => void) {
  const [preview, setPreview] = createSignal<DiscardBranchPreview | undefined>();
  const [checking, setChecking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** The discard was refused because its files changed: the confirm shows the new list and asks again. */
  const [changed, setChanged] = createSignal(false);
  /** A partial stop: what was done and what stayed, on the row. */
  const partial = () => {
    const t = target();
    return (t && partials()[partialKey(t)]) || null;
  };
  const setPartial = (line: string | null) => {
    const t = target();
    if (!t) return;
    const k = partialKey(t);
    setPartials(({ [k]: _, ...rest }) => (line ? { ...rest, [k]: line } : rest));
  };
  let asked = 0;

  /** The dry run, again: the menu item's reason and the confirm's list come from it. */
  const check = async () => {
    const t = target();
    if (!t) return;
    const n = ++asked;
    setChecking(true);
    try {
      const r = await discardBranch(t.project, { branch: t.branch, commit: t.commit, dryRun: true });
      if (n !== asked) return;
      if (r.kind === "preview") {
        setPreview(r.preview);
        setError(null);
      } else if (r.kind !== "result") setError(r.message);
    } catch (err) {
      if (n === asked) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (n === asked) setChecking(false);
    }
  };

  /** Discard, as the confirm showed it. Resolves true when the confirm should close. */
  const run = async (): Promise<boolean> => {
    const t = target();
    const p = preview();
    if (!t || !p || busy()) return false;
    setBusy(true);
    setError(null);
    try {
      const r = await discardBranch(t.project, { branch: t.branch, commit: t.commit, digest: p.digest });
      if (r.kind === "changed") {
        setChanged(true);
        announce(r.message);
        await check();
        return false;
      }
      if (r.kind === "refused") {
        setError(r.message);
        announce(`Discard Branch refused: ${r.message}`);
        void check();
        return false;
      }
      if (r.kind !== "result") return false;
      noteMergeChanged();
      onChanged?.();
      if (r.result.outcome === "discarded") {
        const done = discardDoneToast(p.branch, r.result.steps);
        toast(done);
        announce(done);
        setPartial(null);
      } else {
        const line = discardPartialLine(r.result.steps, { folder: !!p.folder, chat: !!p.chat });
        setPartial(line);
        toast(`Discard of ${p.branch} stopped. ${line}`);
        announce(`Discard of ${p.branch} stopped. ${line}`);
      }
      setChanged(false);
      setPreview(undefined);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** The confirm opens on the preview the menu fetched (asking again when none came yet). */
  const opened = () => {
    setChanged(false);
    if (!preview() && !checking()) void check();
  };
  /** Why it can't run now (the dry run's reason), for the menu item and the confirm. */
  const refused = () => preview()?.refused ?? null;
  return { preview, checking, busy, error, changed, partial, refused, check, run, opened, target };
}
export type Discard = ReturnType<typeof createDiscard>;

/** Discard Branch…'s confirm: what goes (from the dry run), what can't be brought back, Cancel then Discard Branch. */
export function DiscardConfirm(props: { discard: Discard; branch: string; onClose(back: boolean): void }) {
  const d = props.discard;
  let cancel: HTMLButtonElement | undefined;
  // Destructive: focus starts on Cancel.
  onMount(() => cancel?.focus());
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose(true);
  };
  const words = () => {
    const p = d.preview();
    const here = d.target()?.here;
    return p && discardConfirmWords(p, { here: !!p.chat && !!here && p.chat.path === here, folder: p.folder ? tildePath(p.folder, home()) : undefined });
  };
  const files = () => {
    const p = d.preview();
    return p?.files && discardFileCount(p) > 0 ? p.files : undefined;
  };
  return (
    <div class="wt-queue-confirm wt-discard-confirm" role="group" aria-label={`Discard ${props.branch}`} aria-busy={d.checking() ? "true" : undefined} on:keydown={onKey}>
      <p class="wt-queue-confirm-title">{`Discard ${props.branch}?`}</p>
      <Show when={d.changed()}>
        <p class="text-caption wt-queue-confirm-line" role="status">
          Its files changed since you looked, and nothing was deleted. This is what goes now.
        </p>
      </Show>
      <Show when={words()} fallback={<p class="text-caption wt-queue-confirm-line">{d.error() ?? "Checking what goes…"}</p>}>
        {(w) => (
          <Show when={!d.refused()} fallback={<p class="text-caption wt-queue-confirm-line">{d.refused()}</p>}>
            <ul class="wt-discard-parts" aria-label="What goes">
              <For each={w().parts}>
                {(p) => (
                  <li data-part={p.key}>
                    {p.text}
                    <Show when={p.code}>
                      {(c) => (
                        <>
                          {" "}
                          <code class="text-mono">{c()}</code>
                        </>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={files()}>{(f) => <RemoveAnywayListing listing={f()} home={home()} />}</Show>
            <p class="text-caption wt-queue-confirm-line wt-discard-warn">{w().line}</p>
          </Show>
        )}
      </Show>
      <Show when={d.error() && words()}>
        <p class="text-caption wt-queue-error" role="alert">
          {d.error()}
        </p>
      </Show>
      <div class="button-row wt-queue-confirm-act">
        <button type="button" class="button button-sm button-ghost" ref={(el) => (cancel = el)} onClick={() => props.onClose(true)}>
          Cancel
        </button>
        <button
          type="button"
          class="button button-sm button-destructive"
          data-discard=""
          disabled={!words() || !!d.refused() || d.busy() || d.checking()}
          aria-busy={d.busy() ? "true" : undefined}
          onClick={async () => {
            if (await d.run()) props.onClose(false);
          }}
        >
          Discard Branch
        </button>
      </div>
    </div>
  );
}
