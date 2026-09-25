import { createEffect, createMemo, createResource, createSignal, For, Index, Show } from "solid-js";
import type { OverseerCaps, OverseerProactivity, OverseerQuickAction, OverseerSettings } from "../../shared/protocol";
import { ApiError, getOverseerNotes, getOverseerSettings, putOverseerNotes, putOverseerSettings } from "../lib/api";
import { tildePath } from "../lib/format";
import { loadModelPolicy, usableModels } from "../lib/model-policy";
import { loadModels, modelList, thinkingLevelsFor } from "../lib/models";
import { PROACTIVITY, PROACTIVITY_HINT, PROACTIVITY_LABEL } from "../lib/overseer";
import {
  CAP_KEYS,
  CAP_LABEL,
  cloneOverseer,
  moveQuickAction,
  newQuickAction,
  overseerDirty,
  overseerDraft as draft,
  overseerDraftProblem,
  overseerSaved,
  NotesConflict,
  saveOverseerDraft,
  setOverseerDraft,
  setOverseerSaved,
} from "../lib/overseer-draft";
import { announce, home } from "../lib/ui-state";
import { Banner, Icon } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";

/**
 * Settings → Overseer: the model it runs on, what it is told beyond its own prompt, how forward it
 * is, its quick actions, the limits on what one message can make it do, and the standing notes it
 * keeps across /clear. One Save for all of it, with the Delegate hold on unsaved edits.
 */
