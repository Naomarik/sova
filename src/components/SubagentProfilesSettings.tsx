import { createEffect, createResource, createSignal, For, Show, untrack, type JSX } from "solid-js";
import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import type { WorkerChoice } from "../../shared/protocol";
import { getDelegateOptions, getDelegateSettings, getSubagentProfiles, getTeamDefaults } from "../lib/api";
import { cloneProfiles, profilesDraft as store, savedOf } from "../lib/subagent-profiles-draft";
import { claudeDriftNotes, fallbackFor } from "../lib/delegate-form";
import { filterProfiles, nextSetup } from "../lib/mode-menu";
import { numberIssue, numberOf, TEAM_NUMBER_BOUNDS, type TeamNumberField } from "../lib/team-form";
import { tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { clearSettingsSection, settingsSection, subagentSettingsPath } from "../lib/settings-nav";
import {
  coordinatorOn,
  delegateSummary,
  monitorOn,
  roleProblem,
  sectionProblems,
  reviewerSummary,
  specSummary,
  teamsSummary,
  withCoordinator,
  withMonitor,
  type EditorSection,
} from "../lib/subagent-editor";
import { Banner, Chip, Icon } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";
import { adversarialReview } from "../lib/align-review";
import "./SubagentProfilesSettings.css";

const labels = { planning: "Planning & specs", investigation: "Investigation", routine: "Routine implementation", complex: "Complex implementation" } as const;

/** A number field of the teams section, with its bounds' hint and its own refusal inline. */
const NUMBER_HINTS: Record<TeamNumberField, string> = {
  contextPct: "Start wrap-up when a member's context is this full.",
  everyMinutes: "How often the monitor checks in.",
  pausePct: "Pause the team when a provider is this close to its limit.",
  resumeMarginMinutes: "Wait this long after the limit resets before resuming.",
  retireTimeoutMinutes: "How long a replaced member has to hand over.",
};
const NUMBER_LABELS: Record<TeamNumberField, string> = {
  contextPct: "Wrap-up context %",
  everyMinutes: "Check every (minutes)",
  pausePct: "Pause usage %",
  resumeMarginMinutes: "Resume margin (minutes)",
  retireTimeoutMinutes: "Retire timeout (minutes)",
};

/**
 * Settings → Subagents: the whole library, one editor at a time. Off is built in and immutable;
 * every other profile is the same rows, validation and save rules Delegate's and Teams' own screens
 * had. The dialog's Save Changes writes the whole file, so a save reaches every chat on a changed
 * profile from its next turn or team action.
 *
 * Edit (or a new profile) replaces the list with the editor: a back control, the name, then the
 * folds — Delegate routing, Teams, Spec writer, and Reviewer while adversarial review is on — each
 * saying what is inside while closed. Back
 * keeps unsaved edits (the draft is module state); the list then opens only the profile holding
 * them, so another can't be opened over them.
 *
 * A chat's menu opens this tab WITH that chat's path (`subagentSettingsPath`): the list marks the
 * chat's current profile and Save Current as Profile saves what that chat uses now. A plain open
 * reads the library's default view instead. Either way the library is this host's: on the mesh it
 * syncs like the other settings documents.
 */
export function SubagentProfilesSettings() {
  const [info, { refetch: refetchInfo }] = createResource(() => getSubagentProfiles(subagentSettingsPath()));
  const [options, { refetch: refetchOptions }] = createResource(getDelegateOptions);
  /** Backends' labels/efforts for the worker rows (the old Delegate screen's info). */
  const [rows] = createResource(getDelegateSettings);
  /** The legacy team defaults, for seeding a profile's coordinator when it has no saved roles. */
  const [teams] = createResource(getTeamDefaults);
  /** The profile the editor holds. It stays set after Back, so its unsaved edits can be reopened. */
  const [editing, setEditing] = createSignal<string | null>(null);
  /** The editor is showing (rather than the list). */
  const [editorShown, setEditorShown] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [openSections, setOpenSections] = createSignal<Set<EditorSection>>(new Set(["delegate"]));
  let editorEl: HTMLElement | undefined;
  let backButton: HTMLButtonElement | undefined;
  /** Bring `el` to the panel's top. The panel alone scrolls: scrollIntoView would also scroll the modal, hiding its title. */
  const scrollToTop = (el: HTMLElement | null | undefined) => {
    const panel = el?.closest<HTMLElement>(".settings-panel");
    if (el && panel) panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  };

  /** The resource read only when it isn't in an error state. */
  const safeInfo = () => (info.error ? undefined : info());
  /** What the last save wrote (the draft store's PUT answer) or the load: display facts follow writes at once. */
  const shown = () => store.result() ?? safeInfo();
  const footprintOf = (id: string) => shown()?.profiles.find((x) => x.id === id)?.footprint;

  const edit = () => store.draft()?.profiles.find((p) => p.id === editing());
  /** The editor shows only while its profile exists in the draft: a discarded new profile returns to the list. */
  const inEditor = () => editorShown() && !!edit();

  const isOpen = (s: EditorSection) => openSections().has(s);
  const setOpen = (s: EditorSection, open: boolean) => {
    if (open === isOpen(s)) return;
    const next = new Set(openSections());
    if (open) next.add(s);
    else next.delete(s);
    setOpenSections(next);
  };

  /** Edit or a new profile: the editor replaces the list, Delegate routing open, at its top. Focus
      moves to Back when a press opened it; an open the dialog made itself leaves focus on the tab. */
  const openEditor = (id: string, section: EditorSection = "delegate", focus = true) => {
    setEditing(id);
    setOpenSections(new Set<EditorSection>(["delegate", section]));
    setEditorShown(true);
    queueMicrotask(() => {
      scrollToTop(editorEl);
      if (focus) backButton?.focus();
    });
  };
  /** Back to the list. Unsaved edits stay in the draft; focus returns to that profile's Edit. */
  const closeEditor = () => {
    const id = editing();
    setEditorShown(false);
    queueMicrotask(() => document.getElementById(`subagents-edit-${id}`)?.focus());
  };

  // The saved library, whenever it (re)loads. A draft kept from an earlier visit to this tab stays.
  createEffect(() => {
    const i = safeInfo();
    if (i && !i.error) store.setSaved(savedOf(i));
  });

  /** The chat's current profile opens its editor (the menu's Manage and gears land here); a plain open waits for a pick. */
  createEffect(() => {
    const i = safeInfo();
    if (!i || i.error || store.dirty() || editing() !== null || store.draft() === null) return;
    const fromChat = !!subagentSettingsPath();
    const forSpec = settingsSection() === "spec";
    const id = i.current.id;
    if ((fromChat || forSpec) && id !== null && id !== "off" && i.settings.profiles.some((p) => p.id === id)) openEditor(id, forSpec ? "spec" : "delegate", false);
  });
  // Opened from the mode menu's "Configure Spec": Spec writer open, and in view once it renders.
  createEffect(() => {
    if (settingsSection() !== "spec" || !inEditor()) return;
    clearSettingsSection();
    setOpen("spec", true);
    requestAnimationFrame(() => scrollToTop(document.getElementById("subagents-spec")));
  });
  // A section that comes to hold something Save waits for opens itself — once, when it starts to,
  // so the user can still fold it while they fix something else.
  let hadProblems = new Set<EditorSection>();
  createEffect(() => {
    const p = inEditor() ? edit() : undefined;
    const now = p ? sectionProblems(p) : new Set<EditorSection>();
    const fresh = [...now].filter((s) => !hadProblems.has(s));
    hadProblems = now;
    untrack(() => fresh.forEach((s) => setOpen(s, true)));
  });

  const change = (fn: (p: SubagentProfile) => void) => {
    const copy = cloneProfiles(store.draft()!);
    const p = copy.profiles.find((x) => x.id === editing());
    if (p) {
      fn(p);
      store.setDraft(copy);
    }
  };
  /** Replace the edited profile with `fn`'s answer (the teams switches build a whole new profile). */
  const replace = (fn: (p: SubagentProfile) => SubagentProfile) => {
    const copy = cloneProfiles(store.draft()!);
    const i = copy.profiles.findIndex((x) => x.id === editing());
    if (i >= 0) {
      copy.profiles[i] = fn(copy.profiles[i]!);
      store.setDraft(copy);
    }
  };
  /** A new profile: a copy of the chat's current (or the template), untouched until Save Changes. */
  const newProfile = (source?: SubagentProfile) => {
    const i = safeInfo();
    if (!i || store.dirty()) return;
    const copy = cloneProfiles(store.draft()!);
    const p = cloneProfiles(source ?? copy.profiles.find((x) => x.id === i.current.id) ?? i.template);
    const next = nextSetup(copy.profiles);
    p.id = next.id;
    p.name = next.name;
    copy.profiles.push(p);
    store.setDraft(copy);
    openEditor(p.id);
  };
  const remove = (id: string) => {
    if (store.dirty() || store.draft()?.default === id) return;
    const copy = cloneProfiles(store.draft()!);
    copy.profiles = copy.profiles.filter((p) => p.id !== id);
    store.setDraft(copy);
    setEditing(null);
  };
  const makeDefault = (id: string) => {
    const copy = cloneProfiles(store.draft()!);
    copy.default = id;
    store.setDraft(copy);
  };
  /** What the coordinator switch restores: the profile's saved roles, else the legacy team defaults. */
  const teamsSeed = (id: string): TeamsSetting | null => {
    const saved = store.saved()?.profiles.find((x) => x.id === id)?.teams;
    if (saved) return saved;
    const t = teams.error ? undefined : teams()?.defaults;
    // The legacy defaults were born of the same store's parse, so the wire type's wide `string`
    // effort is really the tuple's union; the next save's parse rechecks it.
    return t ? (cloneProfiles({ coordinator: t.coordinator, monitor: t.monitor, handover: t.handover }) as TeamsSetting) : null;
  };

  // Accessor args, not values: these factories are invoked once when their <Show> mounts, so a
  // plain `c()` read there would freeze the row on the toggle's first state (the members/spec bug).
  // The thunk reads the draft every time the row's props are read.
  const tuple = (
    role: string,
    choice: () => WorkerChoice,
    other: () => WorkerChoice | null,
    onChange: (c: WorkerChoice) => void,
    slot: "primary" | "fallback" = "primary",
    unlabelled: () => boolean = () => false,
  ) => (
    <Show when={rows()}>
      {(r) => (
        <WorkerSlotRow
          idPrefix={`subagents-${editing()}-${role}`}
          slot={slot}
          info={r()}
          options={options.state === "ready" ? options() : undefined}
          choice={choice()}
          other={other()}
          disabled={store.saving()}
          unlabelled={unlabelled()}
          compact
          onChange={onChange}
        />
      )}
    </Show>
  );
  /** A primary row, then its fallback row. "Primary" labels the first row only while a fallback is set. */
  const pair = (role: string, choice: () => { primary: WorkerChoice; fallback: WorkerChoice | null }, update: (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => void) => (
    <>
      {tuple(role, () => choice().primary, () => choice().fallback, (c) => update({ ...choice(), primary: c }), "primary", () => choice().fallback === null)}
      <Show when={choice().fallback}>
        {(f) => (
          <>
            {tuple(role, f, () => choice().primary, (c) => update({ ...choice(), fallback: c }), "fallback")}
          </>
        )}
      </Show>
    </>
  );
  /** Add Fallback or Remove Fallback, for the route's head line beside its name. One button whose
      label flips, so keyboard focus stays on it as the fallback row comes and goes. */
  const fallbackAction = (choice: () => { primary: WorkerChoice; fallback: WorkerChoice | null }, update: (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => void) => (
    <button
      type="button"
      class="button button-sm button-ghost subagent-editor-route-action"
      disabled={store.saving()}
      onClick={() => update({ ...choice(), fallback: choice().fallback ? null : fallbackFor(choice().primary, true) })}
    >
      <Show when={choice().fallback} fallback={<><Icon name="plus" small />Add Fallback</>}>
        Remove Fallback
      </Show>
    </button>
  );
  const number = (field: TeamNumberField, value: () => number, update: (n: number) => void) => {
    const id = `subagents-${editing()}-${field}`;
    const issue = () => numberIssue(field, value());
    return (
      <div class="field subagent-editor-number">
        <label class="field-label" for={id}>
          {NUMBER_LABELS[field]}
        </label>
        <div class="subagent-editor-number-row">
          <input
            class="input text-num"
            id={id}
            type="number"
            inputmode="numeric"
            min={TEAM_NUMBER_BOUNDS[field].min}
            max={TEAM_NUMBER_BOUNDS[field].max}
            step="1"
            value={Number.isNaN(value()) ? "" : value()}
            aria-invalid={issue() ? "true" : undefined}
            aria-describedby={`${id}-hint`}
            disabled={store.saving()}
            onInput={(e) => update(numberOf(e.currentTarget.value))}
          />
          <span class={issue() ? "field-error" : "field-hint"} id={`${id}-hint`}>
            {issue() ?? NUMBER_HINTS[field]}
          </span>
        </div>
      </div>
    );
  };
  /** One of the editor's sections: a fold whose closed head says what is inside. */
  const section = (key: EditorSection, label: string, summary: () => string, body: () => JSX.Element, id?: string) => (
    <details class="overseer-fold overseer-advanced subagent-editor-section" id={id} open={isOpen(key)} onToggle={(e) => setOpen(key, e.currentTarget.open)}>
      <summary class="overseer-fold-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="overseer-fold-label">{label}</span>
        <span class="overseer-fold-meta">{summary()}</span>
      </summary>
      <div class="overseer-fold-body">{body()}</div>
    </details>
  );

  return (
    <section class="settings-delegate subagent-editor" aria-labelledby={inEditor() ? "subagents-editor-title" : "settings-subagents-title"}>
      <Show
        when={inEditor()}
        fallback={
          <>
            <div class="settings-type-head">
              <h3 class="settings-type-title" id="settings-subagents-title">
                Subagent profiles
              </h3>
            </div>
            <p class="settings-intro">Which models your subagents use. A chat picks a profile in its mode menu; new chats start on the default.</p>
            <For each={claudeDriftNotes(options.state === "ready" ? options() : undefined)}>{(note) => <p class="settings-intro">{note}</p>}</For>
          </>
        }
      >
        <div class="settings-type-head" ref={(el) => (editorEl = el)}>
          <button type="button" class="button button-sm button-ghost subagent-editor-back" ref={(el) => (backButton = el)} onClick={closeEditor}>
            <Icon name="chevron-left" small />
            Subagent profiles
          </button>
        </div>
      </Show>

      <Show when={info.error || safeInfo()?.error}>
        <Banner
          tone="error"
          title="Couldn't load subagent profiles."
          body={sentence(String(info.error ?? safeInfo()!.error ?? "")) + " Your library is unchanged."}
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
      <Show when={store.error()}>{(e) => <Banner tone="error" title="Couldn't save subagent profiles." body={sentence(e().message)} />}</Show>
      <For each={store.warnings()}>{(w) => <Banner tone="warn" title="Saved, with notes." body={sentence(w)} />}</For>

      <Show when={store.draft() && !safeInfo()?.error}>
        <Show
          when={inEditor() && edit()}
          fallback={
            <>
              <div class="button-row subagent-editor-list-actions">
                <button type="button" class="button button-sm" disabled={store.dirty() || store.saving()} onClick={() => newProfile()}>
                  <Icon name="plus" small />
                  New Profile
                </button>
                <button
                  type="button"
                  class="button button-sm button-ghost"
                  disabled={store.dirty() || store.saving() || !shown() || shown()!.current.id === "off"}
                  title={shown()?.current.id === "off" ? "Off configures nothing, so there is nothing to save" : undefined}
                  onClick={() => newProfile()}
                >
                  Save Current as Profile
                </button>
              </div>
              <Show when={(store.draft()?.profiles.length ?? 0) + 1 > 6}>
                <div class="field">
                  <label class="field-label" for="subagents-search">
                    Find a subagent profile
                  </label>
                  <input class="input" id="subagents-search" type="search" autocomplete="off" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />
                </div>
              </Show>
              <div class="list subagent-editor-list" aria-label="Subagent profiles">
                <div class="list-row">
                  <span class="list-main">
                    <span class="list-title">
                      Off
                      <Show when={store.draft()?.default === "off"}>
                        {" "}
                        <Chip tone="accent">Default</Chip>
                      </Show>
                    </span>
                    <span class="list-meta">The agent picks every model</span>
                  </span>
                  <Show when={store.draft()?.default !== "off"}>
                    <button type="button" class="button button-sm button-ghost" disabled={store.dirty() || store.saving()} onClick={() => makeDefault("off")}>
                      Make Default
                    </button>
                  </Show>
                </div>
                <For each={filterProfiles(store.draft()!.profiles, search())}>
                  {(p) => (
                    <div class="list-row">
                      <span class="list-main">
                        <span class="list-title">
                          {p.name}
                          <Show when={shown()?.current.id === p.id && shown()?.current.source === "pick"}>
                            {" "}
                            <Chip>this chat</Chip>
                          </Show>
                          <Show when={store.draft()?.default === p.id}>
                            {" "}
                            <Chip tone="accent">Default</Chip>
                          </Show>
                        </span>
                        <span class="list-meta text-mono">{footprintOf(p.id) ?? "Not saved yet"}</span>
                      </span>
                      <div class="button-row subagent-editor-row-actions">
                        {/* Unsaved edits are this profile's: its Edit reopens them; every other profile waits. */}
                        <button
                          type="button"
                          class="button button-sm"
                          id={`subagents-edit-${p.id}`}
                          disabled={store.saving() || (store.dirty() && editing() !== p.id)}
                          onClick={() => openEditor(p.id)}
                        >
                          Edit
                        </button>
                        <button type="button" class="button button-sm button-ghost" disabled={store.dirty() || store.saving()} onClick={() => newProfile(p)}>
                          Duplicate
                        </button>
                        <Show when={store.draft()?.default !== p.id}>
                          <button type="button" class="button button-sm button-ghost" disabled={store.dirty() || store.saving()} onClick={() => makeDefault(p.id)}>
                            Make Default
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="button button-sm button-destructive"
                          disabled={store.dirty() || store.saving() || store.draft()?.default === p.id}
                          title={store.draft()?.default === p.id ? "Make another profile the default before deleting this one" : undefined}
                          onClick={() => remove(p.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </>
          }
        >
          {(p) => (
            <>
              <h3 class="visually-hidden" id="subagents-editor-title">
                Edit “{p().name}”
              </h3>
              <Show when={safeInfo()?.current.id === "off" && subagentSettingsPath()}>
                <Banner tone="info" title="This chat is on Off." body="Off configures nothing: the agent picks every model. Editing a profile here doesn't switch the chat." />
              </Show>
              <div class="field settings-team-role subagent-editor-name">
                <label class="field-label" for="subagents-name">
                  Profile name
                </label>
                <input
                  class="input"
                  id="subagents-name"
                  maxlength={48}
                  value={p().name}
                  aria-describedby="subagents-name-footprint"
                  disabled={store.saving()}
                  onInput={(e) => change((x) => (x.name = e.currentTarget.value))}
                />
                <span class="field-hint text-mono" id="subagents-name-footprint">
                  {footprintOf(p().id) ?? "Not saved yet"}
                </span>
              </div>

              {section(
                "delegate",
                "Delegate routing",
                () => delegateSummary(p()),
                () => (
                  <>
                    <p class="field-hint settings-delegate-desc">Without a fallback, the agent asks you which model to use when a route's primary can't run.</p>
                    <For each={Object.keys(labels) as (keyof typeof labels)[]}>
                      {(k) => (
                        <fieldset class="subagent-editor-route">
                          <legend class="subagent-editor-route-name">{labels[k]}</legend>
                          {fallbackAction(() => p().delegate[k], (c) => change((x) => (x.delegate[k] = c)))}
                          {pair(k, () => p().delegate[k], (c) => change((x) => (x.delegate[k] = c)))}
                        </fieldset>
                      )}
                    </For>
                  </>
                ),
              )}

              {section(
                "teams",
                "Teams",
                () => teamsSummary(p()),
                () => (
                  <>
                    <Show when={coordinatorOn(p())}>
                      <p class="field-hint settings-delegate-desc">Without a fallback, a team isn't created when a role's primary can't run.</p>
                    </Show>
                    <For each={["coordinator", "monitor"] as const}>
                      {(role) => {
                        const name = role === "coordinator" ? "Coordinator" : "Monitor";
                        const on = () => (role === "coordinator" ? coordinatorOn(p()) : monitorOn(p()));
                        const t = () => p().teams;
                        /** The Instructions fold opens itself when the role name goes blank, and stays as the user leaves it. */
                        const [instructionsOpen, setInstructionsOpen] = createSignal(false);
                        createEffect(() => {
                          if (p().teams?.[role].role.trim() === "") setInstructionsOpen(true);
                        });
                        const canSwitch = () => (role === "coordinator" ? !!p().teams || teamsSeed(p().id) !== null : coordinatorOn(p()));
                        /** The role's rows show while it's on, or while its fields hold something Save waits for. */
                        const shows = () => !!t() && (on() || roleProblem(p(), role));
                        const choice = () => ({
                          primary: { ...t()![role].primary, effort: t()![role].primary.effort ?? "" },
                          fallback: t()![role].fallback ? { ...t()![role].fallback!, effort: t()![role].fallback!.effort ?? "" } : null,
                        });
                        const update = (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => change((x) => Object.assign(x.teams![role], c));
                        return (
                          <fieldset class="subagent-editor-route">
                            <legend class="subagent-editor-route-name">{name}</legend>
                            <Show when={shows()}>{fallbackAction(choice, update)}</Show>
                            <label class="toggle toggle-switch settings-team-enable">
                              <span>Add a {role} to new teams</span>
                              <input
                                type="checkbox"
                                checked={on()}
                                disabled={store.saving() || !canSwitch()}
                                aria-describedby={role === "monitor" && !coordinatorOn(p()) ? `subagents-${editing()}-monitor-needs` : undefined}
                                onChange={(e) =>
                                  replace((x) => (role === "coordinator" ? withCoordinator(x, e.currentTarget.checked, teamsSeed(x.id)) : withMonitor(x, e.currentTarget.checked)))
                                }
                              />
                              <span class="toggle-box" />
                            </label>
                            <Show when={role === "monitor" && !coordinatorOn(p())}>
                              <p class="field-hint" id={`subagents-${editing()}-monitor-needs`}>
                                The monitor reports to the coordinator, so it needs one.
                              </p>
                            </Show>
                            <Show when={shows()}>
                              {pair(role, choice, update)}
                              <Show when={role === "monitor"}>
                                <div class="subagent-editor-sub">
                                  <div class="settings-team-numbers">
                                    {number("contextPct", () => t()!.monitor.contextPct, (n) => change((x) => (x.teams!.monitor.contextPct = n)))}
                                    {number("everyMinutes", () => t()!.monitor.everyMinutes, (n) => change((x) => (x.teams!.monitor.everyMinutes = n)))}
                                  </div>
                                  <label class="toggle toggle-switch settings-team-enable">
                                    <span>Pause the team near a usage limit</span>
                                    <input type="checkbox" checked={t()!.monitor.usage.enabled} disabled={store.saving()} onChange={(e) => change((x) => (x.teams!.monitor.usage.enabled = e.currentTarget.checked))} />
                                    <span class="toggle-box" />
                                  </label>
                                  <Show when={t()!.monitor.usage.enabled}>
                                    <div class="settings-team-numbers">
                                      {number("pausePct", () => t()!.monitor.usage.pausePct, (n) => change((x) => (x.teams!.monitor.usage.pausePct = n)))}
                                      {number("resumeMarginMinutes", () => t()!.monitor.usage.resumeMarginMinutes, (n) => change((x) => (x.teams!.monitor.usage.resumeMarginMinutes = n)))}
                                    </div>
                                  </Show>
                                </div>
                              </Show>
                              <details class="overseer-fold subagent-editor-instructions" open={instructionsOpen()} onToggle={(e) => setInstructionsOpen(e.currentTarget.open)}>
                                <summary class="overseer-fold-summary">
                                  <Icon name="chevron-right" small class="icon-twist" />
                                  <span class="overseer-fold-label">Instructions</span>
                                  <span class="overseer-fold-meta">
                                    {t()![role].role || "No role name"} · {t()![role].instructions.trim() ? "extra instructions set" : "no extra instructions"}
                                  </span>
                                </summary>
                                <div class="overseer-fold-body">
                                  <div class="field settings-team-role">
                                    <label class="field-label" for={`subagents-${editing()}-${role}-role`}>
                                      Role name
                                    </label>
                                    <input
                                      class="input text-mono"
                                      id={`subagents-${editing()}-${role}-role`}
                                      value={t()![role].role}
                                      maxlength={64}
                                      spellcheck={false}
                                      autocomplete="off"
                                      aria-invalid={t()![role].role.trim() === "" ? "true" : undefined}
                                      disabled={store.saving()}
                                      onInput={(e) => change((x) => (x.teams![role].role = e.currentTarget.value))}
                                    />
                                    <Show when={t()![role].role.trim() === ""}>
                                      <span class="field-error">Name the role.</span>
                                    </Show>
                                  </div>
                                  <div class="field">
                                    <label class="field-label" for={`subagents-${editing()}-${role}-instructions`}>
                                      {name} instructions
                                    </label>
                                    <textarea
                                      class="input textarea"
                                      id={`subagents-${editing()}-${role}-instructions`}
                                      rows={3}
                                      maxlength={4000}
                                      value={t()![role].instructions}
                                      disabled={store.saving()}
                                      onInput={(e) => change((x) => (x.teams![role].instructions = e.currentTarget.value))}
                                    />
                                    <span class="field-hint">Added to the {role}'s standing instructions in every new team.</span>
                                  </div>
                                </div>
                              </details>
                            </Show>
                          </fieldset>
                        );
                      }}
                    </For>
                    <Show when={p().teams}>
                      {(t) => (
                        <fieldset class="subagent-editor-route">
                          <legend class="subagent-editor-route-name">Handover</legend>
                          <div class="settings-team-numbers">{number("retireTimeoutMinutes", () => t().handover.retireTimeoutMinutes, (n) => change((x) => (x.teams!.handover.retireTimeoutMinutes = n)))}</div>
                        </fieldset>
                      )}
                    </Show>
                    <fieldset class="subagent-editor-route subagent-editor-flush">
                      <legend class="subagent-editor-route-name">Members default</legend>
                      <label class="toggle toggle-switch settings-team-enable">
                        <span>Choose a model for ordinary members</span>
                        <input type="checkbox" checked={p().members !== null} disabled={store.saving()} onChange={(e) => change((x) => (x.members = e.currentTarget.checked ? { backend: "pi", model: "", effort: "" } : null))} />
                        <span class="toggle-box" />
                      </label>
                      <Show when={p().members} fallback={<p class="field-hint">A member nobody gave a model runs on its team lead's model.</p>}>
                        {(m) => tuple("members", m, () => null, (c) => change((x) => (x.members = c)), "primary", () => true)}
                      </Show>
                    </fieldset>
                  </>
                ),
              )}

              {section(
                "spec",
                "Spec writer",
                () => specSummary(p()),
                () => (
                  <>
                    <div class="subagent-editor-switch-line">
                      <label class="toggle toggle-switch settings-team-enable">
                        <span>Use a spec writer while spec is on</span>
                        <input
                          type="checkbox"
                          checked={p().specWriter !== null}
                          disabled={store.saving()}
                          onChange={(e) => change((x) => (x.specWriter = e.currentTarget.checked ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))}
                        />
                        <span class="toggle-box" />
                      </label>
                      <Show when={p().specWriter}>{(w) => fallbackAction(w, (c) => change((x) => (x.specWriter = c)))}</Show>
                    </div>
                    <Show when={p().specWriter} fallback={<p class="field-hint">The session writes the spec itself.</p>}>
                      {(w) => (
                        <>
                          <p class="field-hint settings-delegate-desc">Without a fallback, the session writes the spec itself when the writer can't run.</p>
                          <div class="subagent-editor-flush">{pair("spec", w, (c) => change((x) => (x.specWriter = c)))}</div>
                        </>
                      )}
                    </Show>
                  </>
                ),
                "subagents-spec",
              )}

              {/* Adversarial review (experimental): its section shows only while the switch is saved on. */}
              <Show when={adversarialReview()}>
                {section(
                  "reviewer",
                  "Reviewer",
                  () => reviewerSummary(p()),
                  () => (
                    <>
                      <div class="subagent-editor-switch-line">
                        <label class="toggle toggle-switch settings-team-enable">
                          <span>Review alignments with a reviewer</span>
                          <input
                            type="checkbox"
                            checked={!!p().reviewer}
                            disabled={store.saving()}
                            onChange={(e) => change((x) => (x.reviewer = e.currentTarget.checked ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))}
                          />
                          <span class="toggle-box" />
                        </label>
                        <Show when={p().reviewer}>{(w) => fallbackAction(w, (c) => change((x) => (x.reviewer = c)))}</Show>
                      </div>
                      <Show when={p().reviewer} fallback={<p class="field-hint">No review.</p>}>
                        {(w) => (
                          <>
                            <p class="field-hint settings-delegate-desc">Without a fallback, the review is recorded incomplete when the reviewer can't run.</p>
                            <div class="subagent-editor-flush">{pair("reviewer", w, (c) => change((x) => (x.reviewer = c)))}</div>
                          </>
                        )}
                      </Show>
                    </>
                  ),
                  "subagents-reviewer",
                )}
              </Show>
            </>
          )}
        </Show>
        <p class="settings-delegate-file">
          Stored in <code>{shown() ? tildePath(shown()!.file, home()) : "…"}</code>, shared with pi in the terminal.
        </p>
      </Show>
    </section>
  );
}
