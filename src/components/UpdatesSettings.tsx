import { createEffect, createSignal, For, Show } from "solid-js";
import type { UpdatesState, UpdateStep } from "../../shared/protocol";
import { applyUpdate, checkUpdates } from "../lib/api";
import { relativeTime } from "../lib/format";
import { announce } from "../lib/ui-state";
import { KIND_LABEL, refreshUpdates, resultLine, runningLine, setUpdatesState, sourceName, upgradeLabel, updatesState } from "../lib/updates";
import { setUpdatesDraft, setUpdatesSaved, updatesDraft, updatesSaveError, updatesSaving, type UpdatesDraft } from "../lib/updates-draft";
import { Banner } from "./ui";
import { sentence } from "./WorkerSlotRow";

/**
 * Settings → General's **Updates · this machine**: what runs, the last check and what
 * it found, Check Now, the upgrade button with its one confirm and its progress, then the Updates
 * form (Update from, Check for updates automatically, Upgrade automatically), staged and written by
 * the dialog's Save Changes (updates-draft.ts).
 */

const STEPS: { step: UpdateStep; label: string }[] = [
  { step: "downloading", label: "Downloading" },
  { step: "installing", label: "Installing" },
  { step: "building", label: "Building" },
  { step: "restarting", label: "Restarting" },
  { step: "verifying", label: "Checking" },
];

/** How long a finished upgrade's outcome stays in the section. */
const RECENT_JOB_MS = 24 * 60 * 60 * 1000;

