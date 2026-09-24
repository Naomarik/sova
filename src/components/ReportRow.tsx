import { createSignal, Show } from "solid-js";
import type { ReportInfo, TmpAttachment } from "../../shared/protocol";
import { tildePath } from "../lib/format";
import { reportChip, reportFrom } from "../lib/report";
import { home } from "../lib/ui-state";
import { Markdown } from "./Markdown";
import { Chip, Icon } from "./ui";

/** "claude-sonnet-4-6 · high · claude-code" — the model line's parts it actually has. */
function modelMeta(r: ReportInfo): string {
  return [r.model, r.effort, r.backend].filter(Boolean).join(" \u00b7 ");
}

/**
 * A subagent report, or another long extension message. Collapsed
 * to one line: who, a status chip, the first line. Opened, the body renders as markdown on the
 * left, capped at --measure; it's parsed only once opened.
 */
export function ReportRow(props: { report: ReportInfo; attachments?: TmpAttachment[] }) {
  const [open, setOpen] = createSignal(false);
  const r = () => props.report;
  const chip = () => reportChip(r());
  return (
    <details class="disclosure report" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary class="disclosure-summary report-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="visually-hidden">{r().agent ? "Report from " : "Message: "}</span>
        <span class="report-from">{reportFrom(r())}</span>
        <Show when={chip()}>{(c) => <Chip tone={c().tone}>{c().label}</Chip>}</Show>
        <Show when={r().preview}>
          <span class="disclosure-preview">{r().preview}</span>
        </Show>
      </summary>
      <Show when={open()}>
        <div class="report-body">
          <Show when={r().error}>
            <p class="report-error">Error: {r().error}</p>
          </Show>
          <Show when={r().session}>
            <p class="report-meta">
              Session <span class="text-mono">{tildePath(r().session!, home())}</span>
            </p>
          </Show>
          <Show when={r().model}>
            <p class="report-meta">
              <span class="text-mono">{modelMeta(r())}</span>
            </p>
          </Show>
          <Show when={r().body.trim()} fallback={<p class="report-meta">No output.</p>}>
            <Markdown text={r().body} attachments={props.attachments} />
          </Show>
          <Show when={r().truncated}>
            <p class="report-meta">Truncated at 4000 characters. Use agent_transcript for the rest.</p>
          </Show>
        </div>
      </Show>
    </details>
  );
}
