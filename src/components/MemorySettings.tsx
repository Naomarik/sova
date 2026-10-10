import { createEffect, createResource, For, on, Show } from "solid-js";
import type { MemorySettingsInfo } from "../../shared/protocol";
import { getMemoryOptions, getMemorySettings } from "../lib/api";
import { fallbackFor, type DraftChoice, type Slot } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import {
  memoryDraft as draft,
  memorySaveError,
  memorySaveResult,
  memorySaveWarnings,
  memorySaving as saving,
  sameMemorySettings,
  setMemoryDraft as setDraft,
  setMemorySaved,
  toMemoryDraft,
} from "../lib/memory-settings-draft";
import { withoutSubagentMarks } from "../lib/session-title-settings-form";
import { home } from "../lib/ui-state";
import { Banner } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

/**
 * Settings → Memory (§app.settings-dialog/memory): which model writes memory's summaries — a
 * primary and an optional fallback, Delegate's rows. A summarizer is not a worker, so only the
 * policy's global switch marks a model. Saved by the dialog's footer (memory-settings-draft.ts).
 */
export function MemorySettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getMemorySettings);
  const [options, { refetch: refetchOptions }] = createResource(getMemoryOptions);
  const loaded = (): MemorySettingsInfo | undefined => (info.error ? undefined : info());
  const known = () => (options.state === "ready" ? withoutSubagentMarks(options()) : undefined);

  createEffect(() => {
    const i = loaded();
    if (i) setMemorySaved(i.settings);
  });
  // A save from the footer: what the server says now.
  createEffect(on(memorySaveResult, (r) => r && setInfo(r), { defer: true }));

  const update = (slot: Slot, next: DraftChoice | null) => {
    const d = draft();
    if (d) setDraft(slot === "primary" ? { ...d, primary: next! } : { ...d, fallback: next });
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-memory-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-memory-title">
          Summarizer
        </h3>
        <Show when={loaded() && draft()}>
          <span class="settings-head-actions">
            <button
              type="button"
              class="button button-sm button-ghost"
              disabled={saving() || sameMemorySettings(draft()!, loaded()!.defaults)}
              onClick={() => setDraft(toMemoryDraft(loaded()!.defaults))}
            >
              Reset to Defaults
            </button>
          </span>
        </Show>
      </div>
      <p class="settings-intro">
        With memory on, a small model summarizes each message of the chat into lines the chat's model works from. Pick it,
        and a fallback for when it can't run. A change applies from each chat's next summary.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the memory settings."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>
      <Show when={loaded() && draft() && options.error}>
        <Banner
          tone="warn"
          title="Couldn't check which models are offered."
          body="Your saved choices stay, marked not verified."
          action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
        />
      </Show>

      <Show when={loaded() && draft()}>
        <fieldset class="settings-delegate-profile">
          <legend class="visually-hidden">Memory summarizer</legend>
          <WorkerSlotRow
            idPrefix="memory-summarizer"
            slot="primary"
            info={loaded()!}
            options={known()}
            choice={draft()!.primary}
            other={draft()!.fallback}
            disabled={saving()}
            owner="Memory"
            otherwise="summaries wait until one can"
            onChange={(next) => update("primary", next)}
          />
          <label class="toggle toggle-switch settings-delegate-fallback-toggle">
            <span>Fallback</span>
            <input
              type="checkbox"
              checked={draft()!.fallback !== null}
              disabled={saving()}
              onChange={(e) => update("fallback", fallbackFor(draft()!.primary, e.currentTarget.checked))}
            />
            <span class="toggle-box" />
          </label>
          <Show when={draft()!.fallback} fallback={<p class="field-hint">No fallback: when the primary can't run, summaries wait until it can.</p>}>
            {(fallback) => (
              <WorkerSlotRow
                idPrefix="memory-summarizer"
                slot="fallback"
                info={loaded()!}
                options={known()}
                choice={fallback()}
                other={draft()!.primary}
                disabled={saving()}
                owner="Memory"
                otherwise="summaries wait until one can"
                onChange={(next) => update("fallback", next)}
              />
            )}
          </Show>
        </fieldset>

        <Show when={memorySaveError()}>
          {(e) => <Banner tone="error" title="Couldn't save the memory settings." body={`${sentence(e().message)} Your saved choice is unchanged.`} />}
        </Show>
        <For each={memorySaveWarnings()}>{(w) => <Banner tone="warn" title="Saved, with notes." body={sentence(w)} />}</For>
        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>. The memory type new chats start from is saved from a
          chat's mode menu, with Save as default.
        </p>
      </Show>
    </section>
  );
}
