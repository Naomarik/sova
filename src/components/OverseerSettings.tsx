import { createEffect, createMemo, createResource, createSignal, For, Index, on, onCleanup, Show } from "solid-js";
import type { OverseerAutonomy, OverseerCaps, OverseerProactivity, OverseerQuickAction, OverseerSettings } from "../../shared/protocol";
import { getDelegateOptions, getDelegateSettings, getOverseerAutonomy, getOverseerNotes, getOverseerSettings } from "../lib/api";
import { tildePath } from "../lib/format";
import { loadModelPolicy, usableModels } from "../lib/model-policy";
import { loadModels, modelList, thinkingLevelsFor } from "../lib/models";
import { PROACTIVITY, PROACTIVITY_HINT, PROACTIVITY_LABEL } from "../lib/overseer";
import {
  CAP_LABEL,
  capsChangedFromDefault,
  capValid,
  explorerOptions,
  moveQuickAction,
  newQuickAction,
  overseerDirty,
  overseerDraft as draft,
  overseerDraftIssue,
  overseerSaveError,
  overseerSaving as saving,
  overseerWarnings as warnings,
  PER_MESSAGE_CAP_KEYS,
  perMessageSummary,
  runningNowLine,
  setOverseerDraft,
  setOverseerSaved,
} from "../lib/overseer-draft";
import { clearSettingsSection, settingsSection } from "../lib/settings-nav";
import { home } from "../lib/ui-state";
import { Banner, Icon } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

/**
 * Settings → Overseer: one page, in the order a user reaches for it — how forward it is, the model
 * it runs on, the limits on what it may do, its quick actions and standing notes — then Advanced,
 * folded: the idea explorer it launches, extra instructions after its own prompt, and resuming
 * sessions after a restart. Saved by the dialog's footer, with the other forms (overseer-draft.ts
 * holds the save, its error and its notes). A folded group opens itself when the reason Save
 * waits is a field inside it.
 */
