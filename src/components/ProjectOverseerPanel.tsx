import { createEffect, createMemo, createResource, createSignal, For, type JSX, on, Show } from "solid-js";
import { TODO_TEXT_MAX, type IdeaRecord, type OverseerAction, type OverseerTodosInfo } from "../../shared/protocol";
import {
  ALLOWANCE_MAX,
  AT_ONCE_MAX,
  capProblem,
  DEFAULT_PO_CAPS,
  DEFAULT_SOON_LOOK_SEC,
  DEFAULT_WATCH_GAP_MIN,
  GAP_CHOICES,
  isAtOnce,
  SOON_CHOICES,
  type ProjectOverseerCaps,
} from "../../shared/project-overseer";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING, type Autonomy, type CodingStartResult, type ItemCodeInput, type ItemCodeResult, type ItemSendInput, type ItemSendResult, type CodingWorktree, type ProjectOverseerInfo, type ProjectOverseerPatch } from "../../shared/project-overseer";
import type { OrgDetail } from "../../shared/orgs";
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
  sendProjectItem,
  startProjectCoding,
} from "../lib/api";
import { CODING_MODE_KEYS, codingModeKey, codingModeLabel, codingModeOf, folderNote, mergeGate, mergeNote, modeWords, offersMerge, offersRemove, removeGate, startedBy, worktreeOrder, type CodingModeKey } from "../lib/coding-worktrees";
import { relativeTime, tildePath } from "../lib/format";
import { hostLabel, orgHostOf } from "../lib/mesh";
import { unchangedError } from "../lib/unchanged-error";
import { createPoll } from "../lib/poll";
import { actionLine, allowanceLine, gapArea, gapWords, isGap, IDEA_TITLE_MAX, itemSendInput, lastRunTail, limitsProblem, openIdeas, operatorIdeaId, pendingLine, soonWords, STARTED_KIND, waitingLines, watchHint } from "../lib/project-overseer-view";
import { adoptSession, announce, home, toast } from "../lib/ui-state";
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
 * The project overseer on its project's page (§app/project-overseer): how far it may act on its
 * own, what it started and did, and its ideas (gaps first) and to-do items, each of which can go
 * to a person as a gathering session or become a coding session. Its conversation is the ordinary
 * chat page — tool cards there are the live view — so this panel links to it rather than host it.
 */
