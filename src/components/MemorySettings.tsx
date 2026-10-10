import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import type { MemorySettingsInfo, MemoryType } from "../../shared/protocol";
import { getMemoryOptions, getMemorySettings } from "../lib/api";
import { fallbackFor, type DraftChoice, type Slot } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import { initialHelpTab, MEMORY_HELP_SETTINGS, MEMORY_HELP_TABS, type HelpDrawing } from "../lib/memory-help";
import { parseVis } from "../vis/parse";
import { Figure } from "../vis/Figure";
import { viewFor } from "../vis/Visual";
import { HelpPopover } from "./HelpPopover";
import {
  memoryDraft as draft,
  memorySaveError,
  memorySaveResult,
  memorySaveWarnings,
  memorySaving as saving,
  sameMemorySettings,
  setMemoryDraft as setDraft,
  setMemorySaved,
  toMemoryDraft,
} from "../lib/memory-settings-draft";
import { withoutSubagentMarks } from "../lib/session-title-settings-form";
import { home } from "../lib/ui-state";
import { Banner } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

/**
 * Settings → Memory (§app.settings-dialog/memory): which model writes memory's summaries — a
 * primary and an optional fallback, Delegate's rows. A summarizer is not a worker, so only the
 * policy's global switch marks a model. Saved by the dialog's footer (memory-settings-draft.ts).
 */
export function MemorySettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getMemorySettings);
  const [options, { refetch: refetchOptions }] = createResource(getMemoryOptions);
  const loaded = (): MemorySettingsInfo | undefined => (info.error ? undefined : info());
  const known = () => (options.state === "ready" ? withoutSubagentMarks(options()) : undefined);

  createEffect(() => {
    const i = loaded();
    if (i) setMemorySaved(i.settings);
  });
  // A save from the footer: what the server says now.
  createEffect(on(memorySaveResult, (r) => r && setInfo(r), { defer: true }));

  const update = (slot: Slot, next: DraftChoice | null) => {
    const d = draft();
    if (d) setDraft(slot === "primary" ? { ...d, primary: next! } : { ...d, fallback: next });
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-memory-title">
      <div class="settings-type-head">
        <span class="memory-settings-title">
          <h3 class="settings-type-title" id="settings-memory-title">
            Summarizer
          </h3>
          <MemoryHelp saved={loaded()?.settings.default?.type} />
        </span>
        <Show when={loaded() && draft()}>
          <span class="settings-head-actions">
            <button
              type="button"
              class="button button-sm button-ghost"
              disabled={saving() || sameMemorySettings(draft()!, loaded()!.defaults)}
              onClick={() => setDraft(toMemoryDraft(loaded()!.defaults))}
            >
              Reset to Defaults
            </button>
          </span>
        </Show>
      </div>
      <p class="settings-intro">
        With memory on, a small model summarizes each message of the chat into lines the chat's model works from. Pick it,
        and a fallback for when it can't run. A change applies from each chat's next summary.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the memory settings."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>
      <Show when={loaded() && draft() && options.error}>
        <Banner
          tone="warn"
          title="Couldn't check which models are offered."
          body="Your saved choices stay, marked not verified."
          action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
        />
      </Show>

      <Show when={loaded() && draft()}>
        <fieldset class="settings-delegate-profile">
          <legend class="visually-hidden">Memory summarizer</legend>
          <WorkerSlotRow
            idPrefix="memory-summarizer"
            slot="primary"
            info={loaded()!}
            options={known()}
            choice={draft()!.primary}
            other={draft()!.fallback}
            disabled={saving()}
            owner="Memory"
            otherwise="summaries wait until one can"
            onChange={(next) => update("primary", next)}
          />
          <label class="toggle toggle-switch settings-delegate-fallback-toggle">
            <span>Fallback</span>
            <input
              type="checkbox"
              checked={draft()!.fallback !== null}
              disabled={saving()}
              onChange={(e) => update("fallback", fallbackFor(draft()!.primary, e.currentTarget.checked))}
            />
            <span class="toggle-box" />
          </label>
          <Show when={draft()!.fallback} fallback={<p class="field-hint">No fallback: when the primary can't run, summaries wait until it can.</p>}>
            {(fallback) => (
              <WorkerSlotRow
                idPrefix="memory-summarizer"
                slot="fallback"
                info={loaded()!}
                options={known()}
                choice={fallback()}
                other={draft()!.primary}
                disabled={saving()}
                owner="Memory"
                otherwise="summaries wait until one can"
                onChange={(next) => update("fallback", next)}
              />
            )}
          </Show>
        </fieldset>

        <Show when={memorySaveError()}>
          {(e) => <Banner tone="error" title="Couldn't save the memory settings." body={`${sentence(e().message)} Your saved choice is unchanged.`} />}
        </Show>
        <For each={memorySaveWarnings()}>{(w) => <Banner tone="warn" title="Saved, with notes." body={sentence(w)} />}</For>
        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>. The memory type new chats start from is saved from a
          chat's mode menu, with Save as default.
        </p>
      </Show>
    </section>
  );
}

