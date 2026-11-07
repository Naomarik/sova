import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import type {
  DecisionKeyInfo,
  DecisionProbeResult,
  DecisionSettingsInfo,
  DelegateOptions,
} from "../../shared/protocol";
import {
  deleteDecisionKey,
  getDecisionOptions,
  getDecisionSettings,
  probeDecisions,
  putDecisionKey,
} from "../lib/api";
import {
  decisionDirty,
  decisionDraft as draft,
  decisionNotes as notes,
  decisionRefused as refused,
  decisionSaveError,
  decisionSaveResult,
  decisionSaving as saving,
  setDecisionDraft as setDraft,
  setDecisionSaved,
} from "../lib/decision-draft";
import {
  chainLine,
  cloneDecision,
  decisionDraftReady,
  fallbackOn,
  jevChip,
  keyAfterProbe,
  keyInputIssue,
  noWarnings,
  offeredSuggestions,
  placeWarnings,
  probeLine,
  rebaseDecision,
  sameDecision,
  settingsOf,
  suggestionLabel,
  unansweredIssue,
  type DecisionDraft,
  reconcileOn,
} from "../lib/decision-form";
import { sameChoice, type DraftChoice } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import { announce, home } from "../lib/ui-state";
import { EXCLUSIONS_RULE } from "../../shared/decision-limits";
import { Choice, TextArea, TextField, Toggle } from "./form";
import { Banner, Chip } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");

/**
 * Settings → Decisions: who answers the small yes/no and pick-one questions behind "needs you"
 * flags and session tags — Jev with a key, a model the user picks, or Jev then that model — and
 * which of those features are on. Both features start off, and nothing leaves the machine until
 * one is on. Changes are staged and written by the dialog's Save Changes (decision-draft.ts),
 * rebased onto a fresh read first. The
 * Jev key is saved and removed on its own, at once, never through the draft; this screen only ever
 * sees its last 4 characters.
 */
