import { createEffect, createMemo, createResource, For, Show } from "solid-js";
import {
  delegateDirty,
  delegateDraft as draft,
  delegateSaveError,
  delegateSaving as saving,
  delegateWarnings as warnings,
  setDelegateDraft as setDraft,
  setDelegateSaved,
} from "../lib/delegate-draft";
import type { DelegateOptions, DelegateProfileId, DelegateSettingsInfo } from "../../shared/protocol";
import { getDelegateOptions, getDelegateSettings } from "../lib/api";
import { cloneSettings, fallbackFor, sameSettings, type DraftChoice, type Slot } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { Banner } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

/**
 * Settings → Modes → Delegate: which worker — backend, model,
 * effort — each kind of Delegate work goes to, with an optional fallback. The choices come from
 * what each backend actually offers (GET …/delegate/options); nothing here is free text. The file
 * is global and shared with the terminal: chats already in Delegate use a save from their next
 * message, and chats in normal mode never read it. Saved by the dialog's footer (delegate-draft.ts
 * holds the save, its error and its notes, so they outlive this tab).
 */
export function DelegateSettingsSection() {
  const [info, { refetch: refetchInfo }] = createResource(getDelegateSettings);
  const [options, { refetch: refetchOptions }] = createResource(getDelegateOptions);
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
    const copy = cloneSettings(draft()!);
    if (slot === "primary") copy.profiles[profile].primary = next!;
    else copy.profiles[profile].fallback = next;
    setDraft(copy);
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-delegate-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-delegate-title">
          Delegate
        </h3>
        <Show when={loaded() && draft()}>
          <button type="button" class="button button-sm button-ghost" disabled={saving() || atDefaults()} onClick={() => setDraft(cloneSettings(loaded()!.defaults))}>
            Reset to Defaults
          </button>
        </Show>
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
              <WorkerSlotRow
                idPrefix={`delegate-${profile.id}`}
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
                  <WorkerSlotRow
                    idPrefix={`delegate-${profile.id}`}
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

        <Show when={delegateSaveError()}>
          {(e) => <Banner tone="error" title="Couldn't save the routing." body={`${sentence(e().message)} Your saved routing is unchanged.`} />}
        </Show>
        <Show when={warnings().length > 0 && !dirty()}>
          <Banner tone="warn" title="Saved, with notes." body={warnings().map(sentence).join(" ")} />
        </Show>
        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>, shared with pi in the terminal.
        </p>
      </Show>
    </section>
  );
}
