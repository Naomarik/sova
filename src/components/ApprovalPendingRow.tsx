import { createSignal, Show } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import { decideInChat } from "../lib/api";
import { toast } from "../lib/ui-state";
import { Icon } from "./ui";

/** What the line says once decided here. */
const DONE = { approved: "Approved. It loads at the agent's next step here.", disallowed: "Disallowed. It stays out." } as const;

/**
 * A context file or skill this chat came across after its first message, kept out of its fixed list
 * (§chat.context-approval/mid-chat). Never sent to the model. Approve (the operator's page) adds it to
 * the folder's list and loads it in this chat at the agent's next step there; Disallow keeps it out.
 */
export function ApprovalPendingRow(props: { item: NonNullable<TranscriptItem["approvalPending"]>; text: string; /** The chat's own session path; absent outside a chat (no buttons then). */ path?: string }) {
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal<"approved" | "disallowed" | null>(null);
  const name = () => props.item.name ?? props.item.path.split("/").pop() ?? props.item.path;
  const decide = (state: "approved" | "disallowed") => {
    const path = props.path;
    if (busy() || !path) return;
    setBusy(true);
    decideInChat(path, props.item.kind, props.item.path, state)
      .then(() => setDone(state))
      .catch((err: Error) => toast(`Couldn't save ${name()}. ${err.message}`))
      .finally(() => setBusy(false));
  };
  return (
    <div class="info-row approval-pending-row" role="note" title={props.item.path}>
      <span class="info-row-text">
        <Icon name="info" small />
        <span>{props.text || `${name()} wasn't loaded: it isn't approved for this folder.`}</span>
        <Show when={!done()} fallback={<span class="approval-pending-done">{DONE[done()!]}</span>}>
          <Show when={props.path}>
            <span class="approval-pending-actions">
              <button type="button" class="button button-sm" aria-label={`Approve ${name()}`} aria-disabled={busy() ? "true" : undefined} onClick={() => decide("approved")}>
                Approve
              </button>
              <button type="button" class="button button-sm" aria-label={`Disallow ${name()}`} aria-disabled={busy() ? "true" : undefined} onClick={() => decide("disallowed")}>
                Disallow
              </button>
            </span>
          </Show>
        </Show>
      </span>
    </div>
  );
}