/** One static drawing, drawn by the chat's renderer without its Source and Copy. */
function HelpFigure(props: { drawing: HelpDrawing }) {
  const parsed = parseVis(props.drawing.kind, props.drawing.body);
  // The sources are ours and memory-help.test.ts parses each one; a broken one draws nothing.
  return parsed.ok ? <Figure kind={props.drawing.kind} spec={parsed.spec} view={viewFor(props.drawing.kind)} /> : null;
}

/**
 * "How memory works" (§chat.memory/help): the `?` beside the heading, its 2 tabs — opening on the
 * saved default type, else UniiChat — and what the settings change. Words and drawings are
 * memory-help.ts's.
 */
function MemoryHelp(props: { saved: MemoryType | undefined }) {
  const [tab, setTab] = createSignal<MemoryType>("uniichat");
  const tabs = new Map<MemoryType, HTMLButtonElement>();
  const step = (delta: number) => {
    const i = MEMORY_HELP_TABS.findIndex((t) => t.type === tab());
    const next = MEMORY_HELP_TABS[(i + delta + MEMORY_HELP_TABS.length) % MEMORY_HELP_TABS.length]!;
    setTab(next.type);
    tabs.get(next.type)?.focus();
  };
  return (
    <HelpPopover id="memory-help" label="How memory works" onOpen={() => setTab(initialHelpTab(props.saved))}>
      <div class="tabs" role="tablist" aria-label="Memory types">
        <For each={MEMORY_HELP_TABS}>
          {(t) => (
            <button
              type="button"
              role="tab"
              class="tab"
              id={`memory-help-tab-${t.type}`}
              aria-selected={tab() === t.type}
              aria-controls={`memory-help-panel-${t.type}`}
              tabindex={tab() === t.type ? 0 : -1}
              ref={(el) => tabs.set(t.type, el)}
              onClick={() => setTab(t.type)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                step(e.key === "ArrowRight" ? 1 : -1);
              }}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>
      <For each={MEMORY_HELP_TABS}>
        {(t) => (
          <Show when={tab() === t.type}>
            <div class="memory-help-panel" role="tabpanel" id={`memory-help-panel-${t.type}`} aria-labelledby={`memory-help-tab-${t.type}`}>
              <div class="memory-help-text">
                <For each={t.sentences}>{(s) => <p>{s}</p>}</For>
              </div>
              <Show when={t.by && t.link}>
                <p class="memory-help-credit">
                  {t.label} is {t.by}.{" "}
                  <a href={t.link} target="_blank" rel="noopener noreferrer">
                    Read the design ↗
                  </a>
                </p>
              </Show>
              <For each={t.drawings}>{(d) => <HelpFigure drawing={d} />}</For>
            </div>
          </Show>
        )}
      </For>
      <section class="memory-help-settings" aria-labelledby="memory-help-settings-title">
        <h5 id="memory-help-settings-title">What the settings change</h5>
        <dl>
          <For each={MEMORY_HELP_SETTINGS}>
            {(s) => (
              <div>
                <dt>{s.term}</dt>
                <dd>{s.text}</dd>
              </div>
            )}
          </For>
        </dl>
      </section>
    </HelpPopover>
  );
}
