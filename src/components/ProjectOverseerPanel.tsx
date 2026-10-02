import { createEffect, createMemo, createResource, createSignal, For, type JSX, on, onMount, Show } from "solid-js";
import { TODO_TEXT_MAX, type IdeaRecord, type OverseerAction, type OverseerTodosInfo } from "../../shared/protocol";
import {
  ALLOWANCE_MAX,
  AT_ONCE_MAX,
  capProblem,
  DEFAULT_PO_CAPS,
  DEFAULT_SOON_LOOK_SEC,
  DEFAULT_HOLD_MIN,
  DEFAULT_WATCH_GAP_MIN,
  GAP_CHOICES,
  HOLD_CHOICES,
  holdProblem,
  isAtOnce,
  SOON_CHOICES,
  type ProjectOverseerCaps,
} from "../../shared/project-overseer";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING, CONFIRM_KINDS, type ConfirmKind, type Autonomy, type CodingStartResult, type ItemCodeInput, type ItemCodeResult, type ItemSendResult, type CodingWorktree, type ProjectOverseerInfo, type ProjectOverseerPatch } from "../../shared/project-overseer";
import {
  addProjectOverseerIdea,
  addProjectOverseerTodo,
  ApiError,
  codeProjectItem,
  getProjectOverseer,
  getSessionSummaryById,
  listModels,
  mergeCodingWorktree,
  openProjectOverseer,
  patchProjectOverseer,
  patchProjectOverseerTodo,
  projectOverseerActions,
  projectOverseerIdeas,
  projectOverseerTodos,
  removeCodingWorktree,
  runProjectOverseer,
  startProjectCoding,
} from "../lib/api";
import { ABILITIES_KEYS, abilitiesKey, abilitiesLabel, abilitiesOfKey, abilitiesWords, type AbilitiesKey } from "../lib/gathering-abilities";
import { CODING_MODE_KEYS, codingModeKey, codingModeLabel, codingModeOf, folderNote, mergeGate, mergeNote, modeWords, offersMerge, offersRemove, removeGate, startedBy, worktreeOrder, type CodingModeKey } from "../lib/coding-worktrees";
import { relativeTime, tildePath } from "../lib/format";
import { hostLabel, projectHostOf } from "../lib/mesh";
import { unchangedError } from "../lib/unchanged-error";
import { createPoll, type Poll } from "../lib/poll";
import { ACTIVITY_SHOWN, confirmSummary, levelWords, LIMIT_COLUMN_LABEL, LIMIT_COLUMNS, LIMIT_ROWS, limitCell, paceLine, type LimitColumn } from "../lib/project-page";
import { actionLine, allowanceLine, confirmKindDone, confirmKindLabel, gapArea, gapWords, holdHint, holdWords, toggleConfirmKind, confirmKindsFor, isGap, IDEA_TITLE_MAX, lastRunTail, limitsProblem, openIdeas, operatorIdeaId, pendingLine, soonWords, STARTED_KIND, waitingLines, watchHint } from "../lib/project-overseer-view";
import { adoptSession, announce, home, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import { LinksBanner, type Links } from "./LinksBanner";
import { Banner, Chip, Icon } from "./ui";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const sessionHref = (path: string) => `#/s/${encodeURIComponent(path)}`;
const POLL_MS = 10_000;

/** One item the operator can pass on: an idea or a to-do item. */
interface Item {
  ideaId?: string;
  todoId?: string;
  title: string;
  /** The session the item was sent to or coded in (set by items/send and items/code). */
  sessionId?: string;
}

/**
 * The project overseer on its project's page (§app/project-overseer, §app.organizations/project-page):
 * one set of reads the page's tabs share — its info, activity, ideas and to-dos — and the pieces
 * each tab shows: the summary line under the head, Coding sessions, Activity and To-do on Overview,
 * Gaps and ideas on Requirements, and its settings on Settings. Its conversation is the ordinary
 * chat page — tool cards there are the live view — so the page links to it rather than host it.
 */
export interface ProjectOverseer {
  projectId(): string;
  /** The peer that holds the project (null: this host): its models, and the host its words name. */
  host(): string | null;
  info: Poll<ProjectOverseerInfo>;
  actions: Poll<OverseerAction[]>;
  ideas: Poll<{ ideas: IdeaRecord[] }>;
  todos: Poll<OverseerTodosInfo>;
  error(): string | null;
  links(): Links | null;
  setLinks(l: Links | null): void;
  busy(): boolean;
  /** One write: adopt the info it answers with, toast `done`, or say what failed under the summary. */
  run(fn: () => Promise<ProjectOverseerInfo | void>, done?: string): Promise<boolean>;
}

export function createProjectOverseer(props: {
  projectId: string;
  /** Whether the overseer is working now, after every read: its acts (a promotion) change the page around it. */
  onBusy?(busy: boolean): void;
}): ProjectOverseer {
  const p = () => props.projectId;
  const host = () => projectHostOf(p());
  const info = createPoll(() => getProjectOverseer(p()), POLL_MS);
  const actions = createPoll(() => projectOverseerActions(p(), 30), POLL_MS);
  const ideas = createPoll(() => projectOverseerIdeas(p()), POLL_MS * 3);
  const todos = createPoll(() => projectOverseerTodos(p()), POLL_MS * 3);
  const busyNow = createMemo(() => !!info.data()?.busy);
  createEffect(on(busyNow, (b) => props.onBusy?.(b)));
  const [error, setError] = createSignal<string | null>(null);
  const [links, setLinks] = createSignal<Links | null>(null);
  const [busy, setBusy] = createSignal(false);
  const run = async (fn: () => Promise<ProjectOverseerInfo | void>, done?: string): Promise<boolean> => {
    if (busy()) return false;
    setBusy(true);
    try {
      const next = await fn();
      if (next) info.set(next);
      setError(null);
      if (done) {
        toast(done);
        announce(done);
      }
      return true;
    } catch (err) {
      setError(unchangedError(errText(err)));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { projectId: p, host, info, actions, ideas, todos, error, links, setLinks, busy, run };
}

const setAutonomy = (po: ProjectOverseer, autonomy: Autonomy) => void po.run(() => patchProjectOverseer(po.projectId(), { autonomy }), `Autonomy: ${autonomy}.`);

/**
 * The summary's overseer line (§app.organizations/project-page): the level in force, watching, the
 * last run in the page's own words and today's runs, with Working, Run Now and Open Overseer
 * beside it; under it, only when true, what it waits to look at, the allowance used and what waits.
 */
export function OverseerSummary(props: { po: ProjectOverseer; archived?: boolean; /** Who an attach pause names: only a placed project's workspace is ever attached, so the placing layer says it. */ attachedWho?: string }) {
  const po = () => props.po;
  const i = () => po().info.data();
  const openChat = () =>
    void po().run(async () => {
      const next = await openProjectOverseer(po().projectId());
      if (next.path) location.hash = sessionHref(next.path);
      return next;
    });
  const cantOpen = () => !!props.archived && !i()?.exists;
  return (
    <section class="project-summary-overseer" aria-label="Overseer">
      <div class="project-summary-line">
        <p class="project-summary-status">
          <Show when={i()} fallback={po().info.pending() ? "Reading the overseer." : "The overseer didn't answer."}>
            {(x) => <StatusWords info={x()} />}
          </Show>
        </p>
        <div class="cluster project-summary-actions">
          <Show when={i()?.busy}>
            <Chip tone="accent" live>
              Working
            </Chip>
          </Show>
          <button
            type="button"
            class="button button-sm button-ghost"
            aria-disabled={po().busy() || i()?.busy || props.archived ? "true" : undefined}
            title={props.archived ? "Archived" : i()?.busy ? "Working now" : "Look at the project now, as the watch loop would."}
            onClick={() => !props.archived && !i()?.busy && void po().run(() => runProjectOverseer(po().projectId()), "The overseer is looking now.")}
          >
            Run Now
          </button>
          <button type="button" class="button button-sm" aria-disabled={po().busy() || cantOpen() ? "true" : undefined} title={cantOpen() ? "Archived" : undefined} onClick={() => !cantOpen() && openChat()}>
            <Icon name="eye" small />
            {i()?.exists ? "Open Overseer" : "Start Overseer"}
            <Show when={i()?.unread}>{(n) => <span class="chip chip-count">{n()}</span>}</Show>
          </button>
        </div>
      </div>
      <Show when={po().error() ?? (i() ? null : po().info.error())}>{(e) => <Banner tone="error" title="The overseer didn't answer." body={e()} />}</Show>
      <Show when={po().links()}>{(l) => <LinksBanner links={l()} onDismiss={() => po().setLinks(null)} />}</Show>
      <Show when={i()}>
        {(x) => (
          <>
            <StatusMore info={x()} />
            {/* Attached on its host from a clone (a restore or a move): nothing runs on its own until the operator says so there. */}
            <Show when={x().paused}>
              {(since) => (
                <Banner
                  tone="warn"
                  title={`Paused at L0 on ${po().host() ? hostLabel(po().host()!) : "this host"}`}
                  body={`${props.attachedWho ?? "It"} was attached ${po().host() ? `on ${hostLabel(po().host()!)}` : "here"} ${relativeTime(since())}. Until you set its level, the overseer only proposes and its watch loop waits.`}
                  action={
                    <button type="button" class="button button-sm" aria-disabled={po().busy() ? "true" : undefined} onClick={() => setAutonomy(po(), x().settings.autonomy)}>
                      Resume at {x().settings.autonomy}
                    </button>
                  }
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/** "L3 Build · Watching · Last looked on its own 2h ago, after …. 0 runs today." */
function StatusWords(props: { info: ProjectOverseerInfo }) {
  const i = () => props.info;
  const u = () => i().usage;
  const eff = () => i().effective.autonomy;
  return (
    <>
      <span class="project-level" title={AUTONOMY_MEANING[eff()]}>
        {levelWords(eff())}
      </span>
      {" · "}
      {i().settings.watch ? "Watching" : "Not watching"}
      {" · "}
      <Show when={i().lastRun} fallback="It hasn't looked on its own yet.">
        {(r) => (
          <>
            Last looked on its own <time title={r().at}>{relativeTime(r().at)}</time>
            {lastRunTail(r())}.
          </>
        )}
      </Show>{" "}
      {u().unattendedToday} {u().unattendedToday === 1 ? "run" : "runs"} today.
    </>
  );
}

/** The status line's extra lines, each only when it has something to say. */
function StatusMore(props: { info: ProjectOverseerInfo }) {
  const i = () => props.info;
  const u = () => i().usage;
  return (
    <>
      <Show when={u().pending.length}>
        <p class="orgs-line project-muted">Waiting to look at: {pendingLine(u().pending)}</p>
      </Show>
      <For each={[allowanceLine("Today on its own", u().allowance.today), allowanceLine("Your last message", u().allowance.message)].filter((l): l is string => !!l)}>
        {(line) => <p class="orgs-line project-muted">{line}</p>}
      </For>
      <For each={waitingLines(u().held, i().settings)}>{(line) => <p class="orgs-line project-waiting">{line}</p>}</For>
    </>
  );
}

/**
 * The Settings tab's overseer settings (§app.organizations/project-page): watch, the level, what
 * waits for its approval, the sessions it starts, extra instructions and limits. Every control
 * saves as it always has: a pick, tick or switch at once; Extra instructions and Limits on Save.
 */
export function OverseerSettings(props: { po: ProjectOverseer; /** An organization places the project: its gathering sessions and limits show. */ placed: boolean }) {
  const po = () => props.po;
  const p = () => po().projectId();
  const patch = (x: ProjectOverseerPatch) => patchProjectOverseer(p(), x);
  return (
    <Show when={po().info.data()} fallback={<Show when={po().info.pending()}><p class="orgs-empty">Reading the overseer.</p></Show>}>
      {(i) => (
        <>
          <section class="card orgs-section" aria-labelledby="project-settings-overseer">
            <h2 class="orgs-h2" id="project-settings-overseer">
              Overseer
            </h2>
            <div>
              <label class="toggle toggle-switch project-watch">
                <span>Watch this project</span>
                <input
                  type="checkbox"
                  checked={i().settings.watch}
                  aria-describedby="project-watch-hint"
                  onChange={(e) => void po().run(() => patch({ watch: e.currentTarget.checked }), e.currentTarget.checked ? "Watching." : "Not watching.")}
                />
                <span class="toggle-box" />
              </label>
              <p class="field-hint" id="project-watch-hint">
                {watchHint(i().settings.watchGapMin, i().settings.soonLookSec, props.placed)}
              </p>
            </div>
            <AutonomyPicker info={i()} busy={po().busy()} onPick={(a) => setAutonomy(po(), a)} />
            <ConfirmKindsPicker
              info={i()}
              kinds={confirmKindsFor(CONFIRM_KINDS, props.placed)}
              busy={po().busy()}
              onPick={(kind, checked) => void po().run(() => patch({ confirmKinds: toggleConfirmKind(CONFIRM_KINDS, i().settings.confirmKinds, kind, checked) }), confirmKindDone(kind, checked))}
            />
          </section>
          <section class="card orgs-section" aria-labelledby="project-settings-sessions">
            <h2 class="orgs-h2" id="project-settings-sessions">
              Sessions it starts
            </h2>
            <div class="project-models">
              <Show when={props.placed}>
                <SessionModel info={i()} host={po().host()} kind="gathering" label="Gathering sessions" save={async (x) => po().info.set(await patch(x))}>
                  <GatheringAbilitiesField info={i()} onSave={(key) => po().run(() => patch({ gatheringAbilities: abilitiesOfKey(key) }), `Gathering sessions: ${abilitiesLabel(key)}.`)} />
                </SessionModel>
              </Show>
              <SessionModel info={i()} host={po().host()} kind="coding" label="Coding sessions" save={async (x) => po().info.set(await patch(x))}>
                <CodingMode
                  info={i()}
                  onSave={(key) => po().run(() => patch({ codingMode: codingModeOf(key) }), key === "auto" ? "Coding sessions' mode: Automatic." : `Coding sessions run ${codingModeLabel(key)}.`)}
                />
              </SessionModel>
            </div>
          </section>
          <section class="card orgs-section" aria-labelledby="project-extra-label">
            <ExtraInstructions
              saved={i().settings.extraSystemPrompt}
              save={async (text) => {
                const next = await patch({ extraSystemPrompt: text });
                po().info.set(next);
                const done = text.trim() ? "Extra instructions saved." : "Extra instructions removed.";
                toast(done);
                announce(done);
              }}
            />
          </section>
          <section class="card orgs-section" aria-labelledby="project-limits-legend">
            <Limits info={i()} host={po().host()} placed={props.placed} save={(x) => po().run(() => patch(x), "Limits saved.")} />
          </section>
        </>
      )}
    </Show>
  );
}

/** The level as a segmented control: one radio per level, the chosen level's sentence under it. Saves on pick. */
function AutonomyPicker(props: { info: ProjectOverseerInfo; busy: boolean; onPick(a: Autonomy): void }) {
  const chosen = () => props.info.settings.autonomy;
  const eff = () => props.info.effective;
  return (
    <fieldset class="project-autonomy">
      <legend class="field-label">On its own, it may</legend>
      <div class="project-segments" role="radiogroup" aria-label="Autonomy level">
        <For each={AUTONOMY_LEVELS}>
          {(level) => (
            <label class="project-segment" classList={{ "project-segment-on": chosen() === level }} title={AUTONOMY_MEANING[level]}>
              <input type="radio" name="project-autonomy" value={level} checked={chosen() === level} disabled={props.busy} onChange={() => props.onPick(level)} />
              <span class="orgs-mono">{level}</span>
            </label>
          )}
        </For>
      </div>
      <p class="project-autonomy-meaning">
        <span class="orgs-mono">{chosen()}</span> {AUTONOMY_MEANING[chosen()]}
      </p>
      <Show when={eff().autonomy !== chosen() || props.info.paused}>
        <p class="field-hint project-autonomy-note">
          In force now: {eff().autonomy}. {eff().reason ?? ""}
        </p>
      </Show>
      <p class="field-hint">Your own messages to it can always use every tool.</p>
    </fieldset>
  );
}

/**
 * The confirm list (r8, q14): the act kinds that, once held, wait for the overseer to approve
 * them. The rest go ahead when their hold ends. A summary line until Edit; each tick saves at once, like the level.
 */
function ConfirmKindsPicker(props: { info: ProjectOverseerInfo; /** The kinds this project offers (a standalone one: none of an organization's). */ kinds: readonly ConfirmKind[]; busy: boolean; onPick(kind: ConfirmKind, checked: boolean): void }) {
  const on = () => new Set<string>(props.info.settings.confirmKinds ?? []);
  const [editing, setEditing] = createSignal(false);
  return (
    <fieldset class="project-confirm">
      <legend class="field-label">Waits for the overseer's approval</legend>
      <div class="project-confirm-summary">
        <span>{confirmSummary(props.info.settings.confirmKinds ?? [], props.kinds, confirmKindLabel)}</span>
        <button type="button" class="button button-sm button-ghost" aria-expanded={editing()} aria-controls="project-confirm-list" onClick={() => setEditing(!editing())}>
          {editing() ? "Done" : "Edit"}
        </button>
      </div>
      <Show when={editing()}>
        <p class="field-hint project-confirm-hint">
          When one of these is held, it goes ahead only once the overseer approves it; you can cancel it in Needs you. The rest go ahead when their hold ends.
        </p>
        <div class="project-confirm-list" id="project-confirm-list">
          <For each={props.kinds}>
            {(kind) => (
              <label class="toggle project-confirm-row">
                <input type="checkbox" checked={on().has(kind)} disabled={props.busy} onChange={(e) => props.onPick(kind, e.currentTarget.checked)} />
                <span class="toggle-box" />
                <span>{confirmKindLabel(kind)}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </fieldset>
  );
}

const SAME = "";

/**
 * The model and thinking level of the sessions it starts: gathering (the model a roster person
 * talks to) or coding (L3). Empty = the overseer's own (null in the settings). A level the model
 * doesn't offer is refused under the select (§app.project-overseer/identity); a model change that
 * leaves the saved level unsupported moves it to the level pi would run, and says so.
 */
function SessionModel(props: { info: ProjectOverseerInfo; host: string | null; kind: "gathering" | "coding"; label: string; save(patch: ProjectOverseerPatch): Promise<void>; children?: JSX.Element }) {
  const [err, setErr] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  /** One save: its toast, or its refusal under the fields with the select back on what is saved. */
  const save = async (patch: ProjectOverseerPatch, done: string, el: HTMLSelectElement, saved: () => string | null): Promise<boolean> => {
    if (saving()) return false;
    setSaving(true);
    try {
      await props.save(patch);
      setErr(null);
      toast(done);
      announce(done);
      return true;
    } catch (x) {
      setErr(errText(x));
      el.value = saved() ?? SAME;
      return false;
    } finally {
      setSaving(false);
    }
  };
  // The org's host's models (its keys, favorites and policy), as its session pane lists them.
  const [models] = createResource(() => ({ host: props.host }), ({ host }) => listModels(host));
  const modelKey = (): "codingModel" | "gatheringModel" => (props.kind === "coding" ? "codingModel" : "gatheringModel");
  const thinkingKey = (): "codingThinking" | "gatheringThinking" => (props.kind === "coding" ? "codingThinking" : "gatheringThinking");
  const model = () => props.info.settings[modelKey()] ?? null;
  const thinking = () => props.info.settings[thinkingKey()] ?? null;
  const noun = () => (props.kind === "coding" ? "Coding sessions" : "Gathering sessions");
  // Favorites first, then the rest; the saved one always listed, even if the list no longer has it.
  const options = createMemo(() => {
    const all = models() ?? [];
    const refs = [...all.filter((m) => m.favorite), ...all.filter((m) => !m.favorite)].map((m) => m.ref);
    const saved = model();
    return saved && !refs.includes(saved) ? [saved, ...refs] : refs;
  });
  const noVision = createMemo(() => {
    const ref = model();
    const m = ref ? models()?.find((x) => x.ref === ref) : undefined;
    return !!m && Array.isArray(m.input) && !m.input.includes("image");
  });
  const levels = createMemo(() => {
    const ref = model();
    const m = ref ? models()?.find((x) => x.ref === ref) : undefined;
    return m?.thinkingLevels ?? ["off", "minimal", "low", "medium", "high"];
  });
  return (
    <div class="orgs-fields project-coding-model">
      <label class="field">
        <span class="field-label">{props.label}</span>
        <select
          class="select"
          onChange={async (e) => {
            const el = e.currentTarget;
            const v = el.value;
            const before = thinking();
            const patch: ProjectOverseerPatch = v === SAME ? { [modelKey()]: null, [thinkingKey()]: null } : { [modelKey()]: v };
            if (!(await save(patch, v === SAME ? `${noun()} use the overseer's model.` : `${noun()} use ${v}.`, el, model))) return;
            // The server moved a level the new model doesn't offer to the one pi would run: said after the model's own toast.
            const after = thinking();
            if (v !== SAME && before && after && after !== before) {
              const words = `Thinking is now ${after}: ${v} doesn't offer ${before}.`;
              toast(words);
              announce(words);
            }
          }}
        >
          <option value={SAME} selected={!model()}>
            Same as the overseer
          </option>
          <For each={options()}>{(ref) => <option value={ref} selected={ref === model()}>{ref}</option>}</For>
        </select>
        {/* A gathering model without vision: people get no attach button (§app.baton/images). */}
        <Show when={props.kind !== "coding" && noVision()}>
          <span class="field-hint">This model can't see photos: people won't get an attach button.</span>
        </Show>
      </label>
      <label class="field">
        <span class="field-label">Their thinking</span>
        <select
          class="select"
          onChange={(e) => {
            const v = e.currentTarget.value;
            void save({ [thinkingKey()]: v === SAME ? null : v }, v === SAME ? `${noun()}: thinking same as the overseer.` : `${noun()}: thinking ${v}.`, e.currentTarget, thinking);
          }}
        >
          <option value={SAME} selected={!thinking()}>
            Same as the overseer
          </option>
          <For each={levels()}>{(l) => <option value={l} selected={l === thinking()}>{l}</option>}</For>
        </select>
        <Show when={err()}>{(e) => <span class="field-error">{e()}</span>}</Show>
      </label>
      {props.children}
    </div>
  );
}

/** The most characters of the extra instructions (the server's EXTRA_PROMPT_MAX). */
const EXTRA_MAX = 8000;

/**
 * Extra instructions (§app.project-overseer/identity): the operator's own words, added last to the
 * overseer's prompt, after the organization's About text. One PATCH on Save; Cancel puts the saved
 * text back; a blank save removes them.
 */
function ExtraInstructions(props: { saved: string; save(text: string): Promise<void> }) {
  const [draft, setDraft] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const text = () => draft() ?? props.saved;
  const dirty = () => draft() !== null && draft() !== props.saved;
  const over = () => text().length > EXTRA_MAX;
  const submit = async () => {
    if (!dirty() || saving()) return;
    if (over()) {
      setProblem("Extra instructions can be at most 8,000 characters.");
      return;
    }
    setSaving(true);
    try {
      await props.save(text());
      setDraft(null);
      setProblem(null);
    } catch (err) {
      const m = errText(err);
      setProblem(/at most 8000 characters/.test(m) ? "Extra instructions can be at most 8,000 characters." : m);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      class="field project-extra"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label class="orgs-h2" id="project-extra-label" for="project-extra-text">
        Extra instructions
      </label>
      <p class="field-hint" id="project-extra-hint">
        Added last to this overseer's prompt, after the organization's About text, and they win over it. It reads them at its next run.
      </p>
      <textarea
        id="project-extra-text"
        class="input textarea"
        rows={4}
        value={text()}
        aria-describedby={problem() ? "project-extra-hint project-extra-error" : "project-extra-hint"}
        aria-invalid={problem() || over() ? "true" : undefined}
        onInput={(e) => {
          setDraft(e.currentTarget.value);
          setProblem(null);
        }}
      />
      <Show when={problem()}>
        {(p) => (
          <p class="field-error" id="project-extra-error">
            {p()}
          </p>
        )}
      </Show>
      <div class="button-row project-extra-foot">
        <span class={over() ? "field-error orgs-mono" : "field-hint orgs-mono"}>
          {text().length.toLocaleString("en-US")} / 8,000
        </span>
        <span class="orgs-grow" />
        <button
          type="button"
          class="button button-sm button-ghost"
          disabled={!dirty() || saving()}
          onClick={() => {
            setDraft(null);
            setProblem(null);
          }}
        >
          Cancel
        </button>
        <button type="submit" class="button button-sm" disabled={!dirty() || saving()}>
          Save
        </button>
      </div>
    </form>
  );
}

/** The Limits form's values: a limit is a number, NaN while its field is empty or not a number, or null (Unlimited). */
interface LimitsDraft {
  caps: Record<keyof ProjectOverseerCaps, number | null>;
  watchGapMin: number;
  soonLookSec: number | null;
  holdMin: number;
}
const limitsOf = (s: ProjectOverseerInfo["settings"]): LimitsDraft => ({ caps: { ...s.caps }, watchGapMin: s.watchGapMin, soonLookSec: s.soonLookSec, holdMin: s.holdMin });
const numberOf = (v: string): number => (v.trim() === "" ? Number.NaN : Number(v));

/**
 * The project's limits (§app.project-overseer/limits): each message's allowance, the day's on its
 * own, at once, and the pace. Read-only as one table until Edit; then one form, one PATCH.
 * Unlimited is an ∞ toggle beside the field, never a blank field; the at-once limits have none.
 */
function Limits(props: { info: ProjectOverseerInfo; host: string | null; placed: boolean; save(patch: ProjectOverseerPatch): Promise<boolean> }) {
  const saved = createMemo(() => JSON.stringify(limitsOf(props.info.settings)));
  const [draft, setDraft] = createSignal<LimitsDraft>(limitsOf(props.info.settings));
  const [editing, setEditing] = createSignal(false);
  // A save here or elsewhere brings the form to what is saved.
  createEffect(on(saved, (json) => setDraft(JSON.parse(json) as LimitsDraft), { defer: true }));
  /** The number a field had before Unlimited was pressed, to bring back when it is released. */
  const kept = new Map<string, number>();
  const [problem, setProblem] = createSignal<string | null>(null);
  const setCap = (k: keyof ProjectOverseerCaps, v: number | null) => setDraft((d) => ({ ...d, caps: { ...d.caps, [k]: v } }));
  const unlimited = (key: string, on: boolean, cur: number | null, fallback: number, set: (v: number | null) => void) => {
    if (on) {
      if (cur !== null && Number.isFinite(cur)) kept.set(key, cur);
      set(null);
    } else set(kept.get(key) ?? fallback);
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    const d = draft();
    const why = limitsProblem(d) ?? holdProblem(d.holdMin);
    setProblem(why);
    if (why) return;
    if (await props.save({ caps: d.caps as ProjectOverseerCaps, watchGapMin: d.watchGapMin, soonLookSec: d.soonLookSec, holdMin: d.holdMin })) setEditing(false);
  };
  const cancel = () => {
    setDraft(JSON.parse(saved()) as LimitsDraft);
    setProblem(null);
    setEditing(false);
  };
  const gaps = createMemo(() => [...new Set([...GAP_CHOICES, draft().watchGapMin])].sort((a, b) => a - b));
  const holds = createMemo(() => [...new Set<number>([...HOLD_CHOICES, draft().holdMin])].sort((a, b) => a - b));
  const soons = createMemo(() => {
    const cur = draft().soonLookSec;
    const nums = new Set<number>(cur === null ? [] : [cur]);
    for (const x of SOON_CHOICES) if (x !== null) nums.add(x);
    return [...[...nums].sort((a, b) => a - b), null];
  });
  const hostWords = () => (props.host ? hostLabel(props.host) : "this host");
  const s = () => props.info.settings;
  /** One cell: read-only its figure, editing its field (and ∞ for an allowance). */
  const Cell = (c: { k: keyof ProjectOverseerCaps; row: string; column: LimitColumn }) => {
    const atOnce = isAtOnce(c.k);
    const v = () => draft().caps[c.k];
    const id = `project-limit-${c.k}`;
    const name = `${c.row}, ${LIMIT_COLUMN_LABEL[c.column].toLowerCase()}`;
    return (
      <Show
        when={editing()}
        fallback={
          <Show when={s().caps[c.k] === null} fallback={<span class="text-num">{limitCell(s().caps[c.k])}</span>}>
            <span class="text-num" title="Unlimited" aria-hidden="true">
              ∞
            </span>
            <span class="visually-hidden">Unlimited</span>
          </Show>
        }
      >
        <div class="project-limit-edit">
          <input
            class="input text-num project-limit-input"
            id={id}
            type="number"
            inputmode="numeric"
            min="0"
            max={atOnce ? AT_ONCE_MAX[c.k as keyof typeof AT_ONCE_MAX] : ALLOWANCE_MAX}
            step="1"
            aria-label={name}
            value={v() === null || Number.isNaN(v()) ? "" : String(v())}
            disabled={v() === null}
            placeholder={v() === null ? "∞" : undefined}
            aria-invalid={v() !== null && capProblem(c.k, v()) ? "true" : undefined}
            onInput={(e) => setCap(c.k, numberOf(e.currentTarget.value))}
          />
          <Show when={!atOnce}>
            <button
              type="button"
              class="button button-sm button-ghost project-limit-inf"
              aria-pressed={v() === null ? "true" : "false"}
              aria-label={`Unlimited: ${name}`}
              title="Unlimited"
              onClick={() => unlimited(c.k, v() !== null, v(), DEFAULT_PO_CAPS[c.k] ?? 0, (x) => setCap(c.k, x))}
            >
              ∞
            </button>
          </Show>
        </div>
      </Show>
    );
  };
  return (
    <form class="project-limits" onSubmit={submit} aria-labelledby="project-limits-legend">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-limits-legend">
          Limits
        </h2>
        <Show when={!editing()}>
          <button type="button" class="button button-sm" onClick={() => setEditing(true)}>
            Edit Limits
          </button>
        </Show>
      </div>
      <p class="field-hint project-limits-hint">Past a limit it stops and tells you. Your own coding sessions and Send to Person aren't counted.</p>
      <div class="project-limits-table-wrap">
        <table class="project-limits-table">
          <caption class="visually-hidden">Limits: per message you send, per day on its own, and at once</caption>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <For each={LIMIT_COLUMNS}>{(c) => <th scope="col">{LIMIT_COLUMN_LABEL[c]}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={LIMIT_ROWS.filter((r) => props.placed || !r.placed)}>
              {(r) => (
                <tr>
                  <th scope="row">{r.label}</th>
                  <For each={LIMIT_COLUMNS}>
                    {(c) => (
                      <td data-label={LIMIT_COLUMN_LABEL[c]} classList={{ "project-limit-none": !r.cells[c] }}>
                        <Show when={r.cells[c]} fallback={<span class="project-muted" aria-label="None">—</span>}>
                          {(k) => <Cell k={k()} row={r.label} column={c} />}
                        </Show>
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <p class="field-hint project-limits-hint">
        Per day resets at midnight on {hostWords()}. At once never goes Unlimited: it's what stops a burst.
      </p>
      <Show
        when={editing()}
        fallback={<p class="orgs-line project-pace-line">{paceLine(s().watchGapMin, s().soonLookSec, s().holdMin)}</p>}
      >
        <fieldset class="project-limits-group">
          <legend class="project-limits-legend">Pace</legend>
          <div class="orgs-fields">
            <label class="field">
              <span class="field-label">Looks at most every</span>
              <select class="select" onChange={(e) => setDraft((d) => ({ ...d, watchGapMin: Number(e.currentTarget.value) }))}>
                <For each={gaps()}>
                  {(m) => (
                    <option value={m} selected={m === draft().watchGapMin}>
                      {gapWords(m)}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="field">
              <span class="field-label">After a session finishes, it looks within</span>
              <select class="select" onChange={(e) => setDraft((d) => ({ ...d, soonLookSec: e.currentTarget.value === "off" ? null : Number(e.currentTarget.value) }))}>
                <For each={soons()}>
                  {(sec) => (
                    <option value={sec === null ? "off" : sec} selected={sec === draft().soonLookSec}>
                      {sec === null ? "Off" : soonWords(sec)}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <label class="field">
              <span class="field-label">Hold before it reaches people or the code</span>
              <select class="select" aria-describedby="project-hold-hint" onChange={(e) => setDraft((d) => ({ ...d, holdMin: Number(e.currentTarget.value) }))}>
                <For each={holds()}>
                  {(m) => (
                    <option value={m} selected={m === draft().holdMin}>
                      {holdWords(m)}
                    </option>
                  )}
                </For>
              </select>
              <span class="field-hint" id="project-hold-hint">
                {holdHint(draft().holdMin)}
              </span>
            </label>
          </div>
        </fieldset>
        <Show when={problem()}>{(why) => <p class="field-error">{why()}</p>}</Show>
        <div class="project-limits-actions">
          <button type="submit" class="button">
            Save Limits
          </button>
          <button
            type="button"
            class="button button-ghost"
            onClick={() => {
              setProblem(null);
              setDraft({ caps: { ...DEFAULT_PO_CAPS }, watchGapMin: DEFAULT_WATCH_GAP_MIN, soonLookSec: DEFAULT_SOON_LOOK_SEC, holdMin: DEFAULT_HOLD_MIN });
            }}
          >
            Reset Limits
          </button>
          <button type="button" class="button button-ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      </Show>
    </form>
  );
}

/**
 * What its gathering sessions can do (§app.baton/abilities): every start gets it unless it says
 * otherwise. Automatic is draw on, read links off; the overseer may never turn read links on beyond it.
 */
function GatheringAbilitiesField(props: { info: ProjectOverseerInfo; onSave(key: AbilitiesKey): Promise<boolean> }) {
  const key = () => abilitiesKey(props.info.settings.gatheringAbilities ?? null);
  return (
    <label class="field">
      <span class="field-label">Gathering sessions can</span>
      <select
        class="select"
        aria-describedby="project-gathering-abilities-hint"
        onChange={async (e) => {
          const el = e.currentTarget;
          if (!(await props.onSave(el.value as AbilitiesKey))) el.value = key();
        }}
      >
        <For each={ABILITIES_KEYS}>
          {(k) => (
            <option value={k} selected={k === key()}>
              {abilitiesLabel(k)}
            </option>
          )}
        </For>
      </select>
      <span class="field-hint" id="project-gathering-abilities-hint">
        Every gathering session this project starts gets this, unless its start says otherwise. One started now: {abilitiesWords(props.info.gatheringAbilitiesNow)}.
      </span>
    </label>
  );
}

/**
 * The mode every coding session it starts gets (sova_create_session, Start Coding Session).
 * Automatic follows the project: spec on when it has one. Delegate is the operator's opt-in; the
 * overseer may ask for it only when chosen here.
 */
function CodingMode(props: { info: ProjectOverseerInfo; onSave(key: CodingModeKey): Promise<boolean> }) {
  const key = () => codingModeKey(props.info.settings.codingMode ?? null);
  const now = () => props.info.codingModeNow;
  return (
    <label class="field">
      <span class="field-label">Coding sessions' mode</span>
      <select
        class="select"
        aria-describedby="project-coding-mode-hint"
        onChange={async (e) => {
          const el = e.currentTarget;
          if (!(await props.onSave(el.value as CodingModeKey))) el.value = key();
        }}
      >
        <For each={CODING_MODE_KEYS}>
          {(k) => (
            <option value={k} selected={k === key()}>
              {codingModeLabel(k)}
            </option>
          )}
        </For>
      </select>
      <span class="field-hint" id="project-coding-mode-hint">
        Every coding session this project starts runs in it, yours included. One started now: <span class="orgs-mono">{modeWords(now())}</span>.
      </span>
    </label>
  );
}

/** Its gathering sessions and offers; coding sessions list under "Coding sessions". */
function Started(props: { info: ProjectOverseerInfo }) {
  const rows = createMemo(() => props.info.started.filter((s) => s.kind !== "coding"));
  return (
    <Show when={rows().length}>
      <h3 class="orgs-h3">Sessions it started</h3>
      <ul class="list">
        <For each={rows()}>
          {(s) => (
            <li class="list-row orgs-row">
              <span class="list-main">
                <Show when={s.path} fallback={<span class="list-title">{s.title}</span>}>
                  {(path) => (
                    <a class="list-title" href={sessionHref(path())}>
                      {s.title}
                    </a>
                  )}
                </Show>
                <span class="list-meta">
                  {STARTED_KIND[s.kind]} · {s.state} · <time title={s.createdAt}>{relativeTime(s.createdAt)}</time>
                </span>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/**
 * Every coding session the project started, the overseer's and the operator's (§app.project-overseer/
 * coding-worktrees): each runs in a worktree and branch of its own, cut from the root's branch, or
 * in the root when it can't. Merging the branch back, and removing the worktree, are the operator's.
 */
function CodingSessions(props: {
  info: ProjectOverseerInfo;
  /** The project is archived: New Coding Session is disabled, "Archived". */
  archived?: boolean;
  /** New Coding Session (§app.project-overseer/new-coding-session): tied to no item, nothing sent. */
  start(): Promise<CodingStartResult>;
  merge(w: CodingWorktree): Promise<ProjectOverseerInfo>;
  remove(w: CodingWorktree): Promise<ProjectOverseerInfo>;
  onInfo(i: ProjectOverseerInfo): void;
  onStarted(): void;
}) {
  const wt = () => props.info.worktrees;
  const rows = createMemo(() => worktreeOrder(wt().sessions));
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [working, setWorking] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  /** New Coding Session's own refusal, under the heading. */
  const [startError, setStartError] = createSignal<string | null>(null);
  const start = async () => {
    if (starting() || props.archived) return;
    setStarting(true);
    try {
      const r = await props.start();
      props.onStarted();
      // Started, but its mode isn't set: it stays on this page, listed, to be opened and set by hand.
      if (r.modeNotSet) {
        setStartError(r.modeNotSet);
        return;
      }
      setStartError(null);
      toast(r.worktree ? `Coding session started on ${r.worktree.branch}.` : "Coding session started in the project root.");
      // Empty until the operator writes, so the list hides it: the app adopts it, as New Session's.
      const s = await getSessionSummaryById(r.sessionId).catch(() => null);
      if (!s || !adoptSession(s)) location.hash = sessionHref(r.path);
    } catch (x) {
      setStartError(unchangedError(errText(x), "No session was started."));
    } finally {
      setStarting(false);
    }
  };
  /** A refusal stays under its own row. */
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const act = async (w: CodingWorktree, fn: () => Promise<ProjectOverseerInfo>, done: string) => {
    if (working()) return;
    setWorking(w.sessionId);
    try {
      props.onInfo(await fn());
      setErrors(({ [w.sessionId]: _, ...rest }) => rest);
      toast(done);
      announce(done);
    } catch (x) {
      setErrors((e) => ({ ...e, [w.sessionId]: errText(x) }));
    } finally {
      // Done or refused, the confirmation has had its answer; a refusal stays under the row.
      setConfirming(null);
      setWorking(null);
    }
  };
  return (
    <>
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-coding">
          Coding sessions
        </h2>
        <button
          type="button"
          class="button button-sm"
          aria-disabled={starting() || props.archived ? "true" : undefined}
          title={props.archived ? "Archived" : undefined}
          onClick={() => void start()}
        >
          <Icon name="terminal" small /> New Coding Session
        </button>
      </div>
      <Show when={startError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={!wt().available && wt().reason}>{(r) => <p class="orgs-line project-muted">Coding sessions run in the project root: {r()}</p>}</Show>
      <Show when={!rows().length}>
        <p class="orgs-empty">None yet. Yours and the overseer's are listed here.</p>
      </Show>
      <ul class="list project-worktrees">
        <For each={rows()}>
          {(row) => {
            const armed = () => confirming() === row.sessionId;
            const folder = () => (row.worktree ? tildePath(row.worktree, home()) : "");
            const title = () => row.title || UNTITLED_CODING;
            return (
              <li class="list-row orgs-row project-worktree">
                <span class="list-main project-worktree-main">
                  <Show when={row.path} fallback={<span class="list-title project-worktree-title" title={title()}>{title()}</span>}>
                    {(path) => (
                      <a class="list-title project-worktree-title" href={sessionHref(path())} title={title()} onClick={(e) => !row.title && openUntitled(e, row.sessionId)}>
                        {title()}
                      </a>
                    )}
                  </Show>
                  <span class="list-meta project-worktree-meta">
                    {startedBy(row)} · {row.running ? "working" : "idle"} · <time title={row.createdAt}>{relativeTime(row.createdAt)}</time>
                    <Show when={row.branch}>
                      {(b) => (
                        <>
                          {" · "}
                          <span class="orgs-mono project-worktree-branch" title={b()}>
                            {b()}
                          </span>
                        </>
                      )}
                    </Show>
                  </span>
                  <Show when={row.state === "root" && row.inRoot}>{(why) => <span class="list-meta">In the project root: {why()}</span>}</Show>
                  <Show when={mergeNote(row)}>
                    {(lead) => (
                      <span class="list-meta">
                        {lead()} <span class="orgs-mono">{row.target}</span>
                        <Show when={row.mergedAt}>{(at) => <> <time title={at()}>{relativeTime(at())}</time></>}</Show>
                      </span>
                    )}
                  </Show>
                  <Show when={folderNote(row)}>{(note) => <span class="list-meta">{note()}</span>}</Show>
                </span>
                <Show when={offersMerge(row) || offersRemove(row)}>
                  <ActionMenu label={`Actions · ${title()}`} title="Actions" icon="more">
                    {(menu) => (
                      <>
                        <Show when={offersMerge(row)}>
                          <menu.Item
                            label="Merge Branch"
                            aria={`Merge Branch: ${row.branch} into ${row.target}`}
                            icon={<Icon name="branch" small />}
                            description={`${row.branch} into ${row.target}`}
                            disabled={mergeGate(row) ?? (working() ? "Working" : undefined)}
                            onRun={() => void act(row, () => props.merge(row), `Merged ${row.branch} into ${row.target}.`)}
                          />
                        </Show>
                        <Show when={offersRemove(row)}>
                          <menu.Item
                            label="Remove Worktree…"
                            aria={`Remove Worktree: ${title()}`}
                            disabled={removeGate(row) ?? (working() ? "Working" : undefined)}
                            onRun={() => setConfirming(row.sessionId)}
                          />
                        </Show>
                      </>
                    )}
                  </ActionMenu>
                </Show>
                <Show when={errors()[row.sessionId]}>{(e) => <p class="field-error project-worktree-note">{e()}</p>}</Show>
                <Show when={armed()}>
                  <div class="person-confirm project-worktree-note" role="group" aria-label="Remove worktree">
                    <p class="orgs-line">
                      <Show
                        when={row.merged}
                        fallback={
                          <>
                            The folder <span class="orgs-mono">{folder()}</span> goes away. The branch <span class="orgs-mono">{row.branch}</span> keeps its commits, and the session and its transcript stay.
                          </>
                        }
                      >
                        The folder <span class="orgs-mono">{folder()}</span> and the merged branch <span class="orgs-mono">{row.branch}</span> go away. The session and its transcript stay.
                      </Show>
                    </p>
                    <div class="button-row">
                      <button
                        type="button"
                        class="button button-sm button-destructive"
                        aria-disabled={working() ? "true" : undefined}
                        onClick={() => void act(row, () => props.remove(row), "Worktree removed.")}
                      >
                        Remove Worktree
                      </button>
                      <button type="button" class="button button-sm button-ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </>
  );
}

/** Overview's Coding sessions card: every coding session, then the gathering sessions it started. */
export function CodingSessionsCard(props: { po: ProjectOverseer; archived?: boolean }) {
  const po = () => props.po;
  return (
    <section class="card orgs-section" aria-labelledby="project-coding">
      <Show
        when={po().info.data()}
        fallback={
          <>
            <h2 class="orgs-h2" id="project-coding">
              Coding sessions
            </h2>
            <p class="orgs-empty">{po().info.pending() ? "Reading the overseer." : "The overseer didn't answer."}</p>
          </>
        }
      >
        {(i) => (
          <>
            <CodingSessions
              info={i()}
              archived={props.archived}
              start={() => startProjectCoding(po().projectId())}
              merge={(w) => mergeCodingWorktree(po().projectId(), w.sessionId)}
              remove={(w) => removeCodingWorktree(po().projectId(), w.sessionId)}
              onInfo={po().info.set}
              onStarted={() => po().info.refetch()}
            />
            <Started info={i()} />
          </>
        )}
      </Show>
    </section>
  );
}

/** A coding session nobody has written in yet (New Coding Session, before its first message). */
const UNTITLED_CODING = "Untitled coding session";

/** Opens an untitled coding session: the list hides an empty one, so the app adopts it (else the plain link). */
function openUntitled(e: MouseEvent, sessionId: string): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const href = (e.currentTarget as HTMLAnchorElement).getAttribute("href") ?? "";
  void getSessionSummaryById(sessionId).then(
    (s) => adoptSession(s) || (location.hash = href),
    () => (location.hash = href),
  );
}

/** Overview's Activity: the newest few acts, then Show All. A done act has no chip; the rest keep theirs. */
export function ActivityCard(props: { po: ProjectOverseer }) {
  const OUTCOME = {
    partial: { word: "Partly", tone: "warn" as const },
    refused: { word: "Refused", tone: "warn" as const },
    error: { word: "Failed", tone: "error" as const },
  };
  const [all, setAll] = createSignal(false);
  const actions = () => props.po.actions.data();
  const shown = createMemo(() => (all() ? actions() : actions()?.slice(0, ACTIVITY_SHOWN)) ?? []);
  return (
    <section class="card orgs-section" aria-labelledby="project-activity">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-activity">
          Activity
        </h2>
        <Show when={(actions()?.length ?? 0) > ACTIVITY_SHOWN}>
          <button type="button" class="button button-sm button-ghost" aria-expanded={all()} aria-controls="project-activity-list" onClick={() => setAll(!all())}>
            {all() ? "Show Fewer" : `Show All ${actions()!.length}`}
          </button>
        </Show>
      </div>
      <Show when={props.po.actions.error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={actions()?.length} fallback={<p class="orgs-empty">{props.po.actions.pending() ? "Reading its activity." : "Nothing yet. Every act it takes, refused or not, lists here."}</p>}>
        <ul class="orgs-history-list project-activity" id="project-activity-list">
          <For each={shown()}>
            {(a) => (
              <li class="orgs-change">
                <span class="orgs-change-main">
                  {actionLine(a)}
                  <Show when={a.note}>{(n) => <span class="project-muted"> · {n()}</span>}</Show> <span class="list-meta">· <time title={a.at}>{relativeTime(a.at)}</time></span>
                </span>
                <Show when={a.outcome !== "ok" && OUTCOME[a.outcome as keyof typeof OUTCOME]}>{(o) => <Chip tone={o().tone}>{o().word}</Chip>}</Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

// ---- ideas and to-do items, each passable to a coding session (and to a person, while placed) -----------

/**
 * Send to Person's form, contributed by the layer that places the project (the org's roster): the
 * item it passes on, Cancel, and what was sent. Absent on a standalone project: no Send to Person.
 */
export type ItemSendForm = (p: { item: { ideaId?: string; todoId?: string }; close(): void; sent(r: ItemSendResult): void }) => JSX.Element;

interface ItemCallbacks {
  send?: ItemSendForm;
  /** The project is archived: nothing new starts from an item. */
  archived?: boolean;
  onLinks(l: Links): void;
  code(input: ItemCodeInput): Promise<ItemCodeResult>;
  after(): void;
}

/** An item list's add form, opened by + on its heading: closes after an add or on Cancel. */
function AddForm(props: { label: string; submitLabel: string; maxlength: number; add(text: string): Promise<void>; onError(e: string | null): void; onClose(): void }) {
  const [draft, setDraft] = createSignal("");
  let input: HTMLInputElement | undefined;
  onMount(() => input?.focus());
  return (
    <form
      class="orgs-inline"
      onSubmit={(e) => {
        e.preventDefault();
        const text = draft().trim();
        if (!text) return;
        props.add(text).then(
          () => {
            setDraft("");
            props.onError(null);
            props.onClose();
          },
          (x) => props.onError(unchangedError(errText(x), "Nothing was added.")),
        );
      }}
    >
      <label class="field orgs-grow">
        <span class="field-label">{props.label}</span>
        <input ref={input} class="input" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={props.maxlength} />
      </label>
      <button type="submit" class="button">
        {props.submitLabel}
      </button>
      <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
        Cancel
      </button>
    </form>
  );
}

/** The + on an item list's heading: opens its add form. */
function AddButton(props: { label: string; open: boolean; onClick(): void }) {
  return (
    <button type="button" class="button button-sm button-ghost" aria-expanded={props.open} aria-label={props.label} title={props.label} onClick={() => props.onClick()}>
      <Icon name="plus" small />
    </button>
  );
}

/** The ideas as the project's lists pass them on (§app.project-overseer/ideas-and-todos). */
function itemCallbacks(po: ProjectOverseer, send: ItemSendForm | undefined, archived: boolean | undefined, after: () => void): ItemCallbacks {
  return {
    send,
    archived,
    onLinks: po.setLinks,
    code: (input) => codeProjectItem(po.projectId(), input),
    after,
  };
}

/** The open ideas, gaps first (Requirements' Gaps and ideas while placed, else on Overview); its add form behind +. `adding` opens the form from outside (+ Idea). */
export function IdeasCard(props: { po: ProjectOverseer; title: string; empty: string; send?: ItemSendForm; archived?: boolean; adding?: boolean; onAdding?(open: boolean): void }) {
  const po = () => props.po;
  const [err, setErr] = createSignal<string | null>(null);
  const [localAdding, setLocalAdding] = createSignal(false);
  const adding = () => props.adding ?? localAdding();
  const setAdding = (open: boolean) => (props.onAdding ? props.onAdding(open) : setLocalAdding(open));
  const ideas = () => (po().ideas.data() ? openIdeas(po().ideas.data()!.ideas) : undefined);
  const cb = () =>
    itemCallbacks(po(), props.send, props.archived, () => {
      po().ideas.refetch();
      po().info.refetch();
    });
  return (
    <section class="card orgs-section" aria-labelledby="project-ideas">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-ideas">
          {props.title}
          {ideas() ? ` · ${ideas()!.length}` : ""}
        </h2>
        <AddButton label="Add an idea" open={adding()} onClick={() => setAdding(!adding())} />
      </div>
      <Show when={po().ideas.error() ?? err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={adding()}>
        <AddForm
          label="New idea"
          submitLabel="Add Idea"
          maxlength={IDEA_TITLE_MAX}
          onError={setErr}
          onClose={() => setAdding(false)}
          add={async (title) => {
            // Fresh ids: the poll may lag another tab's or the overseer's latest idea.
            const taken = new Set((await projectOverseerIdeas(po().projectId())).ideas.map((i) => i.id));
            po().ideas.set(await addProjectOverseerIdea(po().projectId(), { id: operatorIdeaId(title, taken), title }));
          }}
        />
      </Show>
      <Show when={ideas()?.length} fallback={<p class="orgs-empty">{props.empty}</p>}>
        <ul class="project-items">
          <For each={ideas()}>
            {(idea) => (
              <li class="project-item">
                <div class="orgs-head">
                  <span class="project-item-title">{idea.title}</span>
                  <Show when={isGap(idea)}>
                    <Chip tone="info">Gap</Chip>
                  </Show>
                </div>
                <span class="list-meta">
                  <span class="orgs-mono">{idea.id}</span>
                  {gapArea(idea) ? ` · area ${gapArea(idea)}` : ""} · {idea.status}
                </span>
                <ItemActions {...cb()} item={{ ideaId: idea.id, title: idea.title, sessionId: idea.sessionId }} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** Overview's To-do: the open items, each with its tick and actions; its add form behind +. */
export function TodosCard(props: { po: ProjectOverseer; send?: ItemSendForm; archived?: boolean }) {
  const po = () => props.po;
  const [err, setErr] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);
  const info = () => po().todos.data();
  const open = createMemo(() => info()?.todos.filter((t) => !t.done) ?? []);
  const cb = () =>
    itemCallbacks(po(), props.send, props.archived, () => {
      po().todos.refetch();
      po().info.refetch();
    });
  return (
    <section class="card orgs-section" aria-labelledby="project-todos">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-todos">
          To-do{info() ? ` · ${info()!.open} open` : ""}
        </h2>
        <AddButton label="Add a to-do item" open={adding()} onClick={() => setAdding(!adding())} />
      </div>
      <Show when={po().todos.error() ?? err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={adding()}>
        <AddForm
          label="New to-do item"
          submitLabel="Add Item"
          maxlength={TODO_TEXT_MAX}
          onError={setErr}
          onClose={() => setAdding(false)}
          add={async (text) => po().todos.set(await addProjectOverseerTodo(po().projectId(), text))}
        />
      </Show>
      <Show when={open().length} fallback={<p class="orgs-empty">{info()?.done ? `${info()!.done} done. Nothing open.` : "Nothing to do yet."}</p>}>
        <ul class="project-items">
          <For each={open()}>
            {(t) => (
              <li class="project-item">
                <label class="toggle project-todo">
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={(e) => {
                      const done = e.currentTarget.checked;
                      patchProjectOverseerTodo(po().projectId(), t.id, { done }).then(
                        (next) => {
                          po().todos.set(next);
                          announce(`Done: ${t.text}`);
                        },
                        (x) => setErr(`Couldn't tick it. ${errText(x)}`),
                      );
                    }}
                  />
                  <span class="toggle-box" />
                  <span class="project-item-title">{t.text}</span>
                </label>
                <ItemActions {...cb()} item={{ todoId: t.id, title: t.text, sessionId: t.sessionId }} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

function ItemActions(props: ItemCallbacks & { item: Item }) {
  const [sending, setSending] = createSignal(false);
  const [working, setWorking] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const ref = () => (props.item.ideaId ? { ideaId: props.item.ideaId } : { todoId: props.item.todoId });
  const code = async () => {
    if (working()) return;
    setWorking(true);
    try {
      const r = await props.code(ref());
      props.after();
      // Started but not prompted: it stays on this page, with the item's Open Its Session, to send the message by hand.
      if (r.notPrompted) {
        setErr(`${r.notPrompted} Open it and send the message yourself.`);
        return;
      }
      setErr(null);
      toast(r.worktree ? `Coding session started on ${r.worktree.branch}.` : "Coding session started in the project root.");
      location.hash = sessionHref(r.path);
    } catch (x) {
      setErr(unchangedError(errText(x), "No session was started."));
    } finally {
      setWorking(false);
    }
  };
  return (
    <>
      <div class="button-row project-item-actions">
        {/* The item's own link to what was done with it: the operator's sessions are not in `started`. */}
        <Show when={props.item.sessionId}>
          {(id) => (
            <a class="button button-sm button-ghost" href={`#/sid/${encodeURIComponent(id())}`}>
              <Icon name="chat" small /> Open Its Session
            </a>
          )}
        </Show>
        <Show when={props.send}>
          <button
            type="button"
            class="button button-sm button-ghost"
            aria-expanded={sending()}
            aria-disabled={props.archived ? "true" : undefined}
            title={props.archived ? "Archived" : undefined}
            onClick={() => !props.archived && setSending(!sending())}
          >
            Send to Person…
          </button>
        </Show>
        <button
          type="button"
          class="button button-sm button-ghost"
          aria-disabled={working() || props.archived ? "true" : undefined}
          title={props.archived ? "Archived" : undefined}
          onClick={() => !props.archived && void code()}
        >
          <Icon name="terminal" small /> Start Coding Session
        </button>
      </div>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={sending() && props.send}>
        {(send) =>
          send()({
            item: ref(),
            close: () => setSending(false),
            sent: (r) => {
              setSending(false);
              props.onLinks(r.links);
              props.after();
            },
          })
        }
      </Show>
    </>
  );
}
