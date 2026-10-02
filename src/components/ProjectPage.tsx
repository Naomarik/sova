import { createEffect, createMemo, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import type { ProjectSummary } from "../../shared/projects";
import { ApiError, archiveProject, getProjectPreviews, unarchiveProject } from "../lib/api";
import { relativeTime } from "../lib/format";
import { createPoll } from "../lib/poll";
import { PROJECT_TABS, PROJECTS_HREF, projectTabHref, type ProjectTab } from "../lib/projects-route";
import { summaryChips } from "../lib/project-page";
import { isGap, openIdeas } from "../lib/project-overseer-view";
import { announce, toast } from "../lib/ui-state";
import { InsightsPage } from "./InsightsPage";
import { PreviewsCard } from "./PreviewsCard";
import { ActionMenu } from "./ActionMenu";
import { costFigure, createProjectCost, ProjectCostCard } from "./ProjectCostCard";
import { ProjectSoftwareCard } from "./ProjectSoftwareCard";
import { ActivityCard, CodingSessionsCard, createProjectOverseer, IdeasCard, type ItemSendForm, OverseerSettings, OverseerSummary, type ProjectOverseer, TodosCard } from "./ProjectOverseerPanel";
import { Banner, Icon } from "./ui";
import "../orgs.css";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
/** The previews chip's count; the Previews card reads its own, more often. */
const PREVIEWS_POLL_MS = 30_000;

/** What the page hands the layer that places the project, to build its part from. */
export interface ProjectPartContext {
  projectId: string;
  po: ProjectOverseer;
  archived(): boolean;
  /** The overseer works now: its acts (a promotion) change what a part shows. */
  overseerBusy(): boolean;
  /** The overseer's open ideas, and whether they have been read. */
  openIdeas(): number;
  ideasRead(): boolean;
}

/**
 * What the layer that places a project adds to its page (an organization's sections). The page
 * never knows which layer: the route composes the part, and a standalone project has none.
 */
export interface ProjectOrgPart {
  /** The placing org, linked, on the head's meta line. */
  orgLink(): JSX.Element;
  /** Who the overseer's attach pause names ("This organization"). */
  attachedWho: string;
  /** Where the head's back arrow goes: the org's Projects tab. */
  back(): { href: string; label: string };
  /** Its counts for the summary strip; a count not read yet is absent. */
  counts(): { conflicts?: number; decisions?: { total: number; ready: number } };
  /** What waits on the operator in the part: the Requirements tab's dot and the Overview's banner. */
  attention(): { count: number; line: string | null };
  /** The Requirements tab. */
  requirements(): JSX.Element;
  /** Its cards on Settings, above the danger zone. */
  settings(): JSX.Element;
  /** Send to Person on an idea or a to-do item. */
  send: ItemSendForm;
  refresh(): void;
  error(): string | null;
  loading(): boolean;
}

/**
 * One project (`#/projects/<pid>[/<tab>]`, §app.organizations/project-page): a summary of its
 * overseer and counts, then its tabs. Overview is the live work — coding sessions, previews,
 * activity, to-dos and ideas — with anything that waits on the operator first; Cost is what its
 * sessions cost; Settings is its overseer's settings (§app/project-overseer) and archiving. While an
 * organization places it, the route adds that org's part (`org`): Requirements and the rest.
 */
export function ProjectPage(props: {
  project: ProjectSummary;
  tab: ProjectTab;
  titleRef(el: HTMLHeadingElement): void;
  onProject(p: ProjectSummary): void;
  refetchProject(): void;
  org?: (ctx: ProjectPartContext) => ProjectOrgPart;
}) {
  const projectId = props.project.id;
  const project = () => props.project;
  const [overseerBusy, setOverseerBusy] = createSignal(false);
  // Refresh Project recounts the cost too.
  const [costTick, setCostTick] = createSignal(0);
  // Read once for the whole page: the summary counts them, and each tab shows its part.
  const po = createProjectOverseer({ projectId, onBusy: setOverseerBusy });
  const cost = createProjectCost({ projectId, tick: costTick });
  const previews = createPoll(() => getProjectPreviews(projectId), PREVIEWS_POLL_MS);
  const ideaList = () => (po.ideas.data() ? openIdeas(po.ideas.data()!.ideas) : undefined);
  const archived = () => project().archived ?? null;
  const org = props.org?.({
    projectId,
    po,
    archived: () => !!archived(),
    overseerBusy,
    openIdeas: () => ideaList()?.length ?? 0,
    ideasRead: () => !!po.ideas.data(),
  });
  const tabs = (): readonly ProjectTab[] => (org ? PROJECT_TABS : PROJECT_TABS.filter((t) => t !== "requirements"));
  // Requirements is an org's: a standalone project's address for it shows the Overview.
  const tab = (): ProjectTab => (tabs().includes(props.tab) ? props.tab : "overview");

  // Archive Project (§app.organizations/archive): asked where it was pressed (the head's ⋯ or
  // Settings' danger zone), the server's refusal under the question.
  const [confirmArchive, setConfirmArchive] = createSignal<"head" | "settings" | null>(null);
  const [archiveError, setArchiveError] = createSignal<string | null>(null);
  const [archiving, setArchiving] = createSignal(false);
  const setArchived = async (on: boolean) => {
    const p = project();
    if (archiving()) return;
    setArchiving(true);
    try {
      props.onProject(await (on ? archiveProject(p.id) : unarchiveProject(p.id)));
      setConfirmArchive(null);
      setArchiveError(null);
      const done = on ? `${p.name} archived.` : `${p.name} is back.`;
      toast(done);
      announce(done);
    } catch (err) {
      setArchiveError(errText(err));
    } finally {
      setArchiving(false);
    }
  };
  const ArchiveConfirm = (p: { from: "head" | "settings" }) => (
    <Show when={confirmArchive() === p.from && !archived()}>
      <div class="project-archive-confirm">
        <Banner
          tone="warn"
          title={`${project().name} leaves the Projects list and its overseer stops looking. Nothing is deleted; Unarchive brings it back.`}
          action={
            <div class="button-row">
              <button type="button" class="button button-sm button-destructive" aria-disabled={archiving() ? "true" : undefined} onClick={() => void setArchived(true)}>
                Archive Project
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmArchive(null)}>
                Cancel
              </button>
            </div>
          }
        />
        <Show when={archiveError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      </div>
    </Show>
  );
  const askArchive = (from: "head" | "settings") => {
    setConfirmArchive(confirmArchive() === from ? null : from);
    setArchiveError(null);
  };

  // ---- the summary's counts ----------------------------------------------------------------------
  const ideasTab = (): ProjectTab => (org ? "requirements" : "overview");
  const chips = createMemo(() => {
    const w = po.info.data();
    const ideas = ideaList();
    const c = cost.data();
    const pv = previews.data();
    const oc = org?.counts() ?? {};
    return summaryChips({
      sessions: w ? w.worktrees.sessions.length : undefined,
      previews: pv ? pv.previews.filter((x) => x.state === "active").length : undefined,
      cost: c ? costFigure(c) : undefined,
      conflicts: oc.conflicts,
      decisions: oc.decisions,
      ideas: ideas ? { gaps: ideas.filter(isGap).length, other: ideas.filter((x) => !isGap(x)).length } : undefined,
      ideasTab: ideasTab(),
      todos: po.todos.data()?.open,
    });
  });
  /** A chip's section, brought into view once its tab shows (the tab renders on the hash change). */
  const reveal = (section: string) => requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: "start" })));
  const tabHref = (t: ProjectTab) => projectTabHref(projectId, t);
  const attention = () => org?.attention() ?? { count: 0, line: null };

  return (
    <InsightsPage
      title={project().name}
      titleTip
      class="project-page"
      back={org?.back() ?? { href: PROJECTS_HREF, label: "Back to Projects" }}
      actions={
        <ActionMenu label={`Project actions · ${project().name}`} title="Project actions" icon="more">
          {(menu) => (
            <>
              <menu.Item label="Settings" aria={`Settings · ${project().name}`} icon={<Icon name="settings" small />} href={tabHref("settings")} />
              <Show
                when={!archived()}
                fallback={<menu.Item label="Unarchive Project" aria={`Unarchive ${project().name}`} icon={<Icon name="undo" small />} onRun={() => void setArchived(false)} />}
              >
                <menu.Item label="Archive Project…" aria={`Archive ${project().name}`} icon={<Icon name="archive" small />} onRun={() => askArchive("head")} />
              </Show>
            </>
          )}
        </ActionMenu>
      }
      meta={
        <>
          <Show when={org}>
            {(o) => (
              <>
                {o().orgLink()}
                {" · "}
              </>
            )}
          </Show>
          <span class="orgs-mono orgs-meta-path" title={project().root}>
            {project().root}
          </span>
        </>
      }
      refreshLabel="Refresh Project"
      onRefresh={() => {
        props.refetchProject();
        org?.refresh();
        po.info.refetch();
        po.actions.refetch();
        po.ideas.refetch();
        po.todos.refetch();
        previews.refetch();
        setCostTick((n) => n + 1);
      }}
      error={org?.error() ?? null}
      errorTitle="Couldn't update this project."
      busy={!!org?.loading()}
      titleRef={props.titleRef}
    >
      <ArchiveConfirm from="head" />
      <Show when={archived()}>
        {(a) => (
          <div class="project-archive-confirm">
            <Banner
              tone="info"
              title={`${project().name} was archived${a().via === "overseer" ? " by you, via the Overseer" : ""} ${relativeTime(a().at)}. Its overseer is paused and nothing new starts here. Nothing was deleted.`}
              action={
                <button type="button" class="button button-sm" aria-disabled={archiving() ? "true" : undefined} onClick={() => void setArchived(false)}>
                  Unarchive
                </button>
              }
            />
            <Show when={archiveError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
          </div>
        )}
      </Show>
      <div class="project-summary">
        <OverseerSummary po={po} archived={!!archived()} placed={!!org} attachedWho={org?.attachedWho} />
        <Show when={chips().length}>
          <nav class="project-counts" aria-label="Project counts">
            <For each={chips()}>
              {(c) => (
                <a class="project-count" classList={{ "project-count-warn": c.tone === "warn" }} href={tabHref(c.tab)} title={c.title} onClick={() => reveal(c.section)}>
                  <Show when={c.tone === "warn"}>
                    <i class="chip-dot" aria-hidden="true" />
                  </Show>
                  {c.label}
                </a>
              )}
            </For>
          </nav>
        </Show>
      </div>
      <ProjectTabs tabs={tabs()} tab={tab()} href={tabHref} attention={attention().count} attentionText={attention().line ?? ""} />
      <div class="project-tabpanel" role="tabpanel" id="project-tabpanel" aria-labelledby={`project-tab-${tab()}`}>
        <Switch>
          <Match when={tab() === "overview"}>
            <Show when={attention().line}>
              {(line) => (
                <Banner
                  tone="warn"
                  title={line()}
                  action={
                    <a class="button button-sm" href={tabHref("requirements")}>
                      Review Requirements
                    </a>
                  }
                />
              )}
            </Show>
            <div class="project-overview">
              <div class="project-col">
                <CodingSessionsCard po={po} archived={!!archived()} />
                {/* Preview links (§mesh.public/preview-card): this project's apps, on this host. */}
                <div id="project-previews" class="project-anchor">
                  <PreviewsCard projectId={projectId} />
                </div>
              </div>
              <div class="project-col">
                {/* Its software registry on this host (§app.project-runtime/software-card). */}
                <ProjectSoftwareCard projectId={projectId} archived={!!archived()} />
                <ActivityCard po={po} />
                <TodosCard po={po} send={org?.send} archived={!!archived()} />
                {/* A placed project's ideas sit with its requirements; a standalone one's here. */}
                <Show when={!org}>
                  <IdeasCard po={po} title="Ideas" empty="No open ideas. Add one with +, or the overseer files them as it looks." archived={!!archived()} />
                </Show>
              </div>
            </div>
          </Match>
          <Match when={tab() === "requirements" && org}>{(o) => o().requirements()}</Match>
          <Match when={tab() === "cost"}>
            <ProjectCostCard projectId={projectId} poll={cost} />
          </Match>
          <Match when={tab() === "settings"}>
            <OverseerSettings po={po} placed={!!org} />
            {org?.settings()}
            <section class="card orgs-section project-danger" aria-labelledby="project-danger">
              <h2 class="orgs-h2" id="project-danger">
                Danger zone
              </h2>
              <Show
                when={!archived()}
                fallback={
                  <div class="orgs-head">
                    <p class="orgs-line">{project().name} is archived. Unarchive brings it back to the Projects list.</p>
                    <button type="button" class="button button-sm" aria-disabled={archiving() ? "true" : undefined} onClick={() => void setArchived(false)}>
                      Unarchive
                    </button>
                  </div>
                }
              >
                <div class="orgs-head">
                  <p class="orgs-line">Archiving takes it off the Projects list and stops its overseer. Nothing is deleted.</p>
                  <button type="button" class="button button-sm button-destructive" aria-expanded={confirmArchive() === "settings"} onClick={() => askArchive("settings")}>
                    Archive Project
                  </button>
                </div>
                <ArchiveConfirm from="settings" />
              </Show>
            </section>
          </Match>
        </Switch>
      </div>
    </InsightsPage>
  );
}

