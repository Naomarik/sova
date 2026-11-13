import { createSignal, Show } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import { decideInChat, getFolderApprovals } from "../lib/api";
import { chatQueue, inOrder } from "../lib/approval-overlay";
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
  const [done, setDone] = createSignal<"approved" | "disallowed" | null>(null);
  const name = () => props.item.name ?? props.item.path.split("/").pop() ?? props.item.path;
  // The chat's folder queue, read while the line is drawn, so a click queues at once. A click in the
  // first moment, before that read answers, queues when it does: a click on another surface in that
  // moment may go first.
  const queue = () => (props.path ? chatQueue(props.path, getFolderApprovals) : null);
  void queue();
  // The line says the decision at the click; the save runs behind it, in click order with the
  // folder's other saves (its project page, a new chat's list), and a refusal or failure brings the
  // buttons back with its toast. One that answers after its time says itself after all.
  const decide = (state: "approved" | "disallowed") => {
    const path = props.path;
    const q = queue();
    if (done() || !path || !q) return;
    setDone(state);
    void q
      .then((key) => inOrder(key, () => decideInChat(path, props.item.kind, props.item.path, state), { late: (ok) => ok && setDone(state) }))
      .catch((err: Error) => {
        setDone(null);
        toast(`Couldn't save ${name()}. ${err.message}`);
      });
  };
  return (
    <div class="info-row approval-pending-row" role="note" title={props.item.path}>
      <span class="info-row-text">
        <Icon name="info" small />
        <span>{props.text || `${name()} wasn't loaded: it isn't approved for this folder.`}</span>
        <Show when={!done()} fallback={<span class="approval-pending-done">{DONE[done()!]}</span>}>
          <Show when={props.path}>
            <span class="approval-pending-actions">
              <button type="button" class="button button-sm" aria-label={`Approve ${name()}`} onClick={() => decide("approved")}>
                Approve
              </button>
              <button type="button" class="button button-sm" aria-label={`Disallow ${name()}`} onClick={() => decide("disallowed")}>
                Disallow
              </button>
            </span>
          </Show>
        </Show>
      </span>
    </div>
  );
}
