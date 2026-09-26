import { createEffect, createMemo, createResource, createSignal, For, Show, untrack } from "solid-js";
import type { DelegateOptions } from "../../shared/protocol";
import type { TeamDefaults, TeamDefaultsInfo } from "../../shared/team-defaults";
import { getTeamDefaults, getTeamOptions, putTeamDefaults } from "../lib/api";
import { fallbackFor, type DraftChoice, type Slot } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import { setTeamDraft as setDraft, setTeamSaved, teamDirty, teamDraft as draft } from "../lib/team-draft";
import {
  cloneTeam,
  numberIssue,
  numberOf,
  sameTeam,
  TEAM_NUMBER_BOUNDS,
  teamDraftComplete,
  teamDraftConflict,
  teamNumbers,
  type TeamDraft,
  type TeamNumberField,
} from "../lib/team-form";
import { announce, home } from "../lib/ui-state";
import { Banner } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

type RoleKey = "coordinator" | "monitor";

/**
 * Settings → Teams: the standing members every new team gets — a coordinator that owns the thread
 * to the main session, and a monitor that watches context and usage and runs handovers — and how
 * long a replaced member has to hand over. The file is global and shared with the terminal; the
 * subagents extension reads it when a team is created, so a save applies to teams created after it.
 */
export function TeamSettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getTeamDefaults);
  const [options, { refetch: refetchOptions }] = createResource(getTeamOptions);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  /** The settings once loaded. A resource in its error state throws when read, so this never reads it then. */
  const loaded = (): TeamDefaultsInfo | undefined => (info.error ? undefined : info());
  /** Loaded and editable: a file that can't be read is reported, never edited over. */
  const editable = () => {
    const i = loaded();
    return i && !i.error ? i : undefined;
  };

  // Tracks the loaded info only. setTeamSaved reads the draft; tracked, the dialog's reset of the
  // draft on close would re-run this and re-seed the draft from the file as it was, and the next
  // open would show that stale draft over whatever the file says then.
  createEffect(() => {
    const i = editable();
    if (i) untrack(() => setTeamSaved(i.settings));
  });

  const known = (): DelegateOptions | undefined => (options.state === "ready" ? options() : undefined);
  const unlisted = createMemo(() => known()?.backends.filter((b) => b.models === null) ?? []);
  const atDefaults = createMemo(() => {
    const d = draft();
    const i = editable();
    return !!d && !!i && sameTeam(d, withSwitches(i.defaults, d));
  });

  const edit = (change: (copy: TeamDraft) => void) => {
    setSaveError(null);
    const copy = cloneTeam(draft()!);
    change(copy);
    setDraft(copy);
  };
  const updateSlot = (role: RoleKey, slot: Slot, next: DraftChoice | null) =>
    edit((c) => {
      if (slot === "primary") c[role].primary = next!;
      else c[role].fallback = next;
    });
  const setNumber = (field: TeamNumberField, value: number) =>
    edit((c) => {
      if (field === "contextPct" || field === "everyMinutes") c.monitor[field] = value;
      else if (field === "pausePct" || field === "resumeMarginMinutes") c.monitor.usage[field] = value;
      else c.handover.retireTimeoutMinutes = value;
    });

  const conflict = () => (draft() ? teamDraftConflict(draft()!) : null);
  const canSave = () => !saving() && teamDirty() && teamDraftComplete(draft()!) && conflict() === null;

  const save = async () => {
    const d = draft();
    if (!d || !canSave()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = cloneTeam(d) as TeamDefaults;
      body.coordinator.role = body.coordinator.role.trim();
      body.monitor.role = body.monitor.role.trim();
      const result = await putTeamDefaults(body);
      setInfo(result);
      setTeamSaved(result.settings, { replaceDraft: true });
      setWarnings(result.warnings);
      announce("Team defaults saved. Teams created from now on use them.");
    } catch (err) {
      setSaveError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
    } finally {
      setSaving(false);
    }
  };

  const numberField = (field: TeamNumberField, label: string, hint: string) => {
    const id = `team-${field}`;
    const value = () => teamNumbers(draft()!)[field];
    const issue = () => numberIssue(field, value());
    return (
      <div class="field">
        <label class="field-label" for={id}>
          {label}
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
          disabled={saving()}
          onInput={(e) => setNumber(field, numberOf(e.currentTarget.value))}
        />
        <span class={issue() ? "field-error" : "field-hint"} id={`${id}-hint`}>
          {issue() ?? hint}
        </span>
      </div>
    );
  };

  const roleFields = (role: RoleKey) => {
    const r = () => draft()![role];
    const name = role === "coordinator" ? "Coordinator" : "Monitor";
    return (
      <>
        <label class="toggle toggle-switch settings-team-enable">
          <span>Add a {role} to new teams</span>
          <input type="checkbox" checked={r().enabled} disabled={saving()} onChange={(e) => edit((c) => (c[role].enabled = e.currentTarget.checked))} />
          <span class="toggle-box" />
        </label>
        <div class="field settings-team-role">
          <label class="field-label" for={`team-${role}-role`}>
            Role name
          </label>
          <input
            class="input text-mono"
            id={`team-${role}-role`}
            value={r().role}
            maxlength={64}
            spellcheck={false}
            autocomplete="off"
            aria-invalid={r().role.trim() === "" ? "true" : undefined}
            disabled={saving()}
            onInput={(e) => edit((c) => (c[role].role = e.currentTarget.value))}
          />
          <Show when={r().role.trim() === ""}>
            <span class="field-error">Name the role.</span>
          </Show>
        </div>
        <WorkerSlotRow
          idPrefix={`team-${role}`}
          slot="primary"
          info={editable()!}
          options={known()}
          choice={r().primary}
          other={r().fallback}
          disabled={saving()}
          owner="The team"
          otherwise="isn't created"
          onChange={(next) => updateSlot(role, "primary", next)}
        />
        <label class="toggle toggle-switch settings-delegate-fallback-toggle">
          <span>Fallback</span>
          <input
            type="checkbox"
            checked={r().fallback !== null}
            disabled={saving()}
            onChange={(e) => updateSlot(role, "fallback", fallbackFor(r().primary, e.currentTarget.checked))}
          />
          <span class="toggle-box" />
        </label>
        <Show when={r().fallback} fallback={<p class="field-hint">No fallback: if the primary can't run, the team isn't created.</p>}>
          {(fallback) => (
            <WorkerSlotRow
              idPrefix={`team-${role}`}
              slot="fallback"
              info={editable()!}
              options={known()}
              choice={fallback()}
              other={r().primary}
              disabled={saving()}
              owner="The team"
              otherwise="isn't created"
              onChange={(next) => updateSlot(role, "fallback", next)}
            />
          )}
        </Show>
        <div class="field">
          <label class="field-label" for={`team-${role}-instructions`}>
            {name} instructions
          </label>
          <textarea
            class="input textarea"
            id={`team-${role}-instructions`}
            rows={3}
            maxlength={4000}
            value={r().instructions}
            disabled={saving()}
            onInput={(e) => edit((c) => (c[role].instructions = e.currentTarget.value))}
          />
          <span class="field-hint">Added to the {role}'s standing instructions in every new team.</span>
        </div>
      </>
    );
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-team-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-team-title">
          Teams
        </h3>
      </div>
      <p class="settings-intro">
        Standing members every new team gets, here and in the terminal. A change applies to teams created after it. One
        team can opt out when it's created: <code>team_create</code> with <code>defaults.coordinator</code> or{" "}
        <code>defaults.monitor</code> set to <code>false</code>.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the team defaults."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>
      <Show when={loaded()?.error}>
        {(error) => (
          <Banner
            tone="error"
            title="Couldn't read the team defaults file."
            body={`${sentence(error())} We won't overwrite it. Fix or delete ${tildePath(loaded()!.file, home())}, then check again.`}
            action={<RetryButton label="Check Again" onClick={() => void refetchInfo()} />}
          />
        )}
      </Show>
      <Show when={editable() && options.error}>
        <Banner
          tone="warn"
          title="Couldn't check which models are offered."
          body="Your saved choices stay, marked not verified."
          action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
        />
      </Show>
      <Show when={editable()}>
        <For each={unlisted()}>
          {(b) => (
            <Banner
              tone="warn"
              title={`${b.label} couldn't list its models.`}
              body={`${b.error ? `${sentence(b.error)} ` : ""}Choices on it stay as saved and read "not verified" — it isn't saying they're gone.`}
              action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
            />
          )}
        </For>
      </Show>

      <Show when={editable() && draft()}>
        <Show when={!editable()!.stored}>
          <p class="settings-intro" data-testid="team-defaults-unsaved">
            Nothing is saved yet, so new teams get neither member. These are the built-in values; turn a member on and save
            to start.
          </p>
        </Show>

        <fieldset class="settings-delegate-profile" aria-describedby="team-coordinator-desc">
          <legend class="settings-delegate-legend">Coordinator</legend>
          <p class="field-hint settings-delegate-desc" id="team-coordinator-desc">
            Plans and routes the team's work and does none of it itself. It's the only member that reports to the main
            thread; the other members' questions go to it.
          </p>
          {roleFields("coordinator")}
        </fieldset>

        <fieldset class="settings-delegate-profile" aria-describedby="team-monitor-desc">
          <legend class="settings-delegate-legend">Monitor</legend>
          <p class="field-hint settings-delegate-desc" id="team-monitor-desc">
            Wakes itself on its own timer to check each teammate's context and your providers' usage, and messages
            teammates about what it finds. It hands a full member over to a numbered successor (builder → builder-2) and
            pauses and resumes the whole team around usage limits.
          </p>
          {roleFields("monitor")}
          <div class="settings-team-numbers">
            {numberField("contextPct", "Context threshold (%)", "A teammate past this share of its context window hands over.")}
            {numberField("everyMinutes", "Check every (minutes)", "How often the monitor wakes itself.")}
          </div>
          <label class="toggle toggle-switch settings-team-enable">
            <span>Pause the team near a usage limit</span>
            <input
              type="checkbox"
              checked={draft()!.monitor.usage.enabled}
              disabled={saving()}
              onChange={(e) => edit((c) => (c.monitor.usage.enabled = e.currentTarget.checked))}
            />
            <span class="toggle-box" />
          </label>
          <div class="settings-team-numbers">
            {numberField("pausePct", "Pause at (%)", "Of a provider's usage window.")}
            {numberField("resumeMarginMinutes", "Resume margin (minutes)", "Waited after the window resets.")}
          </div>
        </fieldset>

        <fieldset class="settings-delegate-profile">
          <legend class="settings-delegate-legend">Handover</legend>
          <div class="settings-team-numbers">
            {numberField("retireTimeoutMinutes", "Retire timeout (minutes)", "A replaced member is retired when its successor confirms, or after this long.")}
          </div>
        </fieldset>

        <Show when={conflict()}>{(c) => <p class="field-error">{c()}</p>}</Show>
        <Show when={saveError()}>
          {(message) => <Banner tone="error" title="Couldn't save the team defaults." body={`${sentence(message())} Your saved defaults are unchanged.`} />}
        </Show>
        <Show when={warnings().length > 0 && !teamDirty()}>
          <Banner tone="warn" title="Saved, with notes." body={warnings().map(sentence).join(" ")} />
        </Show>

        <div class="settings-delegate-actions">
          <button
            type="button"
            class="button button-ghost"
            disabled={saving() || atDefaults()}
            onClick={() => edit((c) => Object.assign(c, withSwitches(editable()!.defaults, c)))}
          >
            Reset to Defaults
          </button>
          <span class="modal-spacer" />
          <button
            type="button"
            class="button button-ghost"
            disabled={saving() || !teamDirty()}
            onClick={() => {
              setDraft(cloneTeam(editable()!.settings));
              setSaveError(null);
            }}
          >
            Discard Changes
          </button>
          <button type="button" class="button button-primary" disabled={!canSave()} onClick={() => void save()}>
            {saving() ? "Saving…" : "Save Changes"}
          </button>
        </div>
        <p class="settings-delegate-file">
          Stored in <code>{tildePath(editable()!.file, home())}</code>, shared with pi in the terminal.
        </p>
      </Show>
    </section>
  );
}

/** The built-in values with the draft's on/off switches kept: Reset refills values, it doesn't turn members on or off. */
function withSwitches(defaults: TeamDefaults, d: TeamDraft): TeamDraft {
  const next = cloneTeam(defaults);
  next.coordinator.enabled = d.coordinator.enabled;
  next.monitor.enabled = d.monitor.enabled;
  next.monitor.usage.enabled = d.monitor.usage.enabled;
  return next;
}
