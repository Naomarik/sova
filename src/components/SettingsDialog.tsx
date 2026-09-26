import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import type { ThemeInfo } from "../../shared/protocol";
import { getClaudeCliStatus, getThemes, getWebSettings, putModelPolicy, putWebSettings } from "../lib/api";
import { tildePath } from "../lib/format";
import {
  cacheModelPolicy,
  CLAUDE_CODE_PROVIDER,
  enabledCount,
  loadModelPolicy,
  modelEnabled,
  modelSubagentEnabled,
  modelSubagentPreference,
  providerEnabled,
  providerSubagentEnabled,
  providerSubagentPreference,
  setModelEnabled,
  setModelSubagents,
  setProviderEnabled,
  setProviderSubagents,
  type ModelPolicy,
} from "../lib/model-policy";
import { ensureModels } from "../lib/models";
import { providerGrouper, type ProviderGroup } from "../lib/provider-groups";
import { createPoll } from "../lib/poll";
import {
  DEFAULT_RECENT_COUNT,
  MAX_RECENT_COUNT,
  MIN_RECENT_COUNT,
  parseRecentCount,
  recentCount,
  recentCountValid,
  setRecentCount,
} from "../lib/recent";
import { setShowSummaries, showSummaries } from "../lib/summary-line";
import { activeThemeId, applyTheme, droppedThemeId, reconcileTheme, typography } from "../lib/theme";
import type { SettingsTab } from "../lib/settings-nav";
import { delegateDirty, resetDelegateDraft } from "../lib/delegate-draft";
import { resetSpecDraft, specDirty } from "../lib/spec-draft";
import { resetTeamDraft, teamDirty } from "../lib/team-draft";
import { overseerDirty, resetOverseerDraft } from "../lib/overseer-draft";
import { resetDecisionDraft } from "../lib/decision-draft";
import { effectiveStack } from "../lib/typography";
import { announce, home } from "../lib/ui-state";
import { DecisionSettingsSection } from "./DecisionSettings";
import { DelegateSettingsSection } from "./DelegateSettings";
import { MeshSettingsSection } from "./MeshSettings";
import { SpecSettingsSection } from "./SpecSettings";
import { OverseerSettingsSection } from "./OverseerSettings";
import { SummarizerSettingsSection } from "./SummarizerSettings";
import { TeamSettingsSection } from "./TeamSettings";
import { TypographySection } from "./TypographySection";
import { Banner, Icon, trapFocus } from "./ui";

/** The tab rail. Ten screens; the rail is the structure further settings slot into. General is
    first because it is the one screen about this browser's own behaviour rather than a subsystem.
    Same ids, same order as `SETTINGS_TABS` (lib/settings-nav.ts), which is what opens it. */
const TABS = [
  { id: "general", label: "General", icon: "settings" as const },
  { id: "models", label: "Models", icon: "sliders" as const },
  { id: "modes", label: "Modes", icon: "worker" as const },
  { id: "teams", label: "Teams", icon: "command" as const },
  { id: "overseer", label: "Overseer", icon: "eye" as const },
  { id: "decisions", label: "Decisions", icon: "shield" as const },
  { id: "summaries", label: "Summaries", icon: "chat" as const },
  { id: "themes", label: "Themes", icon: "image" as const },
  { id: "mesh", label: "Mesh", icon: "branch" as const },
  { id: "experimental", label: "Experimental", icon: "terminal" as const },
] as const satisfies readonly { id: SettingsTab; label: string; icon: string }[];
type TabId = (typeof TABS)[number]["id"];

/**
 * The Settings dialog: a modal with a left tab rail. Models edits the
 * policy file every session reads — this browser, the TUI, and every subagent — so a switch here
 * is a rule, not a filter. Themes picks what this browser wears; that one is localStorage only.
 */
