import { For, Show } from "solid-js";
import type { DelegateOptions } from "../../shared/protocol";
import { effortSelectOptions, modelSelectOptions, slotIssue, withBackend, withModel, type BackendsInfo, type DraftChoice, type Slot } from "../lib/delegate-form";

/**
 * One worker row — backend, model, effort, and what the row has to say about the pick — shared by
 * Settings → Modes' Delegate profiles and its spec writer. The choices come from what each backend
 * actually offers; nothing here is free text. `idPrefix` keeps the rows' element ids unique;
 * `owner` names what reroutes a policy-denied pick ("Delegate").
 */
export function WorkerSlotRow(props: {
  idPrefix: string;
  slot: Slot;
  info: BackendsInfo;
  options: DelegateOptions | undefined;
  choice: DraftChoice;
  other: DraftChoice | null;
  disabled: boolean;
  owner?: string;
  /** What happens when the fallback can't run either (default "asks"). */
  otherwise?: string;
  /** A lone row (no fallback, no "Primary" label): its group's accessible name. */
  alone?: string;
  onChange(next: DraftChoice): void;
}) {
  const id = (part: string) => `${props.idPrefix}-${props.slot}-${part}`;
  const issue = () => slotIssue(props.info, props.options, props.choice, props.other, props.slot, props.owner, !props.alone, props.otherwise);
  const models = () => modelSelectOptions(props.options, props.choice);
  const efforts = () => effortSelectOptions(props.info, props.options, props.choice);
  const slotName = () => (props.slot === "primary" ? "Primary" : "Fallback");
  return (
    <div class="settings-delegate-slot" role="group" aria-label={props.alone ?? slotName()}>
      <Show when={props.slot === "primary" && !props.alone}>
        <span class="settings-delegate-slot-label">Primary</span>
      </Show>
      <div class="settings-delegate-fields">
        <div class="field">
          <label class="field-label" for={id("backend")}>
            Backend
          </label>
          <div class="select-wrap">
            <select
              class="select"
              id={id("backend")}
              disabled={props.disabled}
              onChange={(e) => props.onChange(withBackend(props.choice, e.currentTarget.value as DraftChoice["backend"]))}
            >
              <For each={props.info.backends}>
                {(b) => (
                  <option value={b.id} selected={b.id === props.choice.backend}>
                    {b.label}
                  </option>
                )}
              </For>
            </select>
            <span class="select-caret" aria-hidden="true">
              ▾
            </span>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for={id("model")}>
            Model
          </label>
          <div class="select-wrap">
            <select
              class="select text-mono"
              id={id("model")}
              disabled={props.disabled}
              aria-describedby={issue() ? id("issue") : undefined}
              onChange={(e) => props.onChange(withModel(props.choice, e.currentTarget.value, props.options))}
            >
              <Show when={!props.choice.model}>
                <option value="" selected disabled>
                  {props.options ? "Choose a model" : "Checking…"}
                </option>
              </Show>
              <For each={models()}>
                {(o) => (
                  <option value={o.value} selected={o.value === props.choice.model}>
                    {o.label}
                  </option>
                )}
              </For>
            </select>
            <span class="select-caret" aria-hidden="true">
              ▾
            </span>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for={id("effort")}>
            Effort
          </label>
          <div class="select-wrap">
            <select
              class="select"
              id={id("effort")}
              disabled={props.disabled || !props.choice.model}
              onChange={(e) => props.onChange({ ...props.choice, effort: e.currentTarget.value })}
            >
              <Show when={!props.choice.effort}>
                <option value="" selected disabled>
                  Choose
                </option>
              </Show>
              <For each={efforts()}>
                {(effort) => (
                  <option value={effort} selected={effort === props.choice.effort}>
                    {effort}
                  </option>
                )}
              </For>
            </select>
            <span class="select-caret" aria-hidden="true">
              ▾
            </span>
          </div>
        </div>
      </div>
      <Show when={issue()}>
        {(i) => (
          <p class={`settings-delegate-issue settings-delegate-issue-${i().tone}`} id={id("issue")}>
            {i().text}
          </p>
        )}
      </Show>
    </div>
  );
}

/** A reason as a sentence: closed with a period unless it already ends in one (or in "?"). */
export const sentence = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);

export const RetryButton = (props: { label: string; onClick(): void }) => (
  <button type="button" class="button button-sm" onClick={() => props.onClick()}>
    {props.label}
  </button>
);