const TAB_LABEL: Record<ProjectTab, string> = { overview: "Overview", requirements: "Requirements", cost: "Cost", settings: "Settings" };

/** The page's tab strip, as the org page's: a tab per view (the tab is in the URL, each pick a history
    entry), Left/Right moving focus along it (wrapping), Home/End jumping; Enter or Space selects.
    Requirements (only while an org places the project) carries the warn dot while something there waits on the operator. */
function ProjectTabs(props: { tabs: readonly ProjectTab[]; tab: ProjectTab; href(t: ProjectTab): string; attention: number; attentionText: string }) {
  const els: HTMLButtonElement[] = [];
  createEffect(on(() => props.tab, (tab) => queueMicrotask(() => els[props.tabs.indexOf(tab)]?.scrollIntoView({ block: "nearest", inline: "nearest" }))));
  const onKey = (e: KeyboardEvent, i: number) => {
    const last = props.tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    els[next]?.focus();
  };
  return (
    <div class="tabs org-tabs project-tabs" role="tablist" aria-label="Project">
      <For each={props.tabs}>
        {(t, i) => (
          <button
            type="button"
            role="tab"
            class="tab"
            id={`project-tab-${t}`}
            aria-selected={props.tab === t ? "true" : "false"}
            aria-controls={props.tab === t ? "project-tabpanel" : undefined}
            tabindex={props.tab === t ? 0 : -1}
            title={t === "requirements" && props.attention ? props.attentionText : undefined}
            ref={(el) => (els[i()] = el)}
            onClick={() => {
              if (props.tab !== t) location.hash = props.href(t);
            }}
            onKeyDown={(e) => onKey(e, i())}
          >
            {TAB_LABEL[t]}
            <Show when={t === "requirements" && props.attention}>
              <span class="org-tab-dot" aria-hidden="true" />
              <span class="visually-hidden">, needs you: {props.attentionText}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}
