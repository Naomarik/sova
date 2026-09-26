import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show } from "solid-js";
import type { AttentionDigest, OverseerInfo, OverseerProactivity, SessionSummary } from "../../shared/protocol";
import { clearOverseer, getOverseer, getOverseerIdeas, getOverseerSettings, getOverseerTodos, putOverseerSettings } from "../lib/api";
import { relativeTime, shortModel } from "../lib/format";
import { type HeadList, headLists, nextProactivity, OVERSEER_HASH, overseerHistoryHref, PROACTIVITY_HINT, PROACTIVITY_LABEL } from "../lib/overseer";
import { isMainThread } from "../lib/regions";
import { settingsOpenAt } from "../lib/settings-nav";
import { announce, toast } from "../lib/ui-state";
import { sessionWorking } from "../lib/workers";
import { ActionMenu } from "./ActionMenu";
import type { OverseerChat, OverseerSender } from "./ChatView";
import { ContextGauge } from "./ContextGauge";
import { OverseerIdeas } from "./OverseerIdeas";
import { OverseerTodos } from "./OverseerTodos";
import type { PaneWiring } from "./GroupView";
import { SessionView } from "./SessionView";
import { Icon } from "./ui";
import { WatchView } from "./WatchView";

const sentenceOf = (m: string) => (/[.!?]$/.test(m) ? m : `${m}.`);

/** Words for a count of sessions: "1 session", "3 sessions". */
const sessions = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

/** The attention digest as App reads it for the whole page (one poll, shared with the sidebar). */
export interface AttentionFeed {
  data(): AttentionDigest | undefined;
  /** Message of the latest failed read, cleared by the next success. */
  error(): string | null;
  /** A read is in flight. */
  reading(): boolean;
  refetch(): void;
}

/**
 * The Overseer's page (`#/overseer`): the ordinary chat on its current file, plus what no other
 * chat has — its own head (proactivity, History, Clear), `/clear`, quick actions, confirm cards
 * and navigation. The view is keyed on the file's path, so a clear (here or in another tab)
 * mounts a fresh chat on the new file. `#/overseer/h/<id>` shows an earlier file, read only.
 */
