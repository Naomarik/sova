import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import type { DelegateOptions, SummarizerBackend, SummarizerSettings, SummarizerSettingsInfo } from "../../shared/protocol";
import { getDelegateOptions, getSummarizerSettings, putSummarizerSettings } from "../lib/api";
import { tildePath } from "../lib/format";
import { ensureModelPolicy, type ModelPolicy } from "../lib/model-policy";
import { BACKEND_LABELS, summarizerIssue, summarizerModelOptions, type SummarizerDraft } from "../lib/summarizer-form";
import { announce, home } from "../lib/ui-state";
import { Banner } from "./ui";

const BACKENDS: SummarizerBackend[] = ["claude-code", "pi"];

const same = (a: SummarizerDraft | null, b: SummarizerDraft | null) =>
  a === b || (!!a && !!b && a.backend === b.backend && a.model === b.model);
const sameSettings = (a: SummarizerSettings, b: SummarizerSettings) => same(a.primary, b.primary) && same(a.fallback, b.fallback);

/**
 * Settings → Summaries: which model writes the summary line under each session's title — a
 * primary and an optional fallback, as the topic-outline extension's chain. The file is shared
 * with the terminal and read once per session, at its start, so a save reaches sessions started
 * afterwards, here and in the TUI. Only the chain is written; the file's other settings stay.
 *
 * Each complete pick saves at once, like the Models switches: two selects are not a routing to
 * review as a whole, the way Delegate's eight rows are. A backend change blanks its model, and a
 * blank row saves nothing until a model is picked.
 */
export function SummarizerSettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getSummarizerSettings);
  const [options, { refetch: refetchOptions }] = createResource(getDelegateOptions);
  // The global half of the policy is what the extension obeys (lib/summarizer-form.ts). A policy
  // that can't be read warns about nothing rather than blocking the screen.
  const [policy] = createResource(() => ensureModelPolicy().catch(() => null));
  const [draft, setDraft] = createSignal<SummarizerSettings | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  /** The settings once loaded. A resource in its error state throws when read, so this never reads it then. */
  const loaded = (): SummarizerSettingsInfo | undefined => (info.error ? undefined : info());
  const known = (): DelegateOptions | undefined => (options.state === "ready" ? options() : undefined);
  const currentPolicy = (): ModelPolicy | null => (policy.state === "ready" ? (policy() ?? null) : null);
  const locked = () => saving() || !!loaded()?.unreadable;

  createEffect(() => {
    const i = loaded();
    if (i) setDraft(structuredClone(i.settings));
  });

  const complete = (d: SummarizerSettings) =>
    !!d.primary.model && (d.fallback === null || (!!d.fallback.model && !same(d.fallback, d.primary)));

  /** Take the pick; write it when it's a whole chain that differs from what's stored. */
  const apply = async (next: SummarizerSettings) => {
    setDraft(next);
    setSaveError(null);
    const i = loaded();
    if (!i || !complete(next) || sameSettings(next, i.settings)) return;
    setSaving(true);
    try {
      const result = await putSummarizerSettings(next);
      setInfo(result);
      announce("Summary model saved. Sessions you start from now on use it.");
    } catch (err) {
      setDraft(structuredClone(i.settings));
      setSaveError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
    } finally {
      setSaving(false);
    }
  };

  const setSlot = (slot: "primary" | "fallback", choice: SummarizerDraft | null) => {
    const d = draft();
    if (d) void apply(slot === "primary" ? { ...d, primary: choice! } : { ...d, fallback: choice });
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-summaries-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-summaries-title">
          Summary line
        </h3>
      </div>
      <p class="settings-intro">
        A small model writes the line under each session's title as the session goes. Pick it, and a fallback for when
        it can't run. A change applies to sessions started afterwards, here and in pi in the terminal.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the summary settings."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>
      <Show when={loaded()?.unreadable}>
        {(reason) => (
          <Banner
            tone="error"
            title="The summary settings file can't be read."
            body={`${sentence(reason())} Sessions use the built-in models until it's fixed, and saving here is off so the file isn't overwritten.`}
          />
        )}
      </Show>
      <Show when={(loaded()?.beyond ?? 0) > 0}>
        <Banner
          tone="info"
          title={`Your file lists ${loaded()!.beyond} more ${loaded()!.beyond === 1 ? "model" : "models"} after these 2.`}
          body="They still run in order. A change here keeps only the 2 shown."
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

      <Show when={loaded() && draft()}>
        <fieldset class="settings-delegate-profile">
          <legend class="visually-hidden">Summary models</legend>
          <SlotRow
            slot="primary"
            options={known()}
            policy={currentPolicy()}
            choice={draft()!.primary}
            primary={null}
            disabled={locked()}
            onChange={(next) => setSlot("primary", next)}
          />
          <label class="toggle toggle-switch settings-delegate-fallback-toggle">
            <span>Fallback</span>
            <input
              type="checkbox"
              checked={draft()!.fallback !== null}
              disabled={locked()}
              onChange={(e) => setSlot("fallback", e.currentTarget.checked ? { backend: draft()!.primary.backend, model: "" } : null)}
            />
            <span class="toggle-box" />
          </label>
          <Show
            when={draft()!.fallback}
            fallback={<p class="field-hint">No fallback: when the primary can't run, the line isn't updated until it can.</p>}
          >
            {(fallback) => (
              <SlotRow
                slot="fallback"
                options={known()}
                policy={currentPolicy()}
                choice={fallback()}
                primary={draft()!.primary}
                disabled={locked()}
                onChange={(next) => setSlot("fallback", next)}
              />
            )}
          </Show>
        </fieldset>

        <Show when={saveError()}>
          {(message) => (
            <Banner tone="error" title="Couldn't save the summary model." body={`${sentence(message())} Your saved choice is unchanged.`} />
          )}
        </Show>

        <div class="settings-delegate-actions">
          <button
            type="button"
            class="button button-ghost"
            disabled={locked() || sameSettings(draft()!, loaded()!.defaults)}
            onClick={() => void apply(structuredClone(loaded()!.defaults))}
          >
            Reset to Defaults
          </button>
          <span class="field-hint" role="status">
            {saving() ? "Saving…" : loaded()!.usingDefaults ? "These are the built-in models." : ""}
          </span>
        </div>
        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>, shared with pi in the terminal. Its other settings
          stay as they are.
        </p>
      </Show>
    </section>
  );
}

