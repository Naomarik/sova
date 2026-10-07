import { createEffect, createResource, Show } from "solid-js";
import { FILE_MB, MESSAGES_CAP, MESSAGES_MIN, PHOTO_MB, PHOTOS_PER_CONVERSATION, PHOTOS_PER_MESSAGE } from "../../shared/baton";
import { getBatonSettings } from "../lib/api";
import { batonDraft, batonSaveError, batonSaving as saving, parseFileMb, parseLimit, photoFields, setBatonDraft, setBatonSaved, type BatonDraft } from "../lib/baton-settings-draft";
import { Banner } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";

/**
 * Settings → Organizations: the message limit a new hand-off session starts with (a start may set
 * its own; the operator extends one that reaches it), and photos in gathering chats
 * (§app.baton/images). Host state, saved by the dialog's footer (baton-settings-draft.ts holds the
 * save and its error).
 */
export function BatonSettingsSection() {
  const [info, { refetch }] = createResource(getBatonSettings);
  createEffect(() => {
    const i = info.error ? undefined : info();
    if (i) setBatonSaved(i);
  });
  const valid = () => parseLimit(batonDraft()?.messagesMax ?? "") !== null;
  const edit = (patch: Partial<BatonDraft>) => {
    const d = batonDraft();
    if (d) setBatonDraft({ ...d, ...patch });
  };
  const photoField = (label: string, key: "perMessage" | "mb" | "perConversation", bounds: { min: number; max: number }) => (
    <label class="field">
      <span class="field-label">{label}</span>
      <input
        class="input"
        type="number"
        min={bounds.min}
        max={bounds.max}
        step="1"
        value={batonDraft()?.[key] ?? ""}
        disabled={saving() || !batonDraft()?.photosOn}
        aria-invalid={batonDraft() ? photoFields[key](batonDraft()!) === null : false}
        onInput={(e) => edit({ [key]: e.currentTarget.value })}
      />
      <span class="field-hint">
        {bounds.min}–{bounds.max}
      </span>
    </label>
  );
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
            value={batonDraft()?.messagesMax ?? ""}
            disabled={saving()}
            aria-invalid={!valid()}
            onInput={(e) => edit({ messagesMax: e.currentTarget.value })}
          />
          <span class="field-hint">
            {valid() ? `New sessions only; sessions already started keep theirs.` : `A whole number from ${MESSAGES_MIN} to ${MESSAGES_CAP.toLocaleString("en-US")}.`}
          </span>
        </label>
        <h4 class="settings-type-title" id="settings-orgs-photos">
          Photos in gathering chats
        </h4>
        <label class="toggle toggle-switch">
          <input type="checkbox" checked={batonDraft()?.photosOn ?? true} disabled={saving()} onChange={(e) => edit({ photosOn: e.currentTarget.checked })} />
          <span class="toggle-box" />
          <span>People can send photos</span>
        </label>
        <div class="orgs-fields" role="group" aria-labelledby="settings-orgs-photos">
          {photoField("Per message", "perMessage", PHOTOS_PER_MESSAGE)}
          {photoField("Largest photo, MB", "mb", PHOTO_MB)}
          {photoField("Per conversation", "perConversation", PHOTOS_PER_CONVERSATION)}
        </div>
        <p class="field-hint">Applies to every gathering session on this host, from its next message.</p>
        <h4 class="settings-type-title" id="settings-orgs-files">
          Files in gathering chats
        </h4>
        <div class="orgs-fields" role="group" aria-labelledby="settings-orgs-files">
          <label class="field">
            <span class="field-label">Largest file, MB</span>
            <input
              class="input"
              type="number"
              min={FILE_MB.min}
              max={FILE_MB.max}
              step="1"
              value={batonDraft()?.fileMb ?? ""}
              disabled={saving()}
              aria-invalid={batonDraft() ? parseFileMb(batonDraft()!) === null : false}
              onInput={(e) => edit({ fileMb: e.currentTarget.value })}
            />
            <span class="field-hint">
              {FILE_MB.min}–{FILE_MB.max}
            </span>
          </label>
        </div>
        <p class="field-hint">Applies to gathering sessions that take files, from the next upload.</p>
        <Show when={batonSaveError()}>{(e) => <Banner tone="error" title="Couldn't save the message limit." body={`${sentence(e().message)} Your saved limit is unchanged.`} />}</Show>
      </Show>
    </section>
  );
}
