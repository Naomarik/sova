import { createEffect, createResource, For, Show } from "solid-js";
import {
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
import { Banner, Chip } from "./ui";

/**
 * Settings → Alignment (§app.settings-dialog/alignment): how the align mode plans with you — its
 * writing style, its Visuals and adversarial review — staged like every gated form and written by
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
        <legend class="settings-delegate-legend" id="align-style-label">
          Writing style
        </legend>
        <div role="radiogroup" aria-labelledby="align-style-label" aria-describedby="align-style-hint">
          <For each={ALIGN_STYLE_OPTIONS}>
            {(o) => (
              <label class="toggle public-links-choice">
                <input type="radio" name="align-style" checked={alignmentDraft()?.style === o.id} disabled={off()} onChange={() => edit({ style: o.id })} />
                <span class="toggle-box" aria-hidden="true" />
                <span class="public-links-choice-main">
                  <span class="public-links-choice-name">{o.label}</span>
                  <span class="public-links-choice-meta">{o.description}</span>
                </span>
              </label>
            )}
          </For>
        </div>
        <p class="field-hint settings-delegate-desc" id="align-style-hint">
          Reaches open chats at their next message.
        </p>
      </fieldset>

      <fieldset class="settings-delegate-profile">
        <legend class="settings-delegate-legend">Visuals</legend>
        <label class="toggle toggle-switch settings-team-enable">
          <span>Draw when it helps</span>
          <input
            type="checkbox"
            checked={alignmentDraft()?.visuals ?? false}
            disabled={off()}
            aria-describedby="align-visuals-hint"
            onChange={(e) => edit({ visuals: e.currentTarget.checked })}
          />
          <span class="toggle-box" />
        </label>
        <p class="field-hint settings-delegate-desc" id="align-visuals-hint">
          The align mode draws a wireframe or a flow on the alignment card when a picture explains faster than words. Applies to sessions you start after saving.
        </p>
      </fieldset>

      <fieldset class="settings-delegate-profile">
        <legend class="settings-delegate-legend">Review</legend>
        <label class="toggle toggle-switch settings-team-enable">
          <span>
            Adversarial review <Chip>Experimental</Chip>
          </span>
          <input
            type="checkbox"
            checked={alignmentDraft()?.review ?? false}
            disabled={off()}
            aria-describedby="align-review-hint"
            onChange={(e) => edit({ review: e.currentTarget.checked })}
          />
          <span class="toggle-box" />
        </label>
        <p class="field-hint settings-delegate-desc" id="align-review-hint">
          In align sessions, a read-only reviewer checks the plan and the diff of risky work, at most once each per alignment. Applies to sessions you start after saving.
        </p>
      </fieldset>

      <p class="field-hint settings-delegate-desc">A subagent profile can set its own writing style and visuals (Settings → Subagents).</p>

      <Show when={stored.error}>
        <Banner tone="error" title="Couldn't read the alignment settings." body="Nothing was changed." />
      </Show>
      <Show when={alignmentSaveError()}>
        {(err) => <Banner tone="error" title="Couldn't save the change." body={`${sentence(err().message)} Your saved setting is unchanged.`} />}
      </Show>
    </section>
  );
}
