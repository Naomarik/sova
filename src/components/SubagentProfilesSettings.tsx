import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import type { WorkerChoice } from "../../shared/protocol";
import { getDelegateOptions, getDelegateSettings, getSubagentProfiles, getTeamDefaults } from "../lib/api";
import { cloneProfiles, profilesDraft as store, savedOf } from "../lib/subagent-profiles-draft";
import { fallbackFor } from "../lib/delegate-form";
import { filterProfiles, nextSetup } from "../lib/mode-menu";
import { numberIssue, numberOf, TEAM_NUMBER_BOUNDS, type TeamNumberField } from "../lib/team-form";
import { tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { clearSettingsSection, settingsSection, subagentSettingsPath } from "../lib/settings-nav";
import { Banner, Chip, Icon } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";
import { adversarialReview } from "../lib/align-review";

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
 * Settings → Subagents: the whole library, one editor at a
 * time. Off is built in and immutable; every other profile is the same rows, validation and save
 * rules Delegate's and Teams' own screens had. The dialog's Save Changes writes the whole file,
 * so a save reaches every chat on a changed profile from its next turn or team action.
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
  /** The legacy team defaults, for seeding a profile's teams toggle and nothing else. */
  const [teams] = createResource(getTeamDefaults);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal("");
  let editorEl!: HTMLElement;

  /** The resource read only when it isn't in an error state. */
  const safeInfo = () => (info.error ? undefined : info());
  /** What the last save wrote (the draft store's PUT answer) or the load: display facts follow writes at once. */
  const shown = () => store.result() ?? safeInfo();
  const footprintOf = (id: string) => shown()?.profiles.find((x) => x.id === id)?.footprint;

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
    if ((fromChat || forSpec) && id !== null && id !== "off" && i.settings.profiles.some((p) => p.id === id)) setEditing(id);
  });
  // Opened from the mode menu's "Configure Spec": bring the spec writer into view once it renders.
  createEffect(() => {
    if (settingsSection() !== "spec" || !edit()) return;
    clearSettingsSection();
    requestAnimationFrame(() => document.getElementById("subagents-spec")?.scrollIntoView({ block: "start" }));
  });
  // Opening a profile's editor brings it into view once.
  createEffect(() => {
    if (editing() === null) return;
    queueMicrotask(() => editorEl?.scrollIntoView({ block: "start" }));
  });

  const edit = () => store.draft()?.profiles.find((p) => p.id === editing());
  const change = (fn: (p: SubagentProfile) => void) => {
    const copy = cloneProfiles(store.draft()!);
    const p = copy.profiles.find((x) => x.id === editing());
    if (p) {
      fn(p);
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
    setEditing(p.id);
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

  // Accessor args, not values: these factories are invoked once when their <Show> mounts, so a
  // plain `c()` read there would freeze the row on the toggle's first state (the members/spec bug).
  // The thunk reads the draft every time the row's props are read.
  const tuple = (role: string, choice: () => WorkerChoice, other: () => WorkerChoice | null, onChange: (c: WorkerChoice) => void, slot: "primary" | "fallback" = "primary") => (
    <Show when={rows()}>
      {(r) => <WorkerSlotRow idPrefix={`subagents-${editing()}-${role}`} slot={slot} info={r()} options={options.state === "ready" ? options() : undefined} choice={choice()} other={other()} disabled={store.saving()} onChange={onChange} />}
    </Show>
  );
  const pair = (role: string, choice: () => { primary: WorkerChoice; fallback: WorkerChoice | null }, update: (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => void, noFallback: string) => (
    <>
      {tuple(role, () => choice().primary, () => choice().fallback, (c) => update({ ...choice(), primary: c }))}
      <label class="toggle toggle-switch settings-delegate-fallback-toggle">
        <span>Fallback</span>
        <input type="checkbox" checked={choice().fallback !== null} disabled={store.saving()} onChange={(e) => update({ ...choice(), fallback: fallbackFor(choice().primary, e.currentTarget.checked) })} />
        <span class="toggle-box" />
      </label>
      <Show when={choice().fallback} fallback={<p class="field-hint">{noFallback}</p>}>
        {(f) => tuple(role, f, () => choice().primary, (c) => update({ ...choice(), fallback: c }), "fallback")}
      </Show>
    </>
  );
  const number = (field: TeamNumberField, value: () => number, update: (n: number) => void) => {
    const id = `subagents-${editing()}-${field}`;
    const issue = () => numberIssue(field, value());
    return (
      <div class="field">
        <label class="field-label" for={id}>
          {NUMBER_LABELS[field]}
        </label>
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
    );
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-subagents-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-subagents-title">
          Subagent profiles
        </h3>
      </div>
      <p class="settings-intro">
        One bundle of every model your subagents are given: Delegate's routing, teams, and the spec writer. A chat picks one in its
        mode menu; new chats start on the default. Saving changes the library for every chat on the changed profile, from its next
        turn or team action — running workers keep their models.
      </p>

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
        <div class="button-row">
          <button type="button" class="button button-ghost" disabled={store.dirty() || store.saving()} onClick={() => newProfile()}>
            <Icon name="plus" small />
            New Profile
          </button>
          <button
            type="button"
            class="button button-ghost"
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
        <div class="list" aria-label="Subagent profiles">
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
                <div class="button-row">
                  <button type="button" class="button button-sm button-ghost" disabled={store.dirty() || store.saving()} onClick={() => setEditing(p.id)}>
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

        <Show when={edit()}>
          {(p) => (
            <section class="settings-subagents-editor" aria-labelledby="subagents-editor-title" ref={editorEl}>
              <h4 class="settings-subagents-group" id="subagents-editor-title">
                Edit “{p().name}”
              </h4>
              <Show when={safeInfo()?.current.id === "off" && subagentSettingsPath()}>
                <Banner tone="info" title="This chat is on Off." body="Off configures nothing: the agent picks every model. Editing a profile here doesn't switch the chat." />
              </Show>
              <div class="field">
                <label class="field-label" for="subagents-name">
                  Profile name
                </label>
                <input class="input" id="subagents-name" maxlength={48} value={p().name} disabled={store.saving()} onInput={(e) => change((x) => (x.name = e.currentTarget.value))} />
              </div>

              <h5 class="settings-subagents-group">Delegate routing</h5>
              <For each={Object.keys(labels) as (keyof typeof labels)[]}>
                {(k) => (
                  <fieldset class="settings-delegate-profile">
                    <legend class="settings-delegate-legend">{labels[k]}</legend>
                    {pair(k, () => p().delegate[k], (c) => change((x) => (x.delegate[k] = c)), "No fallback: if the primary can't run, the agent asks you which model to use.")}
                  </fieldset>
                )}
              </For>

              <h5 class="settings-subagents-group">Teams</h5>
              <label class="toggle toggle-switch settings-team-enable">
                <span>Add a standing coordinator and monitor to new teams</span>
                <input
                  type="checkbox"
                  disabled={store.saving() || !teams() || !!teams.error}
                  checked={p().teams !== null}
                  onChange={(e) =>
                    change((x) => {
                      const t = teams.error ? undefined : teams()?.defaults;
                      // The legacy defaults were born of the same store's parse, so the wire type's wide
                      // `string` effort is really the tuple's union; the next save's parse rechecks it.
                      x.teams = e.currentTarget.checked && t ? (cloneProfiles({ coordinator: t.coordinator, monitor: t.monitor, handover: t.handover }) as TeamsSetting) : null;
                    })
                  }
                />
                <span class="toggle-box" />
              </label>
              <Show when={p().teams} fallback={<p class="field-hint">No standing members: each team starts with only the workers the call names.</p>}>
                {(t) => (
                  <>
                    <For each={["coordinator", "monitor"] as const}>
                      {(role) => (
                        <fieldset class="settings-delegate-profile">
                          <legend class="settings-delegate-legend">{role === "coordinator" ? "Coordinator" : "Monitor"}</legend>
                          <label class="toggle toggle-switch settings-team-enable">
                            <span>Add a {role} to new teams</span>
                            <input type="checkbox" checked={t()[role].enabled} disabled={store.saving()} onChange={(e) => change((x) => (x.teams![role].enabled = e.currentTarget.checked))} />
                            <span class="toggle-box" />
                          </label>
                          <div class="field settings-team-role">
                            <label class="field-label" for={`subagents-${editing()}-${role}-role`}>
                              Role name
                            </label>
                            <input
                              class="input text-mono"
                              id={`subagents-${editing()}-${role}-role`}
                              value={t()[role].role}
                              maxlength={64}
                              spellcheck={false}
                              autocomplete="off"
                              aria-invalid={t()[role].role.trim() === "" ? "true" : undefined}
                              disabled={store.saving()}
                              onInput={(e) => change((x) => (x.teams![role].role = e.currentTarget.value))}
                            />
                            <Show when={t()[role].role.trim() === ""}>
                              <span class="field-error">Name the role.</span>
                            </Show>
                          </div>
                          {pair(
                            role,
                            () => ({ primary: { ...t()[role].primary, effort: t()[role].primary.effort ?? "" }, fallback: t()[role].fallback ? { ...t()[role].fallback!, effort: t()[role].fallback!.effort ?? "" } : null }),
                            (c) => change((x) => Object.assign(x.teams![role], c)),
                            "No fallback: if the primary can't run, the team isn't created.",
                          )}
                          <div class="field">
                            <label class="field-label" for={`subagents-${editing()}-${role}-instructions`}>
                              {role === "coordinator" ? "Coordinator" : "Monitor"} instructions
                            </label>
                            <textarea
                              class="input textarea"
                              id={`subagents-${editing()}-${role}-instructions`}
                              rows={3}
                              maxlength={4000}
                              value={t()[role].instructions}
                              disabled={store.saving()}
                              onInput={(e) => change((x) => (x.teams![role].instructions = e.currentTarget.value))}
                            />
                            <span class="field-hint">Added to the {role}'s standing instructions in every new team.</span>
                          </div>
                        </fieldset>
                      )}
                    </For>
                    <div class="settings-team-numbers">
                      {number("contextPct", () => t().monitor.contextPct, (n) => change((x) => (x.teams!.monitor.contextPct = n)))}
                      {number("everyMinutes", () => t().monitor.everyMinutes, (n) => change((x) => (x.teams!.monitor.everyMinutes = n)))}
                    </div>
                    <label class="toggle toggle-switch settings-team-enable">
                      <span>Pause the team near a usage limit</span>
                      <input type="checkbox" checked={t().monitor.usage.enabled} disabled={store.saving()} onChange={(e) => change((x) => (x.teams!.monitor.usage.enabled = e.currentTarget.checked))} />
                      <span class="toggle-box" />
                    </label>
                    <Show when={t().monitor.usage.enabled}>
                      <div class="settings-team-numbers">
                        {number("pausePct", () => t().monitor.usage.pausePct, (n) => change((x) => (x.teams!.monitor.usage.pausePct = n)))}
                        {number("resumeMarginMinutes", () => t().monitor.usage.resumeMarginMinutes, (n) => change((x) => (x.teams!.monitor.usage.resumeMarginMinutes = n)))}
                      </div>
                    </Show>
                    <div class="settings-team-numbers">{number("retireTimeoutMinutes", () => t().handover.retireTimeoutMinutes, (n) => change((x) => (x.teams!.handover.retireTimeoutMinutes = n)))}</div>
                  </>
                )}
              </Show>
              <fieldset class="settings-delegate-profile">
                <legend class="settings-delegate-legend">Members default</legend>
                <label class="toggle toggle-switch settings-team-enable">
                  <span>Choose a model for ordinary members</span>
                  <input type="checkbox" checked={p().members !== null} disabled={store.saving()} onChange={(e) => change((x) => (x.members = e.currentTarget.checked ? { backend: "pi", model: "", effort: "" } : null))} />
                  <span class="toggle-box" />
                </label>
                <Show when={p().members} fallback={<p class="field-hint">A member nobody gave a model runs on its team lead's model.</p>}>
                  {(m) => tuple("members", m, () => null, (c) => change((x) => (x.members = c)))}
                </Show>
              </fieldset>

              <h5 class="settings-subagents-group">Spec writer</h5>
              <fieldset class="settings-delegate-profile" id="subagents-spec">
                <legend class="settings-delegate-legend">Spec writer</legend>
                <label class="toggle toggle-switch settings-team-enable">
                  <span>Use a spec writer while spec is on</span>
                  <input type="checkbox" checked={p().specWriter !== null} disabled={store.saving()} onChange={(e) => change((x) => (x.specWriter = e.currentTarget.checked ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))} />
                  <span class="toggle-box" />
                </label>
                <Show when={p().specWriter} fallback={<p class="field-hint">The session writes the spec itself.</p>}>
                  {(w) => pair("spec", w, (c) => change((x) => (x.specWriter = c)), "No fallback: if the primary can't run, the session writes the spec itself.")}
                </Show>
              </fieldset>

              {/* Adversarial review (experimental, §chat.alignment-review/route): only while it is on. */}
              <Show when={adversarialReview()}>
                <h5 class="settings-subagents-group">Reviewer</h5>
                <fieldset class="settings-delegate-profile" id="subagents-reviewer">
                  <legend class="settings-delegate-legend">Reviewer</legend>
                  <label class="toggle toggle-switch settings-team-enable">
                    <span>Review alignments with a reviewer</span>
                    <input type="checkbox" checked={!!p().reviewer} disabled={store.saving()} onChange={(e) => change((x) => (x.reviewer = e.currentTarget.checked ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))} />
                    <span class="toggle-box" />
                  </label>
                  <Show when={p().reviewer} fallback={<p class="field-hint">No review.</p>}>
                    {(w) => pair("reviewer", w, (c) => change((x) => (x.reviewer = c)), "No fallback: if the primary can't run, the review is recorded incomplete.")}
                  </Show>
                </fieldset>
              </Show>
            </section>
          )}
        </Show>
        <p class="settings-delegate-file">
          Stored in <code>{shown() ? tildePath(shown()!.file, home()) : "…"}</code>, shared with pi in the terminal.
        </p>
      </Show>
    </section>
  );
}
