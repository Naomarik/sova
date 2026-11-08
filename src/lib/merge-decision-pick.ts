// Which decision a choice button answered (§chat.merge-queue/decision): a choice on a decision card stages its words in
// the chat's message box and remembers the decision here, per chat, so the send names that decision, not the newest one.
// Kept until the message is sent or the message box is emptied.
import { createSignal } from "solid-js";

const [picks, setPicks] = createSignal<Record<string, string>>({});

/** A choice on decision `id` was put in chat `session`'s message box. */
export const pickDecision = (session: string, id: string): void => void setPicks((p) => ({ ...p, [session]: id }));
/** The decision a chat's staged choice answers, if any. */
export const pickedDecision = (session: string | undefined): string | undefined => (session ? picks()[session] : undefined);
/** Sent, or the message box emptied: the pick is gone. */
export const clearPick = (session: string | undefined): void => {
  if (session && picks()[session]) setPicks(({ [session]: _, ...rest }) => rest);
};
