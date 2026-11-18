import { createEffect, createResource, createSignal, createUniqueId, on, onMount, Show } from "solid-js";
import type { VerbsChatView } from "../../shared/project-runtime";
import { ApiError, freshVerbsChat, getVerbsChat } from "../lib/api";
import { projectSessionHref } from "../lib/projects-route";
import { freshConfirmWords, VERBS_DIRTY_WHY, VERBS_WORKING_WHY } from "../lib/project-software";
import { announce, toast } from "../lib/ui-state";
import { trapFocus } from "./ui";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** The Project verbs chat's own Start Fresh (§app.project-runtime/onboard): what the head and the strip under it share. */
export interface VerbsChatControl {
  /** This session is its project's standing Project verbs chat: the chat as read. */
  chat(): VerbsChatView | null;
  /** Its turn runs (this tab's view first): Start Fresh waits. */
  working(): boolean;
}

/** Read for a project's coding session only, on open and whenever its turn starts or ends. */
export function createVerbsChatControl(o: { projectId: string; path: string; busy: () => boolean }): VerbsChatControl {
  const [status, { refetch }] = createResource(() => o.projectId, (pid) => getVerbsChat(pid).catch(() => null));
  createEffect(on(o.busy, () => void refetch(), { defer: true }));
  const chat = () => {
    const c = status()?.chat;
    return c && c.path === o.path ? c : null;
  };
  return { chat, working: () => !!chat() && (o.busy() || !!chat()!.working) };
}

/**
 * Start Fresh… in the Project verbs chat's head, as the Overseer's Clear sits in its own: disabled while it works
 * (the reason under the head, VerbsChatNote); pressed, the chat is read again, and edits not committed in its
 * worktree refuse it with their sentence; otherwise a confirm names what stays (its proposal, when its branch holds
 * commits), then Start Fresh archives it, starts a new one and opens it.
 */
export function VerbsChatFresh(props: { projectId: string; control: VerbsChatControl; describedBy: string }) {
  const [asking, setAsking] = createSignal<{ ahead: number; branch?: string } | null>(null);
  const [refused, setRefused] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const press = async () => {
    if (busy() || props.control.working()) return;
    setBusy(true);
    try {
      const now = (await getVerbsChat(props.projectId)).chat;
      if (!now) return void setRefused("This is no longer the project's Project verbs chat.");
      if (now.working) return void setRefused(VERBS_WORKING_WHY);
      if (now.dirty) return void setRefused(VERBS_DIRTY_WHY);
      setAsking({ ahead: now.ahead, ...(now.branch ? { branch: now.branch } : {}) });
    } catch (err) {
      setRefused(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const fresh = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      const out = await freshVerbsChat(props.projectId);
      const done = "Started a fresh Project verbs chat.";
      toast(done);
      announce(done);
      setAsking(null);
      if (out.path) location.hash = projectSessionHref(props.projectId, out.path);
    } catch (err) {
      setAsking(null);
      setRefused(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={props.control.chat()}>
      <button
        type="button"
        class="button button-sm button-ghost verbs-fresh"
        aria-haspopup="dialog"
        aria-disabled={props.control.working() || busy() ? "true" : undefined}
        aria-describedby={props.control.working() ? props.describedBy : undefined}
        title={props.control.working() ? VERBS_WORKING_WHY : "Archive this chat and start a new one"}
        onClick={() => void press()}
      >
        Start Fresh…
      </button>
      <Show when={asking()}>{(a) => <FreshDialog words={freshConfirmWords(a().ahead, a().branch)} busy={busy()} onCancel={() => setAsking(null)} onFresh={() => void fresh()} />}</Show>
      <Show when={refused()}>{(m) => <FreshDialog words={m()} busy={false} refused onCancel={() => setRefused(null)} />}</Show>
    </Show>
  );
}

/** While the chat works, under the head: why Start Fresh waits. */
export function VerbsChatNote(props: { control: VerbsChatControl; id: string }) {
  return (
    <Show when={props.control.working()}>
      <p class="text-caption text-muted verbs-fresh-why" id={props.id}>
        {VERBS_WORKING_WHY}
      </p>
    </Show>
  );
}

/** The confirm (Cancel / Start Fresh), or a refusal with Close. Focus starts on Cancel. */
function FreshDialog(props: { words: string; busy: boolean; refused?: boolean; onCancel(): void; onFresh?(): void }) {
  const titleId = createUniqueId();
  let cancel!: HTMLButtonElement;
  onMount(() => cancel.focus());
  const close = () => !props.busy && props.onCancel();
  return (
    <>
      <div class="scrim" onClick={close} />
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-body`} ref={(el) => trapFocus(el)} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            {props.refused ? "Can't start fresh yet" : "Start a fresh Project verbs chat?"}
          </h2>
        </div>
        <div class="modal-body">
          <p class="message-text" id={`${titleId}-body`}>
            {props.words}
          </p>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button ref={cancel} type="button" class="button button-ghost" aria-disabled={props.busy ? "true" : undefined} onClick={close}>
            {props.refused ? "Close" : "Cancel"}
          </button>
          <Show when={!props.refused}>
            <button type="button" class="button button-destructive" aria-disabled={props.busy ? "true" : undefined} onClick={() => !props.busy && props.onFresh?.()}>
              {props.busy ? "Starting…" : "Start Fresh"}
            </button>
          </Show>
        </div>
      </div>
    </>
  );
}
