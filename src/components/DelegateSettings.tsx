import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { delegateDirty, delegateDraft as draft, setDelegateDraft as setDraft, setDelegateSaved } from "../lib/delegate-draft";
import type { DelegateOptions, DelegateProfileId, DelegateSettingsInfo } from "../../shared/protocol";
import { getDelegateOptions, getDelegateSettings, putDelegateSettings } from "../lib/api";
import {
  cloneSettings,
  draftComplete,
  draftConflicts,
  effortSelectOptions,
  fallbackFor,
  modelSelectOptions,
  sameSettings,
  slotIssue,
  withBackend,
  withModel,
  type DraftChoice,
  type Slot,
} from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import { announce, home } from "../lib/ui-state";
import { Banner } from "./ui";

/**
 * Settings → Modes → Delegate (spec/12-settings-dialog.md "Modes"): which worker — backend, model,
 * effort — each kind of Delegate work goes to, with an optional fallback. The choices come from
 * what each backend actually offers (GET …/delegate/options); nothing here is free text. The file
 * is global and shared with the terminal: chats already in Delegate use a save from their next
 * message, and chats in normal mode never read it.
 */
export function DelegateSettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getDelegateSettings);
  const [options, { refetch: refetchOptions }] = createResource(getDelegateOptions);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  /** The settings once loaded. A resource in its error state throws when read, so this never reads it then. */
  const loaded = (): DelegateSettingsInfo | undefined => (info.error ? undefined : info());

  // The saved routing, whenever it (re)loads. A draft kept from an earlier visit to this tab stays.
  createEffect(() => {
    const i = loaded();
    if (i) setDelegateSaved(i.settings);
  });

  /** The options as far as they are known: undefined while asking or when the request failed. */
  const known = (): DelegateOptions | undefined => (options.state === "ready" ? options() : undefined);
  const dirty = delegateDirty;
  const atDefaults = createMemo(() => {
    const d = draft();
    const i = loaded();
    return !!d && !!i && sameSettings(d, i.defaults);
  });
  const unlisted = createMemo(() => known()?.backends.filter((b) => b.models === null) ?? []);

  const update = (profile: DelegateProfileId, slot: Slot, next: DraftChoice | null) => {
    setSaveError(null);
    const copy = cloneSettings(draft()!);
    if (slot === "primary") copy.profiles[profile].primary = next!;
    else copy.profiles[profile].fallback = next;
    setDraft(copy);
  };

  const save = async () => {
    const d = draft();
    if (!d || !draftComplete(d) || draftConflicts(d).length > 0 || saving()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await putDelegateSettings(d);
      setInfo(result);
      setDelegateSaved(result.settings, { replaceDraft: true });
      setWarnings(result.warnings);
      announce("Delegate routing saved. Chats in Delegate use it from their next message.");
    } catch (err) {
      setSaveError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-delegate-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-delegate-title">
          Delegate
        </h3>
      </div>
      <p class="settings-intro">
        In Delegate the agent hands work to background workers and checks what they bring back. Pick the worker for
        each kind of work. Chats already in Delegate, here and in the terminal, use a change from their next message.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the Delegate settings."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>
      <Show when={options.loading}>
        <p class="settings-intro" role="status">
          Checking which models each backend offers…
        </p>
      </Show>
      <Show when={options.error}>
        <Banner
          tone="warn"
          title="Couldn't check which models are offered."
          body="Your saved choices stay, marked not verified."
          action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
        />
      </Show>
      <For each={unlisted()}>
        {(b) => (
          <Banner
            tone="warn"
            title={`${b.label} couldn't list its models.`}
            body={`${b.error ? `${sentence(b.error)} ` : ""}Choices on it stay as saved and read "not verified" — it isn't saying they're gone.`}
            action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
          />
        )}
      </For>

      <Show when={loaded() && draft()}>
        <For each={loaded()!.profiles}>
          {(profile) => (
            <fieldset class="settings-delegate-profile">
              <legend class="settings-delegate-legend">{profile.label}</legend>
              <p class="field-hint settings-delegate-desc">{profile.description}.</p>
              <SlotRow
                profile={profile.id}
                slot="primary"
                info={loaded()!}
                options={known()}
                choice={draft()!.profiles[profile.id].primary}
                other={draft()!.profiles[profile.id].fallback}
                disabled={saving()}
                onChange={(next) => update(profile.id, "primary", next)}
              />
              <label class="toggle toggle-switch settings-delegate-fallback-toggle">
                <span>Fallback</span>
                <input
                  type="checkbox"
                  checked={draft()!.profiles[profile.id].fallback !== null}
                  disabled={saving()}
                  onChange={(e) => update(profile.id, "fallback", fallbackFor(draft()!.profiles[profile.id].primary, e.currentTarget.checked))}
                />
                <span class="toggle-box" />
              </label>
              <Show
                when={draft()!.profiles[profile.id].fallback}
                fallback={<p class="field-hint">No fallback: if the primary can't run, the agent asks you which model to use.</p>}
              >
                {(fallback) => (
                  <SlotRow
                    profile={profile.id}
                    slot="fallback"
                    info={loaded()!}
                    options={known()}
                    choice={fallback()}
                    other={draft()!.profiles[profile.id].primary}
                    disabled={saving()}
                    onChange={(next) => update(profile.id, "fallback", next)}
                  />
                )}
              </Show>
            </fieldset>
          )}
        </For>

        <Show when={saveError()}>
          {(message) => <Banner tone="error" title="Couldn't save the routing." body={`${sentence(message())} Your saved routing is unchanged.`} />}
        </Show>
        <Show when={warnings().length > 0 && !dirty()}>
          <Banner tone="warn" title="Saved, with notes." body={warnings().map(sentence).join(" ")} />
        </Show>

        <div class="settings-delegate-actions">
          <button
            type="button"
            class="button button-ghost"
            disabled={saving() || atDefaults()}
            onClick={() => {
              setDraft(cloneSettings(loaded()!.defaults));
              setSaveError(null);
            }}
          >
            Reset to Defaults
          </button>
          <span class="modal-spacer" />
          <button
            type="button"
            class="button button-ghost"
            disabled={saving() || !dirty()}
            onClick={() => {
              setDraft(cloneSettings(loaded()!.settings));
              setSaveError(null);
            }}
          >
            Discard Changes
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={saving() || !dirty() || !draftComplete(draft()!) || draftConflicts(draft()!).length > 0}
            onClick={() => void save()}
          >
            {saving() ? "Saving…" : "Save Changes"}
          </button>
        </div>
        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>, shared with pi in the terminal.
        </p>
      </Show>
    </section>
  );
}

/** A reason as a sentence: closed with a period unless it already ends in one (or in "?"). */
const sentence = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);

const RetryButton = (props: { label: string; onClick(): void }) => (
  <button type="button" class="button button-sm" onClick={() => props.onClick()}>
    {props.label}
  </button>
);

/** One worker row: backend, model, effort, and what the row has to say about the pick. */
function SlotRow(props: {
  profile: DelegateProfileId;
  slot: Slot;
  info: DelegateSettingsInfo;
  options: DelegateOptions | undefined;
  choice: DraftChoice;
  other: DraftChoice | null;
  disabled: boolean;
  onChange(next: DraftChoice): void;
}) {
  const id = (part: string) => `delegate-${props.profile}-${props.slot}-${part}`;
  const issue = () => slotIssue(props.info, props.options, props.choice, props.other, props.slot);
  const models = () => modelSelectOptions(props.options, props.choice);
  const efforts = () => effortSelectOptions(props.info, props.options, props.choice);
  const slotName = () => (props.slot === "primary" ? "Primary" : "Fallback");
  return (
    <div class="settings-delegate-slot" role="group" aria-label={slotName()}>
      <Show when={props.slot === "primary"}>
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