export function ProjectOverseerPanel(props: {
  org: OrgDetail;
  projectId: string;
  /** Whether the overseer is working now, after every read: its acts (a promotion) change the page around it. */
  onBusy?(busy: boolean): void;
}) {
  const o = () => props.org.id;
  const p = () => props.projectId;
  /** The peer the org is attached on (null: this host): its models, and the host its words name. */
  const host = () => orgHostOf(o());
  const info = createPoll(() => getProjectOverseer(o(), p()), POLL_MS);
  const actions = createPoll(() => projectOverseerActions(o(), p(), 30), POLL_MS);
  const ideas = createPoll(() => projectOverseerIdeas(o(), p()), POLL_MS * 3);
  const todos = createPoll(() => projectOverseerTodos(o(), p()), POLL_MS * 3);
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

  const openChat = () =>
    void run(async () => {
      const next = await openProjectOverseer(o(), p());
      if (next.path) location.hash = sessionHref(next.path);
      return next;
    });

  const setAutonomy = (autonomy: Autonomy) => void run(() => patchProjectOverseer(o(), p(), { autonomy }), `Autonomy: ${autonomy}.`);

  return (
    <section class="card orgs-section" aria-labelledby="project-overseer">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-overseer">
          Overseer
        </h2>
        <Show when={info.data()?.busy}>
          <Chip tone="accent" live>
            Working
          </Chip>
        </Show>
        <button type="button" class="button button-sm button-ghost" aria-disabled={busy() || info.data()?.busy ? "true" : undefined} title="Look at the project now, as the watch loop would." onClick={() => void run(() => runProjectOverseer(o(), p()), "The overseer is looking now.")}>
          Run Now
        </button>
        <button type="button" class="button button-sm" aria-disabled={busy() ? "true" : undefined} onClick={openChat}>
          <Icon name="eye" small />
          {info.data()?.exists ? "Open Overseer" : "Start Overseer"}
          <Show when={info.data()?.unread}>{(n) => <span class="chip chip-count">{n()}</span>}</Show>
        </button>
      </div>
      <Show when={error() ?? (info.data() ? null : info.error())}>{(e) => <Banner tone="error" title="The overseer didn't answer." body={e()} />}</Show>
      <Show when={links()}>{(l) => <LinksBanner links={l()} onDismiss={() => setLinks(null)} />}</Show>
      <Show when={info.data()} fallback={<Show when={info.pending()}><p class="orgs-empty">Reading the overseer.</p></Show>}>
        {(i) => (
          <>
            <StatusLine info={i()} />
            {/* Attached on the org's host from a clone (a restore or a move): nothing runs on its own until the operator says so there. */}
            <Show when={i().paused}>
              {(since) => (
                <Banner
                  tone="warn"
                  title={`Paused at L0 on ${host() ? hostLabel(host()!) : "this host"}`}
                  body={`This organization was attached ${host() ? `on ${hostLabel(host()!)}` : "here"} ${relativeTime(since())}. Until you set its level, the overseer only proposes and its watch loop waits.`}
                  action={
                    <button type="button" class="button button-sm" aria-disabled={busy() ? "true" : undefined} onClick={() => setAutonomy(i().settings.autonomy)}>
                      Resume at {i().settings.autonomy}
                    </button>
                  }
                />
              )}
            </Show>
            <AutonomyPicker info={i()} busy={busy()} onPick={setAutonomy} />
            <div class="project-overseer-settings">
              <label class="toggle toggle-switch">
                <span>Watch this project</span>
                <input
                  type="checkbox"
                  checked={i().settings.watch}
                  aria-describedby="project-watch-hint"
                  onChange={(e) => void run(() => patchProjectOverseer(o(), p(), { watch: e.currentTarget.checked }), e.currentTarget.checked ? "Watching." : "Not watching.")}
                />
                <span class="toggle-box" />
              </label>
              <p class="field-hint" id="project-watch-hint">
                {watchHint(i().settings.watchGapMin, i().settings.soonLookSec)}
              </p>
              <SessionModel
                info={i()}
                host={host()}
                kind="gathering"
                label="Gathering sessions"
                save={async (patch) => info.set(await patchProjectOverseer(o(), p(), patch))}
              />
              <SessionModel info={i()} host={host()} kind="coding" label="Coding sessions" save={async (patch) => info.set(await patchProjectOverseer(o(), p(), patch))}>
                <CodingMode info={i()} onSave={(key) => run(() => patchProjectOverseer(o(), p(), { codingMode: codingModeOf(key) }), key === "auto" ? "Coding sessions' mode: Automatic." : `Coding sessions run ${codingModeLabel(key)}.`)} />
              </SessionModel>
            </div>
            <Limits info={i()} host={host()} save={(patch) => run(() => patchProjectOverseer(o(), p(), patch), "Limits saved.")} />
            <Started info={i()} />
            <CodingSessions
              info={i()}
              start={() => startProjectCoding(o(), p())}
              merge={(w) => mergeCodingWorktree(o(), p(), w.sessionId)}
              remove={(w) => removeCodingWorktree(o(), p(), w.sessionId)}
              onInfo={info.set}
              onStarted={() => info.refetch()}
            />
          </>
        )}
      </Show>
      <Show when={info.data()}>
      <Activity actions={actions.data()} error={actions.error()} />
      <Ideas
        org={props.org}
        ideas={ideas.data() ? openIdeas(ideas.data()!.ideas) : undefined}
        error={ideas.error()}
        add={async (title) => {
          // Fresh ids: the poll may lag another tab's or the overseer's latest idea.
          const taken = new Set((await projectOverseerIdeas(o(), p())).ideas.map((i) => i.id));
          ideas.set(await addProjectOverseerIdea(o(), p(), { id: operatorIdeaId(title, taken), title }));
        }}
        onLinks={setLinks}
        send={(input) => sendProjectItem(o(), p(), input)}
        code={(input) => codeProjectItem(o(), p(), input)}
        after={() => {
          ideas.refetch();
          info.refetch();
        }}
      />
      <Todos
        org={props.org}
        info={todos.data()}
        error={todos.error()}
        onLinks={setLinks}
        add={async (text) => todos.set(await addProjectOverseerTodo(o(), p(), text))}
        tick={async (id, done) => todos.set(await patchProjectOverseerTodo(o(), p(), id, { done }))}
        send={(input) => sendProjectItem(o(), p(), input)}
        code={(input) => codeProjectItem(o(), p(), input)}
        after={() => {
          todos.refetch();
          info.refetch();
        }}
      />
      </Show>
    </section>
  );
}

