import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING, type Autonomy, type ProjectOverseerInfo } from "../../shared/project-overseer";
import { ApiError, clearProjectOverseer, getProjectOverseer, patchProjectOverseer, runProjectOverseer } from "../lib/api";
import { relativeTime } from "../lib/format";
import { orgSessionHref, projectHref } from "../lib/orgs-route";
import { headState, historyTitle, levelName, startedWords, statusLines } from "../lib/project-overseer-view";
import { announce, localRunning, toast } from "../lib/ui-state";
import { unchangedError } from "../lib/unchanged-error";
import { ActionMenu, type ActionMenuApi } from "./ActionMenu";
import { ContextGauge, contextDescribedBy } from "./ContextGauge";
import { Chip, Icon } from "./ui";
import "../orgs.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** What the head, the strip and the composer's `/clear` share for one project overseer's page. */
export interface ProjectOverseerControl {
  orgId: string;
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
export function createProjectOverseerControl(o: { orgId: string; projectId: string; path: string; summary: () => SessionSummary; onRefresh(): void }): ProjectOverseerControl {
  const [info, { refetch, mutate }] = createResource(() => getProjectOverseer(o.orgId, o.projectId));
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
    if (next.path && next.path !== o.path) location.replace(orgSessionHref(o.orgId, next.path));
  };
  const clear = async (): Promise<boolean> => {
    if (acting()) return false;
    setActing(true);
    try {
      const next = await clearProjectOverseer(o.orgId, o.projectId);
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
    orgId: o.orgId,
    projectId: o.projectId,
    info: () => (info.error ? undefined : info()),
    error: () => (info.error && !info.latest ? errText(info.error) : null),
    refetch: () => void refetch(),
    busy,
    acting,
    act,
    clear,
    onReloaded: () => void getProjectOverseer(o.orgId, o.projectId).then(openCurrent, () => o.onRefresh()),
  };
}

/**
 * The project overseer's own head, in place of the session head on its current conversation
 * (§app.project-overseer/page): the level, Run Now and ⋯ (Watch, History…, Clear, Project Page)
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
  const projectName = () => c.info()?.projectName ?? s().org?.projectName ?? "this project";
  const age = (at: string) => relativeTime(at, props.now);
  const history = () => c.info()?.history ?? [];

  const setLevel = (level: Autonomy) => void c.act(() => patchProjectOverseer(c.orgId, c.projectId, { autonomy: level }), `Level: ${level}.`);
  const runNow = () => {
    if (c.busy() || c.acting()) return;
    void c.act(() => runProjectOverseer(c.orgId, c.projectId), "The overseer is looking now.");
  };
  const runTitle = () => (c.busy() ? "Working now" : "Look at the project now, as the watch loop would.");
  const clearNow = () => void c.clear().then((ok) => ok && announce("Cleared. The previous conversation is in History."));
  /** A screen swap moves focus to its first row, as opening the menu does; with no row, to the trigger. */
  const showScreen = (menu: ActionMenuApi, name: string) => {
    menu.show(name);
    queueMicrotask(() => {
      const row = document.querySelector<HTMLElement>(".action-menu:popover-open [role=menuitem]");
      if (row) row.focus();
      else menu.focusTrigger();
    });
  };
  const earlierWords = (n: number) => `${n} earlier ${n === 1 ? "conversation" : "conversations"}`;

  const LevelRows = (p: { menu: ActionMenuApi }) => (
    <For each={AUTONOMY_LEVELS}>
      {(level) => {
        const chosen = () => c.info()?.settings.autonomy === level;
        return (
          <p.menu.Item
            label={level}
            icon={chosen() ? <Icon name="check" small /> : <span class="po-level-spacer" aria-hidden="true" />}
            aria={`${level}, ${AUTONOMY_MEANING[level]}${chosen() ? " Chosen." : ""}`}
            description={AUTONOMY_MEANING[level]}
            onRun={() => setLevel(level)}
          />
        );
      }}
    </For>
  );

  if (props.earlier) {
    return (
      <header class="session-head overseer-head po-head">
        <a
          class="button button-icon button-ghost app-back"
          href={c.info()?.path ? orgSessionHref(c.orgId, c.info()!.path!) : projectHref(c.orgId, c.projectId)}
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
    return i ? headState(i, c.busy()) : c.busy() ? headState({ settings: { autonomy: "L0" }, effective: { autonomy: "L0" } }, true) : null;
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
            Overseer
          </h1>
          <p class="session-head-meta po-head-meta">
            <a class="po-head-project" href={projectHref(c.orgId, c.projectId)} title={`Open the ${projectName()} page`}>
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
                                href={st.path ? orgSessionHref(c.orgId, st.path) : undefined}
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
            <ActionMenu label={levelName(i())} title="What it may do on its own" icon="sliders" text={i().settings.autonomy} class="button-sm button-ghost po-level po-wide">
              {(menu) => <LevelRows menu={menu} />}
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
                <Show when={menu.screen() === "history"} fallback={<LevelRows menu={menu} />}>
                  <For each={history()} fallback={<p class="mode-option-note po-menu-state">No earlier conversations yet.</p>}>
                    {(h) => (
                      <menu.Item
                        label={historyTitle(h.title)}
                        title={historyTitle(h.title)}
                        aria={`${historyTitle(h.title)}, ${age(h.lastActiveAt)}`}
                        description={age(h.lastActiveAt)}
                        href={orgSessionHref(c.orgId, h.path)}
                      />
                    )}
                  </For>
                </Show>
              }
            >
              {/* Below 480px the level and Run Now leave line 1 and live here. */}
              <div class="po-menu-narrow">
                <menu.Item label="Run Now" aria="Run Now" disabled={c.busy() ? "Working now" : undefined} onRun={runNow} />
                <menu.Item label="Level…" aria={c.info() ? levelName(c.info()!) : "Level"} description={c.info()?.settings.autonomy} stayOpen onRun={() => showScreen(menu, "level")} />
              </div>
              <Show when={c.info()}>
                {(i) => (
                  <menu.Item
                    label={i().settings.watch ? "Stop Watching" : "Start Watching"}
                    aria={i().settings.watch ? "Stop watching the project" : "Start watching the project"}
                    onRun={() => {
                      const watch = !i().settings.watch;
                      void c.act(() => patchProjectOverseer(c.orgId, c.projectId, { watch }), watch ? "Watching." : "Not watching.");
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
              <menu.Item label="Project Page" aria={`Open the ${projectName()} page`} href={projectHref(c.orgId, c.projectId)} />
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
            <p class="po-status-line" title={st().pendingTitle || undefined}>
              {st().lines[0]}
              <Show when={st().resume}>
                {(level) => (
                  <>
                    {" "}
                    <button type="button" class="button button-sm" aria-disabled={c.acting() ? "true" : undefined} onClick={() => setLevel(level())}>
                      Resume at {level()}
                    </button>
                  </>
                )}
              </Show>
              <Show when={st().lines.length > 1}>
                {" "}
                <button type="button" class="button button-sm button-ghost po-status-toggle" aria-expanded={moreOpen()} onClick={() => setMoreOpen((v) => !v)}>
                  Details
                </button>
              </Show>
            </p>
            <For each={st().lines.slice(1)}>{(line) => <p class="po-status-line po-status-more">{line}</p>}</For>
          </section>
        )}
      </Show>
    </>
  );
}
