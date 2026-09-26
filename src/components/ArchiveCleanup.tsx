import { createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionSummary } from "../../shared/protocol";
import { type CleanupResponse, type PathsCleanupRequest, cleanupSessions } from "../lib/api";
import { type CleanupRequest, cleanupCandidates, cleanupScope, sessionsWord, skippedText } from "../lib/archive";
import { relativeTime } from "../lib/format";
import { announce, toast } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";

/** Anything the cleanup endpoint accepts; `paths` is the delete-one-archived-session mode. */
type AnyCleanup = CleanupRequest | PathsCleanupRequest;

const ACTIONS: { req: CleanupRequest; label: string; name: string }[] = [
  { req: { mode: "age", minAgeDays: 7 }, label: "Older Than 7 Days", name: "Delete Sessions Older Than 7 Days" },
  { req: { mode: "age", minAgeDays: 30 }, label: "Older Than 30 Days", name: "Delete Sessions Older Than 30 Days" },
  { req: { mode: "husks" }, label: "Empty Sessions", name: "Delete Empty Sessions" },
];

const sameReq = (a: AnyCleanup, b: AnyCleanup): boolean => {
  if (a.mode !== b.mode) return false;
  if (a.mode === "age" && b.mode === "age") return a.minAgeDays === b.minAgeDays;
  if (a.mode === "paths" && b.mode === "paths") return a.paths.join("\n") === b.paths.join("\n");
  return true; // both husks
};

/**
 * The Archive's Clean Up… button: it opens a picker of
 * the actions; each asks the server for a dry run, confirms with its real numbers, then deletes and
 * refreshes the list. The picker also lists the Archive's own rows one at a time (the session list "Deleting one
 * session"), through the same dry-run-then-confirm flow.
 */
export function ArchiveCleanup(props: { sessions: SessionSummary[]; selected: string | null; onDeleted(): void }) {
  const [checking, setChecking] = createSignal<AnyCleanup | null>(null);
  const [preview, setPreview] = createSignal<{ req: AnyCleanup; result: CleanupResponse } | null>(null);
  const [picking, setPicking] = createSignal(false);
  let trigger!: HTMLButtonElement;

  /** Closes the picker first, so its focus goes back to Clean Up… and the next dialog returns it there too. */
  const closePicker = () => {
    setPicking(false);
    trigger.focus();
  };

  /** The rows the server will actually delete one of: the archive mark, and not open in a TUI. */
  const archived = () =>
    [...props.sessions]
      .filter((s) => s.archived && !s.live)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

  const check = async (req: AnyCleanup) => {
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

  const done = (result: CleanupResponse) => {
    setPreview(null);
    const skipped = skippedText(result);
    const refusals = result.refused?.length ? ` ${result.refused.map((r) => r.reason).join(" ")}` : "";
    const text = `Deleted ${sessionsWord(result.deletedCount)}.${skipped ? ` ${skipped}.` : ""}${refusals}`;
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
          <CleanupPicker
            checking={checking()}
            sessions={archived()}
            onPick={(req) => void check(req)}
            onCancel={() => !checking() && setPicking(false)}
          />
        </Portal>
      </Show>
      <Show when={preview()}>
        {(p) => (
          <Portal>
            <CleanupDialog
              req={p().req}
              preview={p().result}
              sessions={props.sessions}
              onCancel={() => setPreview(null)}
              onDone={done}
              onFailed={failed}
            />
          </Portal>
        )}
      </Show>
    </>
  );
}

/** Step one: which cleanup. Rows are plain buttons; every one is aria-disabled while a dry run checks. */
function CleanupPicker(props: { checking: AnyCleanup | null; sessions: SessionSummary[]; onPick(req: AnyCleanup): void; onCancel(): void }) {
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
          {/* One at a time: the Archive's own
              rows, newest first; only ones the server can delete. Hidden when there are none. */}
          <Show when={props.sessions.length > 0}>
            <p class="message-text cleanup-intro">Or pick one archived session to delete for good.</p>
            <ul class="list cleanup-choices">
              <For each={props.sessions}>
                {(s, i) => {
                  const busy = () => props.checking !== null && sameReq(props.checking, { mode: "paths", paths: [s.path] });
                  return (
                    <li>
                      <button
                        type="button"
                        class="list-row list-row-interactive cleanup-choice"
                        aria-label={`Delete “${s.title}”`}
                        aria-describedby={`cleanup-pick-one-${i()}`}
                        aria-disabled={props.checking ? "true" : undefined}
                        onClick={() => !props.checking && props.onPick({ mode: "paths", paths: [s.path] })}
                      >
                        <span class="list-main">
                          <span class="list-title">{s.title}</span>
                          <span class="list-meta" id={`cleanup-pick-one-${i()}`}>
                            {busy() ? "Checking…" : relativeTime(s.lastActiveAt)}
                          </span>
                        </span>
                        <Icon name="chevron-right" small />
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
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
  req: AnyCleanup;
  preview: CleanupResponse;
  sessions: SessionSummary[];
  onCancel(): void;
  onDone(result: CleanupResponse): void;
  onFailed(err: unknown): void;
}) {
  const n = () => cleanupCandidates(props.preview);
  const skipped = () => skippedText(props.preview);
  const [pending, setPending] = createSignal(false);
  let cancelButton!: HTMLButtonElement;
  // Destructive: focus starts on Cancel, never on Delete.
  onMount(() => cancelButton.focus());

  /** A refused or named path as the user knows it: the row's title, else the file's name. */
  const nameOf = (path: string): string => {
    const s = props.sessions.find((x) => x.path === path);
    return `“${s?.title ?? path.split("/").pop() ?? path}”`;
  };
  /** What the request targets; for `paths` the named session(s) themselves. */
  const scope = () => {
    if (props.req.mode !== "paths") return cleanupScope(props.req);
    const [one] = props.req.paths;
    return one !== undefined
      ? `One archived session: ${nameOf(one)}.`
      : `${props.req.paths.length} archived sessions.`;
  };

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
          <p class="message-text">{scope()}</p>
          <Show
            when={n() > 0}
            fallback={
              <p class="message-text">
                {props.preview.refused?.length ? "Nothing was deleted." : "Nothing matches right now, so nothing was changed."}
              </p>
            }
          >
            <p class="message-text">
              {props.req.mode === "paths" && props.req.paths.length === 1
                ? "This permanently deletes its transcript file — this can't be undone."
                : "This permanently deletes their transcript files — this can't be undone."}
            </p>
          </Show>
          <Show when={skipped()}>
            <p class="text-caption text-muted">{skipped()}. They stay as they are.</p>
          </Show>
          <For each={props.preview.refused ?? []}>
            {(r) => (
              <p class="text-caption text-muted">
                {nameOf(r.path)}: {r.reason}
              </p>
            )}
          </For>
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