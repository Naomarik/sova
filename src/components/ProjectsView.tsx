import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import type { ProjectSummary } from "../../shared/projects";
import type { RunningProject } from "../../shared/services-view";
import { ApiError, getHostServices, getProject, listProjects, openProjectOverseer, runProjectVerb, runRootVerb } from "../lib/api";
import { relativeTime } from "../lib/format";
import { placementOf, sortProjects } from "../lib/projects";
import { createPoll } from "../lib/poll";
import { projectHref, projectSessionHref, projectTabHref, type ProjectsRoute, type ProjectTab } from "../lib/projects-route";
import { COPY_CHIP, copyName, memoryOf, refusalLine, SERVICE_CHIP } from "../lib/services-view";
import { announce, toast } from "../lib/ui-state";
import { AddProjectDialog } from "./AddProjectDialog";
import { InsightsPage } from "./InsightsPage";
import { createProjectOrgPart } from "./ProjectOrgPart";
import { ProjectPage } from "./ProjectPage";
import { Banner, Chip, Icon } from "./ui";
import "../orgs.css";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/**
 * The projects pages (§app/projects): `#/projects`, `#/projects/<pid>[/<tab>]` and
 * `#/projects/<pid>/overseer`. This route composes a project's page: the project layer's page, plus
 * the placing organization's part while one places it (`space.kind === "org"`).
 */
export function ProjectsView(props: { route: ProjectsRoute; titleRef(el: HTMLHeadingElement): void }) {
  const tab = createMemo((): ProjectTab => (props.route.kind === "project" ? (props.route.tab ?? "overview") : "overview"));
  return (
    <Switch>
      <Match when={props.route.kind === "list"}>
        <ProjectList titleRef={props.titleRef} />
      </Match>
      {/* Keyed on the project alone: a tab change keeps the page and what it fetched. */}
      <Match when={props.route.kind === "project" && props.route.projectId} keyed>
        {(pid) => <ProjectRoute projectId={pid} tab={tab()} titleRef={props.titleRef} />}
      </Match>
      <Match when={props.route.kind === "overseer" && props.route.projectId} keyed>
        {(pid) => <OverseerDoor projectId={pid} titleRef={props.titleRef} />}
      </Match>
    </Switch>
  );
}

/** One project's page, once its read lands: the org's part composed in only while one places it. */
function ProjectRoute(props: { projectId: string; tab: ProjectTab; titleRef(el: HTMLHeadingElement): void }) {
  const [project, { refetch, mutate }] = createResource(() => props.projectId, getProject);
  // Keyed on where it lives: a project placed (or no longer placed) since the page opened gets the other composition.
  const space = createMemo(() => {
    const p = project.latest;
    return p ? (placementOf(p)?.orgId ?? "") : null;
  });
  return (
    <Show
      when={space() !== null}
      fallback={
        <InsightsPage title="Project" refreshLabel="Refresh Project" onRefresh={() => void refetch()} error={project.error ? errText(project.error) : null} errorTitle="Couldn't open this project." busy={project.loading} titleRef={props.titleRef}>
          <Show when={project.error}>
            <p class="orgs-empty">
              <a href="#/projects">All Projects</a>
            </p>
          </Show>
        </InsightsPage>
      }
    >
      <Show when={space()} keyed fallback={<ProjectPage project={project.latest!} tab={props.tab} titleRef={props.titleRef} onProject={mutate} refetchProject={() => void refetch()} />}>
        {(orgId) => (
          <ProjectPage
            project={project.latest!}
            tab={props.tab}
            titleRef={props.titleRef}
            onProject={mutate}
            refetchProject={() => void refetch()}
            org={(ctx) => createProjectOrgPart(orgId, ctx)}
          />
        )}
      </Show>
    </Show>
  );
}

/** `#/projects/<pid>/overseer`: open (or start) the project's overseer and go to its conversation;
    on failure, the reason and the project's page. */
function OverseerDoor(props: { projectId: string; titleRef(el: HTMLHeadingElement): void }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  openProjectOverseer(props.projectId).then(
    (info) => (info.path ? location.replace(projectSessionHref(props.projectId, info.path)) : setFailed("It has no conversation yet.")),
    (err) => setFailed(errText(err)),
  );
  return (
    <Show when={failed()} fallback={<p class="orgs-empty">Opening the overseer.</p>}>
      {(e) => (
        <>
          <Banner tone="error" title="Couldn't open the overseer." body={e()} />
          <ProjectRoute projectId={props.projectId} tab="overview" titleRef={props.titleRef} />
        </>
      )}
    </Show>
  );
}

