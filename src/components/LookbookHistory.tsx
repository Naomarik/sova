import { createMemo, For, Show } from "solid-js";
import { designDirectionLine } from "../../shared/design";
import type { LookbookHistoryRow } from "../../shared/lookbook-words";
import { versionLabel } from "../lib/design-frame";
import { historyLine, promptChanges } from "../lib/lookbook-history";
import { Stamp } from "./MessageRows";
import { Icon } from "./ui";

/**
 * One prompt item in the Creative Director's chat: a Full Prompt revision with what changed, a Start
 * with what each design got, a message to a design labelled by who sent it, a design made from others,
 * a stop, a removal or a restore. Folded to its line; open, the full text. Never a page's code.
 */
export function LookbookHistoryItem(props: { row: LookbookHistoryRow }) {
  const item = () => props.row.item;
  const line = createMemo(() => historyLine(item()));
  const changes = createMemo(() => (item().kind === "prompt" && props.row.prev !== undefined && item().text !== undefined ? promptChanges(props.row.prev, item().text!) : null));
  const opens = () => !!item().text || !!item().designs?.length || item().version !== undefined || !!item().still;
  return (
    <Show
      when={opens()}
      fallback={
        <div class="lookbook-item lookbook-item-line" role="note">
          <Icon name="info" small />
          <span class="disclosure-label">{line().title}</span>
          <Stamp iso={item().at} />
        </div>
      }
    >
      <details class="disclosure lookbook-item">
        <summary class="disclosure-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="disclosure-label">{line().title}</span>
          <Show when={line().preview}>
            <span class="disclosure-preview">{line().preview}</span>
          </Show>
          <Stamp iso={item().at} />
        </summary>
        <div class="disclosure-body lookbook-item-body">
          <Show when={item().recovered}>
            <p class="text-caption text-muted">Rebuilt from what this Lookbook kept: earlier steps weren't recorded.</p>
          </Show>
          <Show when={item().designs?.length}>
            <ul class="lookbook-item-designs">
              <For each={item().designs}>{(d) => <li>{`${d.label} · ${designDirectionLine(d)} · ${d.model}`}</li>}</For>
            </ul>
          </Show>
          <Show when={item().kind === "new" && (item().direction || item().model)}>
            <p class="text-caption text-muted">{[item().direction && designDirectionLine({ direction: item().direction!, layout: item().layout }), item().model].filter(Boolean).join(" · ")}</p>
          </Show>
          <Show when={changes()}>
            {(c) => (
              <Show when={c().length} fallback={<p class="text-caption text-muted">Only its spacing changed from the revision before.</p>}>
                <p class="text-caption text-muted">What changed from the revision before</p>
                <ul class="lookbook-changes" aria-label="What changed">
                  <For each={c()}>
                    {(x) => (
                      <li class={x.sign === "+" ? "lookbook-change-add" : "lookbook-change-del"}>
                        <span class="lookbook-change-sign" aria-label={x.sign === "+" ? "Added" : "Removed"}>
                          {x.sign}
                        </span>
                        <span>{x.line}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Show>
          <Show when={item().text}>
            {(text) => (
              <Show when={changes()} fallback={<div class="message-text">{text()}</div>}>
                <details class="disclosure">
                  <summary class="disclosure-summary">
                    <Icon name="chevron-right" small class="icon-twist" />
                    <span class="disclosure-label">The whole Full Prompt</span>
                  </summary>
                  <div class="disclosure-body message-text">{text()}</div>
                </details>
              </Show>
            )}
          </Show>
          <Show when={item().version !== undefined && item().label}>
            <p class="text-caption text-muted">{`Led to ${versionLabel(item().label!, item().version!)}.`}</p>
          </Show>
          <Show when={item().still}>{(s) => <p class="text-caption text-muted">{`Kept what it had written as a still (${s().chars.toLocaleString("en-US")} characters).`}</p>}</Show>
        </div>
      </details>
    </Show>
  );
}
