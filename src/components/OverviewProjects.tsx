import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { AttentionDigest, OverseerProactivity, SessionSummary } from "../../shared/protocol";
import { getSessionSummaryById, listProjects, startProjectCoding } from "../lib/api";
import { relativeTime, stampTime } from "../lib/format";
import { CARD_LIMIT, CARD_LIMIT_NARROW, freezeOrder, showsFilter, projectCards, shortFolder, visibleCards, type ProjectCard } from "../lib/home-projects";
import { startInProject } from "../lib/new-session";
import { ForKey } from "../lib/for-key";
import { createPoll } from "../lib/poll";
import { PROJECTS_HREF, projectHref, projectOverseerHref, projectTabHref } from "../lib/projects-route";
import { adoptSession, home, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import { AddProjectDialog } from "./AddProjectDialog";
import { ProjectIcon } from "./ProjectIcon";
import { Chip, CountChip, Icon } from "./ui";
import "../home.css";

const PROJECTS_POLL_MS = 30_000;
/** The overview's width under which cards are compact and fewer show (the CSS container query's). */
const NARROW_PX = 480;

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err).replace(/[.\s]+$/, "");

/**
 * Home's first section (§app.projects/home-cards): a grid of this host's projects, each card with its icon, where it
 * lives, what is happening in it, a one-tap New Chat and a ⋯ menu; then a dashed Add Project tile. Needs you first, then
 * the most recently active; the order is frozen while Home is on screen, so a card never jumps under a finger.
 */
