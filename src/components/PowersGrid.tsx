import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { PowerMap } from "../../shared/powers";
import type { ProjectOverseerInfo, ProjectOverseerPatch } from "../../shared/project-overseer";
import { COLUMN_LABEL, COLUMN_SHORT, STATE_WORD, actCount, alwaysLine, brakeDone, assistantGroups, cellState, columnsFor, expandName, nextOn, powerGroups, powersNote, powersPatch, switchDone, switchName, type CellState, type PowerColumn, type PowerGroupRow, type PowerRow } from "../lib/powers-view";
import { ApiError, getProjectOverseer, patchProjectOverseer } from "../lib/api";
import { announce, toast } from "../lib/ui-state";
import { unchangedError } from "../lib/unchanged-error";
import { Banner, Icon, Placeholder } from "./ui";
import "../projects.css";

/** One On/Off switch with its word before it, so its state never reads from the knob alone. Mixed: the knob sits in the middle. "—": the column can't set it. */
function PowerSwitch(props: { name: string; state: CellState; busy: boolean; onSet(on: boolean): void }) {
  return (
    <Show
      when={props.state !== "none"}
      fallback={
        <span class="powers-none" title={`${props.name}: the Project Assistant can't set this off`}>
          <span aria-hidden="true">{STATE_WORD.none}</span>
          <span class="visually-hidden">{props.name}: not the Project Assistant's</span>
        </span>
      }
    >
      <label class="toggle toggle-switch powers-switch" data-state={props.state} title={props.name}>
        <span class="powers-word" aria-hidden="true">
          {STATE_WORD[props.state]}
        </span>
        <input
          type="checkbox"
          aria-label={props.name}
          checked={props.state === "on"}
          ref={(el) => createEffect(() => (el.indeterminate = props.state === "mixed"))}
          disabled={props.busy}
          onChange={(e) => {
            // The click flipped the box already; the saved switches redraw it.
            e.currentTarget.checked = props.state === "on";
            e.currentTarget.indeterminate = props.state === "mixed";
            props.onSet(nextOn(props.state));
          }}
        />
        <span class="toggle-box" />
      </label>
    </Show>
  );
}

/**
 * What may happen without you (§design.copy-deck/project-powers): the lead, the always-allowed
 * line, the Paused banner with Resume, the one-time note and the grid. The Settings tab and the
 * chat head's menu both draw this; `save` sends one PATCH and says `done` once it is saved.
 */
export function PowersPanel(props: {
  info: ProjectOverseerInfo;
  busy: boolean;
  idPrefix: string;
  /** The head's menu: no lead sentence, and the note stays on the project page. */
  compact?: boolean;
  save(patch: ProjectOverseerPatch, done: string): void;
}) {
  const p = () => props.info.settings.powers;
  const groups = createMemo(() => powerGroups(p()));
  const cols = () => columnsFor(p());
  const note = () => (props.compact ? null : powersNote(p().note));
  return (
    <div class="powers">
      <Show when={!props.compact}>
        <p class="powers-lead">Anything you tell it yourself always runs. These switches cover only what happens without you.</p>
      </Show>
      <p class="powers-always field-hint">{alwaysLine(p().always)}</p>
      <Show when={p().brake}>
        {(b) => (
          <Banner
            tone="warn"
            title="Paused"
            body={b().reason}
            action={
              <button type="button" class="button button-sm" aria-disabled={props.busy ? "true" : undefined} onClick={() => !props.busy && props.save({ resume: true }, brakeDone)}>
                Resume
              </button>
            }
          />
        )}
      </Show>
      <Show when={note()}>
        {(n) => (
          <Banner
            tone="info"
            title={n().title}
            body={n().body}
            action={
              <button type="button" class="button button-sm button-ghost" aria-disabled={props.busy ? "true" : undefined} onClick={() => !props.busy && props.save({ powersNoteSeen: true }, "Note dismissed.")}>
                Dismiss
              </button>
            }
          />
        )}
      </Show>
      <PowersGrid
        groups={groups()}
        cols={cols()}
        maps={{ overseer: p().overseer, assistant: p().assistant }}
        busy={props.busy}
        idPrefix={props.idPrefix}
        onSet={(acts, col, on, label, group) => props.save(powersPatch(acts, col, on), switchDone(label, col, on, group))}
      />
    </div>
  );
}

/**
 * The switch grid (al_3, §design.copy-deck/project-powers): a header naming the columns, one row
 * per group with one switch per column (On, Off or Mixed), each group opening to a row per act.
 * The Settings tab and the chat head's menu draw the same rows. `onSet` saves; the grid keeps only
 * which groups are open.
 */
