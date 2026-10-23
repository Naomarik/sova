import { createSignal, For, Show } from "solid-js";
import type { ProjectSettingsInfo, SettingsHistoryRow } from "../../shared/project-settings";
import { getProjectSettings, getSettingsHistory, undoSettingsRow } from "../lib/api";
import { createPoll, type Poll } from "../lib/poll";
import { agoLabel } from "../lib/session-setup";
import { toast } from "../lib/ui-state";
import { SettingsCard } from "./SettingsChangeCard";

/**
 * The project page's settings parts (§app.project-overseer/settings): the Settings change cards waiting
 * (the overseer's, and the folder's uncommitted settings edits) at the top of the Settings tab; All
 * Settings (every project setting, its state and where it is changed or approved) and the Settings
 * history with Undo near its end.
 */

const POLL_MS = 20_000;

export interface ProjectSettingsData {
  info: Poll<ProjectSettingsInfo>;
  history: Poll<{ rows: SettingsHistoryRow[] }>;
  reload(): void;
}

export function createProjectSettings(projectId: string): ProjectSettingsData {
  const info = createPoll(() => getProjectSettings(projectId), POLL_MS, { cacheKey: `project:${projectId}:settings` });
  const history = createPoll(async () => ({ rows: await getSettingsHistory(projectId) }), POLL_MS, { cacheKey: `project:${projectId}:settings-history` });
  return {
    info,
    history,
    reload: () => {
      info.refetch();
      history.refetch();
    },
  };
}

/** The cards waiting for the operator, at the top of the Settings tab (nothing while none waits). */
export function ProjectSettingsChanges(props: { projectId: string; data: ProjectSettingsData }) {
  const waiting = () => {
    const i = props.data.info.data();
    return i ? [...(i.local ? [i.local] : []), ...i.cards] : [];
  };
  return (
    <Show when={waiting().length}>
      <section class="card orgs-section project-settings-changes" aria-labelledby="project-settings-changes">
        <h2 class="orgs-h2" id="project-settings-changes">
          Settings changes waiting
        </h2>
        <p class="orgs-line">Nothing in a card changes until you apply it. A card that widens what the overseer may do asks for your approval as it applies.</p>
        <div class="project-settings-cards">
          <For each={waiting()}>{(c) => <SettingsCard projectId={props.projectId} card={c} canAct onChanged={props.data.reload} />}</For>
        </div>
      </section>
    </Show>
  );
}

/** Every project setting: Sova-kept, then the project's files (§app.project-overseer/settings). */
export function ProjectAllSettings(props: { data: ProjectSettingsData }) {
  const go = (anchor: string) => document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
  return (
    <section class="card orgs-section project-all-settings" aria-labelledby="project-all-settings">
      <h2 class="orgs-h2" id="project-all-settings">
        All settings
      </h2>
      <Show when={props.data.info.error() && !props.data.info.data()}>
        <p class="field-error">Couldn't read the project's settings. {props.data.info.error()}</p>
      </Show>
      <Show when={props.data.info.data()} fallback={<div class="skeleton skeleton-line" />}>
        {(i) => (
          <>
            <Show when={!i().git}>
              <p class="orgs-line">The project folder isn't a Git repository, so the settings in its files change by hand.</p>
            </Show>
            <For each={(["sova", "file"] as const).filter((w) => i().rows.some((r) => r.where === w))}>
              {(where) => (
                <div class="project-settings-group">
                  <span class="text-eyebrow">{where === "sova" ? "Kept by Sova" : "In the project's files"}</span>
                  <ul class="list project-settings-rows">
                    <For each={i().rows.filter((r) => r.where === where)}>
                      {(r) => (
                        <li class="list-row project-settings-row">
                          <div class="list-main">
                            <span class="list-title">
                              {r.label}
                              <Show when={r.name}>
                                {" "}
                                <span class="text-mono">{r.name}</span>
                              </Show>
                            </span>
                            <Show when={r.detail}>
                              <span class="list-meta">{r.detail}</span>
                            </Show>
                          </div>
                          <span class={`project-settings-state${/Needs approval|Broken/.test(r.state) ? " text-warn" : ""}`}>{r.state}</span>
                          <Show when={r.anchor} fallback={<a class="button button-sm button-ghost" href={r.href}>{r.hrefLabel}</a>}>
                            <button type="button" class="button button-sm button-ghost" onClick={() => go(r.anchor!)}>
                              {r.hrefLabel}
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </section>
  );
}

const byWords = (r: SettingsHistoryRow) =>
  r.by.kind === "project-overseer" ? "the overseer" : r.by.kind === "overseer" ? "the Overseer" : r.by.via === "card" ? `you, on ${r.card === "local" ? "the folder's edits" : r.card}` : r.by.via === "undo" ? "you (Undo)" : r.by.via === "script" ? "a script" : "you";
const valueWords = (v: unknown) => (v === null || v === undefined ? "none" : typeof v === "string" ? (v.length > 40 ? `${v.slice(0, 39)}…` : v) : JSON.stringify(v));

/** Each change to the project's settings, newest first, with Undo (§app.project-overseer/settings). */
export function ProjectSettingsHistory(props: { projectId: string; data: ProjectSettingsData }) {
  const [all, setAll] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const rows = () => props.data.history.data()?.rows ?? [];
  const shown = () => (all() ? rows() : rows().slice(0, 8));
  const undo = (r: SettingsHistoryRow) => {
    if (busy()) return;
    setBusy(r.id);
    undoSettingsRow(props.projectId, r.id)
      .then((out) => {
        toast(out.card ? `Made ${out.card.id}: apply it to put the file back.` : "Put back.");
        props.data.reload();
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };
  return (
    <section class="card orgs-section project-settings-history" aria-labelledby="project-settings-history">
      <h2 class="orgs-h2" id="project-settings-history">
        Settings history
      </h2>
      <Show when={rows().length} fallback={<p class="orgs-line">No settings changed yet. Every change lists here, whoever made it.</p>}>
        <ul class="list project-settings-rows">
          <For each={shown()}>
            {(r) => (
              <li class="list-row project-settings-row">
                <div class="list-main">
                  <span class="list-title">
                    {r.field.startsWith("file:") ? <span class="text-mono">{r.field.slice(5)}</span> : (r.label ?? r.field)}
                    {r.field.startsWith("file:") ? (r.to === null ? " removed" : r.from === null ? " added" : " changed") : `: ${r.fromText ?? valueWords(r.from)} → ${r.toText ?? valueWords(r.to)}`}
                  </span>
                  <span class="list-meta">
                    {agoLabel(Date.parse(r.at), Date.now())} · by {byWords(r)}
                    {r.revertOf ? ` · undoes ${r.revertOf}` : ""}
                    {r.commit ? ` · ${r.commit.slice(0, 10)}` : ""}
                  </span>
                </div>
                <Show when={r.field !== "resume"}>
                  <button type="button" class="button button-sm button-ghost" disabled={!!busy()} aria-busy={busy() === r.id ? "true" : undefined} onClick={() => undo(r)}>
                    Undo
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={rows().length > 8}>
          <button type="button" class="button button-sm button-ghost" onClick={() => setAll((v) => !v)}>
            {all() ? "Show Fewer" : `Show All ${rows().length}`}
          </button>
        </Show>
      </Show>
    </section>
  );
}
