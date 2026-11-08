import { createEffect, createResource, createSignal, For, on, Show, untrack, type JSX } from "solid-js";
import type { SubagentProfile, SubagentProfilesInfo } from "../../shared/subagent-profiles";
import type { WorkerChoice } from "../../shared/protocol";
import { getDelegateOptions, getDelegateSettings, getSubagentProfiles, getTeamDefaults, restoreSubagentProfiles } from "../lib/api";
import { replacedNotice } from "../lib/subagent-replaced";
import { cloneProfiles, profileNameIssue, profilesDraft as store, savedOf } from "../lib/subagent-profiles-draft";
import { INSTRUCTIONS_RULE, PROFILE_NAME_RULE, ROLE_RULE, TEAM_NUMBERS, TEAM_RULES, type TeamNumberField } from "../../shared/subagent-limits";
import { teamNumber } from "../../shared/subagent-profile-checks";
import { NumberField, SearchField, Select, TextArea, TextField, Toggle } from "./form";
import { claudeDriftNotes, fallbackFor } from "../lib/delegate-form";
import { filterProfiles, nextSetup } from "../lib/mode-menu";
import { tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { clearSettingsSection, settingsSection, subagentSettingsPath } from "../lib/settings-nav";
import {
  delegateSummary,
  sectionProblems,
  reviewerSummary,
  alignmentSummary,
  withAlignment,
  ALIGN_STYLE_NAMES,
  ALIGN_EAGERNESS_NAMES,
  specSummary,
  teamsSeed,
  teamsSummary,
  withChosenModels,
  withDefaultModel,
  type EditorSection,
} from "../lib/subagent-editor";
import { Banner, Chip, Icon } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";
import { adversarialReview } from "../lib/align-review";
import "./SubagentProfilesSettings.css";

const HOST = { value: "host", label: "Use host default" };
const ALIGN_EAGERNESS = ["eager", "careful"] as const;
const ALIGN_STYLES = ["pm", "simplified", "default"] as const;
const labels = { planning: "Planning & specs", investigation: "Investigation", routine: "Routine implementation", complex: "Complex implementation" } as const;

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
  /** The legacy team defaults, what Choose Models gives a profile that has no saved roles. */
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
  /** A restore's answer, until the next save answers instead (§chat.subagent-profiles/replaced). */
  const [restoredInfo, setRestoredInfo] = createSignal<SubagentProfilesInfo | null>(null);
  createEffect(on(store.result, () => setRestoredInfo(null), { defer: true }));
  /** What the last write answered (a save's PUT, or a restore) or the load: display facts follow writes at once. */
  const shown = () => restoredInfo() ?? store.result() ?? safeInfo();
  const footprintOf = (id: string) => shown()?.profiles.find((x) => x.id === id)?.footprint;

  // Another device's copy changed the library in the last day (§chat.subagent-profiles/replaced).
  // The load says so; a restore here ends it at once, whatever answer is still on screen.
  const [restoredFile, setRestoredFile] = createSignal<string | null>(null);
  const [restoring, setRestoring] = createSignal(false);
  const [restoreError, setRestoreError] = createSignal<string | null>(null);
  const replaced = () => {
    const r = safeInfo()?.replaced;
    return r && r.file !== restoredFile() ? r : undefined;
  };
  const restore = async (file: string) => {
    if (store.dirty() || restoring()) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const next = await restoreSubagentProfiles(file);
      setRestoredFile(file);
      setRestoredInfo(next);
      // The restored library is what is saved now; the (clean) draft follows it.
      store.acceptSave(savedOf(next));
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  };

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
  /** Replace the edited profile with `fn`'s answer (Choose Models and Use Default Model build a whole new profile). */
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
  /** What Choose Models gives the roles: the profile's saved roles, else the legacy team defaults. */
  const seedFor = (id: string) => teamsSeed(store.saved()?.profiles.find((x) => x.id === id)?.teams, teams.error ? undefined : teams()?.defaults);

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
  /** A teams number box: the draft holds what was typed (red, Save waits), the save its number. */
  const number = (field: TeamNumberField) => {
    const path = TEAM_NUMBERS[field].path;
    return (
      <NumberField
        class="subagent-editor-number"
        id={`subagents-${editing()}-${field}`}
        label={TEAM_RULES[field].label}
        hint={TEAM_NUMBERS[field].hint}
        rule={TEAM_RULES[field]}
        value={String(teamNumber(edit()?.teams, field) ?? "")}
        disabled={store.saving()}
        onInput={(raw) => change((x) => (path.slice(0, -1).reduce<any>((o, k) => o[k], x.teams)[path.at(-1)!] = raw))}
      />
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
              <Show when={restoreError()}>
                {(e) => <Banner tone="error" title="Couldn't restore your previous library." body={`${sentence(e())} Your library is unchanged.`} />}
              </Show>
              <Show when={replaced()}>
                {(r) => {
                  const notice = () => replacedNotice(r());
                  return (
                    <Banner
                      tone="info"
                      title={notice().title}
                      body={notice().body}
                      action={
                        <button
                          type="button"
                          class="button button-sm"
                          disabled={store.dirty() || store.saving() || restoring()}
                          title={store.dirty() ? "Save or discard your Subagents changes first" : undefined}
                          onClick={() => void restore(r().file)}
                        >
                          {restoring() ? "Restoring…" : "Restore Previous Library"}
                        </button>
                      }
                    />
                  );
                }}
              </Show>
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
                <SearchField id="subagents-search" label="Find a subagent profile" value={search()} onInput={setSearch} />
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
              <TextField
                class="settings-team-role subagent-editor-name"
                id="subagents-name"
                label="Profile name"
                hint={<span class="text-mono">{footprintOf(p().id) ?? "Not saved yet"}</span>}
                rule={PROFILE_NAME_RULE}
                error={profileNameIssue(store.draft()!, p().id)}
                value={p().name}
                disabled={store.saving()}
                onInput={(raw) => change((x) => (x.name = raw))}
              />

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
                    <Show
                      when={p().teams}
                      fallback={
                        <div class="button-row">
                          <button
                            type="button"
                            class="button button-sm"
                            disabled={store.saving() || seedFor(p().id) === null}
                            onClick={() => replace((x) => withChosenModels(x, seedFor(x.id)))}
                          >
                            Choose Models
                          </button>
                        </div>
                      }
                    >
                      <p class="field-hint settings-delegate-desc">Without a fallback, a role whose primary can't run uses the chat's own model. With one, a role whose primary runs out of usage during the team moves to it.</p>
                      <div class="button-row">
                        <button type="button" class="button button-sm" disabled={store.saving()} onClick={() => replace(withDefaultModel)}>
                          Use Default Model
                        </button>
                      </div>
                    </Show>
                    <For each={["coordinator", "monitor"] as const}>
                      {(role) => {
                        const name = role === "coordinator" ? "Coordinator" : "Monitor";
                        const t = () => p().teams;
                        /** The Instructions fold opens itself when the role name goes blank, and stays as the user leaves it. */
                        const [instructionsOpen, setInstructionsOpen] = createSignal(false);
                        createEffect(() => {
                          if (p().teams?.[role].role.trim() === "") setInstructionsOpen(true);
                        });
                        const choice = () => ({
                          primary: { ...t()![role].primary, effort: t()![role].primary.effort ?? "" },
                          fallback: t()![role].fallback ? { ...t()![role].fallback!, effort: t()![role].fallback!.effort ?? "" } : null,
                        });
                        const update = (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => change((x) => Object.assign(x.teams![role], c));
                        return (
                          <fieldset class="subagent-editor-route">
                            <legend class="subagent-editor-route-name">{name}</legend>
                            <Show when={t()} fallback={<p class="field-hint">Uses the default model</p>}>
                              {fallbackAction(choice, update)}
                              {pair(role, choice, update)}
                              <Show when={role === "monitor"}>
                                <div class="subagent-editor-sub">
                                  <div class="settings-team-numbers">
                                    {number("contextPct")}
                                    {number("everyMinutes")}
                                  </div>
                                  <Toggle
                                    switch
                                    class="settings-team-enable"
                                    label="Pause the team near a usage limit"
                                    checked={t()!.monitor.usage.enabled}
                                    disabled={store.saving()}
                                    onChange={(v) => change((x) => (x.teams!.monitor.usage.enabled = v))}
                                  />
                                  <Show when={t()!.monitor.usage.enabled}>
                                    <div class="settings-team-numbers">
                                      {number("pausePct")}
                                      {number("resumeMarginMinutes")}
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
                                  <TextField
                                    class="settings-team-role"
                                    inputClass="text-mono"
                                    id={`subagents-${editing()}-${role}-role`}
                                    label="Role name"
                                    rule={ROLE_RULE}
                                    ruleLabel={`${name} role name`}
                                    value={t()![role].role}
                                    spellcheck={false}
                                    autocomplete="off"
                                    disabled={store.saving()}
                                    onInput={(raw) => change((x) => (x.teams![role].role = raw))}
                                  />
                                  <TextArea
                                    id={`subagents-${editing()}-${role}-instructions`}
                                    label={`${name} instructions`}
                                    hint={`Added to the ${role}'s standing instructions in every new team.`}
                                    rule={INSTRUCTIONS_RULE}
                                    ruleLabel={`${name} instructions`}
                                    rows={3}
                                    value={t()![role].instructions}
                                    disabled={store.saving()}
                                    onInput={(raw) => change((x) => (x.teams![role].instructions = raw))}
                                  />
                                </div>
                              </details>
                            </Show>
                          </fieldset>
                        );
                      }}
                    </For>
                    <Show when={p().teams}>
                      <fieldset class="subagent-editor-route">
                        <legend class="subagent-editor-route-name">Handover</legend>
                        <div class="settings-team-numbers">{number("retireTimeoutMinutes")}</div>
                      </fieldset>
                    </Show>
                    <fieldset class="subagent-editor-route subagent-editor-flush">
                      <legend class="subagent-editor-route-name">Members default</legend>
                      <Toggle
                        switch
                        class="settings-team-enable"
                        label="Choose a model for ordinary members"
                        checked={p().members !== null}
                        disabled={store.saving()}
                        onChange={(v) => change((x) => (x.members = v ? { backend: "pi", model: "", effort: "" } : null))}
                      />
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
                      <Toggle
                        switch
                        class="settings-team-enable"
                        label="Use a spec writer while spec is on"
                        checked={p().specWriter !== null}
                        disabled={store.saving()}
                        onChange={(v) => change((x) => (x.specWriter = v ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))}
                      />
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

              {/* Adversarial review: its section shows only while the switch is saved on. */}
              <Show when={adversarialReview()}>
                {section(
                  "reviewer",
                  "Reviewer",
                  () => reviewerSummary(p()),
                  () => (
                    <>
                      <div class="subagent-editor-switch-line">
                        <Toggle
                          switch
                          class="settings-team-enable"
                          label="Review alignments with a reviewer"
                          checked={!!p().reviewer}
                          disabled={store.saving()}
                          onChange={(v) => change((x) => (x.reviewer = v ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))}
                        />
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

              {/* The align mode's Eagerness, writing style and Visuals for chats on this profile (§chat.subagent-profiles/settings):
                  "Use host default" stores nothing, so a profile without an override reads as before. */}
              {section(
                "alignment",
                "Alignment",
                () => alignmentSummary(p()),
                () => {
                  const setAlign = (patch: Parameters<typeof withAlignment>[1]) =>
                    change((x) => {
                      const next = withAlignment(x, patch).alignment;
                      if (next) x.alignment = next;
                      else delete x.alignment;
                    });
                  return (
                    <>
                      <p class="field-hint settings-delegate-desc">How the align mode writes for chats on this profile; "Use host default" follows Settings → Alignment.</p>
                      <div class="public-links-row">
                        <Select
                          class="settings-field"
                          label="Eagerness"
                          value={p().alignment?.eagerness ?? "host"}
                          options={[HOST, ...ALIGN_EAGERNESS.map((v) => ({ value: v, label: ALIGN_EAGERNESS_NAMES[v] }))]}
                          disabled={store.saving()}
                          onChange={(v) => setAlign({ eagerness: v as "host" | "eager" | "careful" })}
                        />
                        <Select
                          class="settings-field"
                          label="Writing style"
                          value={p().alignment?.style ?? "host"}
                          options={[HOST, ...ALIGN_STYLES.map((v) => ({ value: v, label: ALIGN_STYLE_NAMES[v] }))]}
                          disabled={store.saving()}
                          onChange={(v) => setAlign({ style: v as "host" | "default" | "simplified" | "pm" })}
                        />
                        <Select
                          class="settings-field"
                          label="Visuals"
                          value={p().alignment?.visuals === undefined ? "host" : p().alignment?.visuals ? "on" : "off"}
                          options={[HOST, { value: "on", label: "On" }, { value: "off", label: "Off" }]}
                          disabled={store.saving()}
                          onChange={(v) => setAlign({ visuals: v === "host" ? "host" : v === "on" })}
                        />
                      </div>
                      <p class="field-hint">An eagerness or style change reaches this profile's open chats at their next message; Visuals, sessions started after saving.</p>
                    </>
                  );
                },
                "subagents-alignment",
              )}
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
