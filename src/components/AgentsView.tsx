import { createEffect, createUniqueId, For, Index, Match, Show, Switch } from "solid-js";
import type { AgentsInsight, LiveAgentSession, SessionSummary, TeamInfo, WorkerInfo } from "../../shared/protocol";
import { clockTime, relativeTime, shortModel, tildePath } from "../lib/format";
import { activeTeams, memberStatus, type MemberStatus, teamAnchor, teamFresh } from "../lib/insights";
import type { Poll } from "../lib/poll";
import { home } from "../lib/ui-state";
import { capTitle, isHostSession } from "../lib/workers";
import { InsightsPage, iso, ListSkeleton } from "./InsightsPage";
import { sessionHref } from "./Sidebar";
import { Chip, CountChip, Icon } from "./ui";

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

/** One team: a group head (name, id) over its objective, its members, and where it started. */
function TeamGroup(props: { team: TeamInfo; fresh: boolean; now: number; parentTitle: string | null }) {
  const liveSource = () => props.team.live && props.fresh;
  // Orchestrator first, then roster order.
  const members = () => [...props.team.members].sort((a, b) => Number(b.orchestrator) - Number(a.orchestrator));
  return (
    <section class="insights-group team-group" id={teamAnchor(props.team.id)} aria-labelledby={`tt-${props.team.id}`} tabindex="-1">
      <h3 class="list-group-label insights-group-head" id={`tt-${props.team.id}`}>
        <span class="insights-group-name team-group-name">{props.team.name}</span>
        <span class="text-mono">{props.team.id}</span>
      </h3>
      <Show when={props.team.objective}>
        <p class="team-objective" title={capTitle(props.team.objective)}>
          {props.team.objective}
        </p>
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
      <p class="team-started">
        Started {relativeTime(iso(props.team.createdAt), props.now)} in{" "}
        <a href={sessionHref(props.team.parentPath)} title={props.parentTitle ?? undefined}>
          {props.parentTitle ?? "its parent session"}
        </a>
      </p>
    </section>
  );
}

/** Workers of one live pi that aren't in a team. */
function AgentGroup(props: { s: LiveAgentSession; workers: WorkerInfo[]; title: string | null }) {
  const working = () => props.workers.filter((w) => w.working).length;
  // Embedded sessions share the server's pid, so the head's id can't come from the record.
  const headId = `sa-${createUniqueId()}`;
  return (
    <section class="insights-group agent-group" aria-labelledby={headId}>
      <h3 class="list-group-label insights-group-head" id={headId}>
        <span class="insights-group-name agent-group-name">
          <Show when={props.s.path} fallback={<span class="text-mono">{tildePath(props.s.cwd, home())}</span>}>
            {(p) => <a href={sessionHref(p())}>{props.title ?? props.s.name ?? tildePath(props.s.cwd, home())}</a>}
          </Show>
        </span>
        <Show when={props.s.embedded}>
          <CountChip title="A chat running in Sova">Web</CountChip>
        </Show>
        <Show when={working() > 0}>
          <CountChip>{working()} working</CountChip>
        </Show>
      </h3>
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
    </section>
  );
}

function AgentsSections(props: { agents: Poll<AgentsInsight>; now: number; titleOf(path: string | null): string | null }) {
  const a = () => props.agents.data();
  const teams = () => activeTeams(a());
  const liveSessions = () => (a()?.sessions ?? []).filter(isHostSession);
  const solo = () =>
    liveSessions()
      .map((s) => ({ s, workers: s.workers.filter((w) => !w.teamId) }))
      .filter((x) => x.workers.length > 0);
  const soloWorking = () => solo().reduce((n, x) => n + x.workers.filter((w) => w.working).length, 0);

  return (
    <Switch>
      <Match when={!a() && props.agents.pending()}>
        <ListSkeleton groups={1} rows={2} />
      </Match>
      <Match when={a() && liveSessions().length === 0}>
        <div class="card">
          <div class="empty">
            <Icon name="worker" class="empty-mark" />
            <p class="empty-title">No pi sessions running.</p>
            <p class="empty-body">Teams and subagents show up here while the pi session that started them runs.</p>
          </div>
        </div>
      </Match>
      <Match when={a()}>
        <section class="insights-section" aria-labelledby="ins-teams">
          <h2 class="insights-section-head" id="ins-teams">
            <Icon name="worker" small />
            Teams
            <Show when={teams().length > 0}>
              <span class="insights-section-count">· {teams().length} active</span>
            </Show>
          </h2>
          <Switch>
            <Match when={teams().length === 0}>
              <div class="card">
                <div class="empty">
                  <p class="empty-title">
                    {liveSessions().length === 1
                      ? "1 pi session running. It has no team."
                      : `${liveSessions().length} pi sessions running. None of them has a team.`}
                  </p>
                  <p class="empty-body">Teams you create in pi show up here while their session runs.</p>
                </div>
              </div>
            </Match>
            <Match when={teams().length > 0}>
              <div class="card insights-list">
                {/* By position, not identity: sessions carry no id, so a poll that reorders them rebuilds
                    the team objects, and <For> would remount the groups (losing the deep-link focus).
                    Teams are sorted by createdAt, so positions are stable. */}
                <Index each={teams()}>
                  {(t) => <TeamGroup team={t()} fresh={teamFresh(a(), t())} now={props.now} parentTitle={props.titleOf(t().parentPath)} />}
                </Index>
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
            <div class="card insights-list">
              <For each={solo()}>{(x) => <AgentGroup s={x.s} workers={x.workers} title={props.titleOf(x.s.path)} />}</For>
            </div>
          </section>
        </Show>
      </Match>
    </Switch>
  );
}

/** `#/agents`: teams and subagents of every running pi, from the live registry. */
export function AgentsView(props: {
  agents: Poll<AgentsInsight>;
  sessions: SessionSummary[] | undefined;
  now: number;
  /** Team to scroll to (from `#/agents/<teamId>`). */
  focusTeam: string | null;
  titleRef(el: HTMLHeadingElement): void;
}) {
  const titleOf = (path: string | null) => (path ? props.sessions?.find((s) => s.path === path)?.title ?? null : null);
  /** "3 working · 2 pi sessions running": live facts for the head meta. */
  const meta = () => {
    const a = props.agents.data();
    if (!a) return undefined; // nothing loaded yet (first load or error): no meta line
    const live = a.sessions.filter(isHostSession).length;
    if (live === 0) return "No pi sessions running";
    const running = live === 1 ? "1 pi session running" : `${live} pi sessions running`;
    return a.totals.working > 0 ? `${a.totals.working} working · ${running}` : running;
  };

  // Scroll to the linked team once its group exists; once per link, so polls don't steal focus.
  let focused: string | null = null;
  createEffect(() => {
    const id = props.focusTeam;
    props.agents.data(); // the group appears with the first agents payload
    if (!id || id === focused) return;
    const el = document.getElementById(teamAnchor(id));
    if (!el) return;
    focused = id;
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
  });

  return (
    <InsightsPage
      title="Agents"
      meta={meta() ? <span title={meta()}>{meta()}</span> : undefined}
      refreshLabel="Refresh Agents"
      onRefresh={() => props.agents.refetch()}
      error={props.agents.error()}
      errorTitle="Couldn't load agents."
      busy={!props.agents.data() && props.agents.pending()}
      titleRef={props.titleRef}
    >
      <AgentsSections agents={props.agents} now={props.now} titleOf={titleOf} />
    </InsightsPage>
  );
}