export function OverseerView(props: {
  info: OverseerInfo | undefined;
  /** Why the last read of the Overseer failed, while it has never been read. */
  error?: string | null;
  /** The info a request just returned (a clear): adopt it as the latest. */
  onInfo(info: OverseerInfo): void;
  refetch(): void;
  /** The attention digest: the head's finished and drafts menus list from it. */
  attention: AttentionFeed;
  /** An earlier Overseer file to read, from `#/overseer/h/<id>`. */
  historyId: string | null;
  sessions: SessionSummary[];
  wiring: PaneWiring;
  titleRef?: (el: HTMLHeadingElement) => void;
}) {
  // Quick actions and proactivity come from the settings file. Re-read whenever the Settings
  // dialog closes: that is the one place they are edited besides the head's own control.
  const [settings, { refetch: refetchSettings, mutate: setSettings }] = createResource(getOverseerSettings);
  createEffect(on(settingsOpenAt, (open) => open === null && void refetchSettings(), { defer: true }));
  const quickActions = () => (settings.error ? [] : (settings()?.settings.quickActions ?? []));

  /** A reload of the runtime (another tab cleared) remounts the chat even when the path is the same. */
  const [mount, setMount] = createSignal(0);
  const viewKey = createMemo(() => (props.info ? `${props.info.path}#${mount()}` : null));

  const main = createMemo(() => props.sessions.filter(isMainThread));
  const working = () => main().filter((s) => s.busy || sessionWorking(s) > 0 || s.activity?.state === "working").length;
  const act = () => props.info?.badge.act ?? 0;
  /** The head's one line: what the Overseer is watching, as counts. "N finished" and "N drafts" are the menus after it. */
  const facts = () => {
    const parts = [`${sessions(main().length)}`];
    if (working()) parts.push(`${working()} working`);
    if (act()) parts.push(`${act()} ${act() === 1 ? "needs" : "need"} you`);
    return parts.join(" · ");
  };

  // ---- Finished and drafts: two menus read from the attention digest, so each count is its list --
  // App polls it for the whole page; opening the page reads it once more, so the menus start fresh.
  onMount(() => props.attention.refetch());
  const lists = createMemo(() => {
    const d = props.attention.data();
    return d ? headLists(d) : undefined;
  });

  // ---- Ideas: the backlog the Overseer files, in a panel over the chat's right side -----------
  const [ideasOpen, setIdeasOpen] = createSignal(false);
  const [ideas, { refetch: refetchIdeas }] = createResource(getOverseerIdeas);
  const ideasInfo = () => (ideas.error ? undefined : ideas());
  const ideasError = () => (ideas.error ? ((ideas.error as Error).message ?? String(ideas.error)) : null);
  /** Bumps when the backlog may have changed: an Overseer turn ended, or (panel open) the list refreshed. */
  const [ideasVersion, setIdeasVersion] = createSignal(0);
  const bumpIdeas = () => {
    setIdeasVersion((v) => v + 1);
    void refetchIdeas();
  };
  createEffect(on(() => !!props.info?.busy, (busy, was) => was && !busy && bumpIdeas(), { defer: true }));
  createEffect(on(() => props.wiring.listVersion, () => ideasOpen() && bumpIdeas(), { defer: true }));
  createEffect(on(ideasOpen, (open) => open && void refetchIdeas(), { defer: true }));
  const [sender, setSender] = createSignal<OverseerSender | null>(null);
  let ideasButton: HTMLButtonElement | undefined;
  const closeIdeas = () => {
    setIdeasOpen(false);
    queueMicrotask(() => ideasButton?.focus());
  };

  // ---- Todos: the user's checklist, in the same place as Ideas (one of the two open at a time) --
  const [todosOpen, setTodosOpen] = createSignal(false);
  /** The head's count. The open panel polls and reports it; closed, it is read on mount and after each turn. */
  const [openTodos, setOpenTodos] = createSignal<number | null>(null);
  const readTodosCount = () => void getOverseerTodos().then((t) => setOpenTodos(t.open), () => undefined);
  readTodosCount();
  const [todosVersion, setTodosVersion] = createSignal(0);
  createEffect(on(() => !!props.info?.busy, (busy, was) => was && !busy && (todosOpen() ? setTodosVersion((v) => v + 1) : readTodosCount()), { defer: true }));
  createEffect(on(ideasOpen, (open) => open && setTodosOpen(false), { defer: true }));
  createEffect(on(todosOpen, (open) => open && setIdeasOpen(false), { defer: true }));
  let todosButton: HTMLButtonElement | undefined;
  const closeTodos = () => {
    setTodosOpen(false);
    queueMicrotask(() => todosButton?.focus());
  };

  const [clearing, setClearing] = createSignal(false);
  const clear = async (): Promise<boolean> => {
    if (clearing()) return false;
    setClearing(true);
    try {
      const next = await clearOverseer();
      props.onInfo(next);
      return true;
    } catch (err) {
      toast(`Couldn't clear the Overseer. ${(err as Error).message}`);
      return false;
    } finally {
      setClearing(false);
    }
  };

  // ---- Proactivity: Off → Badge → Brief me, one button that says where it is ----------------
  const [proactivity, setProactivity] = createSignal<OverseerProactivity | null>(null);
  createEffect(() => {
    const p = settings.error ? undefined : settings()?.settings.proactivity;
    if (p) setProactivity(p);
  });
  const shownProactivity = (): OverseerProactivity => proactivity() ?? props.info?.proactivity ?? "badge";
  const [savingProactivity, setSavingProactivity] = createSignal(false);
  const cycleProactivity = async () => {
    if (savingProactivity()) return;
    const before = shownProactivity();
    const next = nextProactivity(before);
    setProactivity(next);
    setSavingProactivity(true);
    try {
      // The whole file goes back: read it fresh so a save elsewhere isn't undone.
      const current = await getOverseerSettings();
      const saved = await putOverseerSettings({ ...current.settings, proactivity: next });
      setSettings(saved);
      announce(`Proactivity: ${PROACTIVITY_LABEL[next]}. ${PROACTIVITY_HINT[next]}`);
      props.refetch();
    } catch (err) {
      setProactivity(before);
      toast(`Proactivity unchanged. ${(err as Error).message}`);
    } finally {
      setSavingProactivity(false);
    }
  };

  const overseer: OverseerChat = {
    quickActions,
    // A remount can bind the new chat before the old one unbinds: only the bound one clears.
    bindSender: (s) => {
      setSender(() => s);
      return () => setSender((cur) => (cur === s ? null : cur));
    },
    onClear: clear,
    // Read the route afresh BEFORE remounting: a remount on the old path would reopen a file the
    // clear just retired. A new path remounts through the key; the same path needs the bump.
    onReloaded: () => {
      const was = props.info?.path;
      void getOverseer()
        .then((info) => {
          props.onInfo(info);
          if (info.path === was) setMount((n) => n + 1);
        })
        .catch(() => setMount((n) => n + 1));
    },
    empty: () => (
      <div class="empty overseer-empty">
        <Icon name="eye" class="empty-mark" />
        <p class="empty-title">
          {working() ? `${sessions(working())} working` : `${sessions(main().length)}, none working`}
          {act() ? `, ${act()} ${act() === 1 ? "needs" : "need"} you.` : "."}
        </p>
        <p class="empty-body">Ask below, or pick a quick action.</p>
      </div>
    ),
  };

  /** A file with no message yet is "Untitled" to the list; here it is said as what it is. */
  const history = () => (props.info?.history ?? []).map((h) => (h.title === "Untitled" ? { ...h, title: "No messages" } : h));
  const Head = (p: { earlier?: { title: string; lastActiveAt: string } }) => (
    <header class="session-head overseer-head">
      <a class="button button-icon button-ghost app-back" href={p.earlier ? OVERSEER_HASH : "#/"} aria-label={p.earlier ? "Back to the Overseer" : "Back to Sessions"}>
        <Icon name="chevron-left" />
      </a>
      <div class="session-head-main">
        <h1 class="session-head-title" tabindex="-1" ref={props.titleRef}>
          {p.earlier ? "Earlier Overseer Conversation" : "Overseer"}
        </h1>
        <p class="session-head-meta">
          <Show
            when={p.earlier}
            fallback={
              <>
                <span title={facts()}>{facts()}</span>
                <HeadMenu kind={FINISHED} list={lists()?.finished} error={props.attention.error()} reading={props.attention.reading()} retry={props.attention.refetch} now={props.wiring.now} />
                <HeadMenu kind={DRAFTS} list={lists()?.drafts} error={props.attention.error()} reading={props.attention.reading()} retry={props.attention.refetch} now={props.wiring.now} />
              </>
            }
          >
            {(e) => (
              <span title={e().title}>
                {e().title} · {relativeTime(e().lastActiveAt, props.wiring.now)}
              </span>
            )}
          </Show>
        </p>
      </div>
      <Show when={!p.earlier && props.info}>
        {(info) => (
          <>
        <ContextGauge path={info().path} />
        <button
          type="button"
          class="button button-sm button-ghost overseer-proactivity"
          aria-label={`Proactivity: ${PROACTIVITY_LABEL[shownProactivity()]}. Change to ${PROACTIVITY_LABEL[nextProactivity(shownProactivity())]}.`}
          title={`${PROACTIVITY_HINT[shownProactivity()]} Press to change.`}
          aria-disabled={savingProactivity() ? "true" : undefined}
          onClick={() => void cycleProactivity()}
        >
          <Icon name="bell" small />
          {PROACTIVITY_LABEL[shownProactivity()]}
        </button>
          </>
        )}
      </Show>
      <Show when={!p.earlier && props.info}>
        <button
          type="button"
          class="button button-sm button-ghost overseer-ideas-toggle"
          ref={ideasButton}
          aria-expanded={ideasOpen()}
          aria-controls="overseer-ideas"
          aria-label={ideasInfo() ? `Ideas, ${ideasInfo()!.toc.total}` : "Ideas"}
          title="The ideas the Overseer has filed for later."
          onClick={() => (ideasOpen() ? closeIdeas() : setIdeasOpen(true))}
        >
          <Icon name="star" small />
          <span class="overseer-ideas-word">Ideas</span>
          <Show when={ideasInfo()}>{(i) => <span class="chip chip-count">{i().toc.total}</span>}</Show>
        </button>
        <button
          type="button"
          class="button button-sm button-ghost overseer-todos-toggle"
          ref={todosButton}
          aria-expanded={todosOpen()}
          aria-controls="overseer-todos"
          aria-label={openTodos() === null ? "Todos" : `Todos, ${openTodos()} open`}
          title="Your todos: small tasks you or the Overseer noted."
          onClick={() => (todosOpen() ? closeTodos() : setTodosOpen(true))}
        >
          <Icon name="check" small />
          <span class="overseer-todos-word">Todos</span>
          <Show when={openTodos() !== null}>
            <span class="chip chip-count">{openTodos()}</span>
          </Show>
        </button>
      </Show>
      <Show when={history().length > 0}>
        <ActionMenu label="Earlier Overseer conversations" title="Earlier conversations" icon="clock" text="History" class="button-sm">
          {(menu) => (
            <For each={history()}>
              {(h) => (
                <menu.Item
                  label={h.title}
                  title={h.title}
                  aria={`${h.title}, ${relativeTime(h.lastActiveAt, props.wiring.now)}`}
                  description={relativeTime(h.lastActiveAt, props.wiring.now)}
                  href={overseerHistoryHref(h.id)}
                />
              )}
            </For>
          )}
        </ActionMenu>
      </Show>
      <Show when={!p.earlier}>
        <button
          type="button"
          class="button button-sm"
          title="Start a new conversation. This one moves to History. Same as /clear."
          aria-disabled={clearing() || !props.info ? "true" : undefined}
          onClick={() => {
            void clear().then((ok) => ok && announce("Cleared. The previous conversation is in History."));
          }}
        >
          Clear
        </button>
      </Show>
    </header>
  );

  /** The list's row for a path, else one built from what the Overseer route knows. */
  const summaryFor = (path: string, id: string, title: string): SessionSummary =>
    props.sessions.find((s) => s.path === path) ?? {
      id,
      path,
      cwd: "",
      title,
      createdAt: "",
      lastActiveAt: "",
      model: null,
      live: null,
      busy: !!props.info?.busy,
      origin: "web",
      archived: false,
    };

  const earlier = () => {
    const id = props.historyId;
    return id ? (history().find((h) => h.id === id) ?? null) : null;
  };

  return (
    <Show
      when={!props.historyId}
      fallback={
        <Show
          when={earlier()}
          fallback={
            <div class="center-fill">
              <div class="empty">
                <p class="empty-title">
                  <Show when={props.info} fallback="Loading the Overseer.">
                    That conversation isn't in the Overseer's history anymore.
                  </Show>
                </p>
                <p class="empty-body">It keeps the last 20.</p>
                <a class="button empty-action" href={OVERSEER_HASH}>
                  Back to the Overseer
                </a>
              </div>
            </div>
          }
        >
          {(e) => (
            <Show when={e().path} keyed>
              {(path) => (
                <>
                  <Head earlier={e()} />
                  <WatchView
                    path={path}
                    author={shortModel(summaryFor(path, e().id, e().title).model) ?? "pi"}
                    streaming={false}
                    stateBanner={<></>}
                    readOnly={{ icon: "clock", text: "An earlier conversation. Read only." }}
                  />
                </>
              )}
            </Show>
          )}
        </Show>
      }
    >
      <Show
        when={viewKey()}
        keyed
        fallback={
          <div class="center-fill">
            <div class="empty">
              <Show when={props.error} fallback={<p class="empty-title">Starting the Overseer.</p>}>
                {(e) => (
                  <>
                    <p class="empty-title">Couldn't open the Overseer.</p>
                    <p class="empty-body">{sentenceOf(e())} Nothing was changed.</p>
                    <button type="button" class="button empty-action" onClick={() => props.refetch()}>
                      Try Again
                    </button>
                  </>
                )}
              </Show>
            </div>
          </div>
        }
      >
        {(_key) => {
          const info = props.info!;
          const path = info.path;
          const summary = () => summaryFor(path, info.id, "Overseer");
          const w = props.wiring;
          return (
            <>
            <SessionView
              path={path}
              summary={summary}
              head={() => <Head />}
              overseer={overseer}
              listVersion={w.listVersion}
              now={w.now}
              onRefresh={w.onRefresh}
              onCreated={w.onCreated}
              onArchiveChanged={w.onArchiveChanged}
              onInsight={w.onInsight}
              onWorkers={w.onWorkers}
              onRewindControl={w.onRewindControl}
              onRewound={w.onRewound}
              paneOn={w.paneOn}
              openPane={w.openPane}
              toggleSubagents={w.toggleSubagents}
              showTimeline={w.showTimeline}
              inputsOnly={w.inputsOnly}
              subagentsPath={w.subagentsPath}
              onNewSession={w.onNewSession}
            />
            <Show when={ideasOpen()}>
              <OverseerIdeas
                ideas={ideasInfo()}
                error={ideasError()}
                refetch={bumpIdeas}
                version={ideasVersion()}
                sender={sender}
                now={w.now}
                onClose={closeIdeas}
                onSent={() => {
                  // Folded, the panel covers the chat: step aside so the Overseer's answer shows.
                  if (!window.matchMedia("(min-width: 768px)").matches) closeIdeas();
                }}
              />
            </Show>
            <Show when={todosOpen()}>
              <OverseerTodos version={todosVersion()} onCount={setOpenTodos} onClose={closeTodos} />
            </Show>
            </>
          );
        }}
      </Show>
    </Show>
  );
}

