import { Show } from "solid-js";
import type { WakeInfo } from "../../shared/wake";
import { wakeTitle } from "../../shared/wake";
import { clockTime } from "../lib/format";
import { Icon } from "./ui";

/** A fired wake-nudge, reusing the `.toolcard` shell (ToolCard.tsx): a machine row, not a "You"
    bubble, even though pi sees it as a real user message. Collapsed by default; the body shows
    the message exactly as sent — never rewritten or hidden. */
export function WakeCard(props: { nudge: WakeInfo; text: string; time?: string }) {
  const reason = () => props.nudge.reason ?? "";
  const fired = () => (props.time ? clockTime(props.time) : "");

  return (
    <details class="toolcard">
      <summary class="toolcard-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <Icon name="bell" small />
        <span class="toolcard-name">
          {wakeTitle(props.nudge)}
        </span>
        <span class="toolcard-arg" title={reason() || undefined}>
          {reason()}
        </span>
        <Show when={fired()}>
          <span class="toolcard-wake-time">
            fired {fired()}
            <Show when={props.nudge.late}>{` · ${props.nudge.late} late`}</Show>
          </span>
        </Show>
      </summary>
      <div class="toolcard-body">
        <div class="toolcard-section">
          <pre class="toolcard-output">{props.text}</pre>
        </div>
      </div>
    </details>
  );
}
