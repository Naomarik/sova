import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import type { UsageTime, UsageTimeProjectRow, UsageTimeSessionRow } from "../../shared/usage/time";
import { getUsageTime } from "../lib/api";
import { browserZone, COST_RANGES, dayKey, projectRowTitle } from "../lib/cost-history";
import { usd } from "../lib/costs";
import { createPoll } from "../lib/poll";
import {
  barDays,
  barHeights,
  barWords,
  headline,
  hoursWords,
  isEmptyAnswer,
  lineShare,
  messageCount,
  messageRows,
  messagesNote,
  messagesOffered,
  modelLines,
  projectChoices,
  projectKeyName,
  rowRatioWords,
  sinceWords,
  type TimeLine,
  timeApiSearch,
  timeBars,
  timeEmptyTitle,
  timeHref,
  timeProjectRows,
  type TimeQuery,
  timeSessionRows,
  toolsNote,
  whatLines,
  whoLines,
  yourLines,
} from "../lib/time-totals";
import "../projects.css";
import "../costs-tab.css";
import "../time-tab.css";
import { ActionMenu } from "./ActionMenu";
import { sessionHref } from "./Sidebar";
import { Banner, Icon } from "./ui";

/** Time moves while you and the agents work, but a minute is fresh enough, as on Costs. */
const TIME_POLL_MS = 60_000;

/** Change the filter: the address is the filter, replaced so picking adds no history entry. */
const goTo = (href: string) => {
  if (location.hash !== href) location.replace(href);
};

type Section = "you" | "agents" | "projects" | "sessions" | "messages";
const SECTIONS: readonly { id: Section; label: string }[] = [
  { id: "you", label: "Your Time" },
  { id: "messages", label: "Your Messages" },
  { id: "agents", label: "Agent Time" },
  { id: "projects", label: "By Project" },
  { id: "sessions", label: "Top Sessions" },
];
/** The section you last looked at, for this tab's life: Board → Time Spent brings it back. */
let lastSection: Section = "you";

/**
 * The Agents page's Time Spent tab: your time beside your agents' on this computer, for the range
 * and the project in the address. `tick` is the page's Refresh.
 */
