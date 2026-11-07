import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { AttentionDigest, OverseerProactivity, SessionSummary } from "../../shared/protocol";
import { getProjectGlance, getSessionSummaryById, listProjects, startProjectCoding } from "../lib/api";
import { relativeTime, stampTime } from "../lib/format";
import { cardRuntime, DASH, type ReadyRow } from "../lib/home-glance";
import { cardLimitAt, freezeOrder, showsFilter, projectCards, shortFolder, visibleCards, type ProjectCard } from "../lib/home-projects";
import { startInProject } from "../lib/new-session";
import { ForKey } from "../lib/for-key";
import { createPoll } from "../lib/poll";
import { PROJECTS_HREF, projectHref, projectOverseerHref, projectTabHref, type ProjectTab } from "../lib/projects-route";
import { adoptSession, home, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import { AddProjectDialog } from "./AddProjectDialog";
import { ProjectIcon } from "./ProjectIcon";
import type { JSX } from "solid-js";
import { Chip, Icon } from "./ui";
import "../home.css";

const PROJECTS_POLL_MS = 30_000;

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err).replace(/[.\s]+$/, "");

/** The Ready to merge row: a link to the Merge Queue tab only while the queue serves the project (§app.projects/home-cards). */
export function ReadyToMerge(props: { ready: ReadyRow; href: string }) {
  return (
    <RuntimeRow href={props.ready.link ? props.href : undefined} label="Ready to merge">
      <span class="overview-project-card-val text-num" classList={{ "overview-project-card-muted": props.ready.muted }}>
        <Show when={props.ready.dot}>
          <i class="overview-project-card-dot" aria-hidden="true" />
        </Show>
        {props.ready.count}
        <Show when={props.ready.inLine}>
          <span class="overview-project-card-muted"> {props.ready.inLine}</span>
        </Show>
      </span>
    </RuntimeRow>
  );
}