// ---- the list --------------------------------------------------------------------------------------

function ProjectList(props: { titleRef(el: HTMLHeadingElement): void }) {
  const [info, { refetch }] = createResource(listProjects);
  const [adding, setAdding] = createSignal(false);
  const lists = createMemo(() => sortProjects(info()?.projects ?? []));
  return (
    <InsightsPage
      title="Projects"
      meta={info() ? `${lists().live.length} on this host` : undefined}
      actions={
        <button type="button" class="button button-primary button-sm" onClick={() => setAdding(true)}>
          <Icon name="plus" small /> Add Project
        </button>
      }
      refreshLabel="Refresh Projects"
      onRefresh={() => void refetch()}
      error={info.error ? errText(info.error) : null}
      errorTitle="Couldn't read the projects."
      busy={info.loading}
      titleRef={props.titleRef}
    >
      <Show
        when={lists().live.length}
        fallback={
          <Show when={info()}>
            <div class="card orgs-section org-empty">
              <h2 class="orgs-h2">{lists().archived.length ? `All ${lists().archived.length} projects here are archived` : "Add your first project"}</h2>
              <p class="orgs-empty">A project is a folder or a GitHub repository you add. It gets an overseer, coding sessions in their own worktrees, previews and costs.</p>
              <div class="button-row">
                <button type="button" class="button" onClick={() => setAdding(true)}>
                  <Icon name="plus" /> Add Project
                </button>
              </div>
            </div>
          </Show>
        }
      >
        <section class="card orgs-section" aria-label="Projects">
          <ul class="list orgs-project-list">
            <For each={lists().live}>{(p) => <ProjectRow project={p} />}</For>
          </ul>
        </section>
      </Show>
      <Show when={lists().archived.length}>
        <details class="orgs-history orgs-history-section">
          <summary>Archived Projects ({lists().archived.length})</summary>
          <ul class="list orgs-project-list">
            <For each={lists().archived}>{(p) => <ProjectRow project={p} />}</For>
          </ul>
        </details>
      </Show>
      <RunningCopies />
      <Show when={adding()}>
        <AddProjectDialog onCancel={() => setAdding(false)} onAdded={() => void refetch()} />
      </Show>
    </InsightsPage>
  );
}

/** One project: the whole row opens its page; it names its organization while one places it. */
function ProjectRow(props: { project: ProjectSummary }) {
  const p = () => props.project;
  return (
    <li>
      <a class="list-row list-row-interactive orgs-row orgs-project-row" href={projectHref(p().id)}>
        <Icon name="folder" />
        <span class="list-main">
          <span class="list-title">{p().name}</span>
          <span class="list-meta orgs-mono" title={p().root}>
            {p().root}
          </span>
          <Show when={placementOf(p())}>{(o) => <span class="list-meta">In {o().orgName}</span>}</Show>
          <Show when={p().archived}>
            {(a) => (
              <span class="list-meta">
                archived <time title={a().at}>{relativeTime(a().at)}</time>
              </span>
            )}
          </Show>
        </span>
        <Icon name="chevron-right" class="orgs-row-go" />
      </a>
    </li>
  );
}

// ---- what runs on this host ------------------------------------------------------------------------

const RUNNING_POLL_MS = 15_000;

/**
 * Running copies (§app.project-services/services-ui): every copy and shared service that runs on this
 * host now, by project, standalone or placed, each with its memory and a Stop; the project's name opens
 * its Services tab. A shared service's Stop asks first: it stops it for every copy of the project.
 */