export function SettingsDialog(props: { onClose(): void; initialTab?: SettingsTab }) {
  // The tab it opens at (General unless a caller — the mode menu's "Configure Delegate" — asks for
  // another) is also the one `onMount` focuses: the two have to agree, or the dialog opens with
  // focus on a tab that isn't the selected one.
  const [tab, setTab] = createSignal<TabId>(props.initialTab ?? "general");
  const [webSettings, { refetch: refetchSettings }] = createResource(() => getWebSettings());
  /** The switch as the user has set it: the stored value, then optimistic toggles. */
  const [claudeCodeOn, setClaudeCodeOn] = createSignal(false);
  const [settingsError, setSettingsError] = createSignal<string | null>(null);
  const [savingSettings, setSavingSettings] = createSignal(false);
  createEffect(() => {
    const s = webSettings();
    if (s) setClaudeCodeOn(s.experimental.claudeCodeProvider);
  });
  // Only probed when the tab is open: it spawns `claude --version` on the server.
  const [cliStatus, { refetch: refetchCliStatus }] = createResource(
    () => tab() === "experimental",
    (open) => (open ? getClaudeCliStatus() : undefined),
  );

  /** One line of truth about the CLI, so the switch is never the only thing the user has to go on. */
  const statusLine = () => {
    if (cliStatus.loading) return "Checking for the Claude Code CLI…";
    const status = cliStatus();
    if (!status) return "";
    if (status.error) return `Claude Code CLI: ${status.error}`;
    const count = status.models ?? 0;
    if (!claudeCodeOn()) return `Claude Code CLI ${status.version} found. Switch on to add its models.`;
    return count > 0
      ? `Claude Code CLI ${status.version} · ${count} ${count === 1 ? "model" : "models"} in the picker.`
      : `Claude Code CLI ${status.version} found, but no models are registered yet — start a session, or restart the server.`;
  };

  /** Save the switch; put it back and say so if the write fails. */
  const toggleClaudeCode = async () => {
    const before = claudeCodeOn();
    setClaudeCodeOn(!before);
    setSettingsError(null);
    setSavingSettings(true);
    try {
      await putWebSettings({ experimental: { claudeCodeProvider: !before } });
      void refetchSettings();
      // Turning it on registers the provider server-side, so the count in the status line is
      // already out of date by the time the PUT returns. Without this the line keeps saying
      // "no models are registered yet — start a session, or restart the server" while the
      // picker has them, which is worse than no status line at all.
      void refetchCliStatus();
    } catch (err) {
      setClaudeCodeOn(before);
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSettings(false);
    }
  };

  /** Close was asked for over unsaved edits (Delegate, Spec, Teams or Overseer): the foot asks what to do with them. Decisions saves as it goes. */
  const [closeHeld, setCloseHeld] = createSignal(false);
  const modesDirty = () => delegateDirty() || specDirty() || teamDirty() || overseerDirty();
  /** Which unsaved screens the hold names: "Delegate", "Spec", "Teams", "Overseer", joined. */
  const unsavedNames = () => {
    const names = [delegateDirty() && "Delegate", specDirty() && "Spec", teamDirty() && "Teams", overseerDirty() && "Overseer"].filter(Boolean) as string[];
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
  };
  const resetModesDrafts = () => {
    resetDelegateDraft();
    resetSpecDraft();
    resetTeamDraft();
    resetOverseerDraft();
    resetDecisionDraft();
  };
  /** Every way out (Close, Esc, the scrim) comes through here, so none of them drops a draft silently. */
  const requestClose = () => {
    if (modesDirty()) {
      // To the screen that holds the edit, unless the one showing already does.
      const here = tab() === "overseer" ? overseerDirty() : tab() === "modes" ? delegateDirty() || specDirty() : tab() === "teams" ? teamDirty() : false;
      if (!here) setTab(delegateDirty() || specDirty() ? "modes" : teamDirty() ? "teams" : "overseer");
      setCloseHeld(true);
      return;
    }
    resetModesDrafts();
    props.onClose();
  };
  const discardAndClose = () => {
    resetModesDrafts();
    props.onClose();
  };

  const tabButtons = new Map<TabId, HTMLButtonElement>();
  onMount(() => tabButtons.get(tab())?.focus());

  return (
    <>
      <div class="scrim" onClick={requestClose} />
      <div
        class="modal modal-wide settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") requestClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id="settings-title">
            Settings
          </h2>
        </div>
        <div class="settings-body">
          <nav class="settings-tabs" aria-label="Settings sections" role="tablist" aria-orientation="vertical">
            <For each={TABS}>
              {(t) => (
                <button
                  type="button"
                  role="tab"
                  class="settings-tab"
                  aria-selected={tab() === t.id}
                  aria-controls={`settings-panel-${t.id}`}
                  id={`settings-tab-${t.id}`}
                  tabindex={tab() === t.id ? 0 : -1}
                  ref={(el) => tabButtons.set(t.id, el)}
                  // The one tab the mesh adds: the parity check with the mesh off removes it.
                  data-mesh-ui={t.id === "mesh" ? "" : undefined}
                  onClick={() => setTab(t.id)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const delta = e.key === "ArrowDown" ? 1 : -1;
                      const idx = (TABS.findIndex((x) => x.id === tab()) + delta + TABS.length) % TABS.length;
                      const next = TABS[idx] ?? t; // a bad index can only mean one tab: stay on it
                      setTab(next.id);
                      (document.getElementById(`settings-tab-${next.id}`) as HTMLButtonElement | null)?.focus();
                    }
                  }}
                >
                  <Icon name={t.icon} small />
                  <span>{t.label}</span>
                </button>
              )}
            </For>
          </nav>
          <Show when={tab() === "general"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
              <GeneralPanel />
            </div>
          </Show>
          <Show when={tab() === "models"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models">
              <ModelsPanel />
            </div>
          </Show>
          {/* Mounted only while its tab is: the backend discovery (a Claude Code CLI call) runs
              when the tab opens, not with the dialog. */}
          <Show when={tab() === "modes"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-modes" aria-labelledby="settings-tab-modes">
              <DelegateSettingsSection />
              <SpecSettingsSection />
            </div>
          </Show>
          {/* Mounted only while its tab is, like Modes: it asks the same backend discovery. */}
          <Show when={tab() === "teams"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-teams" aria-labelledby="settings-tab-teams">
              <TeamSettingsSection />
            </div>
          </Show>
          <Show when={tab() === "overseer"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-overseer" aria-labelledby="settings-tab-overseer">
              <OverseerSettingsSection />
            </div>
          </Show>
          {/* Mounted only while its tab is, like Modes: it asks the same backend discovery. */}
          <Show when={tab() === "decisions"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-decisions" aria-labelledby="settings-tab-decisions">
              <DecisionSettingsSection />
            </div>
          </Show>
          {/* Mounted only while its tab is, like Modes: it asks the same backend discovery. */}
          <Show when={tab() === "summaries"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-summaries" aria-labelledby="settings-tab-summaries">
              <SummarizerSettingsSection />
            </div>
          </Show>
          {/* The panel is mounted only while its tab is: the themes poll starts when this tab
              opens and stops with it, which is the lifecycle the settings dialog spec asks for. */}
          <Show when={tab() === "themes"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-themes" aria-labelledby="settings-tab-themes">
              <ThemesPanel />
            </div>
          </Show>
          {/* Mounted only while its tab is: the mesh settings are read when the tab opens. */}
          <Show when={tab() === "mesh"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-mesh" aria-labelledby="settings-tab-mesh" data-mesh-ui>
              <MeshSettingsSection />
            </div>
          </Show>
          {/* Same lifecycle as the other panels: mounted only while its tab is, so the settings
              and CLI-status resources are read when the tab opens. */}
          <Show when={tab() === "experimental"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-experimental" aria-labelledby="settings-tab-experimental">
              <p class="settings-intro">
                Unfinished features. They can change or disappear, and they apply to sessions you start
                after switching them on — chats already open keep the setup they began with.
              </p>
              <Show when={settingsError()}>
                {(message) => (
                  <Banner
                    tone="error"
                    title="Couldn't save the change"
                    body={`The setting on the server didn't update, so the previous choice stands. ${message()}`}
                  />
                )}
              </Show>
              <ul class="settings-list">
                <li>
                  <label class="toggle toggle-switch settings-provider">
                    <input
                      type="checkbox"
                      checked={claudeCodeOn()}
                      disabled={savingSettings() || webSettings.loading}
                      onChange={() => void toggleClaudeCode()}
                    />
                    <span class="settings-provider-main">
                      <span class="settings-provider-name">Claude Code as first-class models</span>
                      <span class="settings-provider-meta">
                        Runs on your Claude subscription through the Claude Code CLI. pi executes every
                        tool, so its permissions and your mode still apply. Applies to new sessions.
                      </span>
                    </span>
                    <span class="toggle-box" />
                  </label>
                  <p class="settings-intro">{statusLine()}</p>
                </li>
              </ul>
            </div>
          </Show>
        </div>
        <Show when={closeHeld() && modesDirty()}>
          <div class="settings-close-held">
            <Banner
              tone="warn"
              title={`Your ${unsavedNames()} changes aren't saved.`}
              body="Save them on this screen, or discard them and close."
              action={
                <span class="settings-close-held-actions">
                  <button type="button" class="button button-sm button-ghost" onClick={() => setCloseHeld(false)}>
                    Keep Editing
                  </button>
                  <button type="button" class="button button-sm" onClick={discardAndClose}>
                    Discard and Close
                  </button>
                </span>
              }
            />
          </div>
        </Show>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={requestClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * General: preferences about how THIS browser draws the
 * product. Nothing here is written to the machine — no policy file, no server endpoint — which is
 * the line between this screen and Models, and the reason the sidebar's Recent region has no
 * control of its own: a count that could be set in two places would disagree in one of them.
 */
function GeneralPanel() {
  /**
   * The field's own text, not the stored count. A number input hands over "" mid-edit (select-all,
   * then type), and the stored value must not become the default for the one keystroke that takes:
   * a valid draft writes through immediately, an invalid one says why and leaves the count alone.
   */
  const [draft, setDraft] = createSignal(String(recentCount()));
  const invalid = () => !recentCountValid(draft());

  /**
   * What is wrong with the draft, in the form the user can act on. Empty while it is fine.
   *
   * `parseRecentCount` is the same parse the rule uses, and it has to be: an empty field is
   * `Number("") === 0`, so reading the raw text here once had a blank box answered with "3 is the
   * fewest" — the floor offered as the fix for a box the user had simply cleared.
   */
  const problem = () => {
    if (!invalid()) return "";
    const n = parseRecentCount(draft());
    if (n === null) return `Type a whole number from ${MIN_RECENT_COUNT} to ${MAX_RECENT_COUNT}.`;
    if (n < MIN_RECENT_COUNT) return `${MIN_RECENT_COUNT} is the fewest. Below that Recent is a row, not a list.`;
    return `${MAX_RECENT_COUNT} is the most. Past that the shortcut is the list again.`;
  };

  /** Writes a valid draft the moment it is typed — the settings dialog spec's rule: a setting that needed a Save
      button would be lying about when it takes effect. */
  const onInput = (value: string) => {
    setDraft(value);
    if (recentCountValid(value)) setRecentCount(value);
  };

  /** Leaving the field is where an unusable draft gets repaired: it becomes the nearest count
      that works, and the field says so rather than sitting on red. */
  const onCommit = () => {
    const n = setRecentCount(draft());
    const repaired = invalid();
    setDraft(String(n));
    if (repaired) announce(`Recent shows ${n} ${n === 1 ? "session" : "sessions"}.`);
  };

  return (
    <>
      <p class="settings-intro">
        How this browser draws Sova. These stay in this browser — nothing here changes your pi
        config, and another machine keeps its own.
      </p>
      <div class="field settings-field">
        <label class="field-label" for="recent-count">
          Sessions in Recent
        </label>
        <input
          class="input input-num"
          classList={{ "input-invalid": invalid() }}
          id="recent-count"
          type="number"
          inputmode="numeric"
          min={MIN_RECENT_COUNT}
          max={MAX_RECENT_COUNT}
          step={1}
          value={draft()}
          aria-invalid={invalid() ? "true" : undefined}
          aria-describedby={invalid() ? "recent-count-error" : "recent-count-hint"}
          onInput={(e) => onInput(e.currentTarget.value)}
          onChange={onCommit}
          onBlur={onCommit}
        />
        <Show
          when={invalid()}
          fallback={
            <span class="field-hint" id="recent-count-hint">
              The top of the sidebar lists this many sessions, the ones that moved last. They stay
              in Live &amp; web and the Archive too. {MIN_RECENT_COUNT}–{MAX_RECENT_COUNT}, {DEFAULT_RECENT_COUNT} by default.
            </span>
          }
        >
          <span class="field-error" id="recent-count-error">
            {problem()}
          </span>
        </Show>
      </div>
      <div class="field settings-field">
        <label class="toggle toggle-switch">
          <span class="field-label">Summary line</span>
          <input
            type="checkbox"
            checked={showSummaries()}
            aria-describedby="summary-line-hint"
            onChange={(e) => setShowSummaries(e.currentTarget.checked)}
          />
          <span class="toggle-box" />
        </label>
        <span class="field-hint" id="summary-line-hint">
          Under each title in the sidebar, what the session is for. Off, a row is its title and when it was last
          active. A draft's first line still shows.
        </span>
      </div>
    </>
  );
}

/**
 * Settings → Models. One row per provider, its models behind a
 * twisty, and two switches on every row: Enabled, which decides whether the model may be used at
 * all, and Subagents, which decides whether a worker may be given it. Providers are group heads:
 * their switches cover every model under them.
 *
 * Every switch saves the whole policy immediately — the file is read per model change, per turn
 * and per spawn, so "immediately" is the truth — and a failed save puts the switch back and says
 * so. A globally disabled model's Subagents switch is greyed rather than cleared: it remembers
 * what you chose, and turning the model back on returns it.
 */
function ModelsPanel() {
  const [models] = createResource(() => ensureModels());
  const [source, { refetch }] = createResource(() => loadModelPolicy());
  /** The policy as the user has set it: `source` on load, then optimistic switch moves. */
  const [policy, setPolicy] = createSignal<ModelPolicy | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [opened, setOpened] = createSignal<string[]>([]);
  createEffect(() => {
    const p = source();
    if (p) setPolicy(p);
  });

  const busy = () => saving() || source.loading;

  /** One switch moved: write the whole policy, revert and say so if the write fails. */
  const apply = async (next: ModelPolicy) => {
    const before = policy();
    setPolicy(next);
    setSaveError(null);
    setSaving(true);
    try {
      cacheModelPolicy(await putModelPolicy(next)); // the picker follows the same rule, at once
    } catch (err) {
      if (before) setPolicy(before);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  const edit = (change: (p: ModelPolicy) => ModelPolicy) => {
    const current = policy();
    if (current && !busy()) void apply(change(current));
  };

  /** Model rows grouped by provider, name-sorted — the same order the model picker lists — plus
      the Claude Code backend and any provider the policy names that has no models here. The
      grouping follows `models()` alone, so a switch never rebuilds a group (see provider-groups). */
  // The Claude Code backend is a provider of its own: one switch over every Claude worker, its
  // own default model included. It has no rows here because its models are the CLI's, not pi's.
  const grouper = providerGrouper({ provider: CLAUDE_CODE_PROVIDER, models: [], note: "Claude Code workers" });
  const baseGroups = createMemo(() => grouper.byModels(models() ?? []));
  const groups = createMemo<ProviderGroup[]>(() => grouper.withPolicy(baseGroups(), policy()));

  /** Every query token must appear in the provider name or in one of its model refs. */
  const tokens = createMemo(() => query().toLowerCase().split(/\s+/).filter(Boolean));
  const matching = createMemo(() => {
    const words = tokens();
    if (words.length === 0) return groups();
    return groups()
      .map((group) => {
        const hitProvider = words.every((t) => group.provider.includes(t));
        const hits = group.models.filter((m) => words.every((t) => m.ref.toLowerCase().includes(t)));
        if (hitProvider) return group; // the whole group matched: keep all of its models
        return hits.length ? { ...group, models: hits } : null;
      })
      .filter((group): group is ProviderGroup => group !== null);
  });
  const shown = createMemo(() => matching().reduce((sum, group) => sum + group.models.length, 0));
  const total = createMemo(() => (models() ?? []).length);

  // A search opens what it found: hiding the matches behind a twisty would answer the query with
  // a count. Without one, groups stay as the user left them — collapsed, so the list is a list.
  const isOpen = (provider: string) => tokens().length > 0 || opened().includes(provider);
  const toggleOpen = (provider: string) =>
    setOpened((list) => (list.includes(provider) ? list.filter((p) => p !== provider) : [...list, provider]));

  /** What a provider row says about itself: the count that answers "how much of this is on". */
  const providerMeta = (group: ProviderGroup, p: ModelPolicy) => {
    if (group.note) return group.note;
    if (!providerEnabled(p, group.provider)) return `Off · ${group.models.length} ${group.models.length === 1 ? "model" : "models"}`;
    return `${enabledCount(p, group.models)} of ${group.models.length} on`;
  };

  return (
    <>
      <p class="settings-intro">
        What may be used, here and in the terminal, and what subagents may be given. A model that is off
        is refused everywhere — a session already on it asks you to switch before its next message.
      </p>
      <Show when={saveError()}>
        {(message) => (
          <Banner tone="error" title="Couldn't save the change" body={`The policy on the server didn't change, so the previous choice stands. ${message()}`} />
        )}
      </Show>
      <Show
        when={!source.error}
        fallback={
          <Banner
            tone="error"
            title="Couldn't read the model policy"
            body="The list below may not match the server. Nothing was changed."
            action={
              <button type="button" class="button button-sm" onClick={() => void refetch()}>
                Retry
              </button>
            }
          />
        }
      >
        <div class="model-policy-search">
          <div class="search">
            <Icon name="search" />
            <input
              class="input"
              type="search"
              aria-label="Search models and providers"
              placeholder="Search models"
              autocomplete="off"
              spellcheck={false}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
        </div>
        <Show
          when={policy() && models() && !models.loading}
          fallback={
            <div aria-hidden="true">
              <div class="skeleton skeleton-row" />
              <div class="skeleton skeleton-row" />
              <div class="skeleton skeleton-row" />
            </div>
          }
        >
          {(_ready) => {
            const p = () => policy()!;
            return (
              <>
                <div class="model-policy-head">
                  <span>Model</span>
                  <span>Enabled</span>
                  <span>Subagents</span>
                </div>
                <Show
                  when={matching().length > 0}
                  fallback={
                    <p class="model-policy-empty">0 models match “{query().trim()}”.</p>
                  }
                >
                  <ul class="model-policy-list">
                    <For each={matching()}>
                      {(group) => (
                        <li class="model-policy-group">
                          <div class="model-policy-row model-policy-provider">
                            <Show
                              when={group.models.length > 0}
                              fallback={
                                /* A provider with no models of its own keeps the name column's
                                   shape without claiming a control that would open nothing. */
                                <span class="model-policy-twist model-policy-twist-static">
                                  <span class="model-policy-provider-name">{group.provider}</span>
                                  <span class="model-policy-meta">{providerMeta(group, p())}</span>
                                </span>
                              }
                            >
                              <button
                                type="button"
                                class="model-policy-twist"
                                aria-expanded={isOpen(group.provider)}
                                aria-controls={`models-${group.provider}`}
                                onClick={() => toggleOpen(group.provider)}
                              >
                                <Icon name={isOpen(group.provider) ? "chevron-down" : "chevron-right"} small />
                                <span class="model-policy-provider-name">{group.provider}</span>
                                <span class="model-policy-meta">{providerMeta(group, p())}</span>
                              </button>
                            </Show>
                            <label class="toggle toggle-switch model-policy-switch">
                              <input
                                type="checkbox"
                                aria-label={`Enable ${group.provider}`}
                                checked={providerEnabled(p(), group.provider)}
                                disabled={busy()}
                                onChange={(e) => edit((cur) => setProviderEnabled(cur, group.provider, e.currentTarget.checked))}
                              />
                              <span class="toggle-box" />
                            </label>
                            <label class="toggle toggle-switch model-policy-switch">
                              <input
                                type="checkbox"
                                aria-label={`Allow subagents to use ${group.provider}`}
                                checked={providerSubagentPreference(p(), group.provider)}
                                disabled={busy() || !providerEnabled(p(), group.provider)}
                                title={providerEnabled(p(), group.provider) ? undefined : `${group.provider} is off, so subagents can't use it either`}
                                onChange={(e) => edit((cur) => setProviderSubagents(cur, group.provider, e.currentTarget.checked))}
                              />
                              <span class="toggle-box" />
                            </label>
                          </div>
                          <Show when={group.models.length > 0 && isOpen(group.provider)}>
                            <ul class="model-policy-models" id={`models-${group.provider}`}>
                              <For each={group.models}>
                                {(m) => (
                                  <li class="model-policy-row model-policy-model">
                                    <span class="model-policy-model-name" title={m.ref}>
                                      {m.id}
                                    </span>
                                    <label class="toggle toggle-switch model-policy-switch">
                                      <input
                                        type="checkbox"
                                        aria-label={`Enable ${m.ref}`}
                                        checked={modelEnabled(p(), m.ref)}
                                        disabled={busy() || !providerEnabled(p(), m.provider)}
                                        title={providerEnabled(p(), m.provider) ? undefined : `${m.provider} is off, so this model is too`}
                                        onChange={(e) => edit((cur) => setModelEnabled(cur, m.ref, e.currentTarget.checked))}
                                      />
                                      <span class="toggle-box" />
                                    </label>
                                    <label class="toggle toggle-switch model-policy-switch">
                                      <input
                                        type="checkbox"
                                        aria-label={`Allow subagents to use ${m.ref}`}
                                        checked={modelSubagentPreference(p(), m.ref) && providerSubagentPreference(p(), m.provider)}
                                        disabled={busy() || !modelEnabled(p(), m.ref) || !providerSubagentEnabled(p(), m.provider)}
                                        title={
                                          modelEnabled(p(), m.ref)
                                            ? modelSubagentEnabled(p(), m.ref) || providerSubagentEnabled(p(), m.provider)
                                              ? undefined
                                              : `${m.provider} is off for subagents, so this model is too`
                                            : "This model is off, so subagents can't use it either"
                                        }
                                        onChange={(e) => edit((cur) => setModelSubagents(cur, m.ref, e.currentTarget.checked))}
                                      />
                                      <span class="toggle-box" />
                                    </label>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <p class="model-policy-foot">
                  <Show
                    when={tokens().length > 0}
                    fallback={`${total()} ${total() === 1 ? "model" : "models"} with credentials on this machine.`}
                  >
                    {shown()} of {total()} {total() === 1 ? "model" : "models"} match.
                  </Show>
                </p>
              </>
            );
          }}
        </Show>
      </Show>
    </>
  );
}

/** The settings dialog spec: re-fetched every 2s while this tab is visible, so a file saved in another window shows
    up without a click. The panel unmounts with the tab, and the poll stops with it. */
const THEMES_POLL_MS = 2000;

/** The 5 swatches, in order: the theme's page, surface, accent, error, and text colors. */
const SWATCH_KEYS = ["bg", "surface", "accent", "status-error", "ink"] as const;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** How many cards share the first card's row — the grid's column count as rendered. 1 when
    nothing is rendered yet, so Up/Down still mean something. */
const columnsOf = (cards: (HTMLElement | null)[]): number => {
  const first = cards[0];
  if (!first) return 1;
  let n = 0;
  for (const c of cards) {
    if (c && c.offsetTop === first.offsetTop) n++;
    else break;
  }
  return Math.max(1, n);
};

/** `Dark base · Built-in`, plus the third clause a user file that took a built-in's id earns —
    a Dracula that isn't ours is the one surprise this folder can spring. */
const metaLine = (t: ThemeInfo) => {
  const base = t.base === "light" ? "Light base" : "Dark base";
  const source = t.source === "user" ? "User" : "Built-in";
  return t.replacesBuiltin ? `${base} · ${source} · replaces the built-in` : `${base} · ${source}`;
};

/**
 * Settings → Themes. Every theme the app can find, as a radiogroup where the row IS the
 * preview: swatches and a font sample painted out of the theme's own values. Those values came
 * off disk, which is why the server checks them at read time rather than at apply time — by the
 * time a row draws there is nothing left to sanitize.
 *
 * Choosing applies immediately and writes localStorage. There is no Save, no preview mode, and
 * no server round-trip: the theme is this browser's.
 */
function ThemesPanel() {
  const themes = createPoll(getThemes, THEMES_POLL_MS);
  const [refreshing, setRefreshing] = createSignal(false);
  const rows = () => themes.data()?.themes ?? [];
  /** Where a dropped-in theme goes, straight out of the payload with $HOME as `~`. Never a
      literal: the folder sits under PI_CODING_AGENT_DIR, which is a documented override, so the
      path in the copy deck is an example and `dir` is the only thing that knows the real one.
      Null until the first list lands — naming the wrong folder is worse than naming none. */
  const dir = () => {
    const d = themes.data()?.dir;
    return d ? tildePath(d, home()) : null;
  };

  /** Roving tabindex: the checked row is the group's one tab stop, or the first usable row when
      the choice isn't in the list (it was just deleted, and the next poll will say so). */
  const usable = createMemo(() => rows().filter((t) => !t.error));
  const tabStopId = createMemo(() => {
    const list = usable();
    return list.find((t) => t.id === activeThemeId())?.id ?? list[0]?.id;
  });

  // Every list the poll brings is also an answer about the theme on screen: a file deleted or
  // broken while you're wearing it takes you back to dark, and one edited in another window
  // re-applies. The check is the boot one, so both paths agree on what "gone" means.
  createEffect(() => {
    const list = themes.data();
    if (list && list.themes.length > 0) reconcileTheme(list);
  });

  const choose = (t: ThemeInfo) => {
    if (t.error) return; // a broken theme is listed, never worn
    applyTheme({ id: t.id, base: t.base, tokens: t.tokens }); // the store clears the fallback notice
  };

  /**
   * Arrows move the choice, the way they do in the rail — across the grid, not down a list:
   * Left/Right step one card and wrap, Up/Down step one ROW and stop at the edges, Home/End go
   * to the first and last. The column count is read off the rendered cards (how many share the
   * first card's top edge) rather than restated from the CSS, so a panel of any width agrees
   * with itself. Broken cards are skipped: they can't be checked, so landing on one would be a
   * dead stop.
   */
  const onRowKeyDown = (e: KeyboardEvent, t: ThemeInfo) => {
    const list = usable();
    if (list.length === 0) return;
    const here = Math.max(0, list.findIndex((x) => x.id === t.id));
    let to: number;
    switch (e.key) {
      case "ArrowRight":
        to = (here + 1) % list.length;
        break;
      case "ArrowLeft":
        to = (here - 1 + list.length) % list.length;
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const cols = columnsOf(list.map((x) => document.getElementById(`theme-row-${x.id}`)));
        to = here + (e.key === "ArrowDown" ? cols : -cols);
        if (to < 0 || to >= list.length) to = here; // the edge: stay, don't wrap to another column
        break;
      }
      case "Home":
        to = 0;
        break;
      case "End":
        to = list.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = list[to];
    if (!next) return;
    if (next.id !== t.id) choose(next);
    (document.getElementById(`theme-row-${next.id}`) as HTMLButtonElement | null)?.focus();
  };

  /** Refresh, for the moment you don't want to wait 2 seconds — and for the case where the poll
      is the thing that's broken. A failure hands back to the poll, which owns the error. */
  const refresh = async () => {
    setRefreshing(true);
    try {
      themes.set(await getThemes());
    } catch {
      themes.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <p class="settings-intro">Applies as you pick. The choice is remembered in this browser.</p>
      <Show when={droppedThemeId()}>
        {(id) => <Banner tone="info" title={<><code>{id()}</code> isn't there anymore, so you're back on Dark.</>} />}
      </Show>
      <Show when={themes.data()?.error && dir()}>
        {(folder) => (
          <Banner
            tone="error"
            title={<>We couldn't read <code>{folder()}/</code>.</>}
            body="Your own themes aren't listed; the built-in ones still work. Retry or check the folder's permissions."
            action={
              <button type="button" class="button button-sm" onClick={() => void refresh()}>
                Retry
              </button>
            }
          />
        )}
      </Show>
      <Show when={themes.error() && !themes.data()}>
        {(message) => (
          <Banner
            tone="error"
            title="Couldn't load the theme list"
            body={`The theme you're wearing is unchanged. ${message()}`}
            action={
              <button type="button" class="button button-sm" onClick={() => void refresh()}>
                Retry
              </button>
            }
          />
        )}
      </Show>
      <Show
        when={!themes.pending()}
        fallback={
          <div class="settings-theme-list" aria-hidden="true">
            <For each={[0, 1, 2, 3, 4, 5]}>{() => <div class="skeleton settings-theme-skeleton" />}</For>
          </div>
        }
      >
        <div class="settings-theme-list" role="radiogroup" aria-label="Theme">
          <For each={rows()}>
            {(t) => (
              <button
                type="button"
                role="radio"
                id={`theme-row-${t.id}`}
                class={`settings-theme-row${t.error ? " settings-theme-broken" : ""}`}
                aria-checked={!t.error && activeThemeId() === t.id}
                disabled={!!t.error}
                tabindex={t.error ? -1 : tabStopId() === t.id ? 0 : -1}
                title={t.source === "user" ? t.path : undefined}
                aria-label={t.error ? undefined : `${t.name}, ${t.base} base, ${t.source === "user" ? "user" : "built-in"}`}
                onClick={() => choose(t)}
                onKeyDown={(e) => onRowKeyDown(e, t)}
                style={
                  t.error
                    ? undefined
                    : {
                        // The faces this theme would actually render in: the font pick on top of
                        // the theme's own tokens. An undefined value leaves the
                        // property unset, and the sample falls through to the root's face.
                        "--theme-font-body": effectiveStack("text", t.tokens, typography()),
                        "--theme-font-mono": effectiveStack("mono", t.tokens, typography()),
                      }
                }
              >
                <span class="settings-theme-name">{t.error ? fileName(t.path) : t.name}</span>
                <Show when={!t.error}>
                  <span class="settings-theme-check" aria-hidden="true">
                    <Icon name="check" small />
                  </span>
                </Show>
                <span class="settings-theme-meta">
                  {t.error ? `We couldn't read this theme. ${t.error}` : metaLine(t)}
                </span>
                <Show when={!t.error}>
                  {/* The one place in the product that paints a color the current theme doesn't
                      own. The values are the file's own, verbatim — checked when it was read. */}
                  <span class="settings-theme-swatches" role="img" aria-label="Page, surface, accent, error, and text colors">
                    <For each={SWATCH_KEYS}>
                      {(key) => <span class="settings-theme-swatch" style={{ background: t.tokens[key] }} />}
                    </For>
                  </span>
                  <span class="settings-theme-font-sample">
                    Aa <span class="mono">0x1F</span>
                  </span>
                </Show>
                <Show when={t.error}>
                  <span class="visually-hidden">, can't be used</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <TypographySection />
      <div class="settings-theme-footer">
        <Show when={dir()} fallback={<span />}>
          {(folder) => (
            <span>
              Drop a <code>.json</code> file in <code>{folder()}/</code> and it shows up here.
            </span>
          )}
        </Show>
        <button type="button" class="button button-sm" onClick={() => void refresh()} aria-busy={refreshing()}>
          <Icon name="refresh" small />
          Refresh
        </button>
      </div>
    </>
  );
}