export function PowersGrid(props: {
  groups: readonly PowerGroupRow[];
  cols: readonly PowerColumn[];
  maps: Readonly<Record<PowerColumn, Partial<PowerMap>>>;
  busy: boolean;
  /** Where its groups' list ids start (two grids on one page stay apart). */
  idPrefix: string;
  onSet(acts: readonly PowerRow[], col: PowerColumn, on: boolean, label: string, group: boolean): void;
}) {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div class="powers-grid" style={{ "--powers-cols": String(props.cols.length) }}>
      <div class="powers-row powers-head" aria-hidden="true">
        <span />
        <For each={props.cols}>
          {(col) => (
            <span class="powers-col">
              <span class="powers-col-long">{COLUMN_LABEL[col]}</span>
              <span class="powers-col-short">{COLUMN_SHORT[col]}</span>
            </span>
          )}
        </For>
      </div>
      <For each={props.groups}>
        {(g) => {
          const isOpen = () => open().has(g.id);
          const listId = `${props.idPrefix}-${g.id}`;
          return (
            <div class="powers-group" classList={{ "powers-group-open": isOpen() }}>
              <div class="powers-row">
                <button type="button" class="powers-name" aria-expanded={isOpen()} aria-controls={listId} aria-label={expandName(g, isOpen())} onClick={() => toggle(g.id)}>
                  <Icon name={isOpen() ? "chevron-down" : "chevron-right"} small />
                  <span class="powers-label">{g.label}</span>
                  <span class="powers-count">{actCount(g.acts.length)}</span>
                </button>
                <For each={props.cols}>
                  {(col) => <PowerSwitch name={switchName(g.label, col)} state={cellState(g.acts, props.maps[col], col)} busy={props.busy} onSet={(on) => props.onSet(g.acts, col, on, g.label, true)} />}
                </For>
              </div>
              <Show when={isOpen()}>
                <div class="powers-acts" id={listId} role="group" aria-label={g.label}>
                  <For each={g.acts}>
                    {(a) => (
                      <div class="powers-row powers-act">
                        <span class="powers-label">{a.label}</span>
                        <For each={props.cols}>
                          {(col) => <PowerSwitch name={switchName(a.label, col)} state={cellState([a], props.maps[col], col)} busy={props.busy} onSet={(on) => props.onSet([a], col, on, a.label, false)} />}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

/**
 * The Project Assistant's switches for an organization's owner page card (§design.copy-deck/project-powers):
 * one block per project, its name and the assistant's column alone, listing only the acts the
 * assistant can ever set. Each block reads its project's overseer on its own and saves with
 * `PATCH …/overseer {powers: {assistant}}`; a brake shows as a line (Resume is on the project page).
 */
export function AssistantPowers(props: { projects: readonly { id: string; name: string }[] }) {
  return (
    <div class="powers-assistant">
      <For each={props.projects}>{(p) => <AssistantProjectPowers projectId={p.id} name={p.name} />}</For>
    </div>
  );
}

function AssistantProjectPowers(props: { projectId: string; name: string }) {
  const [info, { refetch, mutate }] = createResource(() => props.projectId, getProjectOverseer);
  const [busy, setBusy] = createSignal(false);
  const save = async (acts: readonly PowerRow[], on: boolean, label: string, group: boolean) => {
    if (busy()) return;
    setBusy(true);
    try {
      mutate(await patchProjectOverseer(props.projectId, powersPatch(acts, "assistant", on)));
      const done = `${props.name}: ${switchDone(label, "assistant", on, group)}`;
      toast(done);
      announce(done);
    } catch (err) {
      toast(unchangedError(err instanceof ApiError || err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  };
  const view = () => (info.error ? undefined : info()?.settings.powers);
  return (
    <section class="powers-assistant-project" aria-label={`${props.name}: Project Assistant from a client`}>
      <h5 class="powers-assistant-name">{props.name}</h5>
      <Show
        when={view()}
        fallback={
          <Show when={info.error} fallback={<Placeholder lines={2} label={`${props.name} switches`} />}>
            <p class="field-error">
              Couldn't read {props.name}'s switches.{" "}
              <button type="button" class="button button-sm" onClick={() => refetch()}>
                Retry
              </button>
            </p>
          </Show>
        }
      >
        {(v) => (
          <>
            <Show when={v().brake}>{(b) => <p class="field-hint">Paused: {b().reason}</p>}</Show>
            <PowersGrid
              groups={assistantGroups(v())}
              cols={["assistant"]}
              maps={{ overseer: v().overseer, assistant: v().assistant }}
              busy={busy()}
              idPrefix={`assistant-powers-${props.projectId}`}
              onSet={(acts, _col, on, label, group) => void save(acts, on, label, group)}
            />
          </>
        )}
      </Show>
    </section>
  );
}
