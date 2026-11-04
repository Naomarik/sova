import { createContext, createSignal, For, Show, useContext } from "solid-js";
import type { SettingsCardView, SettingsHistoryRow, SettingsToolDetails } from "../../shared/project-settings";
import { applySettingsCard, applySovaSettingsCard, cancelMergeSettings, getProjectSettings, getSovaSettingsCards, undoSettingsRow, withdrawSettingsCard, withdrawSovaSettingsCard } from "../lib/api";
import { cardCanAct, createCardLive, type CardTimer, type SettingsCardScope } from "../lib/settings-card-live";
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

/** A queue card applied while a branch is checking (§app.merge-queue/settings-save). */
export const QUEUE_CARD_WAITS = "Saves when the current branch finishes.";

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
  const project = props.projectId;
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
  const apply = () => act(() => (project === null ? applySovaSettingsCard(c().id, c().fingerprint) : applySettingsCard(project, c().id, c().fingerprint)), (out) => (out.card.saveWaits ? QUEUE_CARD_WAITS : local() ? "Landed the folder's settings edits." : c().grants.length ? `Applied and approved ${c().id}.` : `Applied ${c().id}.`));
  const dismiss = () => act(() => (project === null ? withdrawSovaSettingsCard(c().id) : withdrawSettingsCard(project, c().id, local() ? c().fingerprint : undefined)), local() ? "Discarded the folder's settings edits." : `Dismissed ${c().id}.`);
  const cancelSave = () => project !== null && act(() => cancelMergeSettings(project), `Cancelled the save of ${c().id}.`);
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
        <span class={stateChip[c().state]}>
          <span class="chip-dot" aria-hidden="true" />
          {held() ? "Waiting for a branch" : stateWords[c().state]}
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
            <span class="text-eyebrow">Sova's settings</span>
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
        <Show when={waiting()} fallback={<span class="overseer-confirm-hint">{c().state === "applied" ? `Applied${c().commit ? ` as ${c().commit!.slice(0, 10)}` : ""}.` : "Dismissed: nothing changed."}</span>}>
          <Show when={props.canAct} fallback={<span class="overseer-confirm-hint">{held() ? QUEUE_CARD_WAITS : project === null ? "Waiting for you: apply it in the chat that prepared it." : "Waiting for the operator: apply it on the project's Settings tab."}</span>}>
            <Show
              when={!held()}
              fallback={
                <div class="overseer-card-buttons">
                  <span class="overseer-confirm-hint">{QUEUE_CARD_WAITS}</span>
                  <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={cancelSave}>
                    Cancel Save
                  </button>
                </div>
              }
            >
              <div class="overseer-card-buttons">
                <button type="button" class="button button-sm button-primary" disabled={busy()} onClick={apply}>
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
  return (
    <Show
      when={live() ?? props.details.card}
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
