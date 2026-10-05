import { createEffect, createResource, createSignal, on, Show } from "solid-js";
import type { SessionTitleSettingsInfo } from "../../shared/protocol";
import { getDelegateOptions, getSessionTitleSettings, shortenSessionTitles } from "../lib/api";
import { shortenCountLine, shortenDoneLine, shorteningLabel } from "../lib/auto-title";
import { fallbackFor, type DraftChoice, type Slot } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import {
  setTitleSettingsDraft as setDraft,
  setTitleSettingsSaved,
  titleSettingsDraft as draft,
  titleSettingsSaveError,
  titleSettingsSaveResult,
  titleSettingsSaving as saving,
} from "../lib/session-title-settings-draft";
import { INTERVAL, minutesIssue, QUIET, sameTitleSettings, toTitleDraft, withoutSubagentMarks, type SessionTitleDraft } from "../lib/session-title-settings-form";
import { home } from "../lib/ui-state";
import { Banner } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

/**
 * Settings → Summaries → Session titles (§app.settings-dialog/summaries): whether Sova names
 * sessions itself in the background, how often and after how long a quiet spell, and with which
 * model — a primary and an optional fallback, Delegate's rows. The section heads' Name sessions
 * button uses the same models, switch or not. Sova's own file, one per host; saved by the dialog's
 * footer (session-title-settings-draft.ts).
 */
export function SessionTitleSettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getSessionTitleSettings);
  const [options, { refetch: refetchOptions }] = createResource(getDelegateOptions);
  const loaded = (): SessionTitleSettingsInfo | undefined => (info.error ? undefined : info());
  const known = () => (options.state === "ready" ? withoutSubagentMarks(options()) : undefined);

  createEffect(() => {
    const i = loaded();
    if (i) setTitleSettingsSaved(i.settings);
  });
  // A save from the footer: what the server says now, fresh reasons included.
  createEffect(on(titleSettingsSaveResult, (r) => r && setInfo(r), { defer: true }));

  const edit = (patch: Partial<SessionTitleDraft>) => {
    const d = draft();
    if (d) setDraft({ ...d, ...patch });
  };
  const update = (slot: Slot, next: DraftChoice | null) => edit(slot === "primary" ? { primary: next! } : { fallback: next });
  /** Both configured models can't run: the reasons, row by row. */
  const neither = () => {
    const i = loaded();
    const u = i?.unusable;
    if (!u?.primary || (i!.settings.fallback && !u.fallback)) return null;
    return [`Primary: ${u.primary}.`, ...(u.fallback ? [`Fallback: ${u.fallback}.`] : [])].join(" ");
  };

  return (
    <section class="settings-delegate" aria-labelledby="settings-session-titles-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-session-titles-title">
          Session titles
        </h3>
        <Show when={loaded() && draft()}>
          <span class="settings-head-actions">
            <button
              type="button"
              class="button button-sm button-ghost"
              disabled={saving() || sameTitleSettings(draft()!, loaded()!.defaults)}
              onClick={() => setDraft(toTitleDraft(loaded()!.defaults))}
            >
              Reset to Defaults
            </button>
          </span>
        </Show>
      </div>
      <p class="settings-intro">
        A small model can name each session from what it became. The pencil on a section's heading names its unnamed
        sessions now; the switch below names new ones as they settle.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the session title settings."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>
      <Show when={neither()}>{(why) => <Banner tone="warn" title="Neither title model can run right now." body={why()} />}</Show>
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
          <legend class="visually-hidden">Session titles</legend>
          <label class="toggle toggle-switch settings-delegate-fallback-toggle">
            <span>Name sessions automatically</span>
            <input
              type="checkbox"
              checked={draft()!.enabled}
              disabled={saving()}
              aria-describedby="session-titles-auto-hint"
              onChange={(e) => edit({ enabled: e.currentTarget.checked })}
            />
            <span class="toggle-box" />
          </label>
          <p class="field-hint" id="session-titles-auto-hint">
            Names each session once, from its summary line, after it has been quiet for the time below. A title you or the
            Overseer set is never changed.
          </p>
          <div class="settings-team-numbers">
            <MinutesField
              id="session-titles-interval"
              label="Check every (minutes)"
              hint="How often the sweep looks for sessions to name."
              value={draft()!.intervalMinutes}
              range={INTERVAL}
              disabled={saving()}
              onInput={(v) => edit({ intervalMinutes: v })}
            />
            <MinutesField
              id="session-titles-quiet"
              label="After quiet for (minutes)"
              hint="A session is named once nothing was written in it for this long."
              value={draft()!.quietMinutes}
              range={QUIET}
              disabled={saving()}
              onInput={(v) => edit({ quietMinutes: v })}
            />
          </div>
          <WorkerSlotRow
            idPrefix="session-titles"
            slot="primary"
            info={loaded()!}
            options={known()}
            choice={draft()!.primary}
            other={draft()!.fallback}
            disabled={saving()}
            owner="Naming"
            otherwise="the session keeps its title"
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
          <Show when={draft()!.fallback} fallback={<p class="field-hint">No fallback: when the primary can't run, sessions keep their titles until it can.</p>}>
            {(fallback) => (
              <WorkerSlotRow
                idPrefix="session-titles"
                slot="fallback"
                info={loaded()!}
                options={known()}
                choice={fallback()}
                other={draft()!.primary}
                disabled={saving()}
                owner="Naming"
                otherwise="the session keeps its title"
                onChange={(next) => update("fallback", next)}
              />
            )}
          </Show>
        </fieldset>

        <Show when={titleSettingsSaveError()}>
          {(e) => <Banner tone="error" title="Couldn't save the session title settings." body={`${sentence(e().message)} Your saved choice is unchanged.`} />}
        </Show>
        <ShortenLongTitles />
        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>. Each host names its own sessions with its own settings.
        </p>
      </Show>
    </section>
  );
}

