import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import type { ModelInfo, ThemeInfo } from "../../shared/protocol";
import { getSubagentPolicy, getThemes, putSubagentPolicy } from "../lib/api";
import { tildePath } from "../lib/format";
import { ensureModels } from "../lib/models";
import { createPoll } from "../lib/poll";
import { activeThemeId, applyTheme, droppedThemeId, reconcileTheme } from "../lib/theme";
import { home } from "../lib/ui-state";
import { Banner, Icon, trapFocus } from "./ui";

/** The tab rail. Two screens; the rail is the structure further settings slot into. */
const TABS = [
  { id: "subagents", label: "Subagent models", icon: "worker" as const },
  { id: "themes", label: "Themes", icon: "sliders" as const },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * The Settings dialog (spec/12-settings-dialog.md): a modal with a left tab rail. Subagent
 * models edits the shared file the subagents extension enforces for every session, TUI and
 * webapp alike — every switch saves immediately, and a failed save puts the switch back and
 * says so. Themes picks what this browser wears; that one is localStorage only.
 */
export function SettingsDialog(props: { onClose(): void }) {
  const [tab, setTab] = createSignal<TabId>("subagents");
  const [models] = createResource(() => ensureModels());
  const [policySource, { refetch: refetchPolicy }] = createResource(() => getSubagentPolicy());
  /** The policy as the user has set it: policySource on load, then optimistic toggles. */
  const [providersOff, setProvidersOff] = createSignal<string[]>([]);
  const [modelsOff, setModelsOff] = createSignal<string[]>([]);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  createEffect(() => {
    const p = policySource();
    if (!p) return;
    setProvidersOff(p.disabledProviders.map((x) => x.toLowerCase()));
    setModelsOff(p.disabledModels.map((x) => x.toLowerCase()));
  });
  let firstTab: HTMLButtonElement | undefined;
  onMount(() => firstTab?.focus());

  const providerOff = (provider: string) => providersOff().includes(provider.toLowerCase());
  const modelOff = (provider: string, id: string) => {
    const ref = `${provider}/${id}`.toLowerCase();
    return providersOff().includes(provider.toLowerCase()) || modelsOff().includes(ref);
  };

  /** One switch moved: write the whole policy, revert and say so if the write fails. */
  const apply = async (next: { providers: string[]; models: string[] }) => {
    const before = { providers: providersOff(), models: modelsOff() };
    setProvidersOff(next.providers);
    setModelsOff(next.models);
    setSaveError(null);
    setSaving(true);
    try {
      await putSubagentPolicy({ disabledProviders: next.providers, disabledModels: next.models });
    } catch (err) {
      setProvidersOff(before.providers);
      setModelsOff(before.models);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /** A provider switch: off covers all of its models, so their own entries leave the file —
      turning the provider back on returns every model allowed, which is what the list showed. */
  const toggleProvider = (provider: string) => {
    const key = provider.toLowerCase();
    const off = providerOff(provider);
    const providers = off ? providersOff().filter((p) => p !== key) : [...providersOff(), key];
    const models = modelsOff().filter((m) => !m.startsWith(`${key}/`));
    void apply({ providers, models });
  };

  const toggleModel = (m: ModelInfo) => {
    const ref = m.ref.toLowerCase();
    const off = modelsOff().includes(ref);
    const models = off ? modelsOff().filter((x) => x !== ref) : [...modelsOff(), ref];
    void apply({ providers: providersOff(), models });
  };

  /** Model rows grouped by provider, name-sorted — the same order the model picker lists. */
  const groups = () => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of models() ?? []) {
      const list = byProvider.get(m.provider);
      if (list) list.push(m);
      else byProvider.set(m.provider, [m]);
    }
    return [...byProvider.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, list]) => ({ provider, models: list.sort((a, b) => a.id.localeCompare(b.id)) }));
  };

  return (
    <>
      <div class="scrim" onClick={props.onClose} />
      <div
        class="modal modal-wide settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
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
              {(t, i) => (
                <button
                  type="button"
                  role="tab"
                  class="settings-tab"
                  aria-selected={tab() === t.id}
                  aria-controls={`settings-panel-${t.id}`}
                  id={`settings-tab-${t.id}`}
                  tabindex={tab() === t.id ? 0 : -1}
                  ref={(el) => {
                    if (i() === 0) firstTab = el;
                  }}
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
          <Show when={tab() === "subagents"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-subagents" aria-labelledby="settings-tab-subagents">
              <p class="settings-intro">
                Choose which models and providers subagents and team members can use. Changes apply to the
                next spawn — pi-web sessions and the TUI alike.
              </p>
              <Show when={saveError()}>
                {(message) => (
                  <Banner
                    tone="error"
                    title="Couldn't save the change"
                    body={`The subagent policy on the server didn't update, so the previous choice stands. ${message()}`}
                  />
                )}
              </Show>
              <Show when={!policySource.error} fallback={
                <Banner
                  tone="error"
                  title="Couldn't read the subagent policy"
                  body="The list below may not match the server. Nothing was changed."
                  action={
                    <button type="button" class="button button-sm" onClick={() => void refetchPolicy()}>
                      Retry
                    </button>
                  }
                />
              }>
                <Show
                  when={models() && !models.loading}
                  fallback={
                    <div aria-hidden="true">
                      <div class="skeleton skeleton-row" />
                      <div class="skeleton skeleton-row" />
                      <div class="skeleton skeleton-row" />
                    </div>
                  }
                >
                  <ul class="settings-list">
                    {/* The Claude Code backend is a provider of its own: one switch blocks its
                        workers (their sonnet/opus picks and their default alike). */}
                    <li>
                      <label class="toggle toggle-switch settings-provider" title="Claude Code workers run on the claude-code backend">
                        <input
                          type="checkbox"
                          checked={!providerOff("claude-code")}
                          disabled={saving() || policySource.loading}
                          onChange={() => toggleProvider("claude-code")}
                        />
                        <span class="settings-provider-main">
                          <span class="settings-provider-name">claude-code</span>
                          <span class="settings-provider-meta">Claude Code backend · sonnet, opus, and its default</span>
                        </span>
                        <span class="toggle-box" />
                      </label>
                    </li>
                    <For each={groups()}>
                      {(group) => (
                        <li>
                          <label class="toggle toggle-switch settings-provider">
                            <input
                              type="checkbox"
                              checked={!providerOff(group.provider)}
                              disabled={saving() || policySource.loading}
                              onChange={() => toggleProvider(group.provider)}
                            />
                            <span class="settings-provider-main">
                              <span class="settings-provider-name">{group.provider}</span>
                              <span class="settings-provider-meta">
                                {group.models.length} {group.models.length === 1 ? "model" : "models"}
                              </span>
                            </span>
                            <span class="toggle-box" />
                          </label>
                          <Show when={!providerOff(group.provider)}>
                            <ul class="settings-models">
                              <For each={group.models}>
                                {(m) => (
                                  <li>
                                    <label class="toggle toggle-switch settings-model" title={m.ref}>
                                      <input
                                        type="checkbox"
                                        checked={!modelOff(m.provider, m.id)}
                                        disabled={saving() || policySource.loading}
                                        onChange={() => toggleModel(m)}
                                      />
                                      <span class="settings-model-main">
                                        <span class="settings-model-name">{m.id}</span>
                                        <span class="settings-model-ref">{m.ref}</span>
                                      </span>
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
              </Show>
            </div>
          </Show>
          {/* The panel is mounted only while its tab is: the themes poll starts when this tab
              opens and stops with it, which is the lifecycle §12 asks for. */}
          <Show when={tab() === "themes"}>
            <div class="settings-panel" role="tabpanel" id="settings-panel-themes" aria-labelledby="settings-tab-themes">
              <ThemesPanel />
            </div>
          </Show>
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

/** §12: re-fetched every 2s while this tab is visible, so a file saved in another window shows
    up without a click. The panel unmounts with the tab, and the poll stops with it. */
const THEMES_POLL_MS = 2000;

/** The 5 swatches, in order: the theme's page, surface, accent, error, and text colors (§12). */
const SWATCH_KEYS = ["bg", "surface", "accent", "status-error", "ink"] as const;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `Dark base · Built-in`, plus the third clause a user file that took a built-in's id earns —
    a Dracula that isn't ours is the one surprise this folder can spring (§12). */
const metaLine = (t: ThemeInfo) => {
  const base = t.base === "light" ? "Light base" : "Dark base";
  const source = t.source === "user" ? "User" : "Built-in";
  return t.replacesBuiltin ? `${base} · ${source} · replaces the built-in` : `${base} · ${source}`;
};

/**
 * Settings → Themes (§12). Every theme the app can find, as a radiogroup where the row IS the
 * preview: swatches and a font sample painted out of the theme's own values. Those values came
 * off disk, which is why the server checks them at read time rather than at apply time — by the
 * time a row draws there is nothing left to sanitize (§0).
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

  /** Arrows move the choice, the way they do in the rail. Broken rows are skipped: they can't
      be checked, so landing on one would be a dead stop. */
  const onRowKeyDown = (e: KeyboardEvent, t: ThemeInfo) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const list = usable();
    if (list.length === 0) return;
    e.preventDefault();
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const here = list.findIndex((x) => x.id === t.id);
    const next = list[(((here < 0 ? 0 : here) + delta) % list.length + list.length) % list.length];
    if (!next) return;
    choose(next);
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
          <div aria-hidden="true">
            <div class="skeleton skeleton-row" />
            <div class="skeleton skeleton-row" />
            <div class="skeleton skeleton-row" />
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
                        "--theme-font-body": t.tokens["font-body"],
                        "--theme-font-mono": t.tokens["font-mono"],
                      }
                }
              >
                <span class="settings-theme-name">{t.error ? fileName(t.path) : t.name}</span>
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
