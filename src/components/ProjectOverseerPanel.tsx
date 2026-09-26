import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import type { IdeaRecord, OverseerAction, OverseerTodosInfo } from "../../shared/protocol";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING, type Autonomy, type ItemCodeInput, type ItemCodeResult, type ItemSendInput, type ItemSendResult, type ProjectOverseerInfo, type ProjectOverseerPatch } from "../../shared/project-overseer";
import type { OrgDetail } from "../../shared/orgs";
import {
  addProjectOverseerTodo,
  ApiError,
  codeProjectItem,
  getProjectOverseer,
  listModels,
  openProjectOverseer,
  patchProjectOverseer,
  patchProjectOverseerTodo,
  projectOverseerActions,
  projectOverseerIdeas,
  projectOverseerTodos,
  runProjectOverseer,
  sendProjectItem,
} from "../lib/api";
import { relativeTime } from "../lib/format";
import { unchangedError } from "../lib/unchanged-error";
import { createPoll } from "../lib/poll";
import { actionLine, gapArea, isGap, itemSendInput, lastRunTail, openIdeas, STARTED_KIND, tokens } from "../lib/project-overseer-view";
import { announce, toast } from "../lib/ui-state";
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
          <Icon name="chat" small />
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
                After a new decision, a finished session or a conflict, it looks on its own at most once every 10 minutes.
              </p>
              <SessionModel
                info={i()}
                kind="gathering"
                label="Gathering sessions"
                onSave={(patch, done) => void run(() => patchProjectOverseer(o(), p(), patch), done)}
              />
              <SessionModel info={i()} kind="coding" label="Coding sessions" onSave={(patch, done) => void run(() => patchProjectOverseer(o(), p(), patch), done)} />
              <TokenBudget info={i()} onSave={(n) => void run(() => patchProjectOverseer(o(), p(), { tokenBudget: n }), "Budget saved.")} />
            </div>
            <Started info={i()} />
          </>
        )}
      </Show>
      <Show when={info.data()}>
      <Activity actions={actions.data()} error={actions.error()} />
      <Ideas
        org={props.org}
        ideas={ideas.data() ? openIdeas(ideas.data()!.ideas) : undefined}
        error={ideas.error()}
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
        <p class="orgs-line project-muted">Waiting to look at: {u().pending.join(", ")}.</p>
      </Show>
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
      <Show when={eff().autonomy !== chosen()}>
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
 * talks to) or coding (L3). Empty = the overseer's own (null in the settings).
 */
function SessionModel(props: { info: ProjectOverseerInfo; kind: "gathering" | "coding"; label: string; onSave(patch: ProjectOverseerPatch, done: string): void }) {
  const [models] = createResource(() => listModels());
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
          onChange={(e) => {
            const v = e.currentTarget.value;
            const patch: ProjectOverseerPatch = v === SAME ? { [modelKey()]: null, [thinkingKey()]: null } : { [modelKey()]: v };
            props.onSave(patch, v === SAME ? `${noun()} use the overseer's model.` : `${noun()} use ${v}.`);
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
            props.onSave({ [thinkingKey()]: v === SAME ? null : v }, v === SAME ? `${noun()}: thinking same as the overseer.` : `${noun()}: thinking ${v}.`);
          }}
        >
          <option value={SAME} selected={!thinking()}>
            Same as the overseer
          </option>
          <For each={levels()}>{(l) => <option value={l} selected={l === thinking()}>{l}</option>}</For>
        </select>
      </label>
    </div>
  );
}

function TokenBudget(props: { info: ProjectOverseerInfo; onSave(n: number): void }) {
  const [value, setValue] = createSignal(String(props.info.settings.tokenBudget));
  const u = () => props.info.usage;
  return (
    <div>
      <form
        class="orgs-inline"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Math.round(Number(value()));
          if (Number.isFinite(n) && n >= 0) props.onSave(n);
        }}
      >
        <label class="field">
          <span class="field-label">Coding token budget</span>
          <input class="input input-mono" inputmode="numeric" value={value()} onInput={(e) => setValue(e.currentTarget.value)} aria-describedby="project-budget-hint" />
        </label>
        <button type="submit" class="button">
          Save Budget
        </button>
      </form>
      <p class="field-hint orgs-inline-hint" id="project-budget-hint">
        Spent {tokens(u().codingTokens)} of {tokens(u().tokenBudget)}. At L3 it starts no coding session beyond it.
      </p>
    </div>
  );
}

function Started(props: { info: ProjectOverseerInfo }) {
  return (
    <Show when={props.info.started.length}>
      <h3 class="orgs-h3">Sessions it started</h3>
      <ul class="list">
        <For each={props.info.started}>
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

function Activity(props: { actions: OverseerAction[] | undefined; error: string | null }) {
  const OUTCOME = { ok: { word: "Done", tone: "success" as const }, refused: { word: "Refused", tone: "warn" as const }, error: { word: "Failed", tone: "error" as const } };
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
                  {actionLine(a)} <span class="list-meta">· <time title={a.at}>{relativeTime(a.at)}</time></span>
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

function Ideas(props: ItemCallbacks & { ideas: IdeaRecord[] | undefined; error: string | null }) {
  return (
    <details class="orgs-history orgs-history-section" open>
      <summary>Gaps and ideas{props.ideas ? ` · ${props.ideas.length}` : ""}</summary>
      <Show when={props.error}>{(e) => <p class="field-error">{e()}</p>}</Show>
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
          <input class="input" value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} maxlength={300} />
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
      setErr(null);
      toast("Coding session started.");
      props.after();
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