export function OverseerSettingsSection() {
  const [info, { refetch }] = createResource(getOverseerSettings);
  const [notes, { refetch: refetchNotes }] = createResource(() => getOverseerNotes().then((n) => n.text));
  // The idea explorer's row: Delegate's backends and discovered models (it is a subagent, so the
  // same "off for subagents" policy marks apply).
  const [backends] = createResource(getDelegateSettings);
  const [workerOptions, { refetch: refetchWorkerOptions }] = createResource(getDelegateOptions);
  const knownBackends = () => (backends.state === "ready" ? backends() : undefined);
  const knownOptions = () => (workerOptions.state === "ready" ? workerOptions() : undefined);
  // The model list and the policy that trims it, the composer picker's sources.
  void loadModels().catch(() => {});
  void loadModelPolicy().catch(() => {});

  // Running at once's "Now: 3 of 10 running.": the composer's own count, read on mount and every
  // 15 s while the tab is open; no line while it can't be read.
  const [autonomy, setAutonomy] = createSignal<OverseerAutonomy | null>(null);
  const readAutonomy = () => void getOverseerAutonomy().then(setAutonomy, () => setAutonomy(null));
  readAutonomy();
  const autonomyTimer = setInterval(readAutonomy, 15_000);
  onCleanup(() => clearInterval(autonomyTimer));

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

  // Opened from the composer's "3 of 10 running": bring Limits into view once the form renders.
  let limits: HTMLFieldSetElement | undefined;
  createEffect(() => {
    if (settingsSection() !== "overseer-limits" || !loaded() || !d()) return;
    clearSettingsSection();
    // The panel alone scrolls: scrollIntoView would also scroll the modal, hiding its title.
    requestAnimationFrame(() => {
      const panel = limits?.closest<HTMLElement>(".settings-panel");
      if (limits && panel) panel.scrollTop += limits.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    });
  });

  // The folded groups, and the quick actions open for editing (by id, so a row that moves keeps its state).
  const [perMessageOpen, setPerMessageOpen] = createSignal(false);
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [openActions, setOpenActions] = createSignal<ReadonlySet<string>>(new Set());
  const actionOpen = (id: string) => openActions().has(id);
  const setActionOpen = (id: string, open: boolean) =>
    setOpenActions((cur) => {
      const next = new Set(cur);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const issue = createMemo(() => {
    const cur = d();
    return cur ? overseerDraftIssue(cur) : null;
  });
  // Where the problem is, as a string, so the opening below runs when the place changes and not on
  // every keystroke: folding a group again stays the user's until the problem moves.
  const issuePlace = createMemo(() => {
    const at = issue()?.at;
    if (!at) return null;
    if (at.group === "quick-action") return `quick-action:${d()?.settings.quickActions[at.index]?.id ?? at.index}`;
    return at.group === "per-message" ? `per-message:${at.key}` : at.group;
  });
  createEffect(
    on(issuePlace, (place) => {
      const at = place ? issue()?.at : undefined;
      if (!at) return;
      if (at.group === "per-message") setPerMessageOpen(true);
      else if (at.group === "advanced") setAdvancedOpen(true);
      else if (at.group === "quick-action") {
        const id = d()?.settings.quickActions[at.index]?.id;
        if (id) setActionOpen(id, true);
      }
    }),
  );

  const edit = (patch: Partial<OverseerSettings>) => {
    const cur = d();
    if (!cur) return;
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

  const numberOf = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

  /** A group's Reset to Defaults: in the group's head row, every one worded the same; it fills the draft only. */
  const ResetButton = (p: { onClick: () => void }) => (
    <button type="button" class="button button-sm button-ghost overseer-reset" disabled={saving()} onClick={() => p.onClick()}>
      Reset to Defaults
    </button>
  );

  /** One limit's field; `wide` is Running at once, which leads the group alone. */
  const CapField = (p: { k: keyof OverseerCaps; wide?: boolean; now?: string | null }) => {
    const v = () => d()!.settings.caps[p.k];
    return (
      <div class="field" classList={{ "overseer-cap-wide": !!p.wide }}>
        <label class="field-label" for={`overseer-cap-${p.k}`}>
          {CAP_LABEL[p.k].label}
        </label>
        <div class="overseer-cap-row">
          <input
            class="input text-num overseer-cap-input"
            id={`overseer-cap-${p.k}`}
            type="number"
            inputmode="numeric"
            min="0"
            max="1000"
            step="1"
            value={Number.isNaN(v()) ? "" : v()}
            aria-invalid={!capValid(v()) ? "true" : undefined}
            aria-describedby={`${p.now ? `overseer-cap-${p.k}-now ` : ""}overseer-cap-${p.k}-hint`}
            disabled={saving()}
            onInput={(e) => editCap(p.k, numberOf(e.currentTarget.value))}
          />
          <Show when={p.now}>
            {(line) => (
              <span class="overseer-cap-now text-num" id={`overseer-cap-${p.k}-now`}>
                {line()}
              </span>
            )}
          </Show>
        </div>
        <span class="field-hint" id={`overseer-cap-${p.k}-hint`}>
          {CAP_LABEL[p.k].hint}
        </span>
      </div>
    );
  };

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
          const defaults = () => loaded()!.defaults;
          const changed = () => capsChangedFromDefault(cur().settings.caps, defaults().caps);
          const now = () => {
            const a = autonomy();
            return a ? runningNowLine(a.running, cur().settings.caps.concurrentSessions, a.cap) : null;
          };
          return (
            <>
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
                <legend class="settings-delegate-legend">Model and thinking</legend>
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

              <fieldset class="settings-delegate-profile overseer-group" ref={limits}>
                <legend class="settings-delegate-legend">Limits</legend>
                <ResetButton onClick={() => edit({ caps: { ...defaults().caps } })} />
                <p class="field-hint settings-delegate-desc">
                  Before acting, the Overseer checks these. When one is reached it stops and asks you instead. "Per message" counts
                  restart each time you message it.
                </p>
                <CapField k="concurrentSessions" wide now={now()} />
                <details class="overseer-fold" open={perMessageOpen()} onToggle={(e) => setPerMessageOpen(e.currentTarget.open)}>
                  <summary class="overseer-fold-summary">
                    <Icon name="chevron-right" small class="icon-twist" />
                    <span class="overseer-fold-label">Per-message limits</span>
                    <span class="overseer-fold-meta">{perMessageSummary(changed())}</span>
                  </summary>
                  <div class="overseer-caps">
                    <For each={PER_MESSAGE_CAP_KEYS}>{(k) => <CapField k={k} />}</For>
                  </div>
                </details>
              </fieldset>

              <fieldset class="settings-delegate-profile overseer-group">
                <legend class="settings-delegate-legend">Quick actions</legend>
                <ResetButton onClick={() => edit({ quickActions: defaults().quickActions.map((q) => ({ ...q })) })} />
                <p class="field-hint settings-delegate-desc">
                  The Quick Actions button in the Overseer's composer foot lists these. Picking one sends its prompt.
                </p>
                <ol class="overseer-actions-list">
                  <Index each={cur().settings.quickActions}>
                    {(a, i) => {
                      const name = () => a().label.trim() || "Untitled action";
                      const open = () => actionOpen(a().id);
                      return (
                        <li class="overseer-action-row" classList={{ "overseer-action-row-open": open() }}>
                          <div class="overseer-action-line">
                            <span class="overseer-action-text">
                              <span class="overseer-action-label">{name()}</span>
                              <span class="overseer-action-desc">{a().description.trim() || "No description"}</span>
                            </span>
                            <button
                              type="button"
                              class="button button-sm button-ghost"
                              aria-expanded={open()}
                              aria-controls={`overseer-qa-edit-${i}`}
                              aria-label={open() ? `Done editing ${name()}` : `Edit ${name()}`}
                              onClick={() => setActionOpen(a().id, !open())}
                            >
                              {open() ? "Done" : "Edit"}
                            </button>
                          </div>
                          <Show when={open()}>
                            <div class="overseer-action-edit" id={`overseer-qa-edit-${i}`}>
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
                                    aria-invalid={!a().label.trim() ? "true" : undefined}
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
                                  aria-invalid={!a().prompt.trim() ? "true" : undefined}
                                  onInput={(e) => editAction(i, { prompt: e.currentTarget.value })}
                                />
                              </div>
                              <div class="overseer-action-tools">
                                <button
                                  type="button"
                                  class="button button-sm button-ghost"
                                  aria-label={`Move ${name()} up`}
                                  disabled={saving() || i === 0}
                                  onClick={() => edit({ quickActions: moveQuickAction(cur().settings.quickActions, i, -1) })}
                                >
                                  Move Up
                                </button>
                                <button
                                  type="button"
                                  class="button button-sm button-ghost"
                                  aria-label={`Move ${name()} down`}
                                  disabled={saving() || i === cur().settings.quickActions.length - 1}
                                  onClick={() => edit({ quickActions: moveQuickAction(cur().settings.quickActions, i, 1) })}
                                >
                                  Move Down
                                </button>
                                <button
                                  type="button"
                                  class="button button-sm button-ghost"
                                  aria-label={`Remove ${name()}`}
                                  disabled={saving()}
                                  onClick={() => edit({ quickActions: cur().settings.quickActions.filter((_, j) => j !== i) })}
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          </Show>
                        </li>
                      );
                    }}
                  </Index>
                </ol>
                <div class="settings-delegate-actions">
                  <button
                    type="button"
                    class="button button-sm"
                    disabled={saving()}
                    onClick={() => {
                      const added = newQuickAction(cur().settings.quickActions);
                      setActionOpen(added.id, true);
                      edit({ quickActions: [...cur().settings.quickActions, added] });
                      queueMicrotask(() => document.getElementById(`overseer-qa-label-${cur().settings.quickActions.length - 1}`)?.focus());
                    }}
                  >
                    <Icon name="plus" small />
                    Add Quick Action
                  </button>
                </div>
              </fieldset>

              <fieldset class="settings-delegate-profile">
                <legend class="settings-delegate-legend">Standing notes</legend>
                <div class="field">
                  <label class="visually-hidden" for="overseer-notes">
                    Standing notes
                  </label>
                  <textarea
                    class="input textarea"
                    id="overseer-notes"
                    rows={3}
                    value={cur().notes}
                    disabled={saving()}
                    aria-describedby="overseer-notes-hint"
                    onInput={(e) => setOverseerDraft({ ...cur(), notes: e.currentTarget.value })}
                  />
                  <span class="field-hint" id="overseer-notes-hint">
                    The Overseer reads these every turn and can add to them. They survive /clear.
                  </span>
                </div>
              </fieldset>

              <details class="overseer-fold overseer-advanced" open={advancedOpen()} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
                <summary class="overseer-fold-summary">
                  <Icon name="chevron-right" small class="icon-twist" />
                  <span class="overseer-fold-label">Advanced</span>
                  <span class="overseer-fold-meta">Idea explorer, extra instructions, resume after a restart</span>
                </summary>
                <div class="overseer-fold-body">
                  <fieldset class="settings-delegate-profile overseer-group">
                    <legend class="settings-delegate-legend">Idea explorer</legend>
                    <ResetButton onClick={() => edit({ explorer: { ...defaults().explorer } })} />
                    <p class="field-hint settings-delegate-desc">
                      When you keep working on an idea, the Overseer can launch an agent to plan it with you. It reads, never edits a
                      repository, and reports back to the Overseer.
                    </p>
                    <Show when={workerOptions.error}>
                      <Banner
                        tone="warn"
                        title="Couldn't check which models are offered."
                        body="Your saved choice stays, marked not verified."
                        action={<RetryButton label="Check Again" onClick={() => void refetchWorkerOptions()} />}
                      />
                    </Show>
                    <Show
                      when={knownBackends()}
                      fallback={
                        <p class="field-hint">
                          <Show when={backends.error} fallback="Loading the backends…">
                            Couldn't load the backends. Saved: <code>{cur().settings.explorer.backend}</code> · <code>{cur().settings.explorer.model}</code> ·{" "}
                            {cur().settings.explorer.effort}.
                          </Show>
                        </p>
                      }
                    >
                      {(b) => (
                        <WorkerSlotRow
                          idPrefix="overseer-explorer"
                          slot="primary"
                          alone="Idea explorer"
                          info={b()}
                          options={explorerOptions(knownOptions(), b(), defaults().explorer)}
                          choice={cur().settings.explorer}
                          other={null}
                          disabled={saving()}
                          owner="The Overseer"
                          onChange={(next) => edit({ explorer: next })}
                        />
                      )}
                    </Show>
                  </fieldset>

                  <fieldset class="settings-delegate-profile">
                    <legend class="settings-delegate-legend">Extra instructions</legend>
                    <div class="field">
                      <label class="visually-hidden" for="overseer-extra-prompt">
                        Extra instructions
                      </label>
                      <textarea
                        class="input textarea"
                        id="overseer-extra-prompt"
                        rows={4}
                        value={cur().settings.extraSystemPrompt}
                        disabled={saving()}
                        aria-describedby="overseer-extra-prompt-hint"
                        onInput={(e) => edit({ extraSystemPrompt: e.currentTarget.value })}
                      />
                      <span class="field-hint" id="overseer-extra-prompt-hint">
                        Added after the Overseer's own prompt. Applies from its next run.
                      </span>
                    </div>
                  </fieldset>

                  <fieldset class="settings-delegate-profile">
                    <legend class="settings-delegate-legend">After a restart</legend>
                    <label class="toggle toggle-switch settings-team-enable">
                      <span>Resume interrupted sessions</span>
                      <input
                        type="checkbox"
                        checked={cur().settings.autoResume !== false}
                        disabled={saving()}
                        aria-describedby="overseer-auto-resume-hint"
                        onChange={(e) => edit({ autoResume: e.currentTarget.checked })}
                      />
                      <span class="toggle-box" />
                    </label>
                    <p class="field-hint" id="overseer-auto-resume-hint">
                      A session whose turn the server's restart cut off gets one message to continue. Sessions a usage limit or you stopped
                      stay stopped.
                    </p>
                  </fieldset>
                </div>
              </details>

              <Show when={issue()}>{(p) => <p class="field-error">{p().message}</p>}</Show>
              <Show when={overseerSaveError()}>
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