export function OverviewProjects(props: {
  sessions: readonly SessionSummary[] | undefined;
  digest: Pick<AttentionDigest, "items"> | undefined;
  proactivity: OverseerProactivity | undefined;
  now: number;
  /** New Session, set to this folder (the card menu's New Chat…). */
  onNewSessionIn(root: string): void;
}) {
  const poll = createPoll(listProjects, PROJECTS_POLL_MS, { cacheKey: "home:projects" });
  const [adding, setAdding] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [narrow, setNarrow] = createSignal(false);
  /** Each card's New Chat: starting, or the reason it couldn't. */
  const [starts, setStarts] = createStore<Record<string, { pending?: boolean; error?: string }>>({});
  let section!: HTMLElement;

  onMount(() => {
    const ro = new ResizeObserver(([e]) => e && setNarrow(e.contentRect.width < NARROW_PX));
    ro.observe(section);
    onCleanup(() => ro.disconnect());
  });

  const projects = () => poll.data()?.projects;
  const sorted = createMemo(() => projectCards(projects() ?? [], props.sessions ?? [], props.digest, props.proactivity));
  /** The frozen order: set once the projects, the list and the digest have all been read on this visit. */
  const [order, setOrder] = createSignal<string[] | null>(null);
  createEffect(() => {
    // Needs you is counted only once proactivity is known: freezing before would bury the cards that need you.
    if (order() || !poll.fresh() || !props.sessions || !props.digest || !props.proactivity) return;
    setOrder(sorted().map((c) => c.project.id));
  });
  const cards = createMemo<ProjectCard[]>(() => {
    const o = order();
    return o ? freezeOrder(o, sorted()) : sorted();
  });
  const shown = createMemo(() => visibleCards(cards(), { limit: narrow() ? CARD_LIMIT_NARROW : CARD_LIMIT, expanded: expanded(), filter: filter() }));
  const limit = () => (narrow() ? CARD_LIMIT_NARROW : CARD_LIMIT);

  const newChat = async (c: ProjectCard) => {
    const id = c.project.id;
    if (starts[id]?.pending) return;
    setStarts(id, { pending: true });
    try {
      await startInProject(
        id,
        { start: startProjectCoding, summary: getSessionSummaryById },
        {
          toast,
          created: (s) => {
            if (!adoptSession(s)) location.hash = `#/s/${encodeURIComponent(s.path)}`;
          },
          open: (href) => (location.hash = href),
        },
      );
      setStarts(id, { pending: false, error: undefined });
    } catch (err) {
      setStarts(id, { pending: false, error: errText(err) });
    }
  };

  const where = (c: ProjectCard) => (c.project.space.kind === "org" ? `In ${c.project.space.orgName}` : shortFolder(c.project.root, home()));

  return (
    <section class="explain-section overview-projects" aria-labelledby="overview-projects-title" ref={section}>
      <div class="overview-projects-head">
        <h2 class="explain-section-head" id="overview-projects-title">
          Projects
        </h2>
        <a class="overview-projects-all" href={PROJECTS_HREF}>
          All Projects
        </a>
      </div>
      <Show when={showsFilter(sorted())}>
        <input
          class="input overview-projects-filter"
          type="search"
          placeholder="Filter projects"
          aria-label="Filter projects"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </Show>
      <Show
        when={projects()}
        fallback={
          <Show when={poll.error()} fallback={<p class="overview-projects-note">Reading projects…</p>}>
            <p class="overview-projects-note overview-projects-error">Couldn't read projects. Trying again shortly.</p>
          </Show>
        }
      >
        <Show
          when={cards().length > 0}
          fallback={
            <div class="card overview-projects-empty">
              <p class="overview-projects-empty-title">No projects yet</p>
              <p class="overview-projects-empty-body">Add a folder or clone a GitHub repository and it shows up here.</p>
              <button type="button" class="button" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                Add Project
              </button>
            </div>
          }
        >
          <Show when={filter().trim() && shown().length === 0}>
            <p class="overview-projects-note">No project matches "{filter().trim()}"</p>
          </Show>
          <ul class="overview-projects-grid" aria-label="Projects">
            {/* Keyed by project id: a list update hands each card its fresh row, and its DOM (an open menu, focus) stays. */}
            <ForKey each={shown()} by={(r) => r.project.id}>
              {(c) => {
                const state = () => starts[c().project.id];
                const activeAt = () => {
                  const t = c().lastActivity;
                  return t === null ? null : new Date(t).toISOString();
                };
                return (
                  <li>
                    <div class="card project-card" classList={{ "project-card-needs": c().needsYou > 0 }}>
                      <ProjectIcon project={c().project} size={40} local class="project-card-icon" />
                      <div class="project-card-names">
                        {/* The card's one big target: its ::after covers the card, under the buttons. */}
                        <a class="project-card-name" href={projectHref(c().project.id)}>
                          {c().project.name}
                        </a>
                        <span class="project-card-where" title={c().project.space.kind === "org" ? undefined : c().project.root}>
                          {where(c())}
                        </span>
                      </div>
                      <div class="project-card-menu">
                        <ActionMenu label={`Project actions · ${c().project.name}`} title="Project actions">
                          {(menu) => (
                            <div class="model-menu-list" role="menu" aria-label={`Project actions · ${c().project.name}`}>
                              <menu.Item
                                label="New Chat…"
                                aria={`New Chat… in ${c().project.name}: pick a model, branch or subfolder`}
                                icon={<Icon name="plus" small />}
                                onRun={() => props.onNewSessionIn(c().project.root)}
                                keepFocus
                              />
                              <menu.Item label="Overseer" aria={`Overseer · ${c().project.name}`} icon={<Icon name="eye" small />} href={projectOverseerHref(c().project.id)} />
                              <menu.Item label="Merge Queue" aria={`Merge Queue · ${c().project.name}`} icon={<Icon name="branch" small />} href={projectTabHref(c().project.id, "merge-queue")} />
                              <menu.Item label="Branches" aria={`Branches · ${c().project.name}`} icon={<Icon name="terminal" small />} href={projectTabHref(c().project.id, "branches")} />
                              <menu.Item label="Settings" aria={`Settings · ${c().project.name}`} icon={<Icon name="settings" small />} href={projectTabHref(c().project.id, "settings")} />
                            </div>
                          )}
                        </ActionMenu>
                      </div>
                      <div class="project-card-foot">
                        <div class="project-card-status">
                          <Show
                            when={c().needsYou > 0 || c().working > 0}
                            fallback={
                              <span class="project-card-when" title={activeAt() ? stampTime(activeAt()!) : undefined}>
                                {activeAt() ? `Active ${relativeTime(activeAt()!, props.now)}` : "No chats yet"}
                              </span>
                            }
                          >
                            <Show when={c().needsYou > 0}>
                              <Chip tone="warn">
                                Needs you · <span class="text-num">{c().needsYou}</span>
                              </Chip>
                            </Show>
                            <Show when={c().working > 0}>
                              <CountChip>
                                <span class="text-num">{c().working}</span> working
                              </CountChip>
                            </Show>
                          </Show>
                        </div>
                        <button
                          type="button"
                          class="button button-sm project-card-new"
                          aria-label={state()?.pending ? `Starting a chat in ${c().project.name}…` : `New chat in ${c().project.name}`}
                          disabled={!!state()?.pending}
                          onClick={() => void newChat(c())}
                        >
                          <Show
                            when={!state()?.pending}
                            fallback={
                              <>
                                <Icon name="progress" small />
                                <span class="project-card-new-label">Starting…</span>
                              </>
                            }
                          >
                            <Icon name="plus" small />
                            <span class="project-card-new-label">New Chat</span>
                          </Show>
                        </button>
                      </div>
                      <Show when={state()?.error}>
                        <p class="project-card-error" role="alert">
                          Couldn't start a chat: {state()!.error}
                        </p>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </ForKey>
            <Show when={!filter().trim()}>
              <li>
                <button type="button" class="project-card-add" onClick={() => setAdding(true)}>
                  <Icon name="plus" />
                  Add Project
                </button>
              </li>
            </Show>
          </ul>
          <Show when={!filter().trim() && cards().length > limit()}>
            <button type="button" class="button button-ghost overview-projects-more" aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded((v) => !v)}>
              {expanded() ? "Show fewer" : `Show all ${cards().length}`}
            </button>
          </Show>
        </Show>
      </Show>
      <Show when={adding()}>
        <AddProjectDialog onCancel={() => setAdding(false)} onAdded={() => poll.refetch()} />
      </Show>
    </section>
  );
}
