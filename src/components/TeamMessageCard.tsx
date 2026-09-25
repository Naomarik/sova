import { createSignal, Show } from "solid-js";
import type { ReportInfo, TeamMessageInfo, TmpAttachment } from "../../shared/protocol";
import { clockTime } from "../lib/format";
import { teamMessageChip } from "../lib/report";
import { Markdown } from "./Markdown";
import { Chip, Icon } from "./ui";

/**
 * A coordinated team's message to the operator: the coordinator's report (a milestone or a
 * concern), or a member's question. The report row's grammar — collapsed to one line (who, the
 * team, a chip, the first line, the time), the markdown body once opened — plus one meta line
 * that says what the message asks of the reader. It starts nothing itself: never an input, a
 * timeline marker or an attention signal.
 */
export function TeamMessageCard(props: { report: ReportInfo; team: TeamMessageInfo; time?: string; attachments?: TmpAttachment[] }) {
  const [open, setOpen] = createSignal(false);
  const t = () => props.team;
  const chip = () => teamMessageChip(t());
  const time = () => (props.time ? clockTime(props.time) : "");
  return (
    <details class="disclosure report team-message" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary class="disclosure-summary report-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="visually-hidden">{t().kind === "question" ? "Team question from " : "Team report from "}</span>
        <span class="report-from">
          {t().role} · {t().workerId}
        </span>
        <span class="team-message-team" title={t().teamId}>
          <span aria-hidden="true">· </span>
          {t().teamName}
        </span>
        <Show when={chip()}>{(c) => <Chip tone={c().tone}>{c().label}</Chip>}</Show>
        <span class="disclosure-preview">{props.report.preview}</span>
        <Show when={time()}>
          <span class="team-message-time" title={props.time}>
            {time()}
          </span>
        </Show>
      </summary>
      <Show when={open()}>
        <div class="report-body">
          <Show when={props.report.body.trim()} fallback={<p class="report-meta">No text.</p>}>
            <Markdown text={props.report.body} attachments={props.attachments} />
          </Show>
          <Show when={props.report.truncated}>
            <p class="report-meta">Cut at 4,000 characters.</p>
          </Show>
          <p class="report-meta">
            {t().kind === "question"
              ? `This session's model answers it by steering ${t().workerId}, and the member continues from that answer.`
              : "Informational. The coordinator asks for nothing here; its questions arrive as team questions."}
          </p>
        </div>
      </Show>
    </details>
  );
}
