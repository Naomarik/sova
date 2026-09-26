import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type {
  DecisionKeyInfo,
  DecisionProbeResult,
  DecisionSaveResult,
  DecisionSettings,
  DecisionSettingsInfo,
  DelegateOptions,
  TagsBackfillProgress,
  TagsBackfillScope,
} from "../../shared/protocol";
import {
  ApiError,
  cancelTagsBackfill,
  deleteDecisionKey,
  getDecisionOptions,
  getDecisionSettings,
  getTagsBackfill,
  probeDecisions,
  putDecisionKey,
  putDecisionSettings,
  startTagsBackfill,
} from "../lib/api";
import { decisionDraft as draft, decisionSaved, setDecisionDraft as setDraft, setDecisionSaved } from "../lib/decision-draft";
import {
  backfillBlocked,
  backfillLine,
  chainLine,
  cloneDecision,
  commitOf,
  draftOf,
  exclusionIssue,
  fallbackOn,
  jevChip,
  keyAfterProbe,
  keyInputIssue,
  newerProgress,
  noWarnings,
  offeredSuggestions,
  placeWarnings,
  probeLine,
  revertFailed,
  sameDecision,
  suggestionLabel,
  unansweredIssue,
  type DecisionDraft,
} from "../lib/decision-form";
import { sameChoice, type DraftChoice } from "../lib/delegate-form";
import { tildePath } from "../lib/format";
import { createSaveQueue } from "../lib/save-queue";
import { pushedBackfill } from "../lib/session-feed";
import { announce, home } from "../lib/ui-state";
import { Banner, Chip } from "./ui";
import { RetryButton, sentence, WorkerSlotRow } from "./WorkerSlotRow";

/** How often the backfill's progress is re-read while it runs (the session feed also pushes it). */
const BACKFILL_POLL_MS = 2000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");

/**
 * Settings → Decisions: who answers the small yes/no and pick-one questions behind "needs you"
 * flags and session tags — Jev with a key, a model the user picks, or Jev then that model — and
 * which of those features are on. Both features start off, and nothing leaves the machine until
 * one is on. Every change is saved as it is made (Folders when you leave the box), one write at a
 * time. The Jev key is saved and removed on its own, at once, never through the draft; this
 * screen only ever sees its last 4 characters.
 */
