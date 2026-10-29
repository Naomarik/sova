// The action strip of a pending message of ours (§chat.transcript/a-queued-message): what ChatView hands
// Thread's queued row (`queueActions`), and the frame its Remove sends. DOM- and Solid-free.
import type { MessageActionItem } from "../components/MessageActions";
import type { LiveUserState } from "./live";
import { offersRemove } from "./live";
import { ACTION_LABEL, queueRemoveReason } from "./message-actions";

/** The `queue_remove` action a Remove sends, naming the item by the id the server knows it by. */
export function queueRemoveFrame(itemId: string): { type: "queue_remove"; itemId: string } {
  return { type: "queue_remove", itemId };
}

/**
 * A pending row's actions: one Remove while the server says it can still take it back (`Queued`, a steer
 * already handed to the agent included), none for a `Sending…` row (before the server's answer, or a
 * handed follow-up: Stop takes that back) or a row with no id (there is no truthful way to name it).
 */
export function queueRowActions(
  row: { id?: string; state: LiveUserState; text: string; handed?: boolean },
  o: { removing: readonly string[]; sharedQueue: readonly string[]; remove: (itemId: string) => void },
): MessageActionItem[] {
  const id = row.id;
  if (!id || !offersRemove(row)) return [];
  return [
    {
      kind: "remove",
      label: ACTION_LABEL.remove,
      reason: queueRemoveReason({ state: "queued", pending: o.removing.includes(id), chat: true, sharedQueue: o.sharedQueue.includes(id) }),
      run: () => o.remove(id),
    },
  ];
}
