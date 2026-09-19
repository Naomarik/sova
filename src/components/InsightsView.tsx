import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { AgentsInsight, LiveAgentSession, SessionSummary, TeamInfo, UsageInsight, UsageProvider, UsageWindow, WorkerInfo } from "../../shared/protocol";
import { clockTime, duration, relativeTime, shortDate, shortModel, tildePath } from "../lib/format";
import {
  activeTeams,
  teamFresh,
  meterTone,
  memberStatus,
  type MemberStatus,
  pct,
  PROVIDER_NAME,
  providerChip,
  providerProblem,
  teamAnchor,
  windowLabel,
} from "../lib/insights";
import type { Poll } from "../lib/poll";
import { home } from "../lib/ui-state";
import { sessionHref } from "./Sidebar";
import { Banner, Chip, CountChip, Icon } from "./ui";

const iso = (t: number) => new Date(t).toISOString();

/** Placeholder blocks, shown only once a region has been loading for 300ms. */
function Skeletons(props: { count: number }) {
  const [show, setShow] = createSignal(false);
  const t = setTimeout(() => setShow(true), 300);
  onCleanup(() => clearTimeout(t));
  return (
    <Show when={show()}>
      <For each={Array.from({ length: props.count })}>{() => <div class="skeleton skeleton-card" />}</For>
    </Show>
  );
}

function Meter(props: { w: UsageWindow; now: number }) {
  const tone = () => meterTone(props.w);
  const resetAt = () => (props.w.resetsAt ? Date.parse(props.w.resetsAt) : NaN);
  /** The window already reset: the reading describes a window that's gone. */
  const past = () => resetAt() <= props.now;
  const reset = () => {
    const at = resetAt();
    if (Number.isNaN(at)) return null;
    if (past()) return { lead: "Reset at ", time: clockTime(props.w.resetsAt!), rest: ". New reading at the next refresh." };
    const left = at - props.now;
    return { lead: left < 86_400_000 ? `Resets in ${duration(left)}` : `Resets ${shortDate(at, props.now)}` };
  };
  return (
    <div class="meter" classList={{ "meter-ghost": past() }}>
      <p class="meter-head">
        <span class="meter-label">{windowLabel(props.w)}</span>
        <span class="meter-value">
          {pct(props.w)}%<span class="meter-of"> used</span>
        </span>
      </p>
      <div class="meter-track" aria-hidden="true">
        <span
          class="meter-fill"
          classList={{ "meter-fill-warn": tone() === "warn", "meter-fill-error": tone() === "error" }}
          style={{ "--meter-pct": `${Math.min(100, Math.max(0, props.w.pct))}%` }}
        />
      </div>
      <Show when={reset()}>
        {(r) => (
          <p class="meter-context" title={props.w.resetsAt}>
            {r().lead}
            <Show when={r().time}>
              <span class="text-mono">{r().time}</span>
              {r().rest}
            </Show>
          </p>
        )}
      </Show>
    </div>
  );
}

function UsageCard(props: { p: UsageProvider; now: number }) {
  const problem = () => providerProblem(props.p);
  return (
    <article class="card usage-card" aria-labelledby={`u-${props.p.id}`}>
      <header class="card-head">
        <h3 class="card-title" id={`u-${props.p.id}`}>
          {PROVIDER_NAME[props.p.id]}
        </h3>
        <Show when={providerChip(props.p)}>{(c) => <Chip tone={c().tone}>{c().text}</Chip>}</Show>
      </header>
      <div class="card-body">
        <Show when={problem()} fallback={<For each={props.p.windows}>{(w) => <Meter w={w} now={props.now} />}</For>}>
          {(pr) => (
            <p class="usage-note">
              {pr().lead}
              <Show when={pr().code}>
                <code>{pr().code}</code>
              </Show>
              {pr().rest}
            </p>
          )}
        </Show>
        <Show when={props.p.error && props.p.windows.length > 0}>
          <p class="usage-note">Last fetch failed: {props.p.error!.replace(/\.$/, "")}. Showing the previous reading.</p>
        </Show>
      </div>
    </article>
  );
}