/**
 * Shorten long titles (§app.settings-dialog/summaries): a one-shot outside the saved form. A dry
 * run counts this host's long automatic, Overseer and older titles; a press renames them with the
 * saved models through the namer's race-safe writer. A title typed by hand is never counted or
 * changed — the server decides that, not this list.
 */
function ShortenLongTitles() {
  const [count, { refetch }] = createResource(async () => (await shortenSessionTitles(true)).results.length);
  const [running, setRunning] = createSignal(0);
  const [done, setDone] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const press = async () => {
    const n = count() ?? 0;
    if (running() || n === 0) return;
    setRunning(n);
    setDone(null);
    setError(null);
    try {
      setDone(shortenDoneLine((await shortenSessionTitles()).results));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(0);
      void refetch();
    }
  };
  return (
    <div class="field">
      <div>
        <button
          type="button"
          class="button button-sm"
          disabled={running() > 0 || !count()}
          aria-busy={running() ? "true" : undefined}
          aria-describedby="session-titles-shorten-hint"
          onClick={() => void press()}
        >
          {running() ? shorteningLabel(running()) : "Shorten Long Titles"}
        </button>
      </div>
      <p class="field-hint" id="session-titles-shorten-hint" aria-live="polite">
        <Show when={done()}>{(line) => <>{line()} </>}</Show>
        <Show when={count.state === "ready"}>{shortenCountLine(count()!)} </Show>
        Renames automatic, Overseer and older titles with the saved models. Titles you typed are never changed.
      </p>
      <Show when={error()}>{(e) => <Banner tone="error" title="Couldn't shorten the titles." body={sentence(e())} />}</Show>
    </div>
  );
}

/** A whole-minute field, Teams' number field: its hint, or what's wrong with the value in its place. */
function MinutesField(props: { id: string; label: string; hint: string; value: string; range: { min: number; max: number }; disabled: boolean; onInput(v: string): void }) {
  const issue = () => minutesIssue(props.value, props.range);
  return (
    <div class="field">
      <label class="field-label" for={props.id}>
        {props.label}
      </label>
      <input
        class="input text-num"
        id={props.id}
        type="number"
        inputmode="numeric"
        min={props.range.min}
        max={props.range.max}
        step="1"
        value={props.value}
        disabled={props.disabled}
        aria-invalid={issue() ? "true" : undefined}
        aria-describedby={`${props.id}-hint`}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <span class={issue() ? "field-error" : "field-hint"} id={`${props.id}-hint`}>
        {issue() ?? props.hint}
      </span>
    </div>
  );
}
