import { createEffect, createResource, createSignal, For, onMount, Show } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { getSubagentPolicy, putSubagentPolicy } from "../lib/api";
import { ensureModels } from "../lib/models";
import { Banner, Icon, trapFocus } from "./ui";

/** The tab rail. One screen now; the rail is the structure further settings slot into. */
const TABS = [{ id: "subagents", label: "Subagent models", icon: "worker" as const }] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * The Settings dialog (spec/12-settings-dialog.md): a modal with a left tab rail. Its one
 * screen edits the subagent model policy — the shared file the subagents extension enforces
 * for every session, TUI and webapp alike. Every switch saves immediately; a failed save
 * puts the switch back and says so.
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
          <div class="settings-panel" role="tabpanel" id="settings-panel-subagents" aria-labelledby="settings-tab-subagents">
            <Show when={tab() === "subagents"}>
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
            </Show>
          </div>
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
