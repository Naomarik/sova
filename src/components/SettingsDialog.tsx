import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show } from "solid-js";
import type { ThemeInfo } from "../../shared/protocol";
import { getClaudeCliStatus, getProviderLimits, getThemes, getWebSettings } from "../lib/api";
import { clockTime, tildePath } from "../lib/format";
import {
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
import {
  claudeCodeDraft,
  claudeCodeSaved,
  claudeCodeSaveError,
  claudeCodeSaveResult,
  claudeCodeSaving,
  setClaudeCodeDraft,
  setClaudeCodeSaved,
} from "../lib/experimental-draft";
import { policyDraft, policySaveError, policySaving, setPolicyDraft, setPolicySaved } from "../lib/model-policy-draft";
import { limitsDraft, limitsSaveError, limitsSaveResult, limitsSaving, setLimitsDraft, setLimitsSaved } from "../lib/provider-limits-draft";
import { LIMIT_MAX, LIMIT_MIN, parseLimitField } from "../lib/provider-limits";
import {
  dirtyForms,
  discardAllDrafts,
  failedForms,
  footerStatus,
  formNames,
  invalidForms,
  resetAllDrafts,
  saveAllDrafts,
  savingAny,
  type GatedForm,
} from "../lib/settings-draft";
import { effectiveStack } from "../lib/typography";
import { announce, home } from "../lib/ui-state";
import { DecisionSettingsSection } from "./DecisionSettings";
import { DelegateSettingsSection } from "./DelegateSettings";
import { MeshSettingsSection } from "./MeshSettings";
import { AccountsSettingsSection } from "./AccountsSettings";
import { SpecSettingsSection } from "./SpecSettings";
import { OverseerSettingsSection } from "./OverseerSettings";
import { PublicLinksSettingsSection } from "./PublicLinksSettings";
import { PushSettingsSection } from "./PushSettings";
import { SessionTitleSettingsSection } from "./SessionTitleSettings";
import { SummarizerSettingsSection } from "./SummarizerSettings";
import { BatonSettingsSection } from "./BatonSettings";
import { TeamSettingsSection } from "./TeamSettings";
import { TypographySection } from "./TypographySection";
import { VoiceSettingsSection } from "./VoiceSetup";
import { Banner, Icon, trapFocus } from "./ui";
import { sentence } from "./WorkerSlotRow";

/** The tab rail. Fifteen screens; the rail is the structure further settings slot into. General is
    first because it is the one screen about this browser's own behaviour rather than a subsystem.
    Same ids, same order as `SETTINGS_TABS` (lib/settings-nav.ts), which is what opens it. */
const TABS = [
  { id: "general", label: "General", icon: "settings" as const },
  { id: "models", label: "Models", icon: "sliders" as const },
  { id: "accounts", label: "Accounts", icon: "refresh" as const },
  { id: "modes", label: "Modes", icon: "worker" as const },
  { id: "teams", label: "Teams", icon: "command" as const },
  { id: "overseer", label: "Overseer", icon: "eye" as const },
  { id: "notifications", label: "Notifications", icon: "bell" as const },
  { id: "decisions", label: "Decisions", icon: "shield" as const },
  { id: "summaries", label: "Summaries", icon: "chat" as const },
  { id: "organizations", label: "Organizations", icon: "network" as const },
  { id: "themes", label: "Themes", icon: "image" as const },
  { id: "mesh", label: "Mesh", icon: "branch" as const },
  { id: "public-links", label: "Public links", icon: "external" as const },
  { id: "voice", label: "Voice", icon: "mic" as const },
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

  /** Close was asked for over unsaved edits on a Save-gated form: the foot asks what to do with them. */
  const [closeHeld, setCloseHeld] = createSignal(false);
  /** Every gated form holding unsaved edits, in rail order — the registry the drafts join (settings-draft.ts). */
  const dirty = createMemo(() => dirtyForms());
  /** Every way out (Close, Esc, the scrim) comes through here, so none of them drops a draft silently. */
  const requestClose = () => {
    const held = dirty();
    if (held.length > 0) {
      // To the first screen that holds an edit, unless the one showing already does.
      if (!held.some((f) => f.tab === tab())) setTab(held[0]!.tab as TabId);
      setCloseHeld(true);
      return;
    }
    resetAllDrafts();
    props.onClose();
  };
  const discardAndClose = () => {
    resetAllDrafts();
    props.onClose();
  };

  // ---- The footer: one Save and one Discard for every form on every tab (settings-draft.ts) ----
  /** The forms the last Save Changes wrote, for the status line ("Saved Models; Delegate failed."). */
  const [lastSaved, setLastSaved] = createSignal<GatedForm[]>([]);
  const invalid = createMemo(() => invalidForms());
  const status = () =>
    footerStatus({ saving: savingAny(), dirty: dirty(), problem: invalid()[0]?.problem() ?? null, failed: failedForms(), lastSaved: lastSaved() });
  let closeButton!: HTMLButtonElement;
  /** Focus sits on a footer button that just went away (nothing is dirty now): hand it to Close. */
  const keepFocus = () => {
    if (dirty().length === 0 && !closeButton.contains(document.activeElement)) closeButton.focus();
  };
  const saveAll = async () => {
    setLastSaved([]);
    const { saved, failed } = await saveAllDrafts();
    setLastSaved(saved);
    announce(status());
    if (failed.length > 0) {
      // To the first form that failed, unless the one showing already did; its banner says why.
      if (!failed.some((f) => f.tab === tab())) setTab(failed[0]!.tab as TabId);
      requestAnimationFrame(() => {
        const banners = document.querySelectorAll<HTMLElement>(`#settings-panel-${tab()} .banner-error`);
        [...banners].find((b) => b.textContent?.startsWith("Couldn't save"))?.scrollIntoView({ block: "nearest" });
      });
    }
    keepFocus();
  };
  const discardAll = () => {
    const names = formNames(dirty());
    discardAllDrafts();
    setLastSaved([]);
    announce(`Discarded your ${names} changes.`);
    keepFocus();
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
          {/* Mounted only while its tab is: the logins and their standing are read when it opens,
              and closing Settings cancels a sign-in still waiting for its code. */}
          <Show when={tab() === "accounts"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-accounts" aria-labelledby="settings-tab-accounts">
              <AccountsSettingsSection />
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
          {/* Mounted only while its tab is: the devices and settings are read when it opens. */}
          <Show when={tab() === "notifications"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-notifications" aria-labelledby="settings-tab-notifications">
              <PushSettingsSection />
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
              <SessionTitleSettingsSection />
            </div>
          </Show>
          <Show when={tab() === "organizations"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-organizations" aria-labelledby="settings-tab-organizations">
              <BatonSettingsSection />
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
          {/* Mounted only while its tab is: the setting is read when the tab opens. Not a mesh tab:
              a host that is its own gateway works with the mesh off. */}
          <Show when={tab() === "public-links"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-public-links" aria-labelledby="settings-tab-public-links">
              <PublicLinksSettingsSection />
            </div>
          </Show>
          {/* Mounted only while its tab is: the voice status polls while it's open (every second
              while setup runs), and stops with it. */}
          <Show when={tab() === "voice"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-voice" aria-labelledby="settings-tab-voice">
              <VoiceSettingsSection />
            </div>
          </Show>
          {/* Same lifecycle as the other panels: mounted only while its tab is, so the settings
              and CLI-status resources are read when the tab opens. */}
          <Show when={tab() === "experimental"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-experimental" aria-labelledby="settings-tab-experimental">
              <ExperimentalPanel />
            </div>
          </Show>
        </div>
        <Show when={closeHeld() && dirty().length > 0}>
          <div class="settings-close-held">
            <Banner
              tone="warn"
              title={`Your ${formNames(dirty())} changes aren't saved.`}
              body="Save them, or discard them and close."
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
        <div class="modal-foot settings-foot" classList={{ "settings-foot-dirty": dirty().length > 0 }}>
          <p class="settings-foot-status" id="settings-foot-status" classList={{ "settings-foot-status-problem": invalid().length > 0 && !savingAny() }}>
            {status()}
          </p>
          <Show when={dirty().length > 0}>
            <button type="button" class="button button-ghost settings-foot-edit" disabled={savingAny()} onClick={discardAll}>
              Discard Changes
            </button>
            <button
              type="button"
              class="button button-primary settings-foot-edit"
              disabled={savingAny() || invalid().length > 0}
              aria-describedby="settings-foot-status"
              onClick={() => void saveAll()}
            >
              {savingAny() ? "Saving…" : "Save Changes"}
            </button>
          </Show>
          <button type="button" class="button button-ghost" ref={closeButton} onClick={requestClose}>
            {dirty().length > 0 ? "Cancel" : "Close"}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Experimental: unfinished features, one switch today. Staged like every server-backed form and
 * written by Save Changes. The settings and CLI-status resources are read when the tab opens (the
 * panel is mounted only while its tab is): the status probe spawns `claude --version` on the server.
 */
function ExperimentalPanel() {
  const [webSettings, { mutate: setWebSettings }] = createResource(() => getWebSettings());
  const [cliStatus, { refetch: refetchCliStatus }] = createResource(() => getClaudeCliStatus());
  // setClaudeCodeSaved is untracked (settings-draft.ts), so this tracks the loaded settings only.
  createEffect(() => {
    const s = webSettings.error ? undefined : webSettings();
    if (s) setClaudeCodeSaved(s.experimental.claudeCodeProvider);
  });
  // A save from the dialog's footer. Turning it on registers the provider server-side, so the count
  // in the status line is already out of date by the time the PUT returns. Without the re-read the
  // line keeps saying "no models are registered yet — start a session, or restart the server" while
  // the picker has them, which is worse than no status line at all.
  createEffect(
    on(
      claudeCodeSaveResult,
      (r) => {
        if (!r) return;
        setWebSettings(r);
        void refetchCliStatus();
      },
      { defer: true },
    ),
  );

  /** One line of truth about the CLI, so the switch is never the only thing the user has to go on.
      It reads the SAVED setting: an unsaved switch changes nothing on the server yet. */
  const statusLine = () => {
    if (cliStatus.loading) return "Checking for the Claude Code CLI…";
    const status = cliStatus.error ? undefined : cliStatus();
    if (!status) return "";
    if (status.error) return `Claude Code CLI: ${status.error}`;
    const count = status.models ?? 0;
    if (!claudeCodeSaved()) return `Claude Code CLI ${status.version} found. Switch on to add its models.`;
    return count > 0
      ? `Claude Code CLI ${status.version} · ${count} ${count === 1 ? "model" : "models"} in the picker.`
      : `Claude Code CLI ${status.version} found, but no models are registered yet — start a session, or restart the server.`;
  };

  return (
    <>
      <p class="settings-intro">
        Unfinished features. They can change or disappear, and they apply to sessions you start
        after switching them on — chats already open keep the setup they began with.
      </p>
      <ul class="settings-list">
        <li>
          <label class="toggle toggle-switch settings-provider">
            <input
              type="checkbox"
              checked={claudeCodeDraft() ?? false}
              disabled={claudeCodeSaving() || claudeCodeDraft() === null}
              onChange={(e) => setClaudeCodeDraft(e.currentTarget.checked)}
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
      <Show when={webSettings.error}>
        <Banner tone="error" title="Couldn't read the experimental settings." body="Nothing was changed." />
      </Show>
      <Show when={claudeCodeSaveError()}>
        {(err) => <Banner tone="error" title="Couldn't save the change." body={`${sentence(err().message)} Your saved setting is unchanged.`} />}
      </Show>
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
 * Every switch is staged; the dialog's Save Changes writes the whole policy (model-policy-draft.ts),
 * rebased onto a fresh read, and a failed save keeps the switches and says so. A globally disabled model's Subagents switch is greyed rather than cleared: it remembers
 * what you chose, and turning the model back on returns it.
 *
 * Each provider row also has an "At once" field (§app.provider-limits/setting): how many of that
 * provider's requests may run at once on this device, empty for no limit. Staged too, saved by the
 * same Save Changes into provider-limits.json (provider-limits-draft.ts).
 */
function ModelsPanel() {
  const [models] = createResource(() => ensureModels());
  const [source, { refetch }] = createResource(() => loadModelPolicy());
  /** The policy as the user has set it: the saved policy, then every staged switch move. */
  const policy = policyDraft;
  const [query, setQuery] = createSignal("");
  const [opened, setOpened] = createSignal<string[]>([]);
  // setPolicySaved is untracked (settings-draft.ts), so this tracks the loaded policy only. A kept
  // draft is rebased onto each read: the switches the user moved stay, the rest follow the file.
  createEffect(() => {
    const p = source.error ? undefined : source();
    if (p) setPolicySaved(p);
  });

  const busy = () => policySaving() || source.loading;

  // The request limits (provider-limits.json): their own file and draft, on the same rows.
  const [limitsSource, { refetch: refetchLimits }] = createResource(() => getProviderLimits());
  createEffect(() => {
    const info = limitsSource.error ? undefined : limitsSource();
    if (info) setLimitsSaved(info.limits);
  });
  /** What the server said last: a save's answer, else the load's (the lowered limits, a file that can't be read). */
  const limitsInfo = () => limitsSaveResult() ?? (limitsSource.error ? undefined : limitsSource());
  const limitsBusy = () => limitsSaving() || limitsSource.loading || !!limitsInfo()?.error;
  const limitField = (provider: string) => limitsDraft()?.[provider] ?? "";
  const editLimit = (provider: string, text: string) => {
    const current = limitsDraft();
    if (!current || limitsBusy()) return;
    setLimitsDraft({ ...current, [provider]: text });
  };
  /** "lowered to 4 until 3:12 PM" while a 429 has the provider's limit lowered (the saved number is unchanged). */
  const loweredNote = (provider: string) => {
    const l = limitsInfo()?.lowered?.[provider];
    return l ? `lowered to ${l.limit} until ${clockTime(l.until)}` : undefined;
  };

  /** A switch moved: staged, written by Save Changes. */
  const edit = (change: (p: ModelPolicy) => ModelPolicy) => {
    const current = policy();
    if (!current || busy()) return;
    setPolicyDraft(change(current));
  };

  /** Model rows grouped by provider, name-sorted — the same order the model picker lists — plus
      the Claude Code backend and any provider the policy names that has no models here. The
      grouping follows `models()` alone, so a switch never rebuilds a group (see provider-groups). */
  // The Claude Code backend is a provider of its own: one switch over every Claude worker, its
  // own default model included. It has no rows here because its models are the CLI's, not pi's.
  const grouper = providerGrouper({ provider: CLAUDE_CODE_PROVIDER, models: [], note: "Claude Code workers" });
  const baseGroups = createMemo(() => grouper.byModels(models() ?? []));
  // A provider the limits file names is listed too, with no models here: a limit you can't see is one you can't undo.
  const limitNames = createMemo(() => Object.keys(limitsInfo()?.limits ?? {}), undefined, { equals: (a, b) => a.join() === b.join() });
  const groups = createMemo<ProviderGroup[]>(() => grouper.withPolicy(baseGroups(), policy(), limitNames()));

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
    const lowered = loweredNote(group.provider);
    const count = group.note
      ? group.note
      : !providerEnabled(p, group.provider)
        ? `Off · ${group.models.length} ${group.models.length === 1 ? "model" : "models"}`
        : `${enabledCount(p, group.models)} of ${group.models.length} on`;
    return lowered ? `${count} · ${lowered}` : count;
  };

  return (
    <>
      <p class="settings-intro">
        What may be used, here and in the terminal, and what subagents may be given. A model that is off
        is refused everywhere — a session already on it asks you to switch before its next message.
      </p>
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
                  <span>At once</span>
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
                            <input
                              class="input model-policy-limit text-num"
                              type="text"
                              inputmode="numeric"
                              autocomplete="off"
                              aria-label={`Requests at once for ${group.provider}`}
                              aria-invalid={parseLimitField(limitField(group.provider)) === "invalid" ? "true" : undefined}
                              placeholder="No limit"
                              title={loweredNote(group.provider) ?? `How many ${group.provider} requests may run at once on this device (${LIMIT_MIN}–${LIMIT_MAX}); empty for no limit`}
                              value={limitField(group.provider)}
                              disabled={limitsBusy() || !limitsDraft()}
                              onInput={(e) => editLimit(group.provider, e.currentTarget.value)}
                            />
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
                                    {/* The limit is the provider's: a model row keeps the column empty. */}
                                    <span aria-hidden="true" />
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
                <Show when={policySaveError()}>
                  {(e) => <Banner tone="error" title="Couldn't save the model policy." body={`${sentence(e().message)} Your saved policy is unchanged.`} />}
                </Show>
                <Show when={limitsSaveError()}>
                  {(e) => <Banner tone="error" title="Couldn't save the request limits." body={`${sentence(e().message)} Your saved limits are unchanged.`} />}
                </Show>
                <Show when={limitsInfo()?.error}>
                  {(why) => (
                    <Banner
                      tone="error"
                      title="Couldn't read the request limits."
                      body={`${sentence(why())} The defaults apply, and Save won't overwrite the file until it's fixed or removed.`}
                      action={
                        <button type="button" class="button button-sm" onClick={() => void refetchLimits()}>
                          Retry
                        </button>
                      }
                    />
                  )}
                </Show>
                <Show when={limitsSource.error}>
                  <Banner
                    tone="error"
                    title="Couldn't load the request limits."
                    body="The At once fields are off until they load. Nothing was changed."
                    action={
                      <button type="button" class="button button-sm" onClick={() => void refetchLimits()}>
                        Retry
                      </button>
                    }
                  />
                </Show>
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
