import { createSignal, Show } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import { decideInChat, getFolderApprovals } from "../lib/api";
import { chatQueue, inOrder } from "../lib/approval-overlay";
import { offInChatLine, TURN_ON, TURNED_ON_LINE } from "../lib/approvals";
import { toast } from "../lib/ui-state";
import { Icon } from "./ui";

/**
 * A context file or skill this chat came across after its first message, kept out of its fixed list
 * because it is off for the folder (§chat.context-approval/mid-chat). Never sent to the model. Turn On
 * (the operator's page) turns it on for the folder and loads it in this chat at the agent's next step
 * there. Nothing else needs deciding: it is already off.
 */
export function ApprovalPendingRow(props: { item: NonNullable<TranscriptItem["approvalPending"]>; text: string; /** The chat's own session path; absent outside a chat (no button then). */ path?: string }) {
  const [done, setDone] = createSignal(false);
  const name = () => props.item.name ?? props.item.path.split("/").pop() ?? props.item.path;
  // The chat's folder queue, read while the line is drawn, so a click queues at once. A click in the
  // first moment, before that read answers, queues when it does: a click on another surface in that
  // moment may go first.
  const queue = () => (props.path ? chatQueue(props.path, getFolderApprovals) : null);
  // The same read says whose list it is (a project's queue key starts "p:", a folder's "d:"), so the line
  // names it; until then, and outside a chat, the transcript's own words ("this folder").
  const [folder, setFolder] = createSignal<"project" | "folder" | null>(null);
  void queue()?.then((key) => setFolder(key.startsWith("p:") ? "project" : key.startsWith("d:") ? "folder" : null));
  const what = () => (props.item.kind === "skill" ? `The skill ${props.item.name ?? props.item.path}` : (props.item.name ?? props.item.path));
  const line = () => {
    const f = folder();
    return f ? offInChatLine(what(), f) : props.text || offInChatLine(what(), "folder");
  };
  // The line says it at the click; the save runs behind it, in click order with the folder's other
  // saves (its project page, a new chat's list), and a refusal or failure brings the button back
  // with its toast. One that answers after its time says itself after all.
  const turnOn = () => {
    const path = props.path;
    const q = queue();
    if (done() || !path || !q) return;
    setDone(true);
    void q
      .then((key) => inOrder(key, () => decideInChat(path, props.item.kind, props.item.path, "approved"), { late: (ok) => ok && setDone(true) }))
      .catch((err: Error) => {
        setDone(false);
        toast(`Couldn't turn on ${name()}. ${err.message}`);
      });
  };
  return (
    <div class="info-row approval-pending-row" role="note" title={props.item.path}>
      <span class="info-row-text">
        <Icon name="info" small />
        <span>{line()}</span>
        <Show when={!done()} fallback={<span class="approval-pending-done">{TURNED_ON_LINE}</span>}>
          <Show when={props.path}>
            <span class="approval-pending-actions">
              <button type="button" class="button button-sm" aria-label={`${TURN_ON} ${name()}`} onClick={turnOn}>
                {TURN_ON}
              </button>
            </span>
          </Show>
        </Show>
      </span>
    </div>
  );
}