export function UpdatesSettingsSection() {
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [acting, setActing] = createSignal<"check" | "apply" | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [confirming, setConfirming] = createSignal(false);

  // The section reads afresh when it opens; the form is seeded from what's saved.
  void refreshUpdates().then((s) => {
    if (!s) setLoadError("Couldn't read this machine's update settings.");
  });
  createEffect(() => {
    const s = updatesState();
    if (s) setUpdatesSaved(s.settings);
  });

  const s = () => updatesState();
  const edit = (patch: Partial<UpdatesDraft>) => {
    const d = updatesDraft();
    if (d) setUpdatesDraft({ ...d, ...patch });
  };
  /** The last check, when it compared what runs now against the saved source. */
  const current = () => {
    const st = s();
    const c = st?.lastCheck;
    if (!st || !c) return null;
    const same = c.source.kind === st.settings.source.kind && (c.source.kind !== "branch" || (st.settings.source.kind === "branch" && c.source.branch === st.settings.source.branch));
    return same && c.head === st.running.head ? c : null;
  };
  const offer = () => {
    const c = current();
    const st = s();
    if (!c?.ok || !c.result || !st?.available) return null;
    return c.result.state === "available" || c.result.state === "diverged" ? c.result.target : null;
  };
  const running = () => s()?.job?.state === "running";

  const checkNow = async () => {
    setActing("check");
    setActionError(null);
    try {
      const next = await checkUpdates();
      setUpdatesState(next);
      const c = next.lastCheck;
      announce(c?.ok && c.result ? resultLine(c.result, next.settings.source) : (c?.error ?? "Checked."));
    } catch (err) {
      setActionError(sentence(err instanceof Error ? err.message : String(err)));
    } finally {
      setActing(null);
    }
  };

  const upgrade = async (sha: string) => {
    setActing("apply");
    setActionError(null);
    try {
      setUpdatesState(await applyUpdate(sha));
      setConfirming(false);
      announce("The upgrade started.");
    } catch (err) {
      setActionError(sentence(err instanceof Error ? err.message : String(err)));
    } finally {
      setActing(null);
    }
  };

  const checkedLine = (st: UpdatesState) => {
    const c = st.lastCheck;
    if (st.checking || acting() === "check") return "Checking…";
    if (!c) return st.checksOff ? "Checks are off on this server." : "Not checked yet.";
    const when = relativeTime(c.at);
    if (!c.ok) return `Checked ${when}: ${c.error ?? "the check failed."}`;
    if (!current()) return `Not checked against ${sourceName(st.settings.source)} yet.`;
    return `Checked ${when}.`;
  };

  return (
    <section class="settings-updates" aria-labelledby="settings-updates-title">
      <h3 class="settings-type-title" id="settings-updates-title">
        Updates · this machine
      </h3>
      <Show when={loadError() && !s()}>
        <Banner tone="error" title={loadError()!} body="Nothing was changed. Close and open Settings to try again." />
      </Show>
      <Show when={s()}>
        {(st) => (
          <>
            <div class="settings-updates-running">
              <span class="settings-updates-version">{runningLine(st().running)}</span>
              <Show when={st().running.head}>
                <code class="settings-updates-sha">{st().running.head!.slice(0, 7)}</code>
              </Show>
              <span class="chip">{KIND_LABEL[st().running.kind]}</span>
            </div>
            <Show when={!st().running.canUpgrade && st().running.whyNot}>
              <p class="field-hint">{st().running.whyNot}</p>
            </Show>

            <div class="settings-updates-status" aria-live="polite">
              <p class="settings-updates-checked">{checkedLine(st())}</p>
              <Show when={!st().checking && acting() !== "check" && current()?.ok && current()!.result}>
                {(r) => <p class="settings-updates-result">{resultLine(r(), st().settings.source)}</p>}
              </Show>
              <Show when={st().autoRefusal}>
                <p class="field-hint">Upgrade automatically didn't start: {st().autoRefusal}</p>
              </Show>
            </div>

            <Show when={running() ? null : offer()}>
              {(t) => (
                <div class="settings-updates-offer">
                  <Show when={t().notes}>
                    <details class="settings-updates-notes">
                      <summary>Release Notes</summary>
                      <pre>{t().notes}</pre>
                      <Show when={t().notesUrl}>
                        <a href={t().notesUrl!} target="_blank" rel="noreferrer">
                          Open on GitHub
                        </a>
                      </Show>
                    </details>
                  </Show>
                  <Show when={!t().notes && t().notesUrl}>
                    <a class="settings-updates-link" href={t().notesUrl!} target="_blank" rel="noreferrer">
                      {t().version ? "Release Notes" : "See the Changes"}
                    </a>
                  </Show>
                  <Show
                    when={confirming()}
                    fallback={
                      <button type="button" class="button button-primary" disabled={acting() !== null} onClick={() => setConfirming(true)}>
                        {upgradeLabel(st().settings.source, t(), st().running)}
                      </button>
                    }
                  >
                    <div class="settings-updates-confirm" role="group" aria-label="Confirm the upgrade">
                      <p>Sova restarts once {t().label} is built. Chats keep running and move to the new code when they're idle.</p>
                      <div class="button-row">
                        <button type="button" class="button button-primary" disabled={acting() !== null} onClick={() => void upgrade(t().sha)}>
                          {acting() === "apply" ? "Starting…" : "Upgrade Now"}
                        </button>
                        <button type="button" class="button button-ghost" disabled={acting() !== null} onClick={() => setConfirming(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={st().job}>
              {(job) => (
                <Show
                  when={job().state === "running"}
                  fallback={
                    <Show when={Date.now() - Date.parse(job().endedAt ?? job().startedAt) < RECENT_JOB_MS}>
                      <Banner
                        tone={job().state === "succeeded" ? "success" : job().state === "rolled-back" ? "warn" : "error"}
                        title={job().detail ?? job().state}
                        body={
                          <>
                            {job().auto ? "Started by Upgrade automatically. " : ""}Log: <code>{job().logPath}</code>
                          </>
                        }
                      />
                    </Show>
                  }
                >
                  <div class="settings-updates-progress" role="status">
                    <p>
                      Upgrading to {job().to.label}
                      {job().step === "rolling-back" ? " · putting the previous version back" : ""}
                    </p>
                    <ol class="settings-updates-steps">
                      <For each={STEPS}>
                        {(x) => {
                          const at = () => STEPS.findIndex((y) => y.step === job().step);
                          const mine = STEPS.findIndex((y) => y.step === x.step);
                          return (
                            <li classList={{ done: mine < at(), now: mine === at() }} aria-current={mine === at() ? "step" : undefined}>
                              {x.label}
                            </li>
                          );
                        }}
                      </For>
                    </ol>
                  </div>
                </Show>
              )}
            </Show>

            <div class="button-row">
              <button type="button" class="button button-sm" disabled={acting() !== null || st().checking || st().checksOff || !st().running.head || running()} onClick={() => void checkNow()}>
                {acting() === "check" || st().checking ? "Checking…" : "Check Now"}
              </button>
            </div>
            <Show when={actionError()}>
              <Banner tone="error" title={actionError()!} body="Nothing was changed." />
            </Show>

            <Show when={updatesDraft()}>
              {(d) => (
                <div class="settings-updates-form">
                  <div class="field settings-field">
                    <label class="field-label" for="updates-source">
                      Update from
                    </label>
                    <div class="select-wrap">
                      <select class="select" id="updates-source" disabled={updatesSaving()} onChange={(e) => edit({ source: e.currentTarget.value as UpdatesDraft["source"] })}>
                        <option value="stable" selected={d().source === "stable"}>
                          Stable releases
                        </option>
                        <option value="master" selected={d().source === "master"}>
                          Latest changes (master)
                        </option>
                        <option value="branch" selected={d().source === "branch"}>
                          A branch
                        </option>
                      </select>
                      <span class="select-caret" aria-hidden="true">
                        ▾
                      </span>
                    </div>
                    <span class="field-hint">Always Sova's own repository. Changing it installs nothing.</span>
                  </div>
                  <Show when={d().source === "branch"}>
                    <div class="field settings-field">
                      <label class="field-label" for="updates-branch">
                        Branch
                      </label>
                      <input
                        class="input input-mono"
                        id="updates-branch"
                        value={d().branch}
                        placeholder="feat/name"
                        spellcheck={false}
                        autocomplete="off"
                        disabled={updatesSaving()}
                        aria-invalid={!d().branch.trim() ? "true" : undefined}
                        onInput={(e) => edit({ branch: e.currentTarget.value })}
                      />
                      <Show when={!d().branch.trim()} fallback={<span class="field-hint">Save Changes looks it up in Sova's repository.</span>}>
                        <span class="field-error">Name the branch.</span>
                      </Show>
                    </div>
                  </Show>
                  <label class="toggle settings-updates-toggle">
                    <input type="checkbox" checked={d().autoCheck} disabled={updatesSaving()} onChange={(e) => edit({ autoCheck: e.currentTarget.checked })} />
                    <span class="toggle-box" aria-hidden="true" />
                    Check for updates automatically
                  </label>
                  <span class="field-hint">Once a day, whether or not Sova is open in a browser.</span>
                  <label class="toggle settings-updates-toggle">
                    <input
                      type="checkbox"
                      checked={d().autoUpgrade}
                      disabled={updatesSaving() || !st().running.canUpgrade}
                      onChange={(e) => edit({ autoUpgrade: e.currentTarget.checked })}
                    />
                    <span class="toggle-box" aria-hidden="true" />
                    Upgrade automatically
                  </label>
                  <span class="field-hint">
                    When a check finds an update, we install it and restart Sova. Chats keep running and move to the new code when they're idle.
                  </span>
                </div>
              )}
            </Show>
            <Show when={updatesSaveError()}>
              {(e) => <Banner tone="error" title="Couldn't save the update settings." body={`${sentence(e().message)} Your saved settings are unchanged.`} />}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
