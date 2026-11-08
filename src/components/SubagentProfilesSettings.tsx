import { createEffect, createSignal, For, Show, untrack, type JSX } from "solid-js";
import type { SubagentProfile, TeamsSetting } from "../../shared/subagent-profiles";
import type { DelegateOptions, DelegateSettingsInfo, ModelInfo, WorkerChoice } from "../../shared/protocol";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/profiles";
import { INSTRUCTIONS_RULE, ROLE_RULE, TEAM_NUMBERS, TEAM_RULES, type TeamNumberField } from "../../shared/subagent-limits";
import { teamNumber } from "../../shared/subagent-profile-checks";
import { NumberField, Select, TextArea, TextField, Toggle } from "./form";
import { effortSelectOptions, fallbackFor, modelSelectOptions, slotIssue, withModel } from "../lib/delegate-form";
import { claudeModelName } from "../lib/format";
import { CLAUDE_PROVIDER } from "../lib/profiles-settings";
import { sectionProblems, withAlignment, withChosenModels, withDefaultModel, ALIGN_STYLE_NAMES, ALIGN_EAGERNESS_NAMES } from "../lib/subagent-editor";
import { Icon } from "./ui";
import { WorkerSlotRow } from "./WorkerSlotRow";
import { adversarialReview } from "../lib/align-review";
import "./SubagentProfilesSettings.css";

const HOST = { value: "host", label: "Use host default" };
const ALIGN_EAGERNESS = ["eager", "careful"] as const;
const ALIGN_STYLES = ["pm", "simplified", "default"] as const;
const DELEGATE = [
  ["planning", "Planning"],
  ["investigation", "Investigation"],
  ["routine", "Routine"],
  ["complex", "Complex"],
] as const;
type Route = { primary: WorkerChoice; fallback: WorkerChoice | null };

/** A Set All To pick's value: the backend and the model, one select value. */
const pickValue = (backend: string, model: string) => `${backend}\t${model}`;

/**
 * A profile's Models part (§app.settings-dialog/profile-editor, §chat.subagent-profiles/editor-rows):
 * Set All To, then one compact row per role, its label, a model and an effort, in the groups This
 * chat, Delegate, Teams and Review, then Alignment. Each row but This chat's expands, in place, to
 * the rest of today's controls for it: backend and fallback, and for the coordinator and monitor
 * their instructions, thresholds and handover, with the Subagents editor's own rules. A row that
 * comes to hold something Save waits for opens itself, once, so the user can still fold it.
 *
 * The helpers are the profile's library half (`profile`, null when it links none); `change` and
 * `replace` edit that half in the draft, which for a shared half is every profile linking it.
 */