function UsageSection(props: { usage: Poll<UsageInsight>; now: number }) {
  const u = () => props.usage.data();
  const age = () => props.now - (u()?.fetchedAt ?? props.now);
  return (
    <section class="insights-section" aria-labelledby="ins-usage" aria-busy={!u() && props.usage.pending() ? "true" : undefined}>
      <h2 class="insights-section-head" id="ins-usage">
        <Icon name="gauge" small />
        Usage
      </h2>
      <Switch>
        <Match when={!u() && props.usage.pending()}>
          <div class="insights-grid">
            <Skeletons count={3} />
          </div>
        </Match>
        <Match when={u()?.available === false && u()?.reason === "corrupt"}>
          <Banner
            tone="error"
            title="Couldn't read usage."
            body={
              <>
                <code>usage-status.json</code> isn't valid JSON right now. Nothing was changed. It's rewritten at the next refresh.
              </>
            }
            action={
              <button type="button" class="button button-sm" onClick={() => props.usage.refetch()}>
                Retry
              </button>
            }
          />
        </Match>
        <Match when={u()?.available === false}>
          <div class="card">
            <div class="empty">
              <Icon name="gauge" class="empty-mark" />
              <p class="empty-title">No usage data yet.</p>
              <p class="empty-body">
                The usage-status extension writes <code>~/.pi/agent/cache/usage-status.json</code> while pi runs, and we haven't found it.
              </p>
            </div>
          </div>
        </Match>
        <Match when={u()}>
          {(data) => (
            <>
              <Show when={data().stale}>
                <Banner
                  tone="warn"
                  icon="clock"
                  title={`Usage is ${duration(age())} old.`}
                  body={
                    <>
                      It refreshes while pi runs in a terminal. Open a pi session, or run <code>/usage-refresh</code> in one.
                    </>
                  }
                />
              </Show>
              <div class="insights-grid">
                <For each={data().providers}>{(p) => <UsageCard p={p} now={props.now} />}</For>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </section>
  );
}

/** One worker: role or name, ids in mono, status chip on the right. Not a target. */
function MemberRow(props: {
  title: string;
  orchestrator?: boolean;
  id: string;
  model?: string | null;
  status: MemberStatus;
  /** Shown only while the worker is mid-task. */
  preview?: string;
  owns?: string[];
}) {
  return (
    <li class="list-row member-row" title={props.owns?.length ? `Owns: ${props.owns.join(", ")}` : undefined}>
      <div class="list-main">
        <p class="list-title">
          {props.title}
          <Show when={props.orchestrator}>
            <CountChip>Orchestrator</CountChip>
          </Show>
        </p>
        <p class="list-meta">
          <span class="text-mono">{props.id}</span>
          <Show when={shortModel(props.model)}>
            {(m) => (
              <>
                {" · "}
                <span class="text-mono">{m()}</span>
              </>
            )}
          </Show>
          <Show when={props.status.asOf}>
            {(t) => (
              <>
                {" · as of "}
                <span class="text-mono" title={iso(t())}>
                  {clockTime(iso(t()))}
                </span>
              </>
            )}
          </Show>
          <Show when={props.status.failed}>{" · last task failed"}</Show>
        </p>
        <Show when={props.preview}>
          <p class="member-preview" title={props.preview}>
            {props.preview}
          </p>
        </Show>
      </div>
      <Chip tone={props.status.tone} live={props.status.live}>
        {props.status.text}
      </Chip>
    </li>
  );
}

function TeamCard(props: { team: TeamInfo; fresh: boolean; now: number; parentTitle: string | null }) {
  const liveSource = () => props.team.live && props.fresh;
  // Orchestrator first, then roster order.
  const members = () => [...props.team.members].sort((a, b) => Number(b.orchestrator) - Number(a.orchestrator));
  return (
    <article class="card team-card" id={teamAnchor(props.team.id)} aria-labelledby={`tt-${props.team.id}`} tabindex="-1">
      <header class="card-head">
        <h3 class="card-title" id={`tt-${props.team.id}`}>
          {props.team.name}
        </h3>
        <span class="text-mono text-caption">{props.team.id}</span>
      </header>
      <Show when={props.team.objective}>
        <div class="card-body">
          <p class="team-objective" title={props.team.objective}>
            {props.team.objective}
          </p>
        </div>
      </Show>
      <ul class="list member-list">
        <For each={members()}>
          {(m) => (
            <MemberRow
              title={m.role}
              orchestrator={m.orchestrator}
              id={m.workerId}
              model={m.worker?.model ?? m.model}
              status={memberStatus(m, liveSource())}
              preview={m.worker?.working ? m.worker.preview : undefined}
              owns={m.ownedPaths}
            />
          )}
        </For>
      </ul>
      <footer class="card-foot">
        <p class="text-caption">
          Started {relativeTime(iso(props.team.createdAt), props.now)} in{" "}
          <a href={sessionHref(props.team.parentPath)} title={props.parentTitle ?? undefined}>
            {props.parentTitle ?? "its parent session"}
          </a>
        </p>
      </footer>
    </article>
  );
}

/** Workers of one live pi that aren't in a team. */
function AgentCard(props: { s: LiveAgentSession; workers: WorkerInfo[]; title: string | null }) {
  const working = () => props.workers.filter((w) => w.working).length;
  return (
    <article class="card agent-card">
      <header class="card-head">
        <h3 class="card-title">
          <Show when={props.s.path} fallback={<span class="text-mono">{tildePath(props.s.cwd, home())}</span>}>
            {(p) => <a href={sessionHref(p())}>{props.title ?? props.s.name ?? tildePath(props.s.cwd, home())}</a>}
          </Show>
        </h3>
        <Show when={working() > 0}>
          <CountChip>{working()} working</CountChip>
        </Show>
      </header>
      <ul class="list member-list">
        <For each={props.workers}>
          {(w) => (
            <MemberRow
              title={w.name}
              id={w.id}
              model={w.model}
              status={memberStatus(
                { workerId: w.id, role: w.name, orchestrator: false, backend: w.backend ?? "", ownedPaths: [], addedAt: 0, worker: w },
                props.s.fresh,
              )}
              preview={w.working ? w.preview : undefined}
            />
          )}
        </For>
      </ul>
    </article>
  );
}

function AgentsSections(props: { agents: Poll<AgentsInsight>; now: number; titleOf(path: string | null): string | null }) {
  const a = () => props.agents.data();
  const teams = () => activeTeams(a());
  const liveSessions = () => (a()?.sessions ?? []).filter((s) => s.mode !== "rpc");
  const solo = () =>
    liveSessions()
      .map((s) => ({ s, workers: s.workers.filter((w) => !w.teamId) }))
      .filter((x) => x.workers.length > 0);
  const soloWorking = () => solo().reduce((n, x) => n + x.workers.filter((w) => w.working).length, 0);

  return (
    <>
      <section class="insights-section" aria-labelledby="ins-teams" aria-busy={!a() && props.agents.pending() ? "true" : undefined}>
        <h2 class="insights-section-head" id="ins-teams">
          <Icon name="worker" small />
          Teams
          <Show when={teams().length > 0}>
            <span class="insights-section-count">· {teams().length} active</span>
          </Show>
        </h2>
        <Switch>
          <Match when={!a() && props.agents.pending()}>
            <div class="insights-grid">
              <Skeletons count={1} />
            </div>
          </Match>
          <Match when={a() && teams().length === 0}>
            <div class="card">
              <div class="empty">
                <Show
                  when={liveSessions().length > 0}
                  fallback={
                    <>
                      <p class="empty-title">No pi sessions running.</p>
                      <p class="empty-body">Teams show up here while the session that made them runs.</p>
                    </>
                  }
                >
                  <p class="empty-title">
                    {liveSessions().length === 1
                      ? "1 pi session running. It has no team."
                      : `${liveSessions().length} pi sessions running. None of them has a team.`}
                  </p>
                  <p class="empty-body">Teams you create in pi show up here while their session runs.</p>
                </Show>
              </div>
            </div>
          </Match>
          <Match when={teams().length > 0}>
            <div class="insights-grid">
              <For each={teams()}>
                {(t) => <TeamCard team={t} fresh={teamFresh(a(), t)} now={props.now} parentTitle={props.titleOf(t.parentPath)} />}
              </For>
            </div>
          </Match>
        </Switch>
      </section>

      <Show when={solo().length > 0}>
        <section class="insights-section" aria-labelledby="ins-agents">
          <h2 class="insights-section-head" id="ins-agents">
            <Icon name="worker" small />
            Subagents
            <Show when={soloWorking() > 0}>
              <span class="insights-section-count">· {soloWorking()} working</span>
            </Show>
          </h2>
          <div class="insights-grid">
            <For each={solo()}>{(x) => <AgentCard s={x.s} workers={x.workers} title={props.titleOf(x.s.path)} />}</For>
          </div>
        </section>
      </Show>
    </>
  );
}

/** `#/insights`: usage limits, teams and working subagents across every live pi. */
export function InsightsView(props: {
  usage: Poll<UsageInsight>;
  agents: Poll<AgentsInsight>;
  sessions: SessionSummary[] | undefined;
  now: number;
  /** Team to scroll to (from `#/insights/<teamId>`). */
  focusTeam: string | null;
  titleRef(el: HTMLHeadingElement): void;
}) {
  const titleOf = (path: string | null) => (path ? props.sessions?.find((s) => s.path === path)?.title ?? null : null);
  const fetchedAt = () => props.usage.data()?.fetchedAt ?? null;
  const failure = () => props.usage.error() ?? props.agents.error();
  const retry = () => {
    props.usage.refetch();
    props.agents.refetch();
  };

  // Scroll to the linked team once its card exists; once per link, so polls don't steal focus.
  let focused: string | null = null;
  createEffect(() => {
    const id = props.focusTeam;
    props.agents.data(); // the card appears with the first agents payload
    if (!id || id === focused) return;
    const el = document.getElementById(teamAnchor(id));
    if (!el) return;
    focused = id;
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  });

  return (
    <>
      <header class="session-head">
        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
          <Icon name="chevron-left" />
        </a>
        <div class="session-head-main">
          <h1 class="session-head-title" tabindex="-1" ref={props.titleRef}>
            Insights
          </h1>
          <p class="session-head-meta">
            <Show when={fetchedAt()} fallback="Usage not read yet">
              {(f) => <span title={iso(f())}>Usage updated {relativeTime(iso(f()), props.now)}</span>}
            </Show>
          </p>
        </div>
        <button type="button" class="button button-icon button-ghost" aria-label="Refresh Insights" title="Refresh Insights" onClick={retry}>
          <Icon name="refresh" />
        </button>
      </header>
      <section class="insights pane" aria-label="Insights">
        <div class="insights-inner">
          <Show when={failure()}>
            <Banner
              tone="error"
              title="Couldn't load insights."
              body={`Nothing was changed. ${failure()}`}
              action={
                <button type="button" class="button button-sm" onClick={retry}>
                  Retry
                </button>
              }
            />
          </Show>
          <UsageSection usage={props.usage} now={props.now} />
          <AgentsSections agents={props.agents} now={props.now} titleOf={titleOf} />
        </div>
      </section>
    </>
  );
}
