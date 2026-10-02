import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import type { ProjectSummary } from "../../shared/projects";
import { ApiError, getProject, listProjects, openProjectOverseer } from "../lib/api";
import { relativeTime } from "../lib/format";
import { orgTabHref } from "../lib/orgs-route";
import { placementOf, sortProjects } from "../lib/projects";
import { projectHref, projectSessionHref, type ProjectsRoute, type ProjectTab } from "../lib/projects-route";
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
      <Show when={adding()}>
        <AddProjectDialog onCancel={() => setAdding(false)} onAdded={() => void refetch()} />
      </Show>
    </InsightsPage>
  );
}

/** One project: the whole row opens its page; the placing org, when one does, links to its Projects tab. */
function ProjectRow(props: { project: ProjectSummary }) {
  const p = () => props.project;
  const placed = () => placementOf(p());
  return (
    <li class="projects-row">
      <a class="list-row list-row-interactive orgs-row orgs-project-row" href={projectHref(p().id)}>
        <Icon name="folder" />
        <span class="list-main">
          <span class="list-title">{p().name}</span>
          <span class="list-meta orgs-mono" title={p().root}>
            {p().root}
          </span>
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
      <Show when={placed()}>
        {(o) => (
          <a class="projects-row-org" href={orgTabHref(o().orgId, "projects")} title={`Placed in ${o().orgName}`}>
            <Chip>{o().orgName}</Chip>
          </a>
        )}
      </Show>
    </li>
  );
}