/** A reason as a sentence: closed with a period unless it already ends in one (or in "?"). */
const sentence = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);

const RetryButton = (props: { label: string; onClick(): void }) => (
  <button type="button" class="button button-sm" onClick={() => props.onClick()}>
    {props.label}
  </button>
);

/** One summarizer: backend and model, and what the row has to say about the pick. */
function SlotRow(props: {
  slot: "primary" | "fallback";
  options: DelegateOptions | undefined;
  policy: ModelPolicy | null;
  choice: SummarizerDraft;
  primary: SummarizerDraft | null;
  disabled: boolean;
  onChange(next: SummarizerDraft): void;
}) {
  const id = (part: string) => `summarizer-${props.slot}-${part}`;
  const issue = () => summarizerIssue(props.options, props.policy, props.choice, props.primary);
  const models = () => summarizerModelOptions(props.options, props.policy, props.choice);
  const slotName = () => (props.slot === "primary" ? "Primary" : "Fallback");
  return (
    <div class="settings-delegate-slot" role="group" aria-label={slotName()}>
      <Show when={props.slot === "primary"}>
        <span class="settings-delegate-slot-label">Primary</span>
      </Show>
      <div class="settings-delegate-fields settings-summaries-fields">
        <div class="field">
          <label class="field-label" for={id("backend")}>
            Backend
          </label>
          <div class="select-wrap">
            <select
              class="select"
              id={id("backend")}
              disabled={props.disabled}
              onChange={(e) => props.onChange({ backend: e.currentTarget.value as SummarizerBackend, model: "" })}
            >
              <For each={BACKENDS}>
                {(b) => (
                  <option value={b} selected={b === props.choice.backend}>
                    {BACKEND_LABELS[b]}
                  </option>
                )}
              </For>
            </select>
            <span class="select-caret" aria-hidden="true">
              ▾
            </span>
          </div>
        </div>
        <div class="field">
          <label class="field-label" for={id("model")}>
            Model
          </label>
          <div class="select-wrap">
            <select
              class="select text-mono"
              id={id("model")}
              disabled={props.disabled}
              aria-describedby={issue() ? id("issue") : undefined}
              onChange={(e) => props.onChange({ ...props.choice, model: e.currentTarget.value })}
            >
              <Show when={!props.choice.model}>
                <option value="" selected disabled>
                  {props.options ? "Choose a model" : "Checking…"}
                </option>
              </Show>
              <For each={models()}>
                {(o) => (
                  <option value={o.value} selected={o.value === props.choice.model}>
                    {o.label}
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
      <Show when={issue()}>
        {(i) => (
          <p class={`settings-delegate-issue settings-delegate-issue-${i().tone}`} id={id("issue")}>
            {i().text}
          </p>
        )}
      </Show>
    </div>
  );
}
