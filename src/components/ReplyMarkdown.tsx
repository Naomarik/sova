import { createMemo, Show } from "solid-js";
import type { TmpAttachment } from "../../shared/protocol";
import { splitWorkingNotes } from "../lib/markdown";
import { Markdown } from "./Markdown";
import { Icon } from "./ui";

/**
 * An assistant-text reply's body: its markdown, with the reply's working notes folded
 * (§chat.markdown/working-notes). The first `### Working notes` heading and everything after it
 * render as one closed disclosure; what comes before renders as any reply does. The disclosure
 * stays the same element while the reply streams, so once opened it stays open until the row is
 * drawn again, and it starts closed every time. Only assistant-text rows use this; every other
 * place Markdown draws shows the heading as an ordinary h3.
 */
export function ReplyMarkdown(props: { text: string; streaming?: boolean; attachments?: TmpAttachment[] }) {
  const split = createMemo(() => splitWorkingNotes(props.text));
  return (
    <>
      <Markdown text={split().top} streaming={props.streaming} attachments={props.attachments} />
      <Show when={split().notes !== undefined}>
        <details class="disclosure md-working-notes">
          <summary class="disclosure-summary">
            <Icon name="chevron-right" small class="icon-twist" />
            Working notes
          </summary>
          <div class="disclosure-body">
            <Markdown text={split().notes ?? ""} streaming={props.streaming} attachments={props.attachments} />
          </div>
        </details>
      </Show>
    </>
  );
}