/** The words one head menu uses: "3 finished" and its list, or "2 drafts" and its list. */
interface HeadMenuKind {
  count(n: number): string;
  /** The trigger's accessible name: "3 finished sessions", "1 draft". */
  name(n: number): string;
  title: string;
  icon: "check" | "pencil";
  /** What a read is of: "the finished sessions". */
  subject: string;
  empty: string;
  cut: string;
}

const FINISHED: HeadMenuKind = {
  count: (n) => `${n} finished`,
  name: (n) => `${n} finished ${n === 1 ? "session" : "sessions"}`,
  title: "Finished sessions",
  icon: "check",
  subject: "the finished sessions",
  empty: "Nothing finished right now.",
  cut: "Some finished sessions may not be listed: this list stops at the 30 most urgent items.",
};

const DRAFTS: HeadMenuKind = {
  count: (n) => `${n} ${n === 1 ? "draft" : "drafts"}`,
  name: (n) => `${n} ${n === 1 ? "draft" : "drafts"}`,
  title: "Drafts and queued messages",
  icon: "pencil",
  subject: "the drafts",
  empty: "No drafts right now.",
  cut: "Some drafts may not be listed: this list stops at the 30 most urgent items.",
};

/**
 * One count in the head's meta line that opens the list of its sessions. Its number is its rows,
 * read from the digest poll; it is hidden at 0 unless its menu is open, where a list that emptied
 * says so instead of vanishing under the pointer.
 */