export function OverseerSettingsSection() {
  const [info, { mutate: setInfo, refetch }] = createResource(getOverseerSettings);
  const [notes, { mutate: setNotes, refetch: refetchNotes }] = createResource(() => getOverseerNotes().then((n) => n.text));
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<{ message: string; partial: boolean } | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  // The model list and the policy that trims it, the composer picker's sources.
  void loadModels().catch(() => {});
  void loadModelPolicy().catch(() => {});

  const loaded = () => (info.error ? undefined : info());
  const loadedNotes = () => (notes.error ? undefined : notes());
  // Both are fetched afresh each time the section mounts (each open of the dialog, each return to
  // this tab); a kept draft is rebased onto them, never left on an older copy.
  createEffect(() => {
    const i = loaded();
    const n = loadedNotes();
    if (i && n !== undefined) setOverseerSaved({ settings: i.settings, notes: n });
  });

  const d = () => draft();
  const edit = (patch: Partial<OverseerSettings>) => {
    const cur = d();
    if (!cur) return;
    setSaveError(null);
    setOverseerDraft({ ...cur, settings: { ...cur.settings, ...patch } });
  };
  const editAction = (i: number, patch: Partial<OverseerQuickAction>) => {
    const cur = d();
    if (!cur) return;
    edit({ quickActions: cur.settings.quickActions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  };
  const editCap = (k: keyof OverseerCaps, v: number) => {
    const cur = d();
    if (cur) edit({ caps: { ...cur.settings.caps, [k]: v } });
  };

  /** Models grouped by provider, as the picker lists them. The saved model stays listed even if the
      policy has since turned it off, so the select never silently shows another one. */
  const groups = createMemo(() => {
    const list = usableModels(modelList() ?? []);
    const byProvider = new Map<string, string[]>();
    for (const m of list) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m.ref]);
    return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });
  const listed = (ref: string | null) => !ref || groups().some(([, refs]) => refs.includes(ref));
  const levels = () => thinkingLevelsFor(d()?.settings.model);

  const problem = () => {
    const cur = d();
    return cur ? overseerDraftProblem(cur) : null;
  };

  const save = async () => {
    const cur = d();
    const base = overseerSaved();
    if (!cur || !base || saving() || problem()) return;
    setSaving(true);
    setSaveError(null);
    let wrote = false;
    try {
      const { result, notes: savedNotes } = await saveOverseerDraft(cur, base, {
        getSettings: getOverseerSettings,
        getNotes: () => getOverseerNotes().then((n) => n.text),
        putSettings: async (settings) => {
          const r = await putOverseerSettings(settings);
          wrote = true;
          return r;
        },
        putNotes: (text, was) => putOverseerNotes(text, was).then((n) => n.text),
      });
      setNotes(savedNotes);
      setInfo(result);
      setOverseerSaved({ settings: result.settings, notes: savedNotes }, { replaceDraft: true });
      setWarnings(result.warnings);
      announce("Overseer settings saved. Model and thinking apply when it is idle.");
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      const conflict = err instanceof NotesConflict || (err instanceof ApiError && err.status === 409);
      setSaveError({
        message: conflict
          ? "The Overseer rewrote its standing notes while you were editing them, so your notes weren't saved. Your edit is still in the box: Save Changes again replaces the Overseer's version, and Discard Changes shows it"
          : message,
        partial: wrote,
      });
      // Whatever did land, and whatever the Overseer wrote meanwhile, becomes the base again.
      void refetch();
      void refetchNotes();
    } finally {
      setSaving(false);
    }
  };

  const numberOf = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

  return (
    <section class="settings-delegate overseer-settings" aria-labelledby="settings-overseer-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-overseer-title">
          Overseer
        </h3>
      </div>
      <p class="settings-intro">
        The Overseer watches every session and acts on them for you. Open it with the eye beside the session search, or Alt+O.
      </p>

      <Show when={info.error || notes.error}>
        <Banner
          tone="error"
          title="Couldn't load the Overseer settings."
          body="Nothing was changed."
          action={
            <RetryButton
              label="Try Again"
              onClick={() => {
                void refetch();
                void refetchNotes();
              }}
            />
          }
        />
      </Show>

      <Show when={loaded() && d()}>
        {(_) => {
          const cur = () => d()!;
          return (
            <>
              <fieldset class="settings-delegate-profile">
                <legend class="settings-delegate-legend">Model</legend>
                <div class="settings-delegate-fields overseer-model-fields">
                  <div class="field">
                    <label class="field-label" for="overseer-model">
                      Model
                    </label>
                    <div class="select-wrap">
                      <select
                        class="select text-mono"
                        id="overseer-model"
                        disabled={saving()}
                        onChange={(e) => {
                          const ref = e.currentTarget.value || null;
                          const ladder = thinkingLevelsFor(ref);
                          const thinking = cur().settings.thinking;
                          edit({ model: ref, thinking: thinking && ladder.length && !ladder.includes(thinking) ? null : thinking });
                        }}
                      >
                        <option value="" selected={cur().settings.model === null}>
                          pi's default
                        </option>
                        <Show when={!listed(cur().settings.model)}>
                          <option value={cur().settings.model!} selected>
                            {cur().settings.model} (not available)
                          </option>
                        </Show>
                        <For each={groups()}>
                          {([provider, refs]) => (
                            <optgroup label={provider}>
                              <For each={refs}>
                                {(ref) => (
                                  <option value={ref} selected={ref === cur().settings.model}>
                                    {ref}
                                  </option>
                                )}
                              </For>
                            </optgroup>
                          )}
                        </For>
                      </select>
                      <span class="select-caret" aria-hidden="true">
                        ▾
                      </span>
                    </div>
                  </div>
                  <div class="field">
                    <label class="field-label" for="overseer-thinking">
                      Thinking
                    </label>
                    <div class="select-wrap">
                      <select
                        class="select"
                        id="overseer-thinking"
                        disabled={saving() || levels().length <= 1}
                        onChange={(e) => edit({ thinking: e.currentTarget.value || null })}
                      >
                        <option value="" selected={cur().settings.thinking === null}>
                          Model default
                        </option>
                        <For each={levels()}>
                          {(level) => (
                            <option value={level} selected={level === cur().settings.thinking}>
                              {level}
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
                <p class="field-hint">Applies when the Overseer is idle. It never changes the model new sessions start with.</p>
              </fieldset>

              <fieldset class="settings-delegate-profile">
                <legend class="settings-delegate-legend">Proactivity</legend>
                <div role="radiogroup" aria-label="Proactivity" class="overseer-radios">
                  <For each={PROACTIVITY}>
                    {(p: OverseerProactivity) => (
                      <label class="toggle">
                        <input
                          type="radio"
                          name="overseer-proactivity"
                          checked={cur().settings.proactivity === p}
                          disabled={saving()}
                          onChange={() => edit({ proactivity: p })}
                        />
                        <span class="toggle-box" aria-hidden="true" />
                        <span>
                          {PROACTIVITY_LABEL[p]}
                          <span class="field-hint"> · {PROACTIVITY_HINT[p]}</span>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </fieldset>

              <fieldset class="settings-delegate-profile">
                <legend class="settings-delegate-legend">Quick actions</legend>
                <p class="field-hint settings-delegate-desc">The button above the Overseer's composer. Picking one sends its prompt.</p>
                <ol class="overseer-actions-list">
                  <Index each={cur().settings.quickActions}>
                    {(a, i) => (
                      <li class="overseer-action-row">
                        <div class="settings-delegate-fields">
                          <div class="field">
                            <label class="field-label" for={`overseer-qa-label-${i}`}>
                              Label
                            </label>
                            <input
                              class="input"
                              id={`overseer-qa-label-${i}`}
                              value={a().label}
                              disabled={saving()}
                              onInput={(e) => editAction(i, { label: e.currentTarget.value })}
                            />
                          </div>
                          <div class="field">
                            <label class="field-label" for={`overseer-qa-desc-${i}`}>
                              Description
                            </label>
                            <input
                              class="input"
                              id={`overseer-qa-desc-${i}`}
                              value={a().description}
                              disabled={saving()}
                              onInput={(e) => editAction(i, { description: e.currentTarget.value })}
                            />
                          </div>
                        </div>
                        <div class="field">
                          <label class="field-label" for={`overseer-qa-prompt-${i}`}>
                            Prompt
                          </label>
                          <textarea
                            class="input textarea"
                            id={`overseer-qa-prompt-${i}`}
                            rows={2}
                            value={a().prompt}
                            disabled={saving()}
                            onInput={(e) => editAction(i, { prompt: e.currentTarget.value })}
                          />
                        </div>
                        <div class="overseer-action-tools">
                          <button
                            type="button"
                            class="button button-sm button-ghost"
                            aria-label={`Move ${a().label || "this action"} up`}
                            disabled={saving() || i === 0}
                            onClick={() => edit({ quickActions: moveQuickAction(cur().settings.quickActions, i, -1) })}
                          >
                            Move Up
                          </button>
                          <button
                            type="button"
                            class="button button-sm button-ghost"
                            aria-label={`Move ${a().label || "this action"} down`}
                            disabled={saving() || i === cur().settings.quickActions.length - 1}
                            onClick={() => edit({ quickActions: moveQuickAction(cur().settings.quickActions, i, 1) })}
                          >
                            Move Down
                          </button>
                          <button
                            type="button"
                            class="button button-sm button-ghost"
                            aria-label={`Remove ${a().label || "this action"}`}
                            disabled={saving()}
                            onClick={() => edit({ quickActions: cur().settings.quickActions.filter((_, j) => j !== i) })}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    )}
                  </Index>
                </ol>
                <div class="settings-delegate-actions">
                  <button
                    type="button"
                    class="button button-sm"
                    disabled={saving()}
                    onClick={() => {
                      edit({ quickActions: [...cur().settings.quickActions, newQuickAction(cur().settings.quickActions)] });
                      queueMicrotask(() => document.getElementById(`overseer-qa-label-${cur().settings.quickActions.length - 1}`)?.focus());
                    }}
                  >
                    <Icon name="plus" small />
                    Add Quick Action
                  </button>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    disabled={saving()}
                    onClick={() => edit({ quickActions: loaded()!.defaults.quickActions.map((q) => ({ ...q })) })}
                  >
                    Reset to Defaults
                  </button>
                </div>
              </fieldset>

              <fieldset class="settings-delegate-profile">
                <legend class="settings-delegate-legend">Limits</legend>
                <p class="field-hint settings-delegate-desc">
                  Past a limit the Overseer stops and asks you. Every action it takes is logged.
                </p>
                <div class="overseer-caps">
                  <For each={CAP_KEYS}>
                    {(k) => (
                      <div class="field">
                        <label class="field-label" for={`overseer-cap-${k}`}>
                          {CAP_LABEL[k].label}
                        </label>
                        <input
                          class="input text-num"
                          id={`overseer-cap-${k}`}
                          type="number"
                          inputmode="numeric"
                          min="0"
                          max="1000"
                          step="1"
                          value={Number.isNaN(cur().settings.caps[k]) ? "" : cur().settings.caps[k]}
                          aria-invalid={!Number.isInteger(cur().settings.caps[k]) || cur().settings.caps[k] < 0 ? "true" : undefined}
                          disabled={saving()}
                          onInput={(e) => editCap(k, numberOf(e.currentTarget.value))}
                        />
                        <span class="field-hint">{CAP_LABEL[k].hint}</span>
                      </div>
                    )}
                  </For>
                </div>
                <button
                  type="button"
                  class="button button-sm button-ghost overseer-caps-reset"
                  disabled={saving()}
                  onClick={() => edit({ caps: { ...loaded()!.defaults.caps } })}
                >
                  Reset Limits
                </button>
              </fieldset>

              <fieldset class="settings-delegate-profile">
                <legend class="settings-delegate-legend">Instructions</legend>
                <div class="field">
                  <label class="field-label" for="overseer-extra-prompt">
                    Extra system prompt
                  </label>
                  <textarea
                    class="input textarea"
                    id="overseer-extra-prompt"
                    rows={4}
                    value={cur().settings.extraSystemPrompt}
                    disabled={saving()}
                    onInput={(e) => edit({ extraSystemPrompt: e.currentTarget.value })}
                  />
                  <span class="field-hint">Added after the Overseer's own prompt. Applies from its next run.</span>
                </div>
                <div class="field">
                  <label class="field-label" for="overseer-notes">
                    Standing notes
                  </label>
                  <textarea
                    class="input textarea"
                    id="overseer-notes"
                    rows={4}
                    value={cur().notes}
                    disabled={saving()}
                    onInput={(e) => {
                      setSaveError(null);
                      setOverseerDraft({ ...cur(), notes: e.currentTarget.value });
                    }}
                  />
                  <span class="field-hint">The Overseer reads these every turn and can add to them. They survive /clear.</span>
                </div>
              </fieldset>

              <Show when={problem()}>{(p) => <p class="field-error">{p()}</p>}</Show>
              <Show when={saveError()}>
                {(e) => (
                  <Banner
                    tone="error"
                    title="Couldn't save the Overseer settings."
                    body={`${sentence(e().message)} ${e().partial ? "Your other changes were saved." : "Your saved settings are unchanged."}`}
                  />
                )}
              </Show>
              <Show when={warnings().length > 0 && !overseerDirty()}>
                <Banner tone="warn" title="Saved, with notes." body={warnings().map(sentence).join(" ")} />
              </Show>

              <div class="settings-delegate-actions">
                <span class="modal-spacer" />
                <button
                  type="button"
                  class="button button-ghost"
                  disabled={saving() || !overseerDirty()}
                  onClick={() => {
                    const was = overseerSaved();
                    if (was) setOverseerDraft(cloneOverseer(was));
                    setSaveError(null);
                  }}
                >
                  Discard Changes
                </button>
                <button
                  type="button"
                  class="button button-primary"
                  disabled={saving() || !overseerDirty() || !!problem()}
                  onClick={() => void save()}
                >
                  {saving() ? "Saving…" : "Save Changes"}
                </button>
              </div>
              <p class="settings-delegate-file">
                Stored in <code>{tildePath(loaded()!.file, home())}</code>.
              </p>
            </>
          );
        }}
      </Show>
    </section>
  );
}