export function DecisionSettingsSection() {
  const [info, { mutate: setInfo, refetch: refetchInfo }] = createResource(getDecisionSettings);
  const [options, { refetch: refetchOptions }] = createResource(getDecisionOptions);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [notes, setNotes] = createSignal(noWarnings());
  /** A fallback the server refused: it stays in the row with the reason, and isn't sent again until changed. */
  const [refused, setRefused] = createSignal<{ choice: DraftChoice; reason: string } | null>(null);
  const loaded = (): DecisionSettingsInfo | undefined => (info.error ? undefined : info());

  // Tracks the loaded info only (as TeamSettings does): the dialog's reset of the draft must not re-seed it.
  createEffect(() => {
    const i = loaded();
    if (i) untrack(() => setDecisionSaved(i.settings));
  });

  const known = (): DelegateOptions | undefined => (options.state === "ready" ? options() : undefined);
  const key = (): DecisionKeyInfo => loaded()!.key;
  const setKeyInfo = (k: DecisionKeyInfo) => setInfo((i) => (i ? { ...i, key: k } : i));

  // ---- autosave: each change is written as it is made, one write at a time, the newest winning ----
  /** What the server will hold once the queue drains, while it hasn't; else null (it holds what is saved). */
  let lastPushed: DecisionSettings | null = null;
  const landed = (result: DecisionSaveResult) => {
    setInfo(result);
    setDecisionSaved(result.settings);
  };
  const queue = createSaveQueue<DecisionSettings, DecisionSaveResult>({
    send: putDecisionSettings,
    saved(result, sent) {
      lastPushed = null;
      if (!draft()) return; // the dialog closed meanwhile
      const before = decisionSaved();
      landed(result);
      setNotes((n) => placeWarnings(n, result.warnings, !before || !sameChoice(before.fallback, sent.fallback)));
      announce("Decision settings saved.");
    },
    failed(err, sent, older) {
      lastPushed = null;
      if (!draft()) return;
      if (older) landed(older);
      const stored = decisionSaved()!;
      if (err instanceof ApiError && err.status === 400 && sent.fallback && !sameChoice(sent.fallback, stored.fallback)) {
        // The fallback was refused: it stays in the row with the reason; the rest of that write goes again without it.
        setRefused({ choice: { ...sent.fallback }, reason: message(err).replace(/^Fallback model: /, "") });
        commit();
        return;
      }
      setDraft(revertFailed(draft()!, sent, stored));
      setSaveError(message(err));
    },
    busy: setSaving,
  });

  /** Write what can be written of the draft, unless the server holds (or is about to hold) it already. */
  const commit = () => {
    const d = draft();
    const stored = decisionSaved();
    if (!d || !stored) return;
    if (refused() && !sameChoice(d.fallback, refused()!.choice)) setRefused(null);
    const next = commitOf(d, stored, refused()?.choice ?? null);
    if (sameDecision(draftOf(next), lastPushed ?? stored)) return;
    lastPushed = next;
    queue.push(next);
  };

  const edit = (change: (copy: DecisionDraft) => void) => {
    setSaveError(null);
    const copy = cloneDecision(draft()!);
    change(copy);
    setDraft(copy);
    commit();
  };
  // Folders typed and not yet left when the tab changes: write them as leaving would.
  onCleanup(commit);

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

  // ---- the tag backfill: read on open, re-read while it runs, and whatever the feed pushes ----
  const [polled, setPolled] = createSignal<TagsBackfillProgress | null>(null);
  const progress = createMemo(() => newerProgress(polled(), pushedBackfill()));
  const [backfillError, setBackfillError] = createSignal<string | null>(null);
  const [backfillBusy, setBackfillBusy] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readProgress = async () => {
    try {
      setPolled(await getTagsBackfill());
    } catch {
      // No backfill route (an older server): the controls show no progress.
    }
  };
  void readProgress();
  createEffect(() => {
    clearTimeout(timer);
    if (progress()?.running) timer = setTimeout(() => void readProgress(), BACKFILL_POLL_MS);
  });
  onCleanup(() => clearTimeout(timer));
  const backfillAct = async (run: () => Promise<TagsBackfillProgress>) => {
    setBackfillError(null);
    setBackfillBusy(true);
    try {
      setPolled(await run());
    } catch (err) {
      setBackfillError(message(err));
    } finally {
      setBackfillBusy(false);
    }
  };
  const startBackfill = (scope: TagsBackfillScope) => void backfillAct(() => startTagsBackfill(scope));
  const blocked = () => {
    const i = loaded();
    return i ? backfillBlocked(i.chain) : null;
  };

  const suggestions = createMemo(() => offeredSuggestions(loaded()?.suggestions ?? [], known(), !!options.error));
  const unanswered = () => (draft() && loaded() ? unansweredIssue(draft()!, key()) : null);
  const exclusionsIssue = () => (draft() ? exclusionIssue(draft()!.exclusions) : null);
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
    <div>
      <label class="toggle toggle-switch settings-team-enable">
        <span>{label}</span>
        <input type="checkbox" checked={checked()} aria-describedby={`${id}-hint`} onChange={(e) => set(e.currentTarget.checked)} />
        <span class="toggle-box" />
      </label>
      <Show
        when={checked() && issue?.()}
        fallback={
          <p class="field-hint" id={`${id}-hint`}>
            {hint}
          </p>
        }
      >
        {(w) => (
          <p class="settings-delegate-issue settings-delegate-issue-warn" id={`${id}-hint`}>
            {w()}
          </p>
        )}
      </Show>
    </div>
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
          <label class="toggle toggle-switch settings-team-enable">
            <span>Use Jev</span>
            <input type="checkbox" checked={draft()!.jev.enabled} onChange={(e) => edit((c) => (c.jev.enabled = e.currentTarget.checked))} />
            <span class="toggle-box" />
          </label>
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
                <div class="field">
                  <label class="field-label" for="decisions-key">
                    Jev key
                  </label>
                  <input
                    class="input text-mono"
                    id="decisions-key"
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    placeholder="Paste a key"
                    value={keyText()}
                    disabled={keyBusy()}
                    onInput={(e) => {
                      setKeyText(e.currentTarget.value);
                      setKeyError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveKey();
                    }}
                  />
                </div>
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
          <Show when={keyError()}>{(m) => <p class="field-error">{m()}</p>}</Show>
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
          <div role="radiogroup" aria-label="Fallback model">
            <label class="toggle settings-team-enable">
              <input type="radio" name="decisions-fallback" checked={draft()!.fallback === null} onChange={() => edit((c) => (c.fallback = null))} />
              <span class="toggle-box" aria-hidden="true" />
              None
            </label>
            <label class="toggle settings-team-enable">
              <input
                type="radio"
                name="decisions-fallback"
                checked={draft()!.fallback !== null}
                onChange={() => edit((c) => (c.fallback = c.fallback ?? fallbackOn(true)))}
              />
              <span class="toggle-box" aria-hidden="true" />A model
            </label>
          </div>
          <Show when={draft()!.fallback}>
            {(fallback) => (
              <WorkerSlotRow
                idPrefix="decisions"
                slot="primary"
                info={loaded()!}
                options={known()}
                choice={fallback()}
                other={null}
                disabled={false}
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
                    disabled={sameChoice(draft()!.fallback, s)}
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
            "After each finished turn, checks whether it asks you something, failed, or is going in circles, and marks the row. The Overseer lists them too.",
            () => draft()!.features.attention,
            (on) => edit((c) => (c.features.attention = on)),
            unanswered,
          )}
          {switchRow(
            "decisions-tags",
            "Tag sessions",
            "Gives each session a topic and a status word you can search.",
            () => draft()!.features.tags,
            (on) => edit((c) => (c.features.tags = on)),
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
          <div class="field">
            <label class="field-label" for="decisions-exclusions">
              Folders
            </label>
            <textarea
              class="input textarea text-mono"
              id="decisions-exclusions"
              rows={3}
              spellcheck={false}
              placeholder="~/work/client"
              value={draft()!.exclusions}
              aria-invalid={exclusionsIssue() ? "true" : undefined}
              aria-describedby="decisions-exclusions-hint"
              onInput={(e) => {
                setSaveError(null);
                setDraft({ ...draft()!, exclusions: e.currentTarget.value });
              }}
              onBlur={commit}
            />
            <span class={exclusionsIssue() ? "field-error" : "field-hint"} id="decisions-exclusions-hint">
              {exclusionsIssue() ?? "One per line. Sessions in these folders, and their subfolders, are never checked."}
            </span>
          </div>
        </fieldset>

        <Show when={saveError()}>
          {(m) => <Banner tone="error" title="Couldn't save the decision settings." body={`${sentence(m())} Your saved settings are unchanged.`} />}
        </Show>
        <Show when={notes().other.length > 0}>
          <Banner tone="warn" title="Saved, with notes." body={notes().other.map(sentence).join(" ")} />
        </Show>

        <Show when={loaded()!.settings.features.tags || progress()?.running}>
          <fieldset class="settings-delegate-profile" aria-describedby="decisions-backfill-desc">
            <legend class="settings-delegate-legend">Tag past sessions</legend>
            <p class="field-hint settings-delegate-desc" id="decisions-backfill-desc">
              New sessions are tagged as they finish. This tags the ones from before, 2 at a time, and skips any already
              tagged. On a fallback model it costs more and takes longer.
            </p>
            <div class="decisions-backfill">
              <Show
                when={progress()?.running}
                fallback={
                  <>
                    <button type="button" class="button button-sm" disabled={backfillBusy() || saving() || blocked() !== null} onClick={() => startBackfill("recent")}>
                      Tag Last 30 Days
                    </button>
                    <button type="button" class="button button-sm" disabled={backfillBusy() || saving() || blocked() !== null} onClick={() => startBackfill("all")}>
                      Tag All Sessions
                    </button>
                  </>
                }
              >
                <button type="button" class="button button-sm" disabled={backfillBusy()} onClick={() => void backfillAct(cancelTagsBackfill)}>
                  Stop Tagging
                </button>
              </Show>
              <Show when={backfillLine(progress())}>
                {(line) => (
                  <p class="decisions-backfill-progress" role="status" data-testid="decisions-backfill">
                    {line()}
                  </p>
                )}
              </Show>
            </div>
            <Show when={!progress()?.running && blocked()}>{(m) => <p class="field-hint">{m()}</p>}</Show>
            <Show when={backfillError()}>{(m) => <p class="field-error">{sentence(m())}</p>}</Show>
          </fieldset>
        </Show>

        <p class="settings-delegate-file">
          Stored in <code>{tildePath(loaded()!.file, home())}</code>. The key is stored separately, readable by you only.
        </p>
      </Show>
    </section>
  );
}
