import { createEffect, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import { chatRefOf } from "../lib/merge-chat";
import { chatTreesOf } from "../lib/merge-queue";
import type { ArchiveCopy, ProjectSummary } from "../../shared/projects";
import type { AttentionDigest, SessionSummary } from "../../shared/protocol";
import { ApiError, archiveProject, runDeployVerb, runProjectVerb, unarchiveProject } from "../lib/api";
import { createPoll } from "../lib/poll";
import { deployDot } from "../lib/project-deploy";
import type { DeployReport } from "../../shared/project-contract";
import { relativeTime } from "../lib/format";
import { PROJECT_TABS, PROJECTS_HREF, projectTabHref, TAB_LABEL, type ProjectTab, type QueueTab } from "../lib/projects-route";
import { openIdeas } from "../lib/project-overseer-view";
import { projectHostOf } from "../lib/mesh";
import { announce, toast } from "../lib/ui-state";
import { InsightsPage } from "./InsightsPage";
import { createRunningCopies, ProjectArchiveAsk, refusedCopies } from "./ProjectArchiveAsk";
import { archivedRunningLine, STOP_SHARED_CONFIRM, STOP_SHARED_LABEL, STOP_SHARED_RUNNING, stoppableShared } from "../lib/archive-copies";
import { refusalLine } from "../lib/services-view";
import { ActionMenu } from "./ActionMenu";
import { createProjectCost, ProjectCostCard } from "./ProjectCostCard";
import { createRuntimePoll, ProjectServicesTab } from "./ProjectServicesTab";
import { SessionsTab } from "./ProjectSessionsTab";
import { landedCopies } from "../lib/free-slots";
import { MergeQueueTab } from "./MergeQueueTab";
import { createReleasesPoll, ReleasesTab } from "./ReleasesTab";
import { PlaybookReviewBanner } from "./PlaybookReview";
import { ProjectDeployPanel } from "./ProjectDeployPanel";
import { ProjectFilesCard } from "./ProjectFilesCard";
import { ProjectCardsCard } from "./ProjectCardsCard";
import { ProjectMcpCard } from "./ProjectMcpCard";
import { ProjectContextCard, ProjectSkillsCard } from "./ProjectSkillsCard";
import { ProjectOffersCard } from "./ProjectOffersCard";
import { ProjectIcon } from "./ProjectIcon";
import { ProjectIconCard } from "./ProjectIconCard";
import { createProjectSettings, ProjectAllSettings, ProjectSettingsChanges, ProjectSettingsHistory } from "./ProjectSettingsCards";
import { ActivityCard, createProjectOverseer, IdeasCard, type ItemSendForm, OverseerHeadActions, OverseerNotices, OverseerSettings, type ProjectOverseer, TodosCard } from "./ProjectOverseerPanel";
import { Banner, Icon } from "./ui";
import { createSetupPoll, SetupProposalBanner } from "./SetupChat";
import "../orgs.css";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
/** While archived, what it left running is read this often (the Branches tab reads its own). */
const ARCHIVED_POLL_MS = 15_000;
/** The Deploy tab's dot reads deploy.status this often; the tab's own panel reads it every few seconds while it shows. */
const DEPLOY_DOT_POLL_MS = 30_000;

/** What the page hands the layer that places the project, to build its part from. */
export interface ProjectPartContext {
  projectId: string;
  po: ProjectOverseer;
  archived(): boolean;
  /** The overseer works now: its acts (a promotion) change what a part shows. */
  overseerBusy(): boolean;
  /** Bumped by Refresh Project: a part's own reads read again. */
  refreshed(): number;
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
  /** Open History in the head's ⋯ menu: the placing layer's history of this project (the page never builds it). */
  historyHref(): string;
  /** Where the head's back arrow goes: the org's Projects tab. */
  back(): { href: string; label: string };
  /** What waits on the operator in the part: the Requirements tab's dot and the Sessions tab's banner. */
  attention(): { count: number; line: string | null };
  /** The Requirements tab: the part's own sections, with the project's Files and the sessions its overseer started. */
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
 * One project (`#/projects/<pid>[/<tab>]`, §app.organizations/project-page): a head with its overseer's state word and
 * Open Overseer, then its tabs. Sessions is its coding sessions, what needs the operator first; Backlog its to-dos,
 * ideas and the overseer's activity; Running Copies its copies on this host, one per branch, and their previews;
 * Deploy its deploy targets; Cost what its sessions cost; Settings its overseer's settings (§app/project-overseer) and
 * archiving. While an organization places it, the route adds that org's part (`org`): Requirements and the rest.
 */
export function ProjectPage(props: {
  project: ProjectSummary;
  tab: ProjectTab;
  /** On the Merge Queue tab: one run's page. */
  run?: string;
  /** On the Merge Queue tab: which of its tabs (on a run's page, the one it was opened from). */
  queueTab?: QueueTab;
  titleRef(el: HTMLHeadingElement): void;
  onProject(p: ProjectSummary): void;
  refetchProject(): void;
  org?: (ctx: ProjectPartContext) => ProjectOrgPart;
  /** The session list the sidebar holds: Coding sessions lists from it before its own read answers. */
  sessions?: () => readonly SessionSummary[] | undefined;
  /** The attention digest App holds: the Sessions tab's Needs you is the sidebar's own rule over it. */
  attention?: () => AttentionDigest | undefined;
}) {
  const projectId = props.project.id;
  const project = () => props.project;
  const [overseerBusy, setOverseerBusy] = createSignal(false);
  // Refresh Project recounts the cost too.
  const [costTick, setCostTick] = createSignal(0);
  // Read once for the whole page: the summary counts them, and each tab shows its part.
  const po = createProjectOverseer({ projectId, onBusy: setOverseerBusy, sessions: props.sessions });
  const cost = createProjectCost({ projectId, tick: costTick });
  // The software registry, read once for the page: Running Copies' setup line and a proposed run's banner.
  const runtime = createRuntimePoll(projectId);
  // The project's releases, read once for the page: the Releases tab and the Deploy card's "Runs vX".
  const releases = createReleasesPoll(projectId, () => project().root);
  // The project's Setup chat, read once for every surface that offers it (Merge Queue, Releases, Deploy).
  const setup = createSetupPoll(projectId);
  const ideaList = () => (po.ideas.data() ? openIdeas(po.ideas.data()!.ideas) : undefined);
  const archived = () => project().archived ?? null;
  const org = props.org?.({
    projectId,
    po,
    archived: () => !!archived(),
    overseerBusy,
    refreshed: costTick,
    openIdeas: () => ideaList()?.length ?? 0,
    ideasRead: () => !!po.ideas.data(),
  });
  const tabs = (): readonly ProjectTab[] => (org ? PROJECT_TABS : PROJECT_TABS.filter((t) => t !== "requirements"));
  // Requirements is an org's: a standalone project's address for it shows Sessions.
  const tab = (): ProjectTab => (tabs().includes(props.tab) ? props.tab : "sessions");

  // Archive Project (§app.organizations/archive): asked where it was pressed (the head's ⋯ or
  // Settings' danger zone), the server's refusal under the question.
  const [confirmArchive, setConfirmArchive] = createSignal<"head" | "settings" | null>(null);
  const [archiveError, setArchiveError] = createSignal<string | null>(null);
  const [archiving, setArchiving] = createSignal(false);
  // The copies the last refusal named: the ask lists them at once.
  const [refused, setRefused] = createSignal<ArchiveCopy[] | null>(null);
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
      setRefused(refusedCopies(err));
    } finally {
      setArchiving(false);
    }
  };
  const ArchiveConfirm = (p: { from: "head" | "settings" }) => (
    <Show when={confirmArchive() === p.from && !archived()}>
      <ProjectArchiveAsk
        projectId={projectId}
        name={project().name}
        archiving={archiving()}
        error={archiveError()}
        refused={refused()}
        onArchive={() => void setArchived(true)}
        onCancel={() => setConfirmArchive(null)}
      />
    </Show>
  );
  const askArchive = (from: "head" | "settings") => {
    setConfirmArchive(confirmArchive() === from ? null : from);
    setArchiveError(null);
    setRefused(null);
  };

  const tabHref = (t: ProjectTab) => projectTabHref(projectId, t);
  const attention = () => org?.attention() ?? { count: 0, line: null };
  // The Deploy tab's dot: the page reads deploy.status now and then (the tab's own panel every few seconds, which it
  // hands up while it shows), so a deploy started elsewhere or an overseer's request marks the tab from any tab.
  const deployRead = createPoll(() => runDeployVerb(project().root, "deploy.status", {}), DEPLOY_DOT_POLL_MS, { cacheKey: `project:${projectId}:deploy-dot` });
  // Whichever read answered last, the page's or the panel's.
  const [deployNow, setDeployNow] = createSignal<DeployReport | undefined>();
  createEffect(on(() => deployRead.data(), (d) => d && setDeployNow(d.deploy)));
  const marks = (): Partial<Record<ProjectTab, TabMark>> => {
    const dot = deployDot(deployNow()?.targets);
    const todos = po.todos.data()?.open;
    const a = attention();
    return {
      backlog: { count: todos || undefined },
      deploy: dot ? { dot: dot === "running" ? "live" : "warn", text: dot === "running" ? "deploying now" : "a deploy is asked for" } : {},
      requirements: a.count ? { dot: "warn", text: `needs you: ${a.line ?? ""}` } : {},
    };
  };

  return (
    <InsightsPage
      title={project().name}
      titleTip
      lead={<ProjectIcon project={project()} size={32} local={!projectHostOf(projectId)} class="project-page-icon" />}
      class="project-page"
      back={org?.back() ?? { href: PROJECTS_HREF, label: "Back to Projects" }}
      actions={
        <div class="cluster project-head-actions">
        {/* One box, so a narrow head can give the overseer part a row of its own. */}
        <div class="project-head-overseer">
          <OverseerHeadActions po={po} archived={!!archived()} />
        </div>
        <ActionMenu label={`Project actions · ${project().name}`} title="Project actions" icon="more">
          {(menu) => (
            <>
              <Show when={org}>
                {(o) => <menu.Item label="Open History" aria={`Open History · ${project().name}`} icon={<Icon name="clock" small />} href={o().historyHref()} />}
              </Show>
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
        </div>
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
        po.worktrees.refetch();
        po.actions.refetch();
        po.ideas.refetch();
        po.todos.refetch();
        setCostTick((n) => n + 1);
      }}
      error={org?.error() ?? null}
      errorTitle="Couldn't update this project."
      busy={!!org?.loading()}
      titleRef={props.titleRef}
    >
      <ArchiveConfirm from="head" />
      {/* A verb playbook run waits on Merge Branch (§app.project-runtime/review), on every tab. */}
      <PlaybookReviewBanner projectId={projectId} runtime={runtime.data()} onDone={(view) => (view ? runtime.set(view) : runtime.refetch())} />
      {/* The Setup chat's proposal: read from the Setup read (it is not a verb playbook run). */}
      <SetupProposalBanner projectId={projectId} poll={setup} />
      <Show when={archived()}>
        {(a) => {
          // What it left running (copies run on while archived): read now and then, named under the banner.
          const left = createRunningCopies(projectId, ARCHIVED_POLL_MS);
          const leftLine = () => (left.data() ? archivedRunningLine(left.data()!.copies) : null);
          // Its shared services may run with no copy to show them on Branches: their Stop is here, pressed twice.
          const sharedRow = () => (left.data() ? stoppableShared(left.data()!.copies) : null);
          const [stopArmed, setStopArmed] = createSignal(false);
          const [stopping, setStopping] = createSignal(false);
          const [stopError, setStopError] = createSignal<string | null>(null);
          const stopShared = async () => {
            const row = sharedRow();
            if (!row?.down || stopping()) return;
            if (!stopArmed()) return void setStopArmed(true);
            setStopArmed(false);
            setStopping(true);
            setStopError(null);
            try {
              const why = refusalLine(await runProjectVerb(projectId, "down", row.down));
              if (why) setStopError(why);
              else announce("Stopped its shared services.");
            } catch (err) {
              setStopError(`Couldn't reach the engine. ${errText(err)}`);
            } finally {
              setStopping(false);
              left.refetch();
            }
          };
          return (
            <div class="project-archive-confirm">
              <Banner
                tone="info"
                title={`${project().name} was archived${a().via === "overseer" ? " by you, via the Overseer" : ""} ${relativeTime(a().at)}. Its overseer is paused and nothing new starts here. Nothing was deleted.`}
                body={
                  leftLine() ? (
                    <>
                      {leftLine()!.endsWith(" on Running Copies.") ? (
                        <>
                          {leftLine()!.slice(0, -"Running Copies.".length)}
                          <a href={tabHref("running-copies")}>Running Copies</a>.
                        </>
                      ) : (
                        leftLine()
                      )}
                    </>
                  ) : undefined
                }
                action={
                  <div class="button-row">
                    <Show when={sharedRow()}>
                      <button type="button" class="button button-sm button-destructive" aria-disabled={stopping() ? "true" : undefined} onClick={() => void stopShared()} onBlur={() => setStopArmed(false)}>
                        {stopping() ? STOP_SHARED_RUNNING : stopArmed() ? STOP_SHARED_CONFIRM : STOP_SHARED_LABEL}
                      </button>
                    </Show>
                    <button type="button" class="button button-sm" aria-disabled={archiving() ? "true" : undefined} onClick={() => void setArchived(false)}>
                      Unarchive
                    </button>
                  </div>
                }
              />
              <Show when={stopError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
              <Show when={archiveError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
            </div>
          );
        }}
      </Show>
      {/* What the overseer has to say on every tab: a failed read, the Paused banner with Resume. */}
      <OverseerNotices po={po} attachedWho={org?.attachedWho} />
      <ProjectTabs tabs={tabs()} tab={tab()} href={tabHref} marks={marks()} />
      <div class="project-tabpanel" role="tabpanel" id="project-tabpanel" aria-labelledby={`project-tab-${tab()}`}>
        <Switch>
          <Match when={tab() === "sessions"}>
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
            <SessionsTab po={po} archived={!!archived()} sessions={props.sessions} attention={props.attention} />
          </Match>
          <Match when={tab() === "backlog"}>
            <div class="project-tab-head">
              <div class="project-tab-head-text">
                <h2 class="project-tab-h2">Backlog</h2>
                <p class="project-tab-lede">What you and the overseer filed for this project.</p>
              </div>
            </div>
            {/* To-do and Ideas side by side, the overseer's activity under them. */}
            <div class="project-backlog">
              <TodosCard po={po} send={org?.send} archived={!!archived()} />
              <IdeasCard po={po} title="Ideas" empty="No open ideas. Add one with +, or the overseer files them as it looks." send={org?.send} archived={!!archived()} />
            </div>
            <ActivityCard po={po} />
            {/* Files people sent it (§app.organizations/files-card): a standalone project's, once it holds one; a placed one's are on Requirements. */}
            <Show when={!org}>
              <ProjectFilesCard projectId={projectId} placed={false} tick={costTick} />
            </Show>
          </Match>
          <Match when={tab() === "requirements" && org}>{(o) => o().requirements()}</Match>
          <Match when={tab() === "running-copies"}>
            {/* Its setup line, copies on this host and their verbs, previews and recent runs (§app.project-services/services-ui). */}
            <ProjectServicesTab projectId={projectId} archived={!!archived()} runtime={runtime} landed={() => landedCopies(po.worktrees.data(), props.sessions?.())} />
          </Match>
          <Match when={tab() === "merge-queue"}>
            {/* One branch at a time onto the target: what's checking, the line, what waits for you, recent landings. */}
            <MergeQueueTab
              projectId={projectId}
              root={project().root}
              name={project().name}
              run={props.run}
              queueTab={props.queueTab}
              refreshed={costTick}
              setup={setup}
              // The queue records a chat by its id (an older record by its path); a worker is named as its chat's.
              chatOf={(id) => chatRefOf(id, props.sessions?.())}
              // A Ready row's chip: its chat's own readiness reading of the branch.
              treesOf={(id) => chatTreesOf(id, props.sessions?.())}
            />
          </Match>
          <Match when={tab() === "releases"}>
            {/* The release in progress, then every numbered release. */}
            <ReleasesTab projectId={projectId} root={project().root} name={project().name} archived={!!archived()} poll={releases} setup={setup} />
          </Match>
          <Match when={tab() === "deploy"}>
            {/* Its deploy targets on this host: the deploy panel, which reads deploy.status itself. */}
            <ProjectDeployPanel projectId={projectId} root={project().root} archived={!!archived()} releases={() => releases.data()?.history} setup={setup} onStatus={setDeployNow} />
          </Match>
          <Match when={tab() === "cost"}>
            <ProjectCostCard projectId={projectId} poll={cost} />
          </Match>
          <Match when={tab() === "settings"}>
            {(() => {
              // Every project setting and the overseer's Settings change cards (§app.project-overseer/settings), read while the tab shows.
              const settings = createProjectSettings(projectId);
              return (
                <>
                  {/* Its icon (§app.projects/icon): kept on this host. A peer's project shows no card. */}
                  <Show when={!projectHostOf(projectId)}>
                    <ProjectIconCard project={project()} onChanged={() => props.refetchProject()} />
                  </Show>
                  <ProjectSettingsChanges projectId={projectId} data={settings} />
                  <OverseerSettings po={po} placed={!!org} />
                  {org?.settings()}
                  {/* The project's offers file, read now (§chat.offers/project-list). */}
                  <ProjectOffersCard projectId={projectId} />
                  {/* Its .mcp.json servers, per checkout (§app.mcp/project-servers). */}
                  <ProjectMcpCard projectId={projectId} />
                  {/* Its skill defaults for new chats, kept on this computer. A peer's project shows no card. */}
                  <Show when={!projectHostOf(projectId)}>
                    <ProjectContextCard projectId={projectId} onChanged={() => settings.info.refetch()} />
                    <ProjectSkillsCard projectId={projectId} onChanged={() => settings.info.refetch()} />
                  </Show>
                  {/* Its card folders, broken ones with what is wrong, and its cards' trust. */}
                  <ProjectCardsCard projectId={projectId} />
                  <ProjectAllSettings data={settings} />
                  <ProjectSettingsHistory projectId={projectId} data={settings} />
                </>
              );
            })()}
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


/** What a tab carries beside its label: a count (Backlog's open to-dos), the live dot (a deploy running), or the warn
    dot (something waits on the operator), each with its words for a screen reader. */
export interface TabMark {
  count?: number;
  dot?: "live" | "warn";
  /** The words the dot stands for: the tab's tooltip and its hidden text. */
  text?: string;
}

/** The page's tab strip, as the org page's: a tab per view (the tab is in the URL, each pick a history
    entry), Left/Right moving focus along it (wrapping), Home/End jumping; Enter or Space selects. A tab shows its mark
    (`marks`): Backlog its open to-dos, Deploy a dot while a deploy runs or the overseer asks for one, Requirements (only
    while an org places the project) the warn dot while something there waits on the operator. */
function ProjectTabs(props: { tabs: readonly ProjectTab[]; tab: ProjectTab; href(t: ProjectTab): string; marks: Partial<Record<ProjectTab, TabMark>> }) {
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
        {(t, i) => {
          const mark = () => props.marks[t];
          return (
            <button
              type="button"
              role="tab"
              class="tab"
              id={`project-tab-${t}`}
              aria-selected={props.tab === t ? "true" : "false"}
              aria-controls={props.tab === t ? "project-tabpanel" : undefined}
              tabindex={props.tab === t ? 0 : -1}
              title={mark()?.dot ? mark()?.text : undefined}
              ref={(el) => (els[i()] = el)}
              onClick={() => {
                if (props.tab !== t) location.hash = props.href(t);
              }}
              onKeyDown={(e) => onKey(e, i())}
            >
              {TAB_LABEL[t]}
              <Show when={mark()?.count}>
                {(n) => (
                  <>
                    <span class="text-num org-tab-count">{n()}</span>
                    <span class="visually-hidden"> open {n() === 1 ? "to-do" : "to-dos"}</span>
                  </>
                )}
              </Show>
              <Show when={mark()?.dot}>
                {(d) => (
                  <>
                    <span class={d() === "live" ? "live-dot" : "org-tab-dot"} aria-hidden="true" />
                    <Show when={mark()?.text}>{(w) => <span class="visually-hidden">, {w()}</span>}</Show>
                  </>
                )}
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}
