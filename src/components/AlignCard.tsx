import { createSignal, Show } from "solid-js";
import type { ReportInfo, TmpAttachment } from "../../shared/protocol";
import { alignChip, alignMetrics, type AlignInfo } from "../lib/align";
import { AlignView } from "./AlignView";
import { Chip, Icon } from "./ui";

/**
 * The align document's transcript row: one line (label, state chip, metrics) in the report-row
 * grammar. Activating it opens the read-only viewer; closing returns focus here.
 */
export function AlignCard(props: { report: ReportInfo; align: AlignInfo; attachments?: TmpAttachment[] }) {
  const [open, setOpen] = createSignal(false);
  const chip = () => alignChip(props.align);
  return (
    <div class="disclosure report align-card">
      <button type="button" class="disclosure-summary report-summary align-card-summary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="chevron-right" small />
        <span class="report-from">Alignment</span>
        <Chip tone={chip().tone}>{chip().label}</Chip>
        <span class="disclosure-preview">
          {[props.align.title, alignMetrics(props.align)].filter(Boolean).join(" · ")}
        </span>
      </button>
      <Show when={open()}>
        <AlignView report={props.report} align={props.align} attachments={props.attachments} onClose={() => setOpen(false)} />
      </Show>
    </div>
  );
}
