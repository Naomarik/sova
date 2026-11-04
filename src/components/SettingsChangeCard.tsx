import { createContext, createEffect, createSignal, For, Show, useContext } from "solid-js";
import type { SettingsCardView, SettingsHistoryRow, SettingsToolDetails } from "../../shared/project-settings";
import { applySettingsCard, applySovaSettingsCard, cancelLocalSettingsSave, cancelMergeSettings, getProjectSettings, getSovaSettingsCards, undoSettingsRow, withdrawSettingsCard, withdrawSovaSettingsCard } from "../lib/api";
import { applyToast, cancelHeldSave, cardCanAct, createCardLive, heldButton, PARTLY_APPLIED, QUEUE_CARD_WAITS, typedInput, type CardTimer, type SettingsCardScope } from "../lib/settings-card-live";
import { MESH_HREF } from "../lib/mesh";
import { toast } from "../lib/ui-state";

/**
 * The Settings change card (§app.project-overseer/settings, §chat.create-mode/settings-cards): what the
 * project overseer or a Create chat proposed, each setting in plain words with its before and after and where
 * it lands, its grants marked with what they allow, the exact file changes, and the operator's Apply and
 * Approve (or Apply) and Dismiss. In the chat it stands at its sova_settings call; a project's card also on
 * the project page's Settings tab while it waits. Only a view that may act provides SettingsCardContext;
 * without it the card shows its state only.
 */

export const SettingsCardContext = createContext<SettingsCardScope>({ overseer: false, create: false });

export { QUEUE_CARD_WAITS };

/** How often a waiting card reads its state again (an Apply on the project page shows here this way). */
const POLL_MS = 15_000;

const stateWords: Record<SettingsCardView["state"], string> = { waiting: "Waiting for you", applied: "Applied", dismissed: "Dismissed" };
const stateChip: Record<SettingsCardView["state"], string> = { waiting: "chip chip-warn", applied: "chip chip-success", dismissed: "chip" };

