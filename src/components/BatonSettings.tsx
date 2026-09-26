import { createEffect, createResource, createSignal, Show } from "solid-js";
import { MESSAGES_CAP, MESSAGES_MIN } from "../../shared/baton";
import { getBatonSettings, putBatonSettings } from "../lib/api";
import { acceptBatonSave, batonDirty, batonDraft, discardBatonDraft, parseLimit, setBatonDraft, setBatonSaved } from "../lib/baton-settings-draft";
import { announce } from "../lib/ui-state";
import { SaveBar } from "./SaveBar";
import { Banner } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";

/**
 * Settings → Organizations: the message limit a new hand-off session starts with (a start may set
 * its own; the operator extends one that reaches it). Host state, saved with Save Changes.
 */
export function BatonSettingsSection() {
  const [info, { refetch }] = createResource(getBatonSettings);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  createEffect(() => {
    const i = info.error ? undefined : info();
    if (i) setBatonSaved(i);
  });
  const valid = () => parseLimit(batonDraft() ?? "") !== null;
  const save = async () => {
    const n = parseLimit(batonDraft() ?? "");
    if (n === null || saving()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await putBatonSettings({ messagesMax: n });
      acceptBatonSave(result);
      announce(`New hand-off sessions start with a limit of ${result.messagesMax} messages.`);
    } catch (err) {
      setSaveError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section class="settings-delegate" aria-labelledby="settings-orgs-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-orgs-title">
          Hand-off sessions
        </h3>
      </div>
      <p class="settings-intro">
        How many messages a hand-off session takes in, from everyone, before it comes back to you. A session can set its own
        when you start it, and you can extend one that reaches its limit.
      </p>
      <Show when={info.error}>
        <Banner tone="error" title="Couldn't load the hand-off settings." body="Nothing was changed." action={<RetryButton label="Try Again" onClick={() => void refetch()} />} />
      </Show>
      <Show when={batonDraft() !== null}>
        <label class="field">
          <span class="field-label">Message limit</span>
          <input
            class="input"
            type="number"
            min={MESSAGES_MIN}
            max={MESSAGES_CAP}
            step="1"
            value={batonDraft() ?? ""}
            disabled={saving()}
            aria-invalid={!valid()}
            onInput={(e) => {
              setSaveError(null);
              setBatonDraft(e.currentTarget.value);
            }}
          />
          <span class="field-hint">
            {valid() ? `New sessions only; sessions already started keep theirs.` : `A whole number from ${MESSAGES_MIN} to ${MESSAGES_CAP.toLocaleString("en-US")}.`}
          </span>
        </label>
        <Show when={saveError()}>{(m) => <Banner tone="error" title="Couldn't save the message limit." body={`${sentence(m())} Your saved limit is unchanged.`} />}</Show>
        <SaveBar
          dirty={batonDirty()}
          saving={saving()}
          canSave={valid()}
          onSave={() => void save()}
          onDiscard={() => {
            discardBatonDraft();
            setSaveError(null);
          }}
        />
      </Show>
    </section>
  );
}
