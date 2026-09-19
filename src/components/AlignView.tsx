import { onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { ReportInfo, TmpAttachment } from "../../shared/protocol";
import { alignChip, alignMetrics, type AlignInfo } from "../lib/align";
import { Markdown } from "./Markdown";
import { Chip, Icon, trapFocus } from "./ui";
import "../design/align-viewer.css";

let seq = 0;

/**
 * The align document, read-only, as a modal over the chat. Checklist items render as disabled
 * checkboxes (Markdown). Esc, the scrim or Close dismisses it; trapFocus hands focus back to
 * whatever opened it. Nothing here edits the document.
 */
export function AlignView(props: { report: ReportInfo; align: AlignInfo; attachments?: TmpAttachment[]; onClose(): void }) {
  const titleId = `align-title-${++seq}`;
  const chip = () => alignChip(props.align);
  let close!: HTMLButtonElement;
  onMount(() => close.focus());

  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal align-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onClose();
        }}
      >
        <div class="modal-head align-viewer-head">
          <div class="align-viewer-titles">
            <h2 class="modal-title" id={titleId}>
              {props.align.title ? `Alignment: ${props.align.title}` : "Alignment"}
            </h2>
            <p class="align-status">
              <Chip tone={chip().tone}>{chip().label}</Chip>
              <span class="align-metrics">
                {alignMetrics(props.align)}
                {props.align.revision > 0 ? ` · revision ${props.align.revision}` : ""}
              </span>
            </p>
          </div>
          <button type="button" class="button button-icon button-ghost" aria-label="Close" title="Close" ref={close} onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body align-viewer-body" tabindex="0" aria-label="Alignment document">
          <Markdown text={props.report.body} attachments={props.attachments} />
        </div>
      </div>
    </Portal>
  );
}