export function ProfileModelsPart(props: {
  idPrefix: string;
  readOnly: boolean;
  disabled: boolean;
  /** The chat's own model ref and effort (null: keeps the chat's own). */
  chat: { model: string | null; thinking: ThinkingLevel | null };
  onChat?(next: { model: string | null; thinking: ThinkingLevel | null }): void;
  /** The library half as a library profile (id and name are the row's), or null: no helpers of its own. */
  profile: SubagentProfile | null;
  change(fn: (p: SubagentProfile) => void): void;
  replace(fn: (p: SubagentProfile) => SubagentProfile): void;
  /** Why the helper rows are empty, said in their place. */
  noHelpers: string;
  /** Choose Helpers, for a profile with none: a library half of its own, from the template. */
  onChooseHelpers?(): void;
  /** Set All To; absent where it isn't offered (a project's profile). */
  onSetAll?(pick: { backend: WorkerChoice["backend"]; model: string }): void;
  rows: DelegateSettingsInfo | undefined;
  options: DelegateOptions | undefined;
  models: ModelInfo[] | null;
  /** What Choose Models gives the team roles. */
  teamsSeed: TeamsSetting | null;
  /** Bring the Spec writer's row into view, open (the mode menu's Configure Spec). */
  focusSpec?: boolean;
  onSpecFocused?(): void;
}) {
  const p = () => props.profile;
  const off = () => props.disabled || props.readOnly;
  const change = props.change;
  const replace = props.replace;
  const editing = () => props.idPrefix;

  const [open, setOpenRows] = createSignal<Set<string>>(new Set());
  const isOpen = (k: string) => open().has(k);
  const setOpen = (k: string, v: boolean) => {
    if (v === isOpen(k)) return;
    const next = new Set(open());
    if (v) next.add(k);
    else next.delete(k);
    setOpenRows(next);
  };

  // A row that comes to hold something Save waits for opens itself — once, when it starts to.
  const incomplete = (c: WorkerChoice | null | undefined) => !!c && (!c.model || !c.effort);
  const routeBad = (r: Route | null | undefined) =>
    !!r && (incomplete(r.primary) || incomplete(r.fallback) || (!!r.fallback && r.primary.backend === r.fallback.backend && r.primary.model === r.fallback.model && r.primary.effort === r.fallback.effort));
  const problemRows = (x: SubagentProfile | null): Set<string> => {
    const out = new Set<string>();
    if (!x) return out;
    for (const [k] of DELEGATE) if (routeBad(x.delegate[k])) out.add(k);
    if (sectionProblems(x).has("teams")) {
      if (x.teams) for (const r of ["coordinator", "monitor"] as const) if (routeBad(x.teams[r] as Route)) out.add(r);
      if (incomplete(x.members)) out.add("members");
      if (!["coordinator", "monitor", "members"].some((k) => out.has(k))) out.add("coordinator");
    }
    if (routeBad(x.specWriter)) out.add("spec");
    if (routeBad(x.reviewer)) out.add("reviewer");
    return out;
  };
  let had = new Set<string>();
  createEffect(() => {
    const now = problemRows(p());
    const fresh = [...now].filter((k) => !had.has(k));
    had = now;
    untrack(() => fresh.forEach((k) => setOpen(k, true)));
  });
  // Configure Spec: the Spec writer's row open, and in view once it renders.
  createEffect(() => {
    if (!props.focusSpec || !p()) return;
    untrack(() => setOpen("spec", true));
    props.onSpecFocused?.();
    requestAnimationFrame(() => {
      const el = document.getElementById(`${props.idPrefix}-row-spec`);
      const panel = el?.closest<HTMLElement>(".settings-panel");
      if (el && panel) panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    });
  });

  // Accessor args, not values: these factories are invoked once when their <Show> mounts, so a
  // plain `c()` read there would freeze the row on the toggle's first state (the members/spec bug).
  // The thunk reads the draft every time the row's props are read.
  const tuple = (
    role: string,
    choice: () => WorkerChoice,
    other: () => WorkerChoice | null,
    onChange: (c: WorkerChoice) => void,
    slot: "primary" | "fallback" = "primary",
    unlabelled: () => boolean = () => false,
  ) => (
    <Show when={props.rows}>
      {(r) => (
        <WorkerSlotRow
          idPrefix={`subagents-${editing()}-${role}`}
          slot={slot}
          info={r()}
          options={props.options}
          choice={choice()}
          other={other()}
          disabled={off()}
          unlabelled={unlabelled()}
          compact
          onChange={onChange}
        />
      )}
    </Show>
  );
  /** A primary row, then its fallback row. "Primary" labels the first row only while a fallback is set. */
  const pair = (role: string, choice: () => { primary: WorkerChoice; fallback: WorkerChoice | null }, update: (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => void) => (
    <>
      {tuple(role, () => choice().primary, () => choice().fallback, (c) => update({ ...choice(), primary: c }), "primary", () => choice().fallback === null)}
      <Show when={choice().fallback}>
        {(f) => (
          <>
            {tuple(role, f, () => choice().primary, (c) => update({ ...choice(), fallback: c }), "fallback")}
          </>
        )}
      </Show>
    </>
  );
  /** Add Fallback or Remove Fallback, for the route's head line beside its name. One button whose
      label flips, so keyboard focus stays on it as the fallback row comes and goes. */
  const fallbackAction = (choice: () => { primary: WorkerChoice; fallback: WorkerChoice | null }, update: (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => void) => (
    <Show when={!props.readOnly}>
      <button
        type="button"
        class="button button-sm button-ghost subagent-editor-route-action"
        disabled={off()}
        onClick={() => update({ ...choice(), fallback: choice().fallback ? null : fallbackFor(choice().primary, true) })}
      >
        <Show when={choice().fallback} fallback={<><Icon name="plus" small />Add Fallback</>}>
          Remove Fallback
        </Show>
      </button>
    </Show>
  );
  /** A teams number box: the draft holds what was typed (red, Save waits), the save its number. */
  const number = (field: TeamNumberField) => {
    const path = TEAM_NUMBERS[field].path;
    return (
      <NumberField
        class="subagent-editor-number"
        id={`subagents-${editing()}-${field}`}
        label={TEAM_RULES[field].label}
        hint={TEAM_NUMBERS[field].hint}
        rule={TEAM_RULES[field]}
        value={String(teamNumber(p()?.teams, field) ?? "")}
        disabled={off()}
        onInput={(raw) => change((x) => (path.slice(0, -1).reduce<any>((o, k) => o[k], x.teams)[path.at(-1)!] = raw))}
      />
    );
  };

  /** A role's compact model and effort: the two selects of its primary, named for the row. */
  const compact = (label: string, key: string, choice: () => WorkerChoice | null, onChange: (c: WorkerChoice) => void, none: string) => (
    <Show when={choice()} fallback={<span class="profile-model-none">{none}</span>}>
      {(c) => {
        const issue = () => (props.rows ? slotIssue(props.rows, props.options, c(), null, "primary", undefined, false) : null);
        return (
          <>
            <Select
              id={`${props.idPrefix}-${key}-model`}
              label={`${label} model`}
              hideLabel
              class="profile-model-model"
              selectClass="text-mono"
              title={c().model || undefined}
              value={c().model}
              disabled={off()}
              onChange={(v) => onChange(withModel(c(), v, props.options))}
            >
              <Show when={!c().model}>
                <option value="" selected disabled>
                  {props.options ? "Choose a model" : "Checking…"}
                </option>
              </Show>
              <For each={modelSelectOptions(props.options, c())}>
                {(o) => (
                  <option value={o.value} selected={o.value === c().model} title={o.title}>
                    {o.label}
                  </option>
                )}
              </For>
            </Select>
            <Select
              id={`${props.idPrefix}-${key}-effort`}
              label={`${label} effort`}
              hideLabel
              class="profile-model-effort"
              value={c().effort}
              disabled={off() || !c().model}
              onChange={(v) => onChange({ ...c(), effort: v })}
            >
              <Show when={!c().effort}>
                <option value="" selected disabled>
                  Choose
                </option>
              </Show>
              <For each={props.rows ? effortSelectOptions(props.rows, props.options, c()) : c().effort ? [c().effort] : []}>
                {(e) => (
                  <option value={e} selected={e === c().effort}>
                    {e}
                  </option>
                )}
              </For>
            </Select>
            <Show when={issue()?.tone === "error"}>
              <span class="visually-hidden">{issue()!.text}</span>
            </Show>
          </>
        );
      }}
    </Show>
  );

  /** One role: its label (a button that expands it), its compact model and effort, and in place, open, the rest. */
  const row = (key: string, label: string, line: () => JSX.Element, more?: () => JSX.Element) => (
    <div class="profile-model-row" classList={{ "is-open": !!more && isOpen(key) }} id={`${props.idPrefix}-row-${key}`}>
      <Show
        when={more}
        fallback={
          <span class="profile-model-label">
            <span class="profile-model-label-text">{label}</span>
          </span>
        }
      >
        <button
          type="button"
          class="profile-model-label profile-model-toggle"
          aria-expanded={isOpen(key)}
          aria-controls={`${props.idPrefix}-more-${key}`}
          onClick={() => setOpen(key, !isOpen(key))}
        >
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="profile-model-label-text">{label}</span>
        </button>
      </Show>
      <Show when={!more || !isOpen(key)}>
        <div class="profile-model-line">{line()}</div>
      </Show>
      <Show when={more && isOpen(key)}>
        <div class="profile-model-more" id={`${props.idPrefix}-more-${key}`}>
          {more!()}
        </div>
      </Show>
    </div>
  );

  // This chat: the chat's own model ref, by its catalog name for a Claude model, and pi's thinking ladder.
  const chatLabel = (m: ModelInfo) => (m.provider === CLAUDE_PROVIDER ? `${claudeModelName(m.id) ?? m.id} · Claude Code` : m.ref);
  const chatLevels = () => props.models?.find((m) => m.ref === props.chat.model)?.thinkingLevels ?? [...THINKING_LEVELS];
  const chatRow = () =>
    row("chat", "This chat", () => (
      <>
        <Select
          id={`${props.idPrefix}-chat-model`}
          label="This chat model"
          hideLabel
          class="profile-model-model"
          selectClass="text-mono"
          title={props.chat.model ?? undefined}
          value={props.chat.model ?? ""}
          disabled={off() || !props.onChat}
          onChange={(v) => {
            const levels = props.models?.find((m) => m.ref === v)?.thinkingLevels;
            const t = props.chat.thinking;
            props.onChat?.({ model: v || null, thinking: v && t && (!levels || levels.includes(t)) ? t : null });
          }}
        >
          <option value="" selected={!props.chat.model}>
            Keeps the chat's own model
          </option>
          <Show when={props.chat.model && !props.models?.some((m) => m.ref === props.chat.model)}>
            <option value={props.chat.model!} selected>
              {props.chat.model}
            </option>
          </Show>
          <For each={props.models ?? []}>
            {(m) => (
              <option value={m.ref} selected={m.ref === props.chat.model}>
                {chatLabel(m)}
              </option>
            )}
          </For>
        </Select>
        <Select
          id={`${props.idPrefix}-chat-effort`}
          label="This chat effort"
          hideLabel
          class="profile-model-effort"
          value={props.chat.thinking ?? ""}
          disabled={off() || !props.onChat || !props.chat.model}
          onChange={(v) => props.onChat?.({ model: props.chat.model, thinking: (v || null) as ThinkingLevel | null })}
        >
          <option value="" selected={!props.chat.thinking}>
            Its default
          </option>
          <For each={chatLevels()}>
            {(l) => (
              <option value={l} selected={l === props.chat.thinking}>
                {l}
              </option>
            )}
          </For>
        </Select>
      </>
    ));

  /** Set All To's models: Claude Code's by name first, then pi's by id (less pi's own copy of the Claude Code provider). */
  const setAllOptions = () =>
    [...(props.options?.backends ?? [])]
      .sort((a, b) => (a.id === "claude-code" ? -1 : b.id === "claude-code" ? 1 : 0))
      .flatMap((b) =>
        (b.models ?? [])
          .filter((m) => !m.denied && !(b.id === "pi" && m.id.startsWith(`${CLAUDE_PROVIDER}/`)))
          .map((m) => ({ value: pickValue(b.id, m.id), label: b.id === "claude-code" ? m.name : m.id })),
      );

  const delegateRows = (x: () => SubagentProfile) => (
    <For each={DELEGATE}>
      {([k, label]) =>
        row(
          k,
          label,
          () => compact(label, k, () => x().delegate[k].primary, (c) => change((y) => (y.delegate[k].primary = c)), "Not set"),
          () => (
            <fieldset class="subagent-editor-route">
              <legend class="subagent-editor-route-name">{label}</legend>
              {fallbackAction(() => x().delegate[k], (c) => change((y) => (y.delegate[k] = c)))}
              {pair(k, () => x().delegate[k], (c) => change((y) => (y.delegate[k] = c)))}
            </fieldset>
          ),
        )
      }
    </For>
  );

  const teamRow = (x: () => SubagentProfile, role: "coordinator" | "monitor") => {
    const name = role === "coordinator" ? "Coordinator" : "Monitor";
    const t = () => x().teams;
    /** The Instructions fold opens itself when the role name goes blank, and stays as the user leaves it. */
    const [instructionsOpen, setInstructionsOpen] = createSignal(false);
    createEffect(() => {
      if (x().teams?.[role].role.trim() === "") setInstructionsOpen(true);
    });
    const choice = () => ({
      primary: { ...t()![role].primary, effort: t()![role].primary.effort ?? "" },
      fallback: t()![role].fallback ? { ...t()![role].fallback!, effort: t()![role].fallback!.effort ?? "" } : null,
    });
    const update = (c: { primary: WorkerChoice; fallback: WorkerChoice | null }) => change((y) => Object.assign(y.teams![role], c));
    return row(
      role,
      name,
      () => compact(name, role, () => (t() ? choice().primary : null), (c) => update({ ...choice(), primary: c }), "Uses the default model"),
      () => (
        <fieldset class="subagent-editor-route">
          <legend class="subagent-editor-route-name">{name}</legend>
          <Show
            when={t()}
            fallback={
              <>
                <p class="field-hint">Uses the default model</p>
                <Show when={!props.readOnly}>
                  <div class="button-row">
                    <button type="button" class="button button-sm" disabled={off() || props.teamsSeed === null} onClick={() => replace((y) => withChosenModels(y, props.teamsSeed))}>
                      Choose Models
                    </button>
                  </div>
                </Show>
              </>
            }
          >
            {fallbackAction(choice, update)}
            {pair(role, choice, update)}
            <Show when={role === "monitor"}>
              <div class="subagent-editor-sub">
                <div class="settings-team-numbers">
                  {number("contextPct")}
                  {number("everyMinutes")}
                </div>
                <Toggle
                  switch
                  class="settings-team-enable"
                  label="Pause the team near a usage limit"
                  checked={t()!.monitor.usage.enabled}
                  disabled={off()}
                  onChange={(v) => change((y) => (y.teams!.monitor.usage.enabled = v))}
                />
                <Show when={t()!.monitor.usage.enabled}>
                  <div class="settings-team-numbers">
                    {number("pausePct")}
                    {number("resumeMarginMinutes")}
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={role === "coordinator"}>
              <div class="subagent-editor-sub">
                <span class="subagent-editor-route-name">Handover</span>
                <div class="settings-team-numbers">{number("retireTimeoutMinutes")}</div>
              </div>
            </Show>
            <details class="overseer-fold subagent-editor-instructions" open={instructionsOpen()} onToggle={(e) => setInstructionsOpen(e.currentTarget.open)}>
              <summary class="overseer-fold-summary">
                <Icon name="chevron-right" small class="icon-twist" />
                <span class="overseer-fold-label">Instructions</span>
                <span class="overseer-fold-meta">
                  {t()![role].role || "No role name"} · {t()![role].instructions.trim() ? "extra instructions set" : "no extra instructions"}
                </span>
              </summary>
              <div class="overseer-fold-body">
                <TextField
                  class="settings-team-role"
                  inputClass="text-mono"
                  id={`subagents-${editing()}-${role}-role`}
                  label="Role name"
                  rule={ROLE_RULE}
                  ruleLabel={`${name} role name`}
                  value={t()![role].role}
                  spellcheck={false}
                  autocomplete="off"
                  disabled={off()}
                  onInput={(raw) => change((y) => (y.teams![role].role = raw))}
                />
                <TextArea
                  id={`subagents-${editing()}-${role}-instructions`}
                  label={`${name} instructions`}
                  hint={`Added to the ${role}'s standing instructions in every new team.`}
                  rule={INSTRUCTIONS_RULE}
                  ruleLabel={`${name} instructions`}
                  rows={3}
                  value={t()![role].instructions}
                  disabled={off()}
                  onInput={(raw) => change((y) => (y.teams![role].instructions = raw))}
                />
              </div>
            </details>
            <Show when={!props.readOnly}>
              <div class="button-row">
                <button type="button" class="button button-sm button-ghost" disabled={off()} onClick={() => replace(withDefaultModel)}>
                  Use Default Model
                </button>
              </div>
            </Show>
          </Show>
        </fieldset>
      ),
    );
  };

  return (
    <div class="subagent-editor profile-models">
      <Show when={props.onSetAll && !props.readOnly}>
        <div class="profile-set-all">
          <Select
            id={`${props.idPrefix}-set-all`}
            label="Set All To"
            class="profile-set-all-field"
            value=""
            disabled={off() || !props.options}
            onChange={(v, el) => {
              const [backend, model] = v.split("\t");
              if (backend && model) props.onSetAll!({ backend: backend as WorkerChoice["backend"], model });
              el.value = "";
            }}
          >
            <option value="" selected>
              Pick a model
            </option>
            <For each={setAllOptions()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
          </Select>
        </div>
      </Show>

      <div class="profile-model-rows">
        {chatRow()}
        <Show
          when={p()}
          fallback={
            <div class="profile-model-group">
              <p class="field-hint">{props.noHelpers}</p>
              <Show when={props.onChooseHelpers && !props.readOnly}>
                <div class="button-row">
                  <button type="button" class="button button-sm" disabled={off()} onClick={() => props.onChooseHelpers!()}>
                    Choose Helpers
                  </button>
                </div>
              </Show>
            </div>
          }
        >
          {(x) => (
            <>
              <h4 class="profile-model-group-head">Delegate</h4>
              <p class="field-hint profile-model-lede">Without a fallback, the agent asks you which model to use when a route's primary can't run.</p>
              {delegateRows(x)}

              <h4 class="profile-model-group-head">Teams</h4>
              {teamRow(x, "coordinator")}
              {teamRow(x, "monitor")}
              {row(
                "members",
                "Members",
                () => compact("Members", "members", () => x().members, (c) => change((y) => (y.members = c)), "On the lead's model"),
                () => (
                  <fieldset class="subagent-editor-route subagent-editor-flush">
                    <legend class="subagent-editor-route-name">Members default</legend>
                    <Toggle
                      switch
                      class="settings-team-enable"
                      label="Choose a model for ordinary members"
                      checked={x().members !== null}
                      disabled={off()}
                      onChange={(v) => change((y) => (y.members = v ? { backend: "pi", model: "", effort: "" } : null))}
                    />
                    <Show when={x().members} fallback={<p class="field-hint">A member nobody gave a model runs on its team lead's model.</p>}>
                      {(m) => tuple("members", m, () => null, (c) => change((y) => (y.members = c)), "primary", () => true)}
                    </Show>
                  </fieldset>
                ),
              )}

              <h4 class="profile-model-group-head">Review</h4>
              {row(
                "spec",
                "Spec writer",
                () => compact("Spec writer", "spec", () => x().specWriter?.primary ?? null, (c) => change((y) => (y.specWriter!.primary = c)), "Off · the session writes it"),
                () => (
                  <>
                    <div class="subagent-editor-switch-line">
                      <Toggle
                        switch
                        class="settings-team-enable"
                        label="Use a spec writer while spec is on"
                        checked={x().specWriter !== null}
                        disabled={off()}
                        onChange={(v) => change((y) => (y.specWriter = v ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))}
                      />
                      <Show when={x().specWriter}>{(w) => fallbackAction(w, (c) => change((y) => (y.specWriter = c)))}</Show>
                    </div>
                    <Show when={x().specWriter} fallback={<p class="field-hint">The session writes the spec itself.</p>}>
                      {(w) => (
                        <>
                          <p class="field-hint settings-delegate-desc">Without a fallback, the session writes the spec itself when the writer can't run.</p>
                          <div class="subagent-editor-flush">{pair("spec", w, (c) => change((y) => (y.specWriter = c)))}</div>
                        </>
                      )}
                    </Show>
                  </>
                ),
              )}
              {/* Adversarial review: its row shows only while the switch is saved on. */}
              <Show when={adversarialReview()}>
                {row(
                  "reviewer",
                  "Reviewer",
                  () => compact("Reviewer", "reviewer", () => x().reviewer?.primary ?? null, (c) => change((y) => (y.reviewer!.primary = c)), "Off · no review"),
                  () => (
                    <>
                      <div class="subagent-editor-switch-line">
                        <Toggle
                          switch
                          class="settings-team-enable"
                          label="Review alignments with a reviewer"
                          checked={!!x().reviewer}
                          disabled={off()}
                          onChange={(v) => change((y) => (y.reviewer = v ? { primary: { backend: "pi", model: "", effort: "" }, fallback: null } : null))}
                        />
                        <Show when={x().reviewer}>{(w) => fallbackAction(w, (c) => change((y) => (y.reviewer = c)))}</Show>
                      </div>
                      <Show when={x().reviewer} fallback={<p class="field-hint">No review.</p>}>
                        {(w) => (
                          <>
                            <p class="field-hint settings-delegate-desc">Without a fallback, the review is recorded incomplete when the reviewer can't run.</p>
                            <div class="subagent-editor-flush">{pair("reviewer", w, (c) => change((y) => (y.reviewer = c)))}</div>
                          </>
                        )}
                      </Show>
                    </>
                  ),
                )}
              </Show>

              {/* The align mode's Eagerness, writing style and Visuals for chats on this profile:
                  "Use host default" stores nothing, so a profile without an override reads as before. */}
              <h4 class="profile-model-group-head">Alignment</h4>
              {(() => {
                const setAlign = (patch: Parameters<typeof withAlignment>[1]) =>
                  change((y) => {
                    const next = withAlignment(y, patch).alignment;
                    if (next) y.alignment = next;
                    else delete y.alignment;
                  });
                return (
                  <>
                    {row("eagerness", "Eagerness", () => (
                      <Select
                        label="Eagerness"
                        hideLabel
                        class="profile-model-wide"
                        value={x().alignment?.eagerness ?? "host"}
                        options={[HOST, ...ALIGN_EAGERNESS.map((v) => ({ value: v, label: ALIGN_EAGERNESS_NAMES[v] }))]}
                        disabled={off()}
                        onChange={(v) => setAlign({ eagerness: v as "host" | "eager" | "careful" })}
                      />
                    ))}
                    {row("style", "Writing style", () => (
                      <Select
                        label="Writing style"
                        hideLabel
                        class="profile-model-wide"
                        value={x().alignment?.style ?? "host"}
                        options={[HOST, ...ALIGN_STYLES.map((v) => ({ value: v, label: ALIGN_STYLE_NAMES[v] }))]}
                        disabled={off()}
                        onChange={(v) => setAlign({ style: v as "host" | "default" | "simplified" | "pm" })}
                      />
                    ))}
                    {row("visuals", "Visuals", () => (
                      <Select
                        label="Visuals"
                        hideLabel
                        class="profile-model-wide"
                        value={x().alignment?.visuals === undefined ? "host" : x().alignment?.visuals ? "on" : "off"}
                        options={[HOST, { value: "on", label: "On" }, { value: "off", label: "Off" }]}
                        disabled={off()}
                        onChange={(v) => setAlign({ visuals: v === "host" ? "host" : v === "on" })}
                      />
                    ))}
                    <p class="field-hint">An eagerness or style change reaches this profile's open chats at their next message; Visuals, sessions started after saving.</p>
                  </>
                );
              })()}
            </>
          )}
        </Show>
      </div>
    </div>
  );
}