function HeadMenu(props: { kind: HeadMenuKind; list: HeadList | undefined; error: string | null; reading: boolean; retry(): void; now: number }) {
  const [open, setOpen] = createSignal(false);
  const n = () => props.list?.rows.length ?? 0;
  let body: HTMLDivElement | undefined;
  let retried = false;
  // After Try Again the pressed row goes with the error: put focus on the first row, and say how it went.
  createEffect(
    on(
      () => props.reading,
      (reading) => {
        if (reading || !retried) return;
        retried = false;
        // A task, not a microtask: the poll stores the result after the read itself settles.
        setTimeout(() => {
          if (props.error) announce(`Couldn't read ${props.kind.subject}.`);
          // Only when focus went with the pressed row: never pull it back from where the user took it.
          const at = document.activeElement;
          if (!body?.closest(":popover-open") || (at && at !== document.body)) return;
          body.querySelector<HTMLElement>("[role=menuitem]")?.focus();
        });
      },
      { defer: true },
    ),
  );
  const note = (r: { where: string; since: number }) => [r.where, r.since ? relativeTime(r.since, props.now) : ""].filter(Boolean).join(" · ");
  const retry = () => {
    retried = true;
    props.retry();
  };
  return (
    <Show when={n() > 0 || open()}>
      <span class="overseer-count-sep" aria-hidden="true">·</span>
      {/* `contain` portals the panel out of this line, whose nowrap and caption styles would
          otherwise reach the rows. */}
      <ActionMenu
        label={`${props.kind.name(n())}, show list`}
        title={props.kind.title}
        icon={props.kind.icon}
        text={props.kind.count(n())}
        class="button-sm button-ghost overseer-count"
        align="start"
        contain
        onToggle={setOpen}
      >
        {(menu) => (
          <div class="overseer-count-list" ref={body}>
            <Show when={props.reading && (props.error || !props.list)}>
              <p class="mode-option-note overseer-count-state">Reading {props.kind.subject}.</p>
            </Show>
            <Show when={!props.reading && props.error}>
              {(message) => (
                <>
                  <p class="mode-option-note overseer-count-state">
                    Couldn't read {props.kind.subject}. {sentenceOf(message())} Nothing was changed.
                  </p>
                  <menu.Item label="Try Again" aria={`Read ${props.kind.subject} again`} stayOpen onRun={retry} />
                </>
              )}
            </Show>
            <Show when={props.list}>
              {(list) => (
                <>
                  <For each={list().rows} fallback={<p class="mode-option-note overseer-count-state">{props.kind.empty}</p>}>
                    {(r) => <menu.Item label={r.title} title={r.title} aria={`${r.title}, ${note(r)}`} description={note(r)} href={r.href} />}
                  </For>
                  <Show when={list().cut}>
                    <p class="mode-option-note overseer-count-state">{props.kind.cut}</p>
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
      </ActionMenu>
    </Show>
  );
}
