import { createContext, createSignal, For, onCleanup, Show, useContext } from "solid-js";
import type { SettingsCardView, SettingsHistoryRow, SettingsToolDetails } from "../../shared/project-settings";
import { applySettingsCard, getProjectSettings, undoSettingsRow, withdrawSettingsCard } from "../lib/api";
import { toast } from "../lib/ui-state";

/**
 * The Settings change card (§app.project-overseer/settings): what the project overseer proposed, each setting
 * in plain words with its before and after and where it lands, its grants marked with what they allow, the
 * exact file changes, and the operator's Apply and Approve (or Apply) and Dismiss. In the overseer's chat it
 * stands at its sova_settings call; on the project page's Settings tab while it waits. Only a view that may
 * act provides SettingsCardContext (the overseer's own chat page); without it the card shows its state only.
 */

export const SettingsCardContext = createContext<boolean>(false);

/** How often a waiting card reads its state again (an Apply on the project page shows here this way). */
const POLL_MS = 15_000;

const stateWords: Record<SettingsCardView["state"], string> = { waiting: "Waiting for you", applied: "Applied", dismissed: "Dismissed" };
const stateChip: Record<SettingsCardView["state"], string> = { waiting: "chip chip-warn", applied: "chip chip-success", dismissed: "chip" };

/** One card. `onChanged`: after an Apply, Dismiss or Undo (the project page reads again). */
export function SettingsCard(props: { projectId: string; card: SettingsCardView; canAct: boolean; onChanged?: () => void; appliedNow?: SettingsHistoryRow[] }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showDiff, setShowDiff] = createSignal(false);
  const [undone, setUndone] = createSignal<Set<string>>(new Set());
  const c = () => props.card;
  const local = () => c().id === "local";
  const waiting = () => c().state === "waiting";
  const act = (run: () => Promise<unknown>, done: string) => {
    if (!props.canAct || busy()) return;
    setBusy(true);
    setError(null);
    run()
      .then(() => {
        toast(done);
        props.onChanged?.();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const apply = () => act(() => applySettingsCard(props.projectId, c().id, c().fingerprint), local() ? "Landed the folder's settings edits." : c().grants.length ? `Applied and approved ${c().id}.` : `Applied ${c().id}.`);
  const dismiss = () => act(() => withdrawSettingsCard(props.projectId, c().id, local() ? c().fingerprint : undefined), local() ? "Discarded the folder's settings edits." : `Dismissed ${c().id}.`);
  const undo = (row: SettingsHistoryRow) => {
    if (!props.canAct || busy()) return;
    setBusy(true);
    undoSettingsRow(props.projectId, row.id)
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
          {stateWords[c().state]}
        </span>
      </div>
      <div class="card-body settings-card-body">
        <Show when={c().why}>
          <p class="settings-card-why">{c().why}</p>
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
        <Show when={error()}>
          <div class="banner banner-error" role="alert">
            <div class="banner-body">{error()}</div>
          </div>
        </Show>
      </div>
      <div class="card-foot overseer-card-foot">
        <Show when={waiting()} fallback={<span class="overseer-confirm-hint">{c().state === "applied" ? `Applied${c().commit ? ` as ${c().commit!.slice(0, 10)}` : ""}.` : "Dismissed: nothing changed."}</span>}>
          <Show when={props.canAct} fallback={<span class="overseer-confirm-hint">Waiting for the operator: apply it on the project's Settings tab.</span>}>
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
      </div>
    </section>
  );
}

/** The card at a sova_settings call in the overseer's chat: its state read live from the project's settings. */
export function SettingsToolCard(props: { details: SettingsToolDetails }) {
  const canAct = useContext(SettingsCardContext);
  const [live, setLive] = createSignal<SettingsCardView | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  const load = async () => {
    const id = props.details.card?.id;
    if (!id || !canAct) return;
    try {
      const info = await getProjectSettings(props.details.projectId);
      const found = [...info.cards, ...info.recent].find((x) => x.id === id);
      if (found) setLive(found);
      if (found && found.state !== "waiting" && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    } catch {
      // Keep what the transcript carried.
    }
  };
  void load();
  if (canAct && props.details.card?.state === "waiting") timer = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
  onCleanup(() => timer && clearInterval(timer));
  return (
    <Show
      when={live() ?? props.details.card}
      fallback={
        <Show when={props.details.appliedNow.length}>
          <SettingsCard
            projectId={props.details.projectId}
            canAct={canAct}
            appliedNow={props.details.appliedNow}
            card={{ id: "now", state: "applied", title: "Applied at once", why: "", by: { kind: "project-overseer" }, createdAt: "", kept: [], files: [], grants: [], lands: null, diff: "", fingerprint: "" }}
          />
        </Show>
      }
    >
      {(card) => <SettingsCard projectId={props.details.projectId} card={card()} canAct={canAct} appliedNow={props.details.appliedNow} onChanged={() => void load()} />}
    </Show>
  );
}