/** A Runtime row: a link with a chevron where it has a place to open, else plain (no hover, no chevron). */
export function RuntimeRow(props: { href: string | undefined; label: string; title?: string; children: JSX.Element }) {
  return (
    <Show
      when={props.href}
      fallback={
        <div class="overview-project-card-row" title={props.title}>
          <span class="overview-project-card-key">{props.label}</span>
          {props.children}
        </div>
      }
    >
      <a class="overview-project-card-row overview-project-card-link" href={props.href} title={props.title}>
        <span class="overview-project-card-key">{props.label}</span>
        {props.children}
        <Icon name="chevron-right" small class="overview-project-card-chev" />
      </a>
    </Show>
  );
}

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
  // The cards' runtime figures (§app.projects/home-glance), on the project list's own timer. A failed read keeps nothing:
  // the rows read "—" until the next poll answers.
  const glance = createPoll(getProjectGlance, PROJECTS_POLL_MS);
  const glanceOf = (id: string) => (glance.error() ? undefined : glance.data()?.glances.find((g) => g.projectId === id));
  const [adding, setAdding] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const [limit, setLimit] = createSignal(cardLimitAt(Infinity));
  /** Each card's New Chat: starting, or the reason it couldn't. */
  const [starts, setStarts] = createStore<Record<string, { pending?: boolean; error?: string }>>({});
  let section!: HTMLElement;

  onMount(() => {
    const ro = new ResizeObserver(([e]) => e && setLimit(cardLimitAt(e.contentRect.width)));
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
  const shown = createMemo(() => visibleCards(cards(), { limit: limit(), expanded: expanded(), filter: filter() }));

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
                const rt = () => cardRuntime(glanceOf(c().project.id), glance.data()?.hostTotalBytes ?? null, props.now);
                const name = () => c().project.name;
                const tab = (t: ProjectTab) => projectTabHref(c().project.id, t);
                return (
                  <li>
                    <div class="card overview-project-card" classList={{ "overview-project-card-needs": c().needsYou > 0 }}>
                      {/* The head is the Needs you band and the card's link to its page. */}
                      <a
                        class="overview-project-card-head overview-project-card-link"
                        href={projectHref(c().project.id)}
                        aria-label={`${name()}: ${c().needsYou > 0 ? `${c().needsYou} need${c().needsYou === 1 ? "s" : ""} you` : "nothing needs you"}`}
                      >
                        <ProjectIcon project={c().project} size={40} local class="overview-project-card-icon" />
                        <span class="overview-project-card-names">
                          <span class="overview-project-card-name" title={name()}>
                            {name()}
                          </span>
                          <span class="overview-project-card-where" title={c().project.space.kind === "org" ? undefined : c().project.root}>
                            {where(c())}
                          </span>
                        </span>
                        <Show when={c().needsYou > 0} fallback={<span class="overview-project-card-calm">Nothing needs you</span>}>
                          <span class="overview-project-card-needs-count">
                            <span class="overview-project-card-needs-n text-num">{c().needsYou}</span>
                            <span class="overview-project-card-needs-word">Needs you</span>
                          </span>
                        </Show>
                        <Icon name="chevron-right" small class="overview-project-card-chev" />
                      </a>
                      <div class="overview-project-card-body">
                        <p class="overview-project-card-cap">
                          <span>Chats</span>
                          <span class="overview-project-card-cap-note text-num">{c().open} open</span>
                        </p>
                        <a class="overview-project-card-row overview-project-card-link" href={projectHref(c().project.id)}>
                          <span class="overview-project-card-key">Open chats</span>
                          <span class="overview-project-card-val text-num" classList={{ "overview-project-card-muted": c().open === 0 }}>
                            {c().open}
                            {c().working > 0 ? ` · ${c().working} working` : ""}
                          </span>
                          <Icon name="chevron-right" small class="overview-project-card-chev" />
                        </a>
                        <div class="overview-project-card-row">
                          <span class="overview-project-card-key">Archived chats</span>
                          <span class="overview-project-card-val overview-project-card-muted text-num">{c().archived}</span>
                        </div>
                        <p class="overview-project-card-cap">
                          <span>Runtime</span>
                          <span class="overview-project-card-cap-note text-num">{rt().caption}</span>
                        </p>
                        <ReadyToMerge ready={rt().ready} href={tab("merge-queue")} />
                        <RuntimeRow href={rt().slots ? tab("branches") : undefined} label="Running slots">
                          <Show when={rt().slots} fallback={<span class="overview-project-card-val overview-project-card-muted">{DASH}</span>}>
                            {(sl) => (
                              <span class="overview-project-card-val text-num" classList={{ "overview-project-card-muted": sl().muted }}>
                                <span class="overview-project-card-pips" aria-hidden="true">
                                  {sl().pips.map((on) => (
                                    <i classList={{ "overview-project-card-pip-on": on }} />
                                  ))}
                                </span>
                                <span class="overview-project-card-fig">{sl().text}</span>
                              </span>
                            )}
                          </Show>
                        </RuntimeRow>
                        <RuntimeRow href={rt().hasSetup ? tab("branches") : undefined} label="Memory in use" title={rt().memory.parts ?? undefined}>
                          <span class="overview-project-card-val text-num" classList={{ "overview-project-card-muted": rt().memory.muted }}>
                            <Show when={rt().memory.bar}>
                              {(b) => (
                                <span class="overview-project-card-bar" aria-hidden="true">
                                  <Show when={b().chats > 0}>
                                    <i class="overview-project-card-bar-chats" style={{ width: `${b().chats * 100}%` }} />
                                  </Show>
                                  <Show when={b().slots > 0}>
                                    <i class="overview-project-card-bar-slots" style={{ width: `${b().slots * 100}%` }} />
                                  </Show>
                                </span>
                              )}
                            </Show>
                            <span class="overview-project-card-fig">{rt().memory.text}</span>
                            <Show when={rt().memory.parts}>{(p) => <span class="visually-hidden">: {p()}</span>}</Show>
                          </span>
                        </RuntimeRow>
                      </div>
                      <Show when={rt().progress.length > 0}>
                        <div class="overview-project-card-progress">
                          {rt().progress.map((p) => (
                            <a class="overview-project-card-prog overview-project-card-link" href={tab(p.tab)}>
                              <span class="overview-project-card-prog-top">
                                <span class="overview-project-card-prog-text">
                                  <b>{p.lead}</b> {p.text}
                                </span>
                                <Show when={p.meta}>
                                  <span class="overview-project-card-muted text-num">{p.meta}</span>
                                </Show>
                                <Show when={p.chip}>{(ch) => <Chip tone={ch().tone === "info" ? undefined : ch().tone}>{ch().word}</Chip>}</Show>
                              </span>
                              <span class="overview-project-card-prog-sub">
                                <Show when={p.segments.length > 0}>
                                  <span class="overview-project-card-meter" aria-hidden="true">
                                    {p.segments.map((st) => (
                                      <i class={`overview-project-card-seg-${st}`} />
                                    ))}
                                  </span>
                                </Show>
                                <span class="overview-project-card-prog-detail">{p.detail}</span>
                              </span>
                            </a>
                          ))}
                        </div>
                      </Show>
                      <div class="overview-project-card-foot">
                        <button
                          type="button"
                          class="button button-sm overview-project-card-new"
                          aria-label={state()?.pending ? `Starting a chat in ${name()}…` : `New chat in ${name()}`}
                          disabled={!!state()?.pending}
                          onClick={() => void newChat(c())}
                        >
                          <Show
                            when={!state()?.pending}
                            fallback={
                              <>
                                <Icon name="progress" small />
                                <span>Starting…</span>
                              </>
                            }
                          >
                            <Icon name="plus" small />
                            <span>New Chat</span>
                          </Show>
                        </button>
                        <span class="overview-project-card-when" title={activeAt() ? stampTime(activeAt()!) : undefined}>
                          {activeAt() ? `Active ${relativeTime(activeAt()!, props.now)}` : "No chats yet"}
                        </span>
                        <div class="overview-project-card-menu">
                          <ActionMenu label={`Project actions · ${name()}`} title="Project actions">
                            {(menu) => (
                              <div class="model-menu-list" role="menu" aria-label={`Project actions · ${name()}`}>
                                <menu.Item
                                  label="New Chat…"
                                  aria={`New Chat… in ${name()}: pick a model, branch or subfolder`}
                                  icon={<Icon name="plus" small />}
                                  onRun={() => props.onNewSessionIn(c().project.root)}
                                  keepFocus
                                />
                                <menu.Item label="Overseer" aria={`Overseer · ${name()}`} icon={<Icon name="eye" small />} href={projectOverseerHref(c().project.id)} />
                                <menu.Item label="Merge Queue" aria={`Merge Queue · ${name()}`} icon={<Icon name="branch" small />} href={tab("merge-queue")} />
                                <menu.Item label="Branches" aria={`Branches · ${name()}`} icon={<Icon name="terminal" small />} href={tab("branches")} />
                                <menu.Item label="Settings" aria={`Settings · ${name()}`} icon={<Icon name="settings" small />} href={tab("settings")} />
                              </div>
                            )}
                          </ActionMenu>
                        </div>
                      </div>
                      <Show when={state()?.error}>
                        <p class="overview-project-card-error" role="alert">
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
                <button type="button" class="overview-project-card-add" onClick={() => setAdding(true)}>
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
        <AddProjectDialog
          onCancel={() => setAdding(false)}
          onAdded={() => {
            poll.refetch();
            glance.refetch();
          }}
        />
      </Show>
    </section>
  );
}