export function DecisionSettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getDecisionSettings);
  const [options, { refetch: refetchOptions }] = createResource(getDecisionOptions);
  const loaded = (): DecisionSettingsInfo | undefined => (info.error ? undefined : info());

  // setDecisionSaved is untracked (settings-draft.ts), so this tracks the loaded info only.
  createEffect(() => {
    const i = loaded();
    if (i) setDecisionSaved(i.settings);
  });

  const known = (): DelegateOptions | undefined => (options.state === "ready" ? options() : undefined);
  const key = (): DecisionKeyInfo => loaded()!.key;
  const setKeyInfo = (k: DecisionKeyInfo) => setInfo((i) => (i ? { ...i, key: k } : i));

  // A save from the dialog's footer: what the server says now (the chain line, the backfill).
  createEffect(on(decisionSaveResult, (r) => r && setInfo(r), { defer: true }));
  const dirty = decisionDirty;

  const edit = (change: (copy: DecisionDraft) => void) => {
    const copy = cloneDecision(draft()!);
    change(copy);
    setDraft(copy);
  };

  // ---- the key: its own actions, applied at once ----
  const [keyText, setKeyText] = createSignal("");
  const [keyEditing, setKeyEditing] = createSignal(false);
  const [keyBusy, setKeyBusy] = createSignal(false);
  const [keyError, setKeyError] = createSignal<string | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const keyIssue = () => keyInputIssue(keyText());
  const showKeyInput = () => !key().present || keyEditing();
  const jev = createMemo(() => {
    const i = loaded();
    return i ? jevChip(i.settings.jev.enabled, i.key, i.chain.providers.find((p) => p.id === "jev")) : null;
  });

  const saveKey = async () => {
    if (keyIssue() || keyBusy()) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const k = await putDecisionKey(keyText().trim());
      if (k.status === "rejected") {
        setKeyError(`Jev didn't accept that key, so it wasn't saved.${k.message ? ` ${sentence(k.message)}` : ""}`);
      } else {
        setKeyInfo(k);
        setKeyText("");
        setKeyEditing(false);
        announce("Jev key saved.");
        void refetchInfo(); // the chain changes with the key
      }
    } catch (err) {
      setKeyError(`${sentence(message(err))} The key wasn't saved.`);
    } finally {
      setKeyBusy(false);
    }
  };
  const removeKey = async () => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      setKeyInfo(await deleteDecisionKey());
      setConfirmRemove(false);
      announce("Jev key removed.");
      void refetchInfo();
    } catch (err) {
      setKeyError(`${sentence(message(err))} The key is still stored.`);
    } finally {
      setKeyBusy(false);
    }
  };

  // ---- Test: one canned decision through the saved chain ----
  const [probing, setProbing] = createSignal(false);
  const [probe, setProbe] = createSignal<DecisionProbeResult | null>(null);
  const [probeError, setProbeError] = createSignal<string | null>(null);
  const runProbe = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const r = await probeDecisions();
      setProbe(r);
      // The probe also checked the key: show that at once, then take the server's own status.
      setInfo((i) => (i ? { ...i, chain: r.chain, key: keyAfterProbe(i.key, r) } : i));
      void refetchInfo();
    } catch (err) {
      setProbe(null);
      setProbeError(message(err));
    } finally {
      setProbing(false);
    }
  };

  const suggestions = createMemo(() => offeredSuggestions(loaded()?.suggestions ?? [], known(), !!options.error));
  const unanswered = () => (draft() && loaded() ? unansweredIssue(draft()!, key()) : null);
  const refusedHere = () => {
    const r = refused();
    return r && draft() && sameChoice(draft()!.fallback, r.choice) ? r : null;
  };

  /** Test Decisions: one canned check through the saved chain, shown in every Jev key row. It waits for a save in flight. */
  const testButton = (cls: string) => (
    <button type="button" class={cls} disabled={probing() || saving() || !loaded()!.chain.ready} onClick={() => void runProbe()}>
      {probing() ? "Asking…" : "Test Decisions"}
    </button>
  );

  /** A switch and its hint; an `issue` replaces the hint (in warn) while the switch is on. */
  const switchRow = (id: string, label: string, hint: string, checked: () => boolean, set: (on: boolean) => void, issue?: () => string | null) => (
    <Toggle
      switch
      id={id}
      class="settings-team-enable"
      label={label}
      checked={checked()}
      disabled={saving()}
      onChange={set}
      hint={<Show when={checked() && issue?.()} fallback={hint}>{(w) => <span class="settings-delegate-issue settings-delegate-issue-warn">{w()}</span>}</Show>}
    />
  );

  return (
    <section class="settings-delegate" aria-labelledby="settings-decisions-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-decisions-title">
          Decisions
        </h3>
      </div>
      <p class="settings-intro">
        Sova can ask a small classifier about your sessions — whether a finished turn is waiting on you, and what a session
        is about. Everything here is off until you turn it on.
      </p>

      <Show when={info.error}>
        <Banner
          tone="error"
          title="Couldn't load the decision settings."
          body="Nothing was changed."
          action={<RetryButton label="Try Again" onClick={() => void refetchInfo()} />}
        />
      </Show>

      <Show when={loaded() && draft()}>
        <p class="decisions-privacy" data-testid="decisions-privacy">
          Each check sends a short, redacted excerpt of one session — its title, the last exchange, and recent tool names —
          to Jev (TypeSafe) or your fallback model; never whole transcripts, images, or files. The Overseer's own sessions
          are never checked.
        </p>

        <fieldset class="settings-delegate-profile" aria-describedby="decisions-jev-desc">
          <legend class="settings-delegate-legend">Jev</legend>
          <p class="field-hint settings-delegate-desc" id="decisions-jev-desc">
            TypeSafe's classifier. Fast and cheap — about $0.0001 a check.
          </p>
          <Toggle switch class="settings-team-enable" label="Use Jev" checked={draft()!.jev.enabled} disabled={saving()} onChange={(on) => edit((c) => (c.jev.enabled = on))} />
          <ul class="decisions-providers">
            <li class="decisions-provider" data-testid="decisions-jev">
              <Chip tone={jev()!.tone}>{keyBusy() && !confirmRemove() ? "Checking" : jev()!.word}</Chip>
              <span class="decisions-provider-name">Jev</span>
              <span class="decisions-provider-fact" title={jev()!.fact}>
                {keyBusy() && !confirmRemove() ? "Checking the key…" : jev()!.fact}
              </span>
            </li>
          </ul>
          <Show when={key().source === "env"}>
            <p class="field-hint">The key comes from SOVA_JEV_KEY in the server's environment, so it can't be changed here.</p>
            <div class="settings-delegate-actions">{testButton("button button-sm")}</div>
          </Show>
          <Show when={key().source !== "env"}>
            <Show
              when={showKeyInput()}
              fallback={
                <div class="settings-delegate-actions">
                  <Show
                    when={confirmRemove()}
                    fallback={
                      <>
                        <button type="button" class="button button-sm" disabled={keyBusy()} onClick={() => setKeyEditing(true)}>
                          Replace Key
                        </button>
                        <button type="button" class="button button-sm button-destructive" disabled={keyBusy()} onClick={() => setConfirmRemove(true)}>
                          Remove Key
                        </button>
                        {testButton("button button-sm")}
                      </>
                    }
                  >
                    <span class="field-hint">
                      The stored key is deleted from this machine. Jev stays switched on but can't answer until you save another.
                    </span>
                    <button type="button" class="button button-sm button-ghost" disabled={keyBusy()} onClick={() => setConfirmRemove(false)}>
                      Cancel
                    </button>
                    <button type="button" class="button button-sm button-destructive" disabled={keyBusy()} onClick={() => void removeKey()}>
                      {keyBusy() ? "Removing…" : "Remove Key"}
                    </button>
                  </Show>
                </div>
              }
            >
              <div class="decisions-key">
                <TextField
                  id="decisions-key"
                  label="Jev key"
                  inputClass="text-mono"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  placeholder="Paste a key"
                  value={keyText()}
                  error={keyError()}
                  disabled={keyBusy()}
                  onInput={(v) => {
                    setKeyText(v);
                    setKeyError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveKey();
                  }}
                />
                <Show when={key().present}>
                  <button
                    type="button"
                    class="button button-ghost"
                    disabled={keyBusy()}
                    onClick={() => {
                      setKeyEditing(false);
                      setKeyText("");
                      setKeyError(null);
                    }}
                  >
                    Cancel
                  </button>
                </Show>
                <button type="button" class="button" disabled={keyBusy() || keyIssue() !== null} onClick={() => void saveKey()}>
                  {keyBusy() ? "Checking…" : "Save Key"}
                </button>
                {testButton("button button-ghost")}
              </div>
              <p class="field-hint">Checked with Jev before it's stored, and kept on this machine only. Sova never shows it again.</p>
            </Show>
          </Show>
          <Show when={keyError() && !showKeyInput()}>
            <p class="field-error">{keyError()}</p>
          </Show>
          <Show when={!probing() && probe()}>
            {(r) => (
              <p class={`settings-delegate-issue settings-delegate-issue-${r().ok ? (r().fellBackFrom ? "warn" : "muted") : "error"}`} role="status" data-testid="decisions-probe">
                {probeLine(r())}
              </p>
            )}
          </Show>
          <Show when={!probing() && probeError()}>{(m) => <p class="field-error">{sentence(m())}</p>}</Show>
        </fieldset>

        <fieldset class="settings-delegate-profile" aria-describedby="decisions-fallback-desc">
          <legend class="settings-delegate-legend">Fallback model</legend>
          <p class="field-hint settings-delegate-desc" id="decisions-fallback-desc">
            Answers when Jev is off or can't. Its provider bills it — a local model keeps every check on this machine.
          </p>
          <Show when={draft()!.fallback && options.error}>
            <Banner
              tone="warn"
              title="Couldn't check which models are offered."
              body="Your saved choice stays, marked not verified."
              action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />}
            />
          </Show>
          <Choice
            label="Fallback model"
            value={draft()!.fallback === null ? "none" : "model"}
            options={[
              { value: "none", label: "None" },
              { value: "model", label: "A model" },
            ]}
            disabled={saving()}
            onChange={(v) => edit((c) => (c.fallback = v === "none" ? null : (c.fallback ?? fallbackOn(true))))}
          />
          <Show when={draft()!.fallback}>
            {(fallback) => (
              <WorkerSlotRow
                idPrefix="decisions"
                slot="primary"
                info={loaded()!}
                options={known()}
                choice={fallback()}
                other={null}
                disabled={saving()}
                owner="Decisions"
                alone="Fallback model"
                onChange={(next) => edit((c) => (c.fallback = next))}
              />
            )}
          </Show>
          <Show when={refusedHere()}>
            {(r) => (
              <p class="settings-delegate-issue settings-delegate-issue-error" role="alert" data-testid="decisions-fallback-refused">
                {sentence(r().reason)} Your saved fallback model is unchanged.
              </p>
            )}
          </Show>
          <For each={notes().fallback}>{(w) => <p class="settings-delegate-issue settings-delegate-issue-warn">{sentence(w)}</p>}</For>
          <Show when={suggestions().length > 0}>
            <div class="settings-delegate-actions" role="group" aria-label="Suggested models">
              <span class="field-hint">Suggested:</span>
              <For each={suggestions()}>
                {(s) => (
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    disabled={saving() || sameChoice(draft()!.fallback, s)}
                    onClick={() => edit((c) => (c.fallback = { ...s }))}
                  >
                    {suggestionLabel(s, loaded()!.backends)}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <p class="field-hint settings-delegate-desc" data-testid="decisions-chain-line">
            {chainLine(loaded()!.settings, key(), loaded()!.chain)}
          </p>
        </fieldset>

        <fieldset class="settings-delegate-profile">
          <legend class="settings-delegate-legend">Features</legend>
          {switchRow(
            "decisions-attention",
            "Flag sessions that need you",
            "After a turn, checks whether the reply waits on you (a decision, an approval or information) or says it is done without checking, notices a team gone quiet and whether a merge left work open, and marks the row. The Overseer and Needs you list them too.",
            () => draft()!.features.attention,
            (on) => edit((c) => (c.features.attention = on)),
            unanswered,
          )}
          {switchRow(
            "decisions-reconcile",
            "Reconcile decisions",
            "Compares decisions recorded in hand-off sessions and sends contradictions to whoever decides. Only the decision text is sent.",
            () => reconcileOn(draft()!.features),
            (on) => edit((c) => (c.features.reconcile = on)),
            unanswered,
          )}
          {switchRow(
            "decisions-message-labels",
            "Label your messages",
            "Labels each message you type or dictate by what it asks for, and shows the time on each in the session's Time Spent tab. Only messages sent while this is on. The agent never sees a label.",
            () => draft()!.features.messageLabels === true,
            (on) => edit((c) => (c.features.messageLabels = on)),
            unanswered,
          )}
          {/* The switches already say it when nobody can answer; the server's note covers the other reasons. */}
          <Show when={!unanswered()}>
            <For each={notes().features}>{(w) => <p class="settings-delegate-issue settings-delegate-issue-warn">{sentence(w)}</p>}</For>
          </Show>
        </fieldset>

        <fieldset class="settings-delegate-profile">
          <legend class="settings-delegate-legend">Never send</legend>
          {switchRow(
            "decisions-tui",
            "Never send TUI sessions",
            "Sessions started in the pi terminal stay on this machine.",
            () => draft()!.neverSendTui,
            (on) => edit((c) => (c.neverSendTui = on)),
          )}
          <TextArea
            id="decisions-exclusions"
            label="Folders"
            inputClass="text-mono"
            rows={3}
            spellcheck={false}
            placeholder="~/work/client"
            hint="One per line. Sessions in these folders, and their subfolders, are never checked."
            rule={EXCLUSIONS_RULE}
            value={draft()!.exclusions}
            disabled={saving()}
            onInput={(v) => setDraft({ ...draft()!, exclusions: v })}
          />
        </fieldset>

        <Show when={decisionSaveError()}>
          {(e) => <Banner tone="error" title="Couldn't save the decision settings." body={`${sentence(e().message)} Your saved settings are unchanged.`} />}
        </Show>
        <Show when={notes().other.length > 0 && !dirty()}>
          <Banner tone="warn" title="Saved, with notes." body={notes().other.map(sentence).join(" ")} />
        </Show>

        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>. The key is stored separately, readable by you only.
        </p>
      </Show>
    </section>
  );
}
