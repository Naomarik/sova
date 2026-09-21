import { createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionSummary } from "../../shared/protocol";
import { cleanupSessions } from "../lib/api";
import { type CleanupRequest, type CleanupResult, cleanupCandidates, cleanupScope, sessionsWord, skippedText } from "../lib/archive";
import { announce, toast } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";

const ACTIONS: { req: CleanupRequest; label: string; name: string }[] = [
  { req: { mode: "age", minAgeDays: 7 }, label: "Older Than 7 Days", name: "Delete Sessions Older Than 7 Days" },
  { req: { mode: "age", minAgeDays: 30 }, label: "Older Than 30 Days", name: "Delete Sessions Older Than 30 Days" },
  { req: { mode: "husks" }, label: "Empty Sessions", name: "Delete Empty Sessions" },
];

const sameReq = (a: CleanupRequest, b: CleanupRequest) =>
  a.mode === b.mode && (a.mode === "husks" || a.minAgeDays === (b as typeof a).minAgeDays);

/**
 * The Archive's Clean Up… button (spec/02-session-list.md §2 "Archive cleanup"): it opens a picker of the
 * actions; each asks the server for a dry run, confirms with its real numbers, then deletes and
 * refreshes the list.
 */
export function ArchiveCleanup(props: { sessions: SessionSummary[]; selected: string | null; onDeleted(): void }) {
  const [checking, setChecking] = createSignal<CleanupRequest | null>(null);
  const [preview, setPreview] = createSignal<{ req: CleanupRequest; result: CleanupResult } | null>(null);
  const [picking, setPicking] = createSignal(false);
  let trigger!: HTMLButtonElement;

  /** Closes the picker first, so its focus goes back to Clean Up… and the next dialog returns it there too. */
  const closePicker = () => {
    setPicking(false);
    trigger.focus();
  };

  const check = async (req: CleanupRequest) => {
    if (checking() || preview()) return;
    setChecking(req);
    try {
      const result = await cleanupSessions(req, true);
      closePicker();
      setPreview({ req, result });
    } catch (err) {
      closePicker();
      toast(`Couldn't check what to delete. Nothing was deleted. ${(err as Error).message}`);
    } finally {
      setChecking(null);
    }
  };

  const done = (result: CleanupResult) => {
    setPreview(null);
    const skipped = skippedText(result);
    const text = `Deleted ${sessionsWord(result.deletedCount)}.${skipped ? ` ${skipped}.` : ""}`;
    toast(text);
    announce(text);
    // The open session's file is gone: leave it rather than show a transcript that can't load.
    const open = props.sessions.find((s) => s.path === props.selected);
    if (open && result.deletedIds?.includes(open.id)) location.hash = "#/";
    props.onDeleted();
  };

  const failed = (err: unknown) => {
    setPreview(null);
    toast(`Couldn't delete sessions. Some may be gone; the list is refreshed. ${(err as Error).message}`);
    props.onDeleted();
  };

  return (
    <>
      <div class="archive-tools">
        <button
          ref={trigger}
          type="button"
          class="button button-sm button-ghost"
          aria-haspopup="dialog"
          aria-disabled={preview() ? "true" : undefined}
          onClick={() => !preview() && setPicking(true)}
        >
          Clean Up…
        </button>
      </div>
      <Show when={picking()}>
        <Portal>
          <CleanupPicker checking={checking()} onPick={(req) => void check(req)} onCancel={() => !checking() && setPicking(false)} />
        </Portal>
      </Show>
      <Show when={preview()}>
        {(p) => (
          <Portal>
            <CleanupDialog req={p().req} preview={p().result} onCancel={() => setPreview(null)} onDone={done} onFailed={failed} />
          </Portal>
        )}
      </Show>
    </>
  );
}

/** Step one: which cleanup. Rows are plain buttons; every one is aria-disabled while a dry run checks. */
function CleanupPicker(props: { checking: CleanupRequest | null; onPick(req: CleanupRequest): void; onCancel(): void }) {
  let first!: HTMLButtonElement;
  onMount(() => first.focus());

  return (
    <>
      <div class="scrim" onClick={() => props.onCancel()} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cleanup-pick-title"
        aria-describedby="cleanup-pick-body"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="cleanup-pick-title">
            Clean Up Archive
          </h2>
        </div>
        <div class="modal-body">
          <p class="message-text cleanup-intro" id="cleanup-pick-body">
            Pick what to delete. You'll see how many sessions match before anything is deleted.
          </p>
          <ul class="list cleanup-choices">
            <For each={ACTIONS}>
              {(a, i) => {
                const busy = () => props.checking !== null && sameReq(props.checking, a.req);
                return (
                  <li>
                    <button
                      ref={(el) => {
                        if (i() === 0) first = el;
                      }}
                      type="button"
                      class="list-row list-row-interactive cleanup-choice"
                      aria-label={a.name}
                      aria-describedby={`cleanup-pick-${i()}`}
                      aria-disabled={props.checking ? "true" : undefined}
                      onClick={() => !props.checking && props.onPick(a.req)}
                    >
                      <span class="list-main">
                        <span class="list-title">{a.label}</span>
                        <span class="list-meta" id={`cleanup-pick-${i()}`}>
                          {busy() ? "Checking…" : cleanupScope(a.req)}
                        </span>
                      </span>
                      <Icon name="chevron-right" small />
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" aria-disabled={props.checking ? "true" : undefined} onClick={() => props.onCancel()}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

function CleanupDialog(props: {
  req: CleanupRequest;
  preview: CleanupResult;
  onCancel(): void;
  onDone(result: CleanupResult): void;
  onFailed(err: unknown): void;
}) {
  const n = () => cleanupCandidates(props.preview);
  const skipped = () => skippedText(props.preview);
  const [pending, setPending] = createSignal(false);
  let cancelButton!: HTMLButtonElement;
  // Destructive: focus starts on Cancel, never on Delete.
  onMount(() => cancelButton.focus());

  const cancel = () => !pending() && props.onCancel();
  const confirm = async () => {
    if (pending()) return;
    setPending(true);
    try {
      props.onDone(await cleanupSessions(props.req, false));
    } catch (err) {
      props.onFailed(err);
    }
  };

  return (
    <>
      <div class="scrim" onClick={cancel} />
      <div
        class="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cleanup-title"
        aria-describedby="cleanup-body"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="cleanup-title">
            {n() > 0 ? `Delete ${sessionsWord(n())}?` : "0 sessions to delete."}
          </h2>
        </div>
        <div class="modal-body" id="cleanup-body">
          <p class="message-text">{cleanupScope(props.req)}</p>
          <Show when={n() > 0} fallback={<p class="message-text">Nothing matches right now, so nothing was changed.</p>}>
            <p class="message-text">This permanently deletes their transcript files — this can't be undone.</p>
          </Show>
          <Show when={skipped()}>
            <p class="text-caption text-muted">{skipped()}. They stay as they are.</p>
          </Show>
        </div>
        <div class="modal-foot">
          <Show when={n() > 0}>
            <button type="button" class="button button-destructive" aria-disabled={pending() ? "true" : undefined} onClick={() => void confirm()}>
              {pending() ? "Deleting…" : `Delete ${n() === 1 ? "Session" : `${n()} Sessions`}`}
            </button>
          </Show>
          <span class="modal-spacer" />
          <button ref={cancelButton} type="button" class="button button-ghost" aria-disabled={pending() ? "true" : undefined} onClick={cancel}>
            {n() > 0 ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </>
  );
}