function RunningCopies() {
  const poll = createPoll(getHostServices, RUNNING_POLL_MS);
  const [running, setRunning] = createSignal<string | null>(null);
  const [armed, setArmed] = createSignal<string | null>(null);
  const [said, setSaid] = createSignal<Record<string, string>>({});

  const stop = async (p: RunningProject, key: string, name: string, body: Record<string, unknown>, asksFirst: boolean) => {
    if (running()) return;
    const confirmed = armed() === key;
    if (asksFirst && !confirmed) return setArmed(key);
    setArmed(null);
    setRunning(key);
    const { [key]: _, ...rest } = said();
    setSaid(rest);
    try {
      const b = { ...body, ...(confirmed ? { confirm: true } : {}) };
      const r = p.projectId ? await runProjectVerb(p.projectId, "down", b) : await runRootVerb(p.root, "down", b);
      const why = refusalLine(r);
      if (why) {
        setSaid({ ...said(), [key]: why });
        announce(why);
        if (r.error?.code === "needs-confirm") setArmed(key);
      } else {
        const done = `Stopped ${name} of ${p.name}.`;
        toast(done);
        announce(done);
      }
    } catch (x) {
      setSaid({ ...said(), [key]: `Couldn't reach the engine. ${errText(x)}` });
    } finally {
      setRunning(null);
      poll.refetch();
    }
  };

  const StopButton = (b: { p: RunningProject; id: string; name: string; body: Record<string, unknown>; asksFirst?: boolean }) => (
    <button
      type="button"
      class="button button-sm"
      aria-disabled={running() ? "true" : undefined}
      aria-label={`Stop ${b.name} of ${b.p.name}`}
      onClick={() => void stop(b.p, b.id, b.name, b.body, !!b.asksFirst)}
      onBlur={() => armed() === b.id && setArmed(null)}
    >
      {running() === b.id ? "Stopping…" : armed() === b.id ? "Confirm Stop" : "Stop"}
    </button>
  );

  return (
    <section class="card orgs-section running-copies" aria-labelledby="running-copies">
      <h2 class="orgs-h2" id="running-copies">
        Running copies
      </h2>
      <Show when={poll.data()} fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read what runs here. ${poll.error()}` : "Reading what runs on this host."}</p>}>
        {(v) => (
          <Show when={v().projects.length} fallback={<p class="orgs-empty">Nothing runs on this host now. Copies you start show here.</p>}>
            <ul class="list running-copies-list">
              <For each={v().projects}>
                {(p) => (
                  <li class="running-copies-project">
                    <p class="list-title running-copies-head">
                      <Show when={p.projectId} fallback={<span class="orgs-mono" title={p.root}>{p.root}</span>}>
                        {(pid) => <a href={projectTabHref(pid(), "services")}>{p.name}</a>}
                      </Show>
                      <Show when={p.orgName}>{(o) => <span class="list-meta">In {o()}</span>}</Show>
                    </p>
                    <ul class="list">
                      <For each={p.copies}>
                        {(c) => {
                          const name = () => copyName({ slot: c.slot, branch: c.branch, checkout: p.root });
                          const key = () => `${c.instance}:down`;
                          return (
                            <li class="list-row services-row">
                              <div class="list-main services-row-main">
                                <p class="services-row-title">
                                  <span class="services-name text-mono">{name()}</span>
                                  <span class="list-meta">slot {c.slot}</span>
                                  <Chip tone={COPY_CHIP[c.state].tone}>{COPY_CHIP[c.state].word}</Chip>
                                  <span class="list-meta">{memoryOf(c.rssBytes)}</span>
                                </p>
                                <Show when={said()[key()]}>{(line) => <p class="field-error services-said">{line()}</p>}</Show>
                              </div>
                              <div class="button-row services-actions">
                                <StopButton p={p} id={key()} name={name()} body={{ instance: c.instance }} />
                              </div>
                            </li>
                          );
                        }}
                      </For>
                      <For each={p.shared}>
                        {(s) => {
                          const key = () => `${p.root}:shared:${s.name}:down`;
                          return (
                            <li class="list-row services-row">
                              <div class="list-main services-row-main">
                                <p class="services-row-title">
                                  <span class="services-name">{s.name}</span>
                                  <span class="list-meta">shared</span>
                                  <Chip tone={SERVICE_CHIP[s.state].tone}>{SERVICE_CHIP[s.state].word}</Chip>
                                  <span class="list-meta">{memoryOf(s.rssBytes)}</span>
                                </p>
                                <Show when={said()[key()]}>{(line) => <p class="field-error services-said">{line()}</p>}</Show>
                              </div>
                              <div class="button-row services-actions">
                                <StopButton p={p} id={key()} name={s.name} body={{ instance: s.via, services: [s.name] }} asksFirst />
                              </div>
                            </li>
                          );
                        }}
                      </For>
                    </ul>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  );
}
