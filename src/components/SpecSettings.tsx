import { createEffect, createResource, createSignal, Show } from "solid-js";
import type { DelegateOptions, SpecSettingsInfo } from "../../shared/protocol";
import { getSpecOptions, getSpecSettings, putSpecSettings } from "../lib/api";
import { fallbackFor, type DraftChoice, type Slot } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import { clearSettingsSection, settingsSection } from "../lib/settings-nav";
import { setSpecDraft as setDraft, setSpecSaved, specDirty, specDraft as draft } from "../lib/spec-draft";
import { cloneSpec, specDraftComplete, specDraftConflict, writerFor } from "../lib/spec-form";
import { announce, home } from "../lib/ui-state";
import { Banner } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

/**
 * Settings → Modes → Spec: which worker writes draft claims and evidence while the spec minor mode
 * is on, in either major mode — or none, and the session writes them itself. One worker row and an
 * optional fallback, the same row Delegate uses, from what each backend actually offers. The file
 * is global and shared with the terminal: chats with spec on use a save from their next message.
 */
export function SpecSettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getSpecSettings);
  const [options, { refetch: refetchOptions }] = createResource(getSpecOptions);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  let section!: HTMLElement;
  /** The settings once loaded. A resource in its error state throws when read, so this never reads it then. */
  const loaded = (): SpecSettingsInfo | undefined => (info.error ? undefined : info());

  createEffect(() => {
    const i = loaded();
    if (i) setSpecSaved(i.settings);
  });

  // Opened from the mode menu's "Configure Spec": bring this section into view once it has rows.
  createEffect(() => {
    if (settingsSection() !== "spec" || !loaded()) return;
    clearSettingsSection();
    requestAnimationFrame(() => section.scrollIntoView({ block: "start" }));
  });

  const known = (): DelegateOptions | undefined => (options.state === "ready" ? options() : undefined);
  const writer = () => draft()?.writer ?? null;

  const setWriter = (next: ReturnType<typeof writerFor>) => {
    setSaveError(null);
    setDraft({ version: 1, writer: next });
  };
  const update = (slot: Slot, next: DraftChoice | null) => {
    const w = writer();
    if (!w) return;
    setWriter(slot === "primary" ? { ...w, primary: next! } : { ...w, fallback: next });
  };

  const save = async () => {
    const d = draft();
    if (!d || !specDraftComplete(d) || specDraftConflict(d) || saving()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await putSpecSettings(cloneSpec(d) as SpecSettingsInfo["settings"]);
      setInfo(result);
      setSpecSaved(result.settings, { replaceDraft: true });
      setWarnings(result.warnings);
      announce(
        result.settings.writer
          ? "Spec writer saved. Chats with spec on use it from their next message."
          : "Spec writer cleared. Chats with spec on write the spec themselves from their next message.",
      );
    } catch (err) {
      setSaveError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-spec-title" ref={section}>
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-spec-title">
          Spec
        </h3>
      </div>
      <p class="settings-intro">
        With spec on, the agent keeps the project's spec in step with its work. Pick a worker to write the draft claims
        and evidence, or leave it to the chat. Chats with spec on, here and in the terminal, use a change from their next
        message.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the Spec settings."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>
      <Show when={writer() && options.error}>
        <Banner
          tone="warn"
          title="Couldn't check which models are offered."
          body="Your saved choices stay, marked not verified."
          action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
        />
      </Show>

      <Show when={loaded() && draft()}>
        <fieldset class="settings-delegate-profile">
          <legend class="settings-delegate-legend">{loaded()!.writer.label}</legend>
          <p class="field-hint settings-delegate-desc">{loaded()!.writer.description}. The chat checks its work and promotes it.</p>
          <div role="radiogroup" aria-label="Who writes the spec">
            <label class="toggle">
              <input type="radio" name="spec-writer" checked={writer() === null} disabled={saving()} onChange={() => setWriter(writerFor(false))} />
              <span class="toggle-box" aria-hidden="true" />
              None — this session writes the spec
            </label>
            <label class="toggle">
              <input type="radio" name="spec-writer" checked={writer() !== null} disabled={saving()} onChange={() => setWriter(writer() ?? writerFor(true))} />
              <span class="toggle-box" aria-hidden="true" />A worker
            </label>
          </div>
          <Show when={writer()}>
            {(w) => (
              <>
                <WorkerSlotRow
                  idPrefix="spec-writer"
                  slot="primary"
                  info={loaded()!}
                  options={known()}
                  choice={w().primary}
                  other={w().fallback}
                  disabled={saving()}
                  owner="Spec writing"
                  onChange={(next) => update("primary", next)}
                />
                <label class="toggle toggle-switch settings-delegate-fallback-toggle">
                  <span>Fallback</span>
                  <input
                    type="checkbox"
                    checked={w().fallback !== null}
                    disabled={saving()}
                    onChange={(e) => update("fallback", fallbackFor(w().primary, e.currentTarget.checked))}
                  />
                  <span class="toggle-box" />
                </label>
                <Show when={w().fallback} fallback={<p class="field-hint">No fallback: if the primary can't run, the agent asks you which model to use.</p>}>
                  {(fallback) => (
                    <WorkerSlotRow
                      idPrefix="spec-writer"
                      slot="fallback"
                      info={loaded()!}
                      options={known()}
                      choice={fallback()}
                      other={w().primary}
                      disabled={saving()}
                      owner="Spec writing"
                      onChange={(next) => update("fallback", next)}
                    />
                  )}
                </Show>
              </>
            )}
          </Show>
        </fieldset>

        <Show when={saveError()}>
          {(message) => <Banner tone="error" title="Couldn't save the spec writer." body={`${sentence(message())} Your saved choice is unchanged.`} />}
        </Show>
        <Show when={warnings().length > 0 && !specDirty()}>
          <Banner tone="warn" title="Saved, with notes." body={warnings().map(sentence).join(" ")} />
        </Show>

        <div class="settings-delegate-actions">
          <span class="modal-spacer" />
          <button
            type="button"
            class="button button-ghost"
            disabled={saving() || !specDirty()}
            onClick={() => {
              setDraft(cloneSpec(loaded()!.settings));
              setSaveError(null);
            }}
          >
            Discard Changes
          </button>
          <button
            type="button"
            class="button button-primary"
            disabled={saving() || !specDirty() || !specDraftComplete(draft()!) || specDraftConflict(draft()!)}
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
