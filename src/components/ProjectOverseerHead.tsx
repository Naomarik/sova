import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import type { ProjectOverseerInfo, ProjectOverseerPatch } from "../../shared/project-overseer";
import { ApiError, clearProjectOverseer, getProjectOverseer, patchProjectOverseer, runProjectOverseer } from "../lib/api";
import { relativeTime } from "../lib/format";
import { projectHref, projectSessionHref } from "../lib/projects-route";
import { headState, historyTitle, startedWords, statusLines } from "../lib/project-overseer-view";
import { brakeDone, columnsFor, powerGroups, powersButtonName } from "../lib/powers-view";
import { PowersPanel } from "./PowersGrid";
import { announce, localRunning, toast } from "../lib/ui-state";
import { unchangedError } from "../lib/unchanged-error";
import { ActionMenu, type ActionMenuApi } from "./ActionMenu";
import { ContextGauge, contextDescribedBy } from "./ContextGauge";
import { Chip, Icon } from "./ui";
import "../orgs.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** What the head, the strip and the composer's `/clear` share for one project overseer's page. */
export interface ProjectOverseerControl {
  projectId: string;
  info(): ProjectOverseerInfo | undefined;
  /** Why the last read failed, while nothing was ever read. */
  error(): string | null;
  refetch(): void;
  /** Its turn runs, whoever started it: this tab's run first, then the list's. */
  busy(): boolean;
  /** An action is in flight: the head's controls wait for it. */
  acting(): boolean;
  /** One action: its result adopted as the latest read, its toast, or its refusal said. */
  act(fn: () => Promise<ProjectOverseerInfo>, done?: string): Promise<boolean>;
  /** A new conversation, opened in place of this one. False when nothing was cleared. */
  clear(): Promise<boolean>;
  /** Another tab cleared it: the chat's runtime went away, so open whichever conversation is current. */
  onReloaded(): void;
}

/**
 * The project overseer page's state (§app.project-overseer/page). Read on open, when its turn
 * ends (the list's busy flips: a watch-loop run flips it too) and after each action; never on a
 * timer, because that read runs git on every coding worktree.
 */
export function createProjectOverseerControl(o: { projectId: string; path: string; summary: () => SessionSummary; onRefresh(): void }): ProjectOverseerControl {
  const [info, { refetch, mutate }] = createResource(() => getProjectOverseer(o.projectId));
  const busy = createMemo(() => !!(localRunning()[o.path] ?? o.summary().busy));
  createEffect(on(busy, () => void refetch(), { defer: true }));
  const [acting, setActing] = createSignal(false);
  const act = async (fn: () => Promise<ProjectOverseerInfo>, done?: string): Promise<boolean> => {
    if (acting()) return false;
    setActing(true);
    try {
      mutate(await fn());
      if (done) {
        toast(done);
        announce(done);
      }
      return true;
    } catch (err) {
      toast(unchangedError(errText(err)));
      return false;
    } finally {
      setActing(false);
    }
  };
  /** Open the current conversation in this one's place (a clear leaves nothing to go back to). */
  const openCurrent = (next: ProjectOverseerInfo) => {
    o.onRefresh();
    if (next.path && next.path !== o.path) location.replace(projectSessionHref(o.projectId, next.path));
  };
  const clear = async (): Promise<boolean> => {
    if (acting()) return false;
    setActing(true);
    try {
      const next = await clearProjectOverseer(o.projectId);
      mutate(next);
      openCurrent(next);
      return true;
    } catch (err) {
      toast(`Couldn't clear the overseer. ${errText(err)}`);
      return false;
    } finally {
      setActing(false);
    }
  };
  return {
    projectId: o.projectId,
    info: () => (info.error ? undefined : info()),
    error: () => (info.error && !info.latest ? errText(info.error) : null),
    refetch: () => void refetch(),
    busy,
    acting,
    act,
    clear,
    onReloaded: () => void getProjectOverseer(o.projectId).then(openCurrent, () => o.onRefresh()),
  };
}

/**
 * The project overseer's own head, in place of the session head on its current conversation
 * (§app.project-overseer/page): What may happen without you, Run Now and ⋯ (Watch, History…, Clear, Project Page)
 * on line 1, the project and what it started on the meta line, then the status strip. On an
 * earlier conversation: its title, age and the way back to the current one, nothing else.
 */
