import { For, Show } from "solid-js";
import type { UsageResend } from "../../shared/usage/wire";
import { RESEND_EXPLAIN, resendReasonLine, resendReasons, resendSummary, resentAnything, resumedWords } from "../lib/resend";
import "../costs-tab.css";
import { Icon } from "./ui";

/**
 * What re-sending a conversation's history cost, beside its spend (§app.insights/usage-resend-display):
 * one line that opens, by tap, click or keyboard, to the reasons. Nothing when nothing was re-sent.
 * `spendUsd` is the spend the line sits beside (the re-sends are already inside it); `of` names it.
 */
export function ResendLine(props: { resend: UsageResend | undefined; spendUsd: number; of: string }) {
  return (
    <Show when={resentAnything(props.resend) ? props.resend : undefined}>
      {(r) => {
        const summary = () => resendSummary(r(), props.spendUsd, props.of);
        const resumed = () => resumedWords(r());
        return (
          <details class={summary().high ? "resend resend-high" : "resend"}>
            <summary class="resend-summary">
              <Icon name="chevron-right" small class="icon-twist" />
              <span class="resend-text">{summary().text}</span>
            </summary>
            <div class="resend-body">
              <p class="resend-explain">{RESEND_EXPLAIN}</p>
              <ul class="resend-reasons">
                <For each={resendReasons(r())}>{(reason) => <li>{resendReasonLine(reason)}</li>}</For>
              </ul>
              <Show when={resumed()}>{(words) => <p class="resend-explain">{words()}</p>}</Show>
            </div>
          </details>
        );
      }}
    </Show>
  );
}
