import { createEffect, createResource, Show } from "solid-js";
import {
  ALIGN_EAGERNESS_OPTIONS,
  ALIGN_STYLE_OPTIONS,
  alignmentDraft,
  alignmentSaveError,
  alignmentSaving,
  readAlignment,
  setAlignmentDraft,
  setAlignmentSaved,
  type AlignmentSettings,
} from "../lib/alignment-draft";
import { sentence } from "./WorkerSlotRow";
import { Choice, Toggle } from "./form";
import { Banner } from "./ui";

/**
 * Settings → Alignment (§app.settings-dialog/alignment): how the align mode plans with you — its
 * Eagerness, writing style, Visuals and adversarial review — staged like every gated form and written by
 * Save Changes (alignment-draft.ts writes each of its two stores). Read when the tab opens (the
 * panel is mounted only while its tab is), so the form starts from what's saved.
 */
export function AlignmentSettings() {
  const [stored] = createResource(() => readAlignment());
  // setAlignmentSaved is untracked (settings-draft.ts), so this tracks the loaded settings only.
  createEffect(() => {
    const s = stored.error ? undefined : stored();
    if (s) setAlignmentSaved(s);
  });
  const off = () => alignmentSaving() || alignmentDraft() === null;
  const edit = (patch: Partial<AlignmentSettings>) => {
    const d = alignmentDraft();
    if (d) setAlignmentDraft({ ...d, ...patch });
  };

  return (
    <section class="settings-delegate">
      <p class="settings-intro">How the align mode plans with you.</p>

      <fieldset class="settings-delegate-profile">
        <legend class="settings-delegate-legend">Eagerness</legend>
        <Choice
          label="Eagerness"
          value={alignmentDraft()?.eagerness ?? ""}
          options={ALIGN_EAGERNESS_OPTIONS.map((o) => ({ value: o.id, label: o.label, hint: o.description }))}
          disabled={off()}
          onChange={(v) => edit({ eagerness: v as AlignmentSettings["eagerness"] })}
        />
        <p class="field-hint settings-delegate-desc">Either way, nothing is built until you confirm a card. Reaches open chats at their next message.</p>
      </fieldset>

      <fieldset class="settings-delegate-profile">
        <legend class="settings-delegate-legend">Writing style</legend>
        <Choice
          label="Writing style"
          value={alignmentDraft()?.style ?? ""}
          options={ALIGN_STYLE_OPTIONS.map((o) => ({ value: o.id, label: o.label, hint: o.description }))}
          disabled={off()}
          onChange={(v) => edit({ style: v as AlignmentSettings["style"] })}
        />
        <p class="field-hint settings-delegate-desc">Reaches open chats at their next message.</p>
      </fieldset>

      <fieldset class="settings-delegate-profile">
        <legend class="settings-delegate-legend">Visuals</legend>
        <Toggle
          switch
          class="settings-team-enable"
          label="Draw when it helps"
          checked={alignmentDraft()?.visuals ?? false}
          disabled={off()}
          onChange={(on) => edit({ visuals: on })}
          hint="The align mode draws a wireframe or a flow on the alignment card when a picture explains faster than words. Applies to sessions you start after saving."
        />
      </fieldset>

      <fieldset class="settings-delegate-profile">
        <legend class="settings-delegate-legend">Review</legend>
        <Toggle
          switch
          class="settings-team-enable"
          label="Adversarial review"
          checked={alignmentDraft()?.review ?? false}
          disabled={off()}
          onChange={(on) => edit({ review: on })}
          hint="In align sessions, a read-only reviewer checks the plan and the diff of risky work, at most once each per alignment. Applies to sessions you start after saving."
        />
      </fieldset>

      <p class="field-hint settings-delegate-desc">A profile can set its own eagerness, writing style and visuals (Settings → Profiles, its Models part).</p>

      <Show when={stored.error}>
        <Banner tone="error" title="Couldn't read the alignment settings." body="Nothing was changed." />
      </Show>
      <Show when={alignmentSaveError()}>
        {(err) => <Banner tone="error" title="Couldn't save the change." body={`${sentence(err().message)} Your saved setting is unchanged.`} />}
      </Show>
    </section>
  );
}
