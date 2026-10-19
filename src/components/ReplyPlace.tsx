import { Show } from "solid-js";
import { stripLabel, type MessageStrip } from "../lib/message-actions";
import { addedFor, builtInItems, slotPolicy, type ReplyPlace } from "../lib/reply-place";
import { MessageActions } from "./MessageActions";
import { ReplySlot } from "./ReplySlot";

/**
 * The reply place under one delivered message (src/lib/reply-place.ts): Sova's built-ins as the
 * message-actions strip, exactly as it was drawn before the place existed, then what extensions add
 * under a reply. With nothing added the second lane draws nothing at all.
 */
export function ReplyPlaceView(props: { place: ReplyPlace; strip: MessageStrip }) {
  return (
    <>
      <MessageActions
        label={stripLabel(props.strip.role)}
        align={props.strip.role === "user" ? "end" : "start"}
        items={builtInItems(props.place, props.strip)}
        note={props.place.note?.(props.strip.entryId) ?? null}
      />
      <Show when={addedFor(props.place, props.strip)}>
        {(state) => <ReplySlot state={state()} policy={slotPolicy} run={(chip) => props.place.runChip?.(chip, props.strip.entryId) ?? Promise.resolve("Nothing to run.")} />}
      </Show>
    </>
  );
}
