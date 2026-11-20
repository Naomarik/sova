// Release with Options: the panel the Start Release ▾ opens on the Releases tab. Kind, the Full and Quick presets, then
// what every release does, the release steps and release-only checks you may turn off, and the landing checks that
// always run, each with its line and its rough minutes; Start <Kind> Release sends the kind and what was turned off.
import { createSignal, For, onMount, Show, type JSX } from "solid-js";
import type { ReleaseKind, ReleaseStartOptions } from "../../shared/release";
import { autoHint, countOff, groupSummary, KIND_WORD, KINDS, minutesWord, NONE_OFF, preset, presetOf, startBody, startLabel, totalMinutes, type OptionItem, type Off, type StartPanel } from "../lib/release-options";
import { Choice, Toggle } from "./form";
import { Icon } from "./ui";

export function ReleaseOptionsPanel(props: {
  panel: StartPanel;
  /** A changed note draft is saved first: the panel says so. */
  savesNote: boolean;
  busy: boolean;
  error: string | null;
  onStart(options: ReleaseStartOptions): void;
  onClose(): void;
}) {
  const p = () => props.panel;
  // Auto (the default) sends no kind: the release chat's version rule picks patch or minor, as Start Release does.
  const [kind, setKind] = createSignal<ReleaseKind | "auto">("auto");
  const picked = (): ReleaseKind | null => (p().next && kind() !== "auto" ? (kind() as ReleaseKind) : null);
  const [off, setOff] = createSignal<Off>(NONE_OFF);
  const at = () => presetOf(p(), off());
  const custom = () => countOff(p(), off()) > 0;
  const total = () => totalMinutes(p(), off());
  const flip = (what: "steps" | "checks", id: string, on: boolean) => {
    const o = off();
    const next = new Set(o[what]);
    if (on) next.delete(id);
    else next.add(id);
    setOff({ ...o, [what]: next });
  };
  const label = () => startLabel(picked(), custom());
  // Opened from the ▾ menu: focus moves into the panel, on its first choice.
  let box!: HTMLDivElement;
  onMount(() => box.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")?.focus());
  const row = (what: "steps" | "checks") => (x: OptionItem) => (
    <li>
      <Toggle
        class="rel-opt-toggle"
        label={<OptionWords item={x} />}
        checked={!off()[what].has(x.id)}
        onChange={(on) => flip(what, x.id, on)}
      />
    </li>
  );
  return (
    <div ref={box} class="deploy-confirm rel-options" id="rel-options" role="group" aria-label="Release with options">
      <p class="text-heading-s">Release with Options</p>
      <Show when={p().next}>
        {(n) => (
          <fieldset class="field rel-opt-kind">
            <legend class="field-label">Kind</legend>
            <Choice label="Kind" class="rel-opt-kinds" value={kind()} options={[{ value: "auto", label: "Auto", hint: <span class="text-mono">{autoHint(n())}</span> }, ...KINDS.map((k) => ({ value: k, label: KIND_WORD[k], hint: <span class="text-mono">{n()[k]}</span> }))]} onChange={(k) => setKind(k as ReleaseKind | "auto")} />
            <p class="field-hint">Auto lets the release chat pick, as Start Release does. A version your release note names still wins.</p>
          </fieldset>
        )}
      </Show>
      <div class="cluster rel-opt-presets" role="group" aria-label="Presets">
        <span class="field-label">Preset</span>
        <button type="button" class="button button-sm" aria-pressed={at() === "full" ? "true" : "false"} onClick={() => setOff(preset(p(), "full"))}>
          Full
        </button>
        <button type="button" class="button button-sm" aria-pressed={at() === "quick" ? "true" : "false"} disabled={!p().steps.length && !p().checks.length} onClick={() => setOff(preset(p(), "quick"))}>
          Quick
        </button>
        <span class="text-caption text-muted">{at() === "full" ? "Everything runs, as Start Release does." : at() === "quick" ? "Release steps and release-only checks off." : "Custom."}</span>
      </div>
      <OptionGroup title="Always done" summary={groupSummary(p().always.map((a) => ({ id: a, label: a })), null, "never turned off")}>
        <For each={p().always}>
          {(a) => (
            <li>
              <Toggle class="rel-opt-toggle" label={a} checked disabled onChange={() => {}} />
            </li>
          )}
        </For>
      </OptionGroup>
      <Show when={p().steps.length}>
        <OptionGroup title="Release steps" summary={groupSummary(p().steps, off().steps)}>
          <For each={p().steps}>{row("steps")}</For>
        </OptionGroup>
      </Show>
      <Show when={p().checks.length}>
        <OptionGroup title="Release-only checks" summary={groupSummary(p().checks, off().checks)}>
          <For each={p().checks}>{row("checks")}</For>
        </OptionGroup>
      </Show>
      <Show when={p().landing.length}>
        <OptionGroup title="Landing checks" summary={groupSummary(p().landing, null)} note="Every landing runs them; so does every release.">
          <For each={p().landing}>
            {(x) => (
              <li>
                <Toggle class="rel-opt-toggle" label={<OptionWords item={x} />} checked disabled onChange={() => {}} />
              </li>
            )}
          </For>
        </OptionGroup>
      </Show>
      <Show when={total() !== null}>
        <p class="rel-opt-total">
          Checks and steps: <strong>{minutesWord(total()!)}</strong>
          <span class="text-caption text-muted"> · rough figures, from an earlier release</span>
        </p>
      </Show>
      <Show when={props.savesNote}>
        <p class="text-caption text-muted">Your release note is saved first, then sent with it.</p>
      </Show>
      <Show when={props.error}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <div class="deploy-actions">
        <button type="button" class="button button-sm button-primary" aria-disabled={props.busy ? "true" : undefined} onClick={() => !props.busy && props.onStart(startBody(p(), picked(), off()))}>
          {props.busy ? "Starting…" : label()}
        </button>
        <button type="button" class="button button-sm button-ghost" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One group of the panel, folded by default: its header (a button) says the group, how many are on and their minutes;
    opening it lists its rows. */
function OptionGroup(props: { title: string; summary: string; note?: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  const id = `rel-opt-${props.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div class="rel-opt-group" role="group" aria-label={props.title}>
      <button type="button" class="rel-opt-head" aria-expanded={open() ? "true" : "false"} aria-controls={open() ? id : undefined} onClick={() => setOpen(!open())}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} small />
        <span class="text-eyebrow">{props.title}</span>
        <span class="text-caption text-muted">{props.summary}</span>
      </button>
      <Show when={open()}>
        <div id={id} class="rel-opt-body">
          <Show when={props.note}>{(n) => <p class="text-caption text-muted">{n()}</p>}</Show>
          <ul class="rel-opt-list">{props.children}</ul>
        </div>
      </Show>
    </div>
  );
}

function OptionWords(props: { item: OptionItem }) {
  return (
    <span class="rel-opt-words">
      <span class="rel-opt-label">
        {props.item.label}
        <Show when={props.item.minutes !== undefined}>
          <span class="text-caption text-muted"> · {minutesWord(props.item.minutes!)}</span>
        </Show>
      </span>
      <Show when={props.item.about}>{(a) => <span class="text-caption text-muted">{a()}</span>}</Show>
    </span>
  );
}