export function ProjectOverseerHead(props: {
  control: ProjectOverseerControl;
  path: string;
  summary: () => SessionSummary;
  now: number;
  /** A cleared conversation, opened read-only from History. */
  earlier: boolean;
  titleRef?: (el: HTMLHeadingElement) => void;
  detailsOpen: boolean;
  onDetails(): void;
}) {
  const c = props.control;
  const s = () => props.summary();
  const projectName = () => c.info()?.projectName ?? s().project?.projectName ?? "this project";
  const age = (at: string) => relativeTime(at, props.now);
  const history = () => c.info()?.history ?? [];

  const save = (x: ProjectOverseerPatch, done: string) => void c.act(() => patchProjectOverseer(c.projectId, x), done);
  const resume = () => save({ resume: true }, brakeDone);
  const runNow = () => {
    if (c.busy() || c.acting()) return;
    void c.act(() => runProjectOverseer(c.projectId), "The overseer is looking now.");
  };
  const runTitle = () => (c.busy() ? "Working now" : "Look at the project now, as the watch loop would.");
  const clearNow = () => void c.clear().then((ok) => ok && announce("Cleared. The previous conversation is in History."));
  /** A screen swap moves focus to its first row, as opening the menu does; with no row, to the trigger. */
  const showScreen = (menu: ActionMenuApi, name: string) => {
    menu.show(name);
    queueMicrotask(() => {
      const row = document.querySelector<HTMLElement>(".action-menu:popover-open [role=menuitem], .action-menu:popover-open .po-powers-panel button");
      if (row) row.focus();
      else menu.focusTrigger();
    });
  };
  const earlierWords = (n: number) => `${n} earlier ${n === 1 ? "conversation" : "conversations"}`;

  /** The same switches as the project page's (§design.copy-deck/project-powers), in a menu panel. */
  const Powers = (p: { info: ProjectOverseerInfo }) => (
    <div class="po-powers-panel">
      <PowersPanel info={p.info} busy={c.acting()} idPrefix="po-powers" compact save={save} />
    </div>
  );
  const powersName = (i: ProjectOverseerInfo) => powersButtonName(powerGroups(i.settings.powers), i.settings.powers, columnsFor(i.settings.powers), i.settings.powers.brake);

  if (props.earlier) {
    return (
      <header class="session-head overseer-head po-head">
        <a
          class="button button-icon button-ghost app-back"
          href={c.info()?.path ? projectSessionHref(c.projectId, c.info()!.path!) : projectHref(c.projectId)}
          aria-label="Back to the overseer"
        >
          <Icon name="chevron-left" />
        </a>
        <div class="session-head-main">
          <h1 class="session-head-title" tabindex="-1" ref={props.titleRef}>
            Earlier Overseer Conversation
          </h1>
          <p class="session-head-meta">
            <span title={s().title}>
              {historyTitle(s().title)} · {age(s().lastActiveAt)}
            </span>
          </p>
        </div>
      </header>
    );
  }

  const chip = () => {
    const i = c.info();
    return i ? headState(i, c.busy()) : c.busy() ? headState({ settings: { powers: { brake: null } } }, true) : null;
  };
  const status = createMemo(() => {
    const i = c.info();
    return i ? statusLines(i, i.lastRun ? age(i.lastRun.at) : "") : null;
  });
  const [moreOpen, setMoreOpen] = createSignal(false);

  return (
    <>
      <header class="session-head overseer-head po-head">
        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
          <Icon name="chevron-left" />
        </a>
        <div class="session-head-main">
          <h1 class="session-head-title" tabindex="-1" ref={props.titleRef} title={s().title} aria-describedby={contextDescribedBy(props.path)}>
            {/* A phone with a state chip shows the eye instead of the word (orgs.css); the word
                stays for AT, and the eye's title names it. */}
            <span class="po-head-title-text">Overseer</span>
            <span class="po-head-title-icon" title={`Overseer · ${projectName()}`}>
              <Icon name="eye" small />
            </span>
          </h1>
          <p class="session-head-meta po-head-meta">
            <a class="po-head-project" href={projectHref(c.projectId)} title={`Open the ${projectName()} page`}>
              {projectName()}
            </a>
            <Show when={s().org?.orgName}>
              {(name) => (
                <span class="po-head-part po-head-org">
                  <span aria-hidden="true">·</span> {name()}
                </span>
              )}
            </Show>
            <Show when={c.info()}>
              {(i) => (
                <>
                  <span class="po-head-part">
                    <span aria-hidden="true">·</span> {i().settings.watch ? "Watching" : "Not watching"}
                  </span>
                  <Show when={i().started.length > 0}>
                    <span class="overseer-count-sep" aria-hidden="true">·</span>
                    <ActionMenu
                      label={`${i().started.length} ${i().started.length === 1 ? "session" : "sessions"} it started, show list`}
                      title="Sessions it started"
                      icon="worker"
                      text={`${i().started.length} started`}
                      class="button-sm button-ghost overseer-count"
                      align="start"
                    >
                      {(menu) => (
                        <div class="overseer-count-list">
                          <For each={i().started}>
                            {(st) => (
                              <menu.Item
                                label={st.title}
                                title={st.title}
                                aria={`${st.title}, ${startedWords(st)}`}
                                description={startedWords(st)}
                                href={st.path ? projectSessionHref(c.projectId, st.path) : undefined}
                                disabled={st.path ? undefined : "On another host"}
                              />
                            )}
                          </For>
                        </div>
                      )}
                    </ActionMenu>
                  </Show>
                </>
              )}
            </Show>
          </p>
        </div>
        <Show when={chip()}>
          {(ch) => (
            <Chip tone={ch().tone} live={ch().tone === "accent"} title={ch().title}>
              {ch().text}
            </Chip>
          )}
        </Show>
        <ContextGauge path={props.path} />
        <Show when={c.info()}>
          {(i) => (
            <ActionMenu label={powersName(i())} title="What may happen without you" icon="sliders" text="Without you" class="button-sm button-ghost po-level po-wide" panelClass="po-powers-menu">
              {() => <Powers info={i()} />}
            </ActionMenu>
          )}
        </Show>
        <button
          type="button"
          class="button button-sm button-ghost po-run po-wide"
          aria-disabled={c.busy() || c.acting() || !c.info() ? "true" : undefined}
          title={runTitle()}
          onClick={runNow}
        >
          Run Now
        </button>
        <ActionMenu label={`Overseer actions · ${projectName()}`} title="Overseer actions" icon="more" class="po-more">
          {(menu) => (
            <Show
              when={menu.screen() === null}
              fallback={
                <Show when={menu.screen() === "history"} fallback={<Show when={c.info()}>{(i) => <Powers info={i()} />}</Show>}>
                  <For each={history()} fallback={<p class="mode-option-note po-menu-state">No earlier conversations yet.</p>}>
                    {(h) => (
                      <menu.Item
                        label={historyTitle(h.title)}
                        title={historyTitle(h.title)}
                        aria={`${historyTitle(h.title)}, ${age(h.lastActiveAt)}`}
                        description={age(h.lastActiveAt)}
                        href={projectSessionHref(c.projectId, h.path)}
                      />
                    )}
                  </For>
                </Show>
              }
            >
              {/* Below 480px What may happen without you and Run Now leave line 1 and live here. */}
              <div class="po-menu-narrow">
                <menu.Item label="Run Now" aria="Run Now" disabled={c.busy() ? "Working now" : undefined} onRun={runNow} />
                <menu.Item label="Without You…" aria={c.info() ? powersName(c.info()!) : "What may happen without you"} stayOpen onRun={() => showScreen(menu, "powers")} />
              </div>
              <Show when={c.info()}>
                {(i) => (
                  <menu.Item
                    label={i().settings.watch ? "Stop Watching" : "Start Watching"}
                    aria={i().settings.watch ? "Stop watching the project" : "Start watching the project"}
                    onRun={() => {
                      const watch = !i().settings.watch;
                      void c.act(() => patchProjectOverseer(c.projectId, { watch }), watch ? "Watching." : "Not watching.");
                    }}
                  />
                )}
              </Show>
              <menu.Item label="History…" aria={`History, ${earlierWords(history().length)}`} description={history().length ? `${history().length} earlier` : undefined} stayOpen onRun={() => showScreen(menu, "history")} />
              <menu.Item
                label="Clear"
                aria="Clear: start a new conversation"
                description="Start a new conversation. This one moves to History."
                onRun={clearNow}
              />
              <menu.Item label="Project Page" aria={`Open the ${projectName()} page`} href={projectHref(c.projectId)} />
            </Show>
          )}
        </ActionMenu>
        <button
          type="button"
          class="button button-icon button-ghost session-details-open"
          aria-label="Session details"
          title="Session details"
          aria-controls="session-pane"
          aria-expanded={props.detailsOpen}
          onClick={() => props.onDetails()}
        >
          <Icon name="info" />
        </button>
      </header>
      <Show
        when={status()}
        fallback={
          <Show when={c.error()}>
            {(e) => (
              <section class="po-status" aria-label="Overseer status">
                <p class="po-status-line">
                  Couldn't read its status. {e()}{" "}
                  <button type="button" class="button button-sm button-ghost" onClick={() => c.refetch()}>
                    Try Again
                  </button>
                </p>
              </section>
            )}
          </Show>
        }
      >
        {(st) => (
          <section class="po-status" classList={{ "po-status-open": moreOpen() }} aria-label="Overseer status">
            {/* Line 1 is a row: its sentence, then Resume (while braked) and Details (below 480px),
                standard small buttons that never wrap under the sentence on their own. */}
            <div class="po-status-first">
              <p class="po-status-line" title={st().pendingTitle || undefined}>
                {st().lines[0]}
              </p>
              <Show when={st().resume || st().lines.length > 1}>
                <div class="po-status-actions">
                  <Show when={st().resume}>
                    <button type="button" class="button button-sm" aria-disabled={c.acting() ? "true" : undefined} onClick={() => !c.acting() && resume()}>
                      Resume
                    </button>
                  </Show>
                  <Show when={st().lines.length > 1}>
                    <button type="button" class="button button-sm button-ghost po-status-toggle" aria-expanded={moreOpen()} onClick={() => setMoreOpen((v) => !v)}>
                      Details
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
            <For each={st().lines.slice(1)}>{(line) => <p class="po-status-line po-status-more">{line}</p>}</For>
          </section>
        )}
      </Show>
    </>
  );
}