/** One card. `onChanged`: after an Apply, Dismiss or Undo (the project page reads again). */
export function SettingsCard(props: { projectId: string | null; card: SettingsCardView; canAct: boolean; onChanged?: () => void; appliedNow?: SettingsHistoryRow[] }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showDiff, setShowDiff] = createSignal(false);
  const [undone, setUndone] = createSignal<Set<string>>(new Set());
  const c = () => props.card;
  const local = () => c().id === "local";
  const waiting = () => c().state === "waiting";
  /** A queue card whose Save is held: Apply was pressed, and it lands when the branch finishes. */
  const held = () => waiting() && !!c().saveWaits;
  /** What holds the Save, as the server says it: a branch checking, or a release. */
  const saveWords = () => c().saveWords ?? QUEUE_CARD_WAITS;
  const project = props.projectId;
  /** The card's field, if it has one: held here only, sent only with Apply, gone once Apply took it or the card ended. */
  const [typed, setTyped] = createSignal("");
  createEffect(() => {
    if (!waiting()) setTyped("");
  });
  const inputValue = () => typedInput(c(), typed());
  const inputEmpty = () => inputValue() === "";
  const act = <T,>(run: () => Promise<T>, done: string | ((out: T) => string)) => {
    if (!props.canAct || busy()) return;
    setBusy(true);
    setError(null);
    run()
      .then((out) => {
        toast(typeof done === "string" ? done : done(out));
        props.onChanged?.();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const apply = () => {
    if (inputEmpty()) return;
    act(
      () => (project === null ? applySovaSettingsCard(c().id, c().fingerprint, inputValue()) : applySettingsCard(project, c().id, c().fingerprint)),
      (out) => {
        setTyped("");
        return applyToast(out.card, c());
      },
    );
  };
  const dismiss = () => act(() => (project === null ? withdrawSovaSettingsCard(c().id) : withdrawSettingsCard(project, c().id, local() ? c().fingerprint : undefined)), local() ? "Discarded the folder's settings edits." : `Dismissed ${c().id}.`);
  const cancelSave = () =>
    project !== null &&
    act(() => cancelHeldSave(c(), project, { queue: cancelMergeSettings, card: withdrawSettingsCard, local: cancelLocalSettingsSave }), local() ? "Cancelled the save. The folder's edits stay." : heldButton(c()) === "Dismiss" ? `Dismissed ${c().id}.` : `Cancelled the save of ${c().id}.`);
  const undo = (row: SettingsHistoryRow) => {
    if (!props.canAct || busy() || project === null) return;
    setBusy(true);
    undoSettingsRow(project, row.id)
      .then((r) => {
        setUndone((s) => new Set([...s, row.id]));
        toast(r.card ? `Made ${r.card.id} to put it back.` : `Put back ${row.field}.`);
        props.onChanged?.();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const applyLabel = () => (local() ? (c().grants.length ? "Land and Approve" : "Land Edits") : c().grants.length ? "Apply and Approve" : "Apply");
  return (
    <section class="card overseer-confirm overseer-card settings-card" data-settings-card={c().id} data-phase={c().state} aria-label={`Settings change ${c().id}: ${c().title}`}>
      <div class="card-head overseer-card-head">
        <span class="text-mono overseer-card-id">{local() ? "local" : c().id}</span>
        <h3 class="card-title" title={c().title}>
          {c().title}
        </h3>
        <span class={c().partly ? "chip chip-warn" : stateChip[c().state]}>
          <span class="chip-dot" aria-hidden="true" />
          {c().partly ? PARTLY_APPLIED : c().saveFailed ? "Save failed" : held() ? "Waiting to save" : stateWords[c().state]}
        </span>
      </div>
      <div class="card-body settings-card-body">
        <Show when={c().why}>
          <p class="settings-card-why">{c().why}</p>
        </Show>
        <Show when={c().place}>
          {(place) => (
            <div class="settings-card-group">
              <span class="text-eyebrow">Where it lands</span>
              <span class="settings-card-place">{place()}</span>
            </div>
          )}
        </Show>
        <Show when={props.appliedNow?.length}>
          <div class="settings-card-group">
            <span class="text-eyebrow">Applied now</span>
            <ul class="settings-card-list">
              <For each={props.appliedNow}>
                {(r) => (
                  <li class="settings-card-row">
                    <span>
                      {r.field}: <span class="text-mono">{JSON.stringify(r.from)}</span> → <span class="text-mono">{JSON.stringify(r.to)}</span>
                    </span>
                    <Show when={props.canAct && !undone().has(r.id)} fallback={<Show when={undone().has(r.id)}><span class="text-muted">Undone</span></Show>}>
                      <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => undo(r)}>
                        Undo
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={c().kept.length}>
          <div class="settings-card-group">
            <span class="text-eyebrow">{c().kind === "queue" ? "Merge queue" : "Sova's settings"}</span>
            <ul class="settings-card-list">
              <For each={c().kept}>
                {(k) => (
                  <li class="settings-card-row">
                    <span>
                      {k.label}: {k.fromText} → <strong>{k.toText}</strong>
                    </span>
                    <Show when={k.grant}>
                      <span class="chip chip-warn" title={k.grant}>
                        <span class="chip-dot" aria-hidden="true" />
                        Needs approval
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={c().files.length}>
          <div class="settings-card-group">
            <span class="text-eyebrow">The project's files</span>
            <Show when={c().lands}>{(l) => <span class="settings-card-lands">Lands as one commit on {l().split(" in ")[0]} in <span class="text-mono">{l().split(" in ").slice(1).join(" in ")}</span></span>}</Show>
            <ul class="settings-card-list">
              <For each={c().files}>
                {(f) => (
                  <li class="settings-card-row">
                    <span>{f.summary.replace(/ \(.*\)$/, "")}</span>
                    <span class="text-mono settings-card-path">{f.path}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={c().grants.length}>
          <div class="settings-card-group">
            <span class="text-eyebrow">What approving it allows</span>
            <ul class="settings-card-list settings-card-grants">
              <For each={c().grants}>{(g) => <li>{g.what.charAt(0).toUpperCase() + g.what.slice(1)}.</li>}</For>
            </ul>
          </div>
        </Show>
        <Show when={c().diff}>
          <button type="button" class="button button-sm button-ghost settings-card-diff-toggle" aria-expanded={showDiff()} onClick={() => setShowDiff((v) => !v)}>
            {showDiff() ? "Hide File Changes" : "Show File Changes"}
          </button>
          <Show when={showDiff()}>
            <pre class="settings-card-diff text-mono">{c().diff}</pre>
          </Show>
        </Show>
        <Show when={c().access?.length}>
          <div class="settings-card-group">
            <span class="text-eyebrow">Every computer's access after this</span>
            <ul class="settings-card-list">
              <For each={c().access}>
                {(a) => (
                  <li class="settings-card-row" data-access-changed={a.changed ? "true" : undefined}>
                    <span>
                      {a.label}:{" "}
                      <Show when={a.changed} fallback={a.after}>
                        {a.before} → <strong>{a.after}</strong>
                      </Show>
                    </span>
                    <Show when={a.changed}>
                      <span class="chip chip-warn">
                        <span class="chip-dot" aria-hidden="true" />
                        Changes
                      </span>
                    </Show>
                    <Show when={a.shell}>
                      <span class="text-warn">Shell-level: it can run anything here.</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={c().input && waiting() && !held() && props.canAct ? c().input : null}>
          {(field) => (
            <div class="field">
              <label class="field-label" for={`settings-card-input-${c().id}`}>
                {field().label}
              </label>
              <input
                class="input text-mono"
                id={`settings-card-input-${c().id}`}
                type="text"
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                value={typed()}
                disabled={busy()}
                onInput={(e) => setTyped(e.currentTarget.value)}
              />
              <p class="field-hint">
                This computer's own fingerprint is on the Mesh page, under Dial-out pairings.{" "}
                <a class="button button-sm button-ghost" href={MESH_HREF}>
                  Open Mesh Page
                </a>
              </p>
            </div>
          )}
        </Show>
        <Show when={c().notes?.length && waiting() ? c().notes : null}>
          {(notes) => (
            <div class="settings-card-group">
              <For each={notes()}>{(line) => <p class="settings-card-why">{line}</p>}</For>
            </div>
          )}
        </Show>
        <Show when={c().stillNeeds?.length}>
          <div class="banner banner-warn" role="status">
            <div class="banner-body">
              <For each={c().stillNeeds}>{(line) => <p class="settings-card-why">{line}</p>}</For>
            </div>
          </div>
        </Show>
        <Show when={c().saveFailed}>
          {(why) => (
            <div class="banner banner-error" role="alert">
              <div class="banner-body">{why()}</div>
            </div>
          )}
        </Show>
        <Show when={error()}>
          <div class="banner banner-error" role="alert">
            <div class="banner-body">{error()}</div>
          </div>
        </Show>
      </div>
      <div class="card-foot overseer-card-foot">
        <Show when={waiting()} fallback={<span class="overseer-confirm-hint">{c().partly ? `${PARTLY_APPLIED}: see above.` : c().state === "applied" ? `Applied${c().commit ? ` as ${c().commit!.slice(0, 10)}` : ""}.` : "Dismissed: nothing changed."}</span>}>
          <Show when={props.canAct} fallback={<span class="overseer-confirm-hint">{held() ? saveWords() : project === null ? "Waiting for you: apply it in the chat that prepared it." : "Waiting for the operator: apply it on the project's Settings tab."}</span>}>
            <Show
              when={!held()}
              fallback={
                <div class="overseer-card-buttons">
                  <Show when={!c().saveFailed}>
                    <span class="overseer-confirm-hint">{saveWords()}</span>
                  </Show>
                  <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={cancelSave}>
                    {heldButton(c())}
                  </button>
                </div>
              }
            >
              <div class="overseer-card-buttons">
                <button type="button" class="button button-sm button-primary" disabled={busy() || inputEmpty()} onClick={apply}>
                  {applyLabel()}
                </button>
                <button type="button" class={`button button-sm ${local() ? "button-destructive" : "button-ghost"}`} disabled={busy()} onClick={dismiss}>
                  {local() ? "Discard Edits" : "Dismiss"}
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  );
}

/** The waiting card's timer: a tab nobody is looking at reads nothing. */
const whileVisible: CardTimer = (run, ms) => {
  const t = setInterval(() => document.visibilityState === "visible" && run(), ms);
  return () => clearInterval(t);
};

/** The card at a sova_settings call in the overseer's chat: its state read live from the project's settings. */
export function SettingsToolCard(props: { details: SettingsToolDetails }) {
  const scope = useContext(SettingsCardContext);
  const canAct = () => cardCanAct(scope, props.details);
  const { live, load } = createCardLive({ details: props.details, canAct, reads: { project: getProjectSettings, sova: getSovaSettingsCards }, everyMs: POLL_MS, timer: whileVisible });
  /** Before a read, the transcript's copy, less its notes: they can change while a card waits, so only a live read says them. */
  const transcriptCopy = () => (props.details.card ? { ...props.details.card, notes: undefined } : null);
  return (
    <Show
      when={live() ?? transcriptCopy()}
      fallback={
        <Show when={props.details.appliedNow.length}>
          <SettingsCard
            projectId={props.details.projectId}
            canAct={canAct()}
            appliedNow={props.details.appliedNow}
            card={{ id: "now", state: "applied", title: "Applied at once", why: "", by: { kind: "project-overseer" }, createdAt: "", kept: [], files: [], grants: [], lands: null, diff: "", fingerprint: "" }}
          />
        </Show>
      }
    >
      {(card) => <SettingsCard projectId={props.details.projectId} card={card()} canAct={canAct()} appliedNow={props.details.appliedNow} onChanged={() => void load()} />}
    </Show>
  );
}