function StatusLine(props: { info: ProjectOverseerInfo }) {
  const i = () => props.info;
  const u = () => i().usage;
  return (
    <>
      <p class="orgs-line">
        <Show when={i().lastRun} fallback="It hasn't looked on its own yet.">
          {(r) => (
            <>
              Last looked on its own <time title={r().at}>{relativeTime(r().at)}</time>
              {lastRunTail(r())}.
            </>
          )}
        </Show>{" "}
        {u().unattendedToday} {u().unattendedToday === 1 ? "run" : "runs"} today.
      </p>
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

function AutonomyPicker(props: { info: ProjectOverseerInfo; busy: boolean; onPick(a: Autonomy): void }) {
  const chosen = () => props.info.settings.autonomy;
  const eff = () => props.info.effective;
  return (
    <fieldset class="project-autonomy">
      <legend class="field-label">On its own, it may</legend>
      <For each={AUTONOMY_LEVELS}>
        {(level) => (
          <label class="project-autonomy-row" classList={{ "project-autonomy-on": chosen() === level }}>
            <input type="radio" name="project-autonomy" value={level} checked={chosen() === level} disabled={props.busy} onChange={() => props.onPick(level)} />
            <span class="orgs-mono project-autonomy-level">{level}</span>
            <span class="project-autonomy-meaning">{AUTONOMY_MEANING[level]}</span>
          </label>
        )}
      </For>
      <Show when={eff().autonomy !== chosen() || props.info.paused}>
        <p class="field-hint project-autonomy-note">
          In force now: {eff().autonomy}. {eff().reason ?? ""}
        </p>
      </Show>
      <p class="field-hint">Your own messages to it can always use every tool.</p>
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

/** The Limits form's values: a limit is a number, NaN while its field is empty or not a number, or null (Unlimited). */
interface LimitsDraft {
  caps: Record<keyof ProjectOverseerCaps, number | null>;
  watchGapMin: number;
  soonLookSec: number | null;
}
const limitsOf = (s: ProjectOverseerInfo["settings"]): LimitsDraft => ({ caps: { ...s.caps }, watchGapMin: s.watchGapMin, soonLookSec: s.soonLookSec });
// A hint that names a host takes the org's host (a peer's day ends at its own midnight).
const LIMIT_GROUPS: { legend: string; hint?: string | ((host: string) => string); keys: (keyof ProjectOverseerCaps)[] }[] = [
  { legend: "Each message you send", keys: ["gatherPerTurn", "promotePerTurn", "createPerTurn", "promptsPerTurn"] },
  { legend: "On its own, each day", hint: (host) => `Resets at midnight on ${host}.`, keys: ["gatherPerDay", "promotePerDay", "createPerDay", "promptsPerDay", "unattendedPerDay"] },
  { legend: "At once", hint: "These never go Unlimited: they are what stops a burst.", keys: ["gatheringsOpen", "codingRunning"] },
];
/** A field's own label (its group's legend says which allowance). */
const FIELD_LABEL: Record<keyof ProjectOverseerCaps, string> = {
  gatherPerTurn: "Gathering sessions started",
  promotePerTurn: "Decisions promoted",
  createPerTurn: "Coding sessions started",
  promptsPerTurn: "Prompts to coding sessions",
  gatherPerDay: "Gathering sessions started",
  promotePerDay: "Decisions promoted",
  createPerDay: "Coding sessions started",
  promptsPerDay: "Prompts to coding sessions",
  unattendedPerDay: "Looks",
  gatheringsOpen: "Gathering sessions open",
  codingRunning: "Coding sessions running",
};
const numberOf = (v: string): number => (v.trim() === "" ? Number.NaN : Number(v));

/**
 * The project's limits (§app.project-overseer/limits): each message's allowance, the day's on its
 * own, at once, and the pace. One form, one PATCH. Unlimited is a checkbox
 * beside the field, never a blank field; the at-once limits have none.
 */
function Limits(props: { info: ProjectOverseerInfo; host: string | null; save(patch: ProjectOverseerPatch): Promise<boolean> }) {
  const saved = createMemo(() => JSON.stringify(limitsOf(props.info.settings)));
  const [draft, setDraft] = createSignal<LimitsDraft>(limitsOf(props.info.settings));
  // A save here or elsewhere brings the form to what is saved.
  createEffect(on(saved, (json) => setDraft(JSON.parse(json) as LimitsDraft), { defer: true }));
  /** The number a field had before Unlimited was ticked, to bring back when it is unticked. */
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
    const why = limitsProblem(d);
    setProblem(why);
    if (why) return;
    await props.save({ caps: d.caps as ProjectOverseerCaps, watchGapMin: d.watchGapMin, soonLookSec: d.soonLookSec });
  };
  const gaps = createMemo(() => [...new Set([...GAP_CHOICES, draft().watchGapMin])].sort((a, b) => a - b));
  const soons = createMemo(() => {
    const cur = draft().soonLookSec;
    const nums = new Set<number>(cur === null ? [] : [cur]);
    for (const x of SOON_CHOICES) if (x !== null) nums.add(x);
    return [...[...nums].sort((a, b) => a - b), null];
  });
  return (
    <form class="project-limits" onSubmit={submit} aria-labelledby="project-limits-legend">
      <h3 class="orgs-h3" id="project-limits-legend">
        Limits
      </h3>
      <p class="field-hint project-limits-hint">Past a limit it stops and tells you. Your own coding sessions and Send to Person aren't counted.</p>
      <For each={LIMIT_GROUPS}>
        {(g) => (
          <fieldset class="project-limits-group">
            <legend class="project-limits-legend">{g.legend}</legend>
            <Show when={g.hint}>
              {(h) => {
                const hint = h();
                return <p class="field-hint project-limits-hint">{typeof hint === "string" ? hint : hint(props.host ? hostLabel(props.host) : "this host")}</p>;
              }}
            </Show>
            <div class="overseer-caps">
              <For each={g.keys}>
                {(k) => {
                  const atOnce = isAtOnce(k);
                  const v = () => draft().caps[k];
                  const id = `project-limit-${k}`;
                  return (
                    <div class="field project-limit">
                      <label class="field-label" for={id}>
                        {FIELD_LABEL[k]}
                      </label>
                      <input
                        class="input text-num"
                        id={id}
                        type="number"
                        inputmode="numeric"
                        min="0"
                        max={atOnce ? AT_ONCE_MAX[k as keyof typeof AT_ONCE_MAX] : ALLOWANCE_MAX}
                        step="1"
                        value={v() === null || Number.isNaN(v()) ? "" : String(v())}
                        disabled={v() === null}
                        placeholder={v() === null ? "Unlimited" : undefined}
                        aria-invalid={v() !== null && capProblem(k, v()) ? "true" : undefined}
                        onInput={(e) => setCap(k, numberOf(e.currentTarget.value))}
                      />
                      <Show when={!atOnce}>
                        <label class="toggle project-limit-unlimited">
                          <input type="checkbox" checked={v() === null} onChange={(e) => unlimited(k, e.currentTarget.checked, v(), DEFAULT_PO_CAPS[k] ?? 0, (x) => setCap(k, x))} />
                          <span class="toggle-box" />
                          <span>Unlimited</span>
                        </label>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </fieldset>
        )}
      </For>
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
            setDraft({ caps: { ...DEFAULT_PO_CAPS }, watchGapMin: DEFAULT_WATCH_GAP_MIN, soonLookSec: DEFAULT_SOON_LOOK_SEC });
          }}
        >
          Reset Limits
        </button>
      </div>
    </form>
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
    if (starting()) return;
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
        <h3 class="orgs-h3">Coding sessions</h3>
        <button type="button" class="button button-sm" aria-disabled={starting() ? "true" : undefined} onClick={() => void start()}>
          <Icon name="terminal" small /> New Coding Session
        </button>
      </div>
      <Show when={startError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={!wt().available && wt().reason}>{(r) => <p class="orgs-line project-muted">Coding sessions run in the project root: {r()}</p>}</Show>
      <Show when={!rows().length}>
        <p class="orgs-empty">None yet. Yours and the overseer's are listed here.</p>
      </Show>
      <ul class="list">
        <For each={rows()}>
          {(row) => {
            const armed = () => confirming() === row.sessionId;
            const folder = () => (row.worktree ? tildePath(row.worktree, home()) : "");
            return (
              <li class="list-row orgs-row project-worktree">
                <span class="list-main">
                  <Show when={row.path} fallback={<span class="list-title">{row.title || UNTITLED_CODING}</span>}>
                    {(path) => (
                      <a class="list-title" href={sessionHref(path())} onClick={(e) => !row.title && openUntitled(e, row.sessionId)}>
                        {row.title || UNTITLED_CODING}
                      </a>
                    )}
                  </Show>
                  <span class="list-meta">
                    {startedBy(row)} · {row.running ? "working" : "idle"} · <time title={row.createdAt}>{relativeTime(row.createdAt)}</time>
                    <Show when={row.branch}>
                      {(b) => (
                        <>
                          {" · "}
                          <span class="orgs-mono">{b()}</span>
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
                  <div class="button-row project-worktree-actions">
                    <Show when={offersMerge(row)}>
                      <button
                        type="button"
                        class="button button-sm"
                        aria-disabled={mergeGate(row) || working() ? "true" : undefined}
                        title={mergeGate(row) ?? undefined}
                        onClick={() => !mergeGate(row) && void act(row, () => props.merge(row), `Merged ${row.branch} into ${row.target}.`)}
                      >
                        Merge Branch
                      </button>
                    </Show>
                    <Show when={offersRemove(row)}>
                      <button
                        type="button"
                        class="button button-sm button-destructive"
                        aria-disabled={removeGate(row) || working() ? "true" : undefined}
                        aria-expanded={armed()}
                        title={removeGate(row) ?? undefined}
                        onClick={() => !removeGate(row) && setConfirming(armed() ? null : row.sessionId)}
                      >
                        Remove Worktree
                      </button>
                    </Show>
                  </div>
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

function Activity(props: { actions: OverseerAction[] | undefined; error: string | null }) {
  const OUTCOME = {
    ok: { word: "Done", tone: "success" as const },
    partial: { word: "Partly", tone: "warn" as const },
    refused: { word: "Refused", tone: "warn" as const },
    error: { word: "Failed", tone: "error" as const },
  };
  return (
    <details class="orgs-history orgs-history-section" open>
      <summary>Activity{props.actions ? ` · ${props.actions.length}` : ""}</summary>
      <Show when={props.error}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={props.actions?.length} fallback={<p class="orgs-empty">Nothing yet. Every act it takes, refused or not, lists here.</p>}>
        <ul class="orgs-history-list">
          <For each={props.actions}>
            {(a) => (
              <li class="orgs-change">
                <span class="orgs-change-main">
                  {actionLine(a)}
                  <Show when={a.note}>{(n) => <span class="project-muted"> · {n()}</span>}</Show> <span class="list-meta">· <time title={a.at}>{relativeTime(a.at)}</time></span>
                </span>
                <Chip tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].word}</Chip>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </details>
  );
}

// ---- ideas and to-do items, each passable to a person or a coding session -----------------------------

interface ItemCallbacks {
  org: OrgDetail;
  onLinks(l: Links): void;
  send(input: ItemSendInput): Promise<ItemSendResult>;
  code(input: ItemCodeInput): Promise<ItemCodeResult>;
  after(): void;
}

function Ideas(props: ItemCallbacks & { ideas: IdeaRecord[] | undefined; error: string | null; add(title: string): Promise<void> }) {
  const [draft, setDraft] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);
  return (
    <details class="orgs-history orgs-history-section" open>
      <summary>Gaps and ideas{props.ideas ? ` · ${props.ideas.length}` : ""}</summary>
      <Show when={props.error ?? err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={props.ideas?.length} fallback={<p class="orgs-empty">No open ideas. Gaps it finds between the decisions and who decides them land here.</p>}>
        <ul class="project-items">
          <For each={props.ideas}>
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
                <ItemActions {...props} item={{ ideaId: idea.id, title: idea.title, sessionId: idea.sessionId }} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form
        class="orgs-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft().trim();
          if (!title) return;
          props.add(title).then(
            () => {
              setDraft("");
              setErr(null);
            },
            (x) => setErr(unchangedError(errText(x), "Nothing was added.")),
          );
        }}
      >
        <label class="field orgs-grow">
          <span class="field-label">New idea</span>
          <input class="input" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={IDEA_TITLE_MAX} />
        </label>
        <button type="submit" class="button">
          Add Idea
        </button>
      </form>
    </details>
  );
}

function Todos(
  props: ItemCallbacks & {
    info: OverseerTodosInfo | undefined;
    error: string | null;
    add(text: string): Promise<void>;
    tick(id: string, done: boolean): Promise<void>;
  },
) {
  const [draft, setDraft] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);
  const open = createMemo(() => props.info?.todos.filter((t) => !t.done) ?? []);
  return (
    <details class="orgs-history orgs-history-section" open>
      <summary>To-do items{props.info ? ` · ${props.info.open} open` : ""}</summary>
      <Show when={props.error ?? err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={open().length} fallback={<p class="orgs-empty">{props.info?.done ? `${props.info.done} done. Nothing open.` : "Nothing to do yet."}</p>}>
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
                      props.tick(t.id, done).then(
                        () => announce(`Done: ${t.text}`),
                        (x) => setErr(`Couldn't tick it. ${errText(x)}`),
                      );
                    }}
                  />
                  <span class="toggle-box" />
                  <span class="project-item-title">{t.text}</span>
                </label>
                <ItemActions {...props} item={{ todoId: t.id, title: t.text, sessionId: t.sessionId }} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form
        class="orgs-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft().trim();
          if (!text) return;
          props.add(text).then(
            () => {
              setDraft("");
              setErr(null);
            },
            (x) => setErr(unchangedError(errText(x), "Nothing was added.")),
          );
        }}
      >
        <label class="field orgs-grow">
          <span class="field-label">New to-do item</span>
          <input class="input" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={TODO_TEXT_MAX} />
        </label>
        <button type="submit" class="button">
          Add Item
        </button>
      </form>
    </details>
  );
}

function ItemActions(props: ItemCallbacks & { item: Item }) {
  const [sending, setSending] = createSignal(false);
  const [working, setWorking] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const active = () => props.org.roster.filter((x) => x.status === "active");
  const [to, setTo] = createSignal<string[]>([]);
  // Empty on purpose: the item's title is the overseer's own wording, never for outsiders (itemSendInput).
  const [title, setTitle] = createSignal("");
  const [question, setQuestion] = createSignal("");
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
  const send = async (e: Event) => {
    e.preventDefault();
    const input = itemSendInput(ref(), { to: to(), publicTitle: title(), question: question() });
    if (working() || !input) return;
    setWorking(true);
    try {
      const r = await props.send(input);
      setErr(null);
      setSending(false);
      setTo([]);
      props.onLinks(r.links);
      toast(r.links.length > 1 ? `Offered to ${r.links.length} people.` : "Hand-off session started.");
      props.after();
    } catch (x) {
      setErr(unchangedError(errText(x), "Nothing was sent."));
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
        <button type="button" class="button button-sm button-ghost" aria-expanded={sending()} onClick={() => setSending(!sending())}>
          Send to Person…
        </button>
        <button type="button" class="button button-sm button-ghost" aria-disabled={working() ? "true" : undefined} onClick={() => void code()}>
          <Icon name="terminal" small /> Start Coding Session
        </button>
      </div>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={sending()}>
        <form class="orgs-form orgs-subform" onSubmit={send}>
          <fieldset class="project-people">
            <legend class="field-label">Send to</legend>
            <Show when={active().length} fallback={<p class="orgs-empty">Nobody active on the roster yet.</p>}>
              <For each={active()}>
                {(person) => (
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={to().includes(person.id)}
                      onChange={(e) => setTo((cur) => (e.currentTarget.checked ? [...cur, person.id] : cur.filter((x) => x !== person.id)))}
                    />
                    <span class="toggle-box" />
                    <span>{`${person.name}${person.role ? ` — ${person.role}` : ""}`}</span>
                  </label>
                )}
              </For>
            </Show>
            <p class="field-hint">Pick 2 or more to offer it: the first to answer takes it.</p>
          </fieldset>
          <label class="field">
            <span class="field-label">Public title</span>
            <input class="input" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} maxlength={120} required placeholder="What the person sees as the title" />
            <span class="field-hint">All they see of the goal. The item's own words stay private: they go to the model as the goal.</span>
          </label>
          <label class="field">
            <span class="field-label">First question</span>
            <input class="input" value={question()} onInput={(e) => setQuestion(e.currentTarget.value)} maxlength={1000} required placeholder="What you ask them, in your words" />
            <span class="field-hint">They see it at the top of their page.</span>
          </label>
          <div class="button-row">
            <button type="submit" class="button button-primary" aria-disabled={!to().length || !title().trim() || !question().trim() || working() ? "true" : undefined}>
              {to().length > 1 ? `Offer to ${to().length}` : "Start Session"}
            </button>
            <button type="button" class="button button-ghost" onClick={() => setSending(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Show>
    </>
  );
}