export function TimeTab(props: { query: TimeQuery; sessions: SessionSummary[] | undefined; now: number; tick: number }) {
  const search = createMemo(() => timeApiSearch(props.query, browserZone()));
  const poll = createPoll(() => getUsageTime(search()), TIME_POLL_MS);
  createEffect(on([search, () => props.tick], () => poll.refetch(), { defer: true }));
  /** The answer on screen is for the filter on screen; until the new one lands, the old one is marked busy. */
  const fresh = () => {
    const a = poll.data();
    return !!a && a.range === props.query.range && (a.project ?? null) === props.query.project;
  };
  const [chosen, setChosen] = createSignal<Section>(lastSection);
  const pick = (s: Section) => {
    lastSection = s;
    setChosen(s);
  };
  /** The sections on offer: Your Messages only while message labels are on. */
  const sections = () => SECTIONS.filter((s) => s.id !== "messages" || !poll.data() || messagesOffered(poll.data()!.messages));
  /** The section shown: the one picked, or Your Time when the picked one isn't offered. */
  const section = () => (sections().some((s) => s.id === chosen()) ? chosen() : "you");

  return (
    <div class="costs time-tab" id="agents-tabpanel" role="tabpanel" aria-labelledby="agents-tab-time">
      <TimeBar query={props.query} projects={poll.data()?.projects} />
      <Show when={poll.error()}>
        {(message) => (
          <Banner
            tone="error"
            title="Couldn't load time spent."
            body={
              message() === "usage-unavailable"
                ? "The usage counter isn't running yet. Nothing was lost: your time and the agents' keep being recorded, and the figures come back when it starts."
                : `Nothing was changed. ${message()}`
            }
          />
        )}
      </Show>
      <Show
        when={poll.data()}
        fallback={
          <Show when={!poll.error()}>
            <div class="card costs-card" aria-busy="true">
              <span class="skeleton skeleton-title" />
              <span class="skeleton skeleton-line" />
              <span class="skeleton skeleton-line" />
            </div>
          </Show>
        }
      >
        {(a) => (
          <div class="costs" aria-busy={fresh() ? undefined : "true"}>
            <Show
              when={!isEmptyAnswer(a().totals)}
              fallback={
                <div class="card">
                  <div class="empty">
                    <p class="empty-title">{timeEmptyTitle(props.query)}</p>
                    <p class="empty-body">Figures appear here as you work.</p>
                  </div>
                </div>
              }
            >
              <TimeStats answer={a()} />
              <TimeChart answer={a()} query={props.query} now={props.now} />
              <div class="board-filters time-sections" role="group" aria-label="Section">
                <For each={sections()}>
                  {(s) => (
                    <button type="button" class="board-filter" aria-pressed={section() === s.id ? "true" : "false"} aria-controls="time-section" onClick={() => pick(s.id)}>
                      {s.label}
                    </button>
                  )}
                </For>
              </div>
              <div id="time-section">
                <Show when={section() === "you"}>
                  <YourTime answer={a()} />
                </Show>
                <Show when={section() === "agents"}>
                  <AgentTime answer={a()} now={props.now} />
                </Show>
                <Show when={section() === "projects"}>
                  <ProjectTable answer={a()} picked={props.query.project} />
                </Show>
                <Show when={section() === "sessions"}>
                  <TopSessions rows={a().sessions} projects={a().projects} sessions={props.sessions} />
                </Show>
                <Show when={section() === "messages"}>
                  <YourMessages answer={a()} now={props.now} />
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <footer class="costs-foot">
        <p class="cost-note">{poll.data() ? sinceWords(poll.data()!.since, props.now) : "This computer only."}</p>
      </footer>
    </div>
  );
}

/** Range chips, then the Project picker. */
function TimeBar(props: { query: TimeQuery; projects: UsageTimeProjectRow[] | undefined }) {
  const go = (q: TimeQuery) => goTo(timeHref(q));
  const choices = createMemo(() => projectChoices(props.projects, props.query.project));
  const word = () => {
    const key = props.query.project;
    return key ? (choices().find((c) => c.key === key)?.name ?? projectKeyName(key)) : "All projects";
  };
  return (
    <div class="costs-bar">
      <div class="board-filters" role="group" aria-label="Range">
        <For each={COST_RANGES}>
          {(r) => (
            <button type="button" class="board-filter" aria-pressed={props.query.range === r.id ? "true" : "false"} onClick={() => go({ ...props.query, range: r.id })}>
              <Show when={props.query.range === r.id}>
                <Icon name="check" small />
              </Show>
              {r.label}
            </button>
          )}
        </For>
      </div>
      <span class="costs-pick">
        <ActionMenu label={`Project: ${word()}`} title="Project" icon={null} text={word()} align="start" class={props.query.project ? "costs-pick-on" : undefined}>
          {(menu) => (
            <>
              <menu.Item label="All projects" aria="All projects" checked={!props.query.project} onRun={() => go({ ...props.query, project: null })} />
              <Show when={choices().length} fallback={<p class="costs-pick-empty">Nothing recorded in this range.</p>}>
                <For each={choices().map((c) => c.key)}>
                  {(key) => (
                    <menu.Item
                      label={choices().find((c) => c.key === key)?.name ?? projectKeyName(key)}
                      aria={`Project ${choices().find((c) => c.key === key)?.name ?? projectKeyName(key)}`}
                      checked={props.query.project === key}
                      onRun={() => go({ ...props.query, project: key })}
                    />
                  )}
                </For>
              </Show>
            </>
          )}
        </ActionMenu>
      </span>
    </div>
  );
}

/** You, Agents, Agent Hours Per Your Hour, While You Were Away. */
function TimeStats(props: { answer: UsageTime }) {
  const stats = () => headline(props.answer.totals, props.answer.agents.who);
  return (
    <dl class="costs-stats">
      <For each={stats()}>
        {(s) => (
          <div class="card costs-stat" title={s.title} data-time-stat={s.key}>
            <dt class="text-eyebrow">{s.label}</dt>
            <dd class="cost-figure">{s.value}</dd>
            <dd class="costs-stat-cache">{s.note}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

/** A bar per day (per week over a long range): agent hours, your hours drawn inside. */
function TimeChart(props: { answer: UsageTime; query: TimeQuery; now: number }) {
  const bars = createMemo(() => timeBars(props.answer.days, props.query.range, props.answer.to || dayKey(new Date(props.now))));
  const weeks = () => bars().some((b) => b.from !== b.to);
  const max = () => Math.max(0, ...bars().map((b) => Math.max(b.agents, b.you)));
  const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
  /** The bar under the pointer or focus, by its first day: its words replace the head's highest. */
  const [active, setActive] = createSignal<string | null>(null);
  const activeBar = () => bars().find((b) => b.from === active());
  return (
    <section class="card costs-card" aria-labelledby="time-chart">
      <div class="costs-chart-head">
        <h2 class="costs-h2" id="time-chart">
          {weeks() ? "Hours per week" : "Hours per day"}
        </h2>
        <span class="cost-note time-legend">
          <span class="time-key time-key-you" aria-hidden="true" />
          You
          <span class="time-key time-key-agents" aria-hidden="true" />
          Agents
        </span>
      </div>
      <p class="cost-note time-chart-read" aria-hidden="true">
        <Show when={activeBar()} fallback={<>Highest <span class="cost-figure">{hoursWords(max())}</span></>}>
          {(b) => <span class="cost-figure">{barWords(b(), props.now)}</span>}
        </Show>
      </p>
      <ol class="costs-chart time-chart" style={{ "--bars": String(bars().length) }}>
        <For each={bars()}>
          {(b) => {
            const h = () => barHeights(b, bars());
            return (
              <li
                class="costs-bar-slot time-bar-slot"
                tabindex="0"
                aria-label={barWords(b, props.now)}
                data-time-day={b.from}
                onMouseEnter={() => setActive(b.from)}
                onMouseLeave={() => setActive((a) => (a === b.from ? null : a))}
                onFocus={() => setActive(b.from)}
                onBlur={() => setActive((a) => (a === b.from ? null : a))}
              >
                <span class="time-bar-agents" style={{ height: pct(h().agents) }} />
                <span class="time-bar-you" style={{ height: pct(h().you) }} />
              </li>
            );
          }}
        </For>
      </ol>
      <div class="costs-chart-axis cost-note" aria-hidden="true">
        <span>{barDays({ from: bars()[0]!.from, to: bars()[0]!.from }, props.now)}</span>
        <span>{barDays({ from: bars().at(-1)!.to, to: bars().at(-1)!.to }, props.now)}</span>
      </div>
    </section>
  );
}

/** A section card: its title and what it holds. */
function SectionCard(props: { id: string; title: string; note?: string | null; children: JSX.Element }) {
  return (
    <section class="card costs-card" aria-labelledby={props.id}>
      <h2 class="costs-h2" id={props.id}>
        {props.title}
      </h2>
      {props.children}
      <Show when={props.note}>
        <p class="cost-note">{props.note}</p>
      </Show>
    </section>
  );
}

/** Rows of label · bar · hours, each bar against the list's longest; a row with parts opens to them. */
function Lines(props: { lines: TimeLine[]; label: string; count?: (line: TimeLine) => string | null; countTitle?: (line: TimeLine) => string }) {
  return (
    <ul class="time-lines" aria-label={props.label}>
      <For each={props.lines}>{(line) => <LineRow line={line} lines={props.lines} count={props.count} countTitle={props.countTitle} />}</For>
    </ul>
  );
}

function LineRow(props: { line: TimeLine; lines: TimeLine[]; count?: (line: TimeLine) => string | null; countTitle?: (line: TimeLine) => string }) {
  const [open, setOpen] = createSignal(false);
  const id = `time-parts-${props.line.key}`;
  const bar = (share: number) => (
    <span class="time-line-track" aria-hidden="true">
      <span class="time-line-fill" style={{ width: `${Math.round(share * 1000) / 10}%` }} />
    </span>
  );
  const count = () => props.count?.(props.line) ?? null;
  return (
    <li class="time-line-item" data-time-line={props.line.key} data-seconds={Math.round(props.line.seconds)}>
      <div class="time-line">
        <Show when={props.line.parts?.length} fallback={<span class="time-line-label">{props.line.label}</span>}>
          <button type="button" class="time-line-open" aria-expanded={open() ? "true" : "false"} aria-controls={id} onClick={() => setOpen(!open())}>
            <Icon name="chevron-right" small />
            <span>{props.line.label}</span>
          </button>
        </Show>
        {bar(lineShare(props.line, props.lines))}
        <span class="time-line-figure">
          <Show when={count()}>
            <span class="time-line-count" title={props.countTitle?.(props.line)} aria-label={props.countTitle?.(props.line)}>
              {count()}
            </span>
          </Show>
          <span class="cost-figure">{hoursWords(props.line.seconds)}</span>
        </span>
      </div>
      <Show when={props.line.parts?.length}>
        <ul class="time-lines time-parts" id={id} hidden={!open()} aria-label={`${props.line.label} by where`}>
          <For each={props.line.parts}>
            {(p) => (
              <li class="time-line-item" data-time-line={p.key} data-seconds={Math.round(p.seconds)}>
                <div class="time-line">
                  <span class="time-line-label">{p.label}</span>
                  {bar(lineShare(p, props.line.parts!))}
                  <span class="time-line-figure">
                    <span class="cost-figure">{hoursWords(p.seconds)}</span>
                  </span>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}

function YourTime(props: { answer: UsageTime }) {
  const lines = createMemo(() => yourLines(props.answer.you));
  return (
    <SectionCard id="time-you" title="Your Time">
      <Show when={lines().length} fallback={<p class="cost-note">None of your time was recorded in this range.</p>}>
        <Lines lines={lines()} label="Your Time" />
      </Show>
    </SectionCard>
  );
}

function AgentTime(props: { answer: UsageTime; now: number }) {
  const who = createMemo(() => whoLines(props.answer.agents.who));
  const what = createMemo(() => whatLines(props.answer.agents.what));
  const models = createMemo(() => modelLines(props.answer.agents.models));
  return (
    <SectionCard id="time-agents" title="Agent Time" note={toolsNote(props.answer.since, props.answer.from, props.now)}>
      <Show when={who().length} fallback={<p class="cost-note">No agent time in this range.</p>}>
        <h3 class="time-h3 text-eyebrow">Who Worked</h3>
        <Lines lines={who()} label="Who Worked" />
        <h3 class="time-h3 text-eyebrow">On What</h3>
        <Lines lines={what()} label="On What" />
        <Show when={models().length}>
          <h3 class="time-h3 text-eyebrow">By Model</h3>
          <Lines lines={models()} label="By Model" />
        </Show>
      </Show>
      <div class="time-apart" data-time-line="worker-wait" data-seconds={Math.round(props.answer.totals.workerWait)}>
        <span>
          Waiting On Workers
          <span class="cost-session-meta">Not in Agents.</span>
        </span>
        <span class="cost-figure">{hoursWords(props.answer.totals.workerWait)}</span>
      </div>
    </SectionCard>
  );
}

const Num = (props: { label: string; children: JSX.Element; title?: string }) => (
  <td align="right" data-label={props.label} title={props.title}>
    {props.children}
  </td>
);

function ProjectTable(props: { answer: UsageTime; picked: string | null }) {
  const rows = createMemo(() => timeProjectRows(props.answer.projects, props.picked));
  return (
    <section class="card costs-card" aria-labelledby="time-projects">
      <h2 class="costs-h2" id="time-projects">
        By Project
      </h2>
      <div class="md md-table-wrap cost-table-wrap">
        <table class="cost-table cost-table-stack time-table">
          <caption class="visually-hidden">Your time, agent time, agent hours per your hour and cost by project</caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col" align="right">
                You
              </th>
              <th scope="col" align="right">
                Agents
              </th>
              <th scope="col" align="right">
                Agent Hours Per Your Hour
              </th>
              <th scope="col" align="right">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r) => (
                <tr data-time-project={r.key}>
                  <th scope="row" title={projectRowTitle({ ...r, project: r.project ?? null, cwd: r.kind === "folder" ? (r.path ?? null) : null })}>
                    {r.name}
                    <Show when={r.archived}>
                      <span class="cost-session-meta">archived</span>
                    </Show>
                  </th>
                  <Num label="You">
                    <span class="cost-figure">{hoursWords(r.you)}</span>
                  </Num>
                  <Num label="Agents">
                    <span class="cost-figure">{hoursWords(r.agents)}</span>
                  </Num>
                  <Num label="Agent Hours Per Your Hour">
                    <span class="cost-figure">{rowRatioWords(r)}</span>
                  </Num>
                  <Num label="Cost">
                    <span class="cost-figure">{usd(r.usd)}</span>
                  </Num>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Top Sessions by your time; a click opens the session (a worker's: its parent's). */
function TopSessions(props: { rows: UsageTimeSessionRow[]; projects: UsageTimeProjectRow[]; sessions: SessionSummary[] | undefined }) {
  const rows = createMemo(() => timeSessionRows(props.rows));
  const find = (sid: string | null) => (sid ? props.sessions?.find((s) => s.id === sid) : undefined);
  const target = (r: UsageTimeSessionRow) => (r.kind === "worker" && r.parent ? r.parent : r.sid);
  const href = (r: UsageTimeSessionRow) => {
    const s = find(target(r));
    return s ? sessionHref(s.path) : `#/sid/${encodeURIComponent(target(r))}`;
  };
  const name = (r: UsageTimeSessionRow) => {
    if (r.kind === "worker") {
      const parent = find(r.parent)?.title ?? (r.parent ? r.parent.slice(0, 8) : null);
      return `${r.worker ?? "Worker"}${parent ? ` in ${parent}` : ""}`;
    }
    return find(r.sid)?.title ?? (r.kind === "overseer" ? "Overseer" : r.sid.slice(0, 8));
  };
  /** Its project under its title: the By Project row it falls in. */
  const project = (r: UsageTimeSessionRow) => props.projects.find((p) => p.key === r.row)?.name ?? projectKeyName(r.row);
  return (
    <section class="card costs-card" aria-labelledby="time-top">
      <h2 class="costs-h2" id="time-top">
        Top Sessions
      </h2>
      <Show when={rows().length} fallback={<p class="cost-note">No session with your time in this range.</p>}>
        <div class="md md-table-wrap cost-table-wrap">
          <table class="cost-table cost-table-stack time-table">
            <caption class="visually-hidden">Sessions by your time, with agent time and cost</caption>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col" align="right">
                  You
                </th>
                <th scope="col" align="right">
                  Agents
                </th>
                <th scope="col" align="right">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(r) => (
                  <tr data-time-session={r.sid}>
                    <th scope="row">
                      <a href={href(r)}>{name(r)}</a>
                      <span class="cost-session-meta" title={r.cwd ?? undefined}>
                        {project(r)}
                      </span>
                    </th>
                    <Num label="You">
                      <span class="cost-figure">{hoursWords(r.you)}</span>
                    </Num>
                    <Num label="Agents">
                      <span class="cost-figure">{hoursWords(r.agents)}</span>
                    </Num>
                    <Num label="Cost">
                      <span class="cost-figure">{usd(r.usd)}</span>
                    </Num>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  );
}

function YourMessages(props: { answer: UsageTime; now: number }) {
  const lines = createMemo(() => messageRows(props.answer.messages.rows));
  const counts = createMemo(() => new Map(lines().map((l) => [l.key, l.count])));
  return (
    <SectionCard id="time-messages" title="Your Messages" note={lines().length ? messagesNote(props.answer.messages, props.answer.since, props.now) : null}>
      <Show when={lines().length} fallback={<p class="cost-note">No labelled messages in this range.</p>}>
        <Lines lines={lines()} label="Your Messages" count={(l) => String(counts().get(l.key) ?? 0)} countTitle={(l) => messageCount(counts().get(l.key) ?? 0)} />
      </Show>
    </SectionCard>
  );
}
