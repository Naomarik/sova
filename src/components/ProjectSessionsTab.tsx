import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { CodingWorktree, ProjectWorktrees } from "../../shared/project-overseer";
import type { AttentionDigest, CodingWorktreeHold, SessionSummary } from "../../shared/protocol";
import { ApiError, codingWorktreeHold, getSessionSummaryById, mergeCodingWorktree, removeCodingWorktree, removeCodingWorktreeAnyway, startProjectCoding } from "../lib/api";
import { codingRows, rowGestures, type CodingRow } from "../lib/coding-worktrees";
import { ForKey } from "../lib/for-key";
import { relativeTime, shortDate, tildePath } from "../lib/format";
import { land, refusal } from "../lib/merge-queue-client";
import { queueRow } from "../lib/merge-queue";
import { createProjectQueue } from "../lib/project-queue";
import { agentsFeed, wantAgentsTokens } from "../lib/agents-feed";
import { rateCell, rowRates } from "../lib/agents-board";
import { showSummaries } from "../lib/summary-line";
import { summaryLineOf, summaryTitleOf } from "../lib/summary-row";
import {
  ageWords,
  GROUP_NAME,
  groupCount,
  groupSessions,
  isQuiet,
  landedFoldWords,
  needsYouIds,
  OLD_DAYS,
  sessionBranches,
  branchLines,
  rowLand,
  waitsOnYou,
  type BranchState,
  type SessionFacts,
} from "../lib/project-sessions";
import { unchangedError } from "../lib/unchanged-error";
import { adoptSession, announce, home, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import type { ProjectOverseer } from "./ProjectOverseerPanel";
import { RemoveAnywayListing } from "./RemoveAnywayListing";
import { Icon, Placeholder } from "./ui";
import "../project-sessions.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const sessionHref = (path: string) => `#/s/${encodeURIComponent(path)}`;
/** A coding session nobody has written in yet (New Coding Session, before its first message). */
const UNTITLED_CODING = "Untitled coding session";
/** Landed rows shown at a time once the group is open. */
const LANDED_PAGE = 50;

/** One row as the tab draws it: the session, what the list knows of it, and its branches in words. */
interface SessionView {
  row: CodingRow;
  s: SessionSummary | undefined;
  branches: BranchState[];
  facts: SessionFacts & { position?: number };
}

/**
 * The project page's Sessions tab (§app.project-overseer/coding-worktrees): every coding session the project started,
 * the overseer's and the operator's, in one list grouped by what needs you first. Each row is one link to its chat,
 * with its state, last activity, summary and branches with their landing state, Land on a ready one, and a ⋯ menu
 * for Remove Worktree (and Merge Branch where the project has no merge queue). New Coding Session sits top right.
 * Rows come from the overseer read (no git), else the session list; each row's branch facts from the branch read,
 * a moment later.
 */
export function SessionsTab(props: {
  po: ProjectOverseer;
  /** The project is archived: New Coding Session is disabled, "Archived". */
  archived?: boolean;
  /** The sidebar's session list: each row's activity, summary, branches and readiness, joined by session id. */
  sessions?: () => readonly SessionSummary[] | undefined;
  /** The attention digest App holds: Needs you is the sidebar's own rule over it. */
  attention?: () => AttentionDigest | undefined;
}) {
  const po = () => props.po;
  const wt = () => po().worktrees.data();
  const rows = createMemo(() => codingRows(po().info.data()?.coding, po().listed(), wt()?.sessions));
  const queue = createProjectQueue(() => po().projectId());
  const unknown = () => !rows().length && !po().info.data() && !wt();

  /** The project's coding sessions in the session list, by id. */
  const listed = createMemo(() => {
    const m = new Map<string, SessionSummary>();
    for (const s of props.sessions?.() ?? []) if (s.project?.kind === "coding" && s.project.projectId === po().projectId()) m.set(s.id, s);
    return m;
  });
  const needs = createMemo(() => {
    const list = [...listed().values()];
    const d = props.attention?.();
    return d ? needsYouIds(d, list) : new Set(list.filter(waitsOnYou).map((s) => s.id));
  });

  // A minute's clock for "active 4m ago" and the Old threshold; groups move only when a read or this changes them.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 60_000);
  onCleanup(() => clearInterval(tick));

  const views = createMemo((): SessionView[] =>
    rows().map((row) => {
      const s = listed().get(row.sessionId);
      const branches = sessionBranches(row, s, (branch) => {
        const q = queue.info(branch);
        if (!q) return undefined;
        return {
          position: q.position,
          landedAt: q.landed?.at,
          row: queueRow({ status: "active", exists: true, readiness: undefined, branch, queue: q, ...(queue.setUp() ? { mergeServed: true as const } : {}) }),
        };
      });
      const lastActive = Date.parse(s?.lastActiveAt ?? row.createdAt) || 0;
      const positions = branches.map((b) => b.position).filter((p): p is number => p !== undefined);
      return {
        row,
        s,
        branches,
        facts: {
          needsYou: needs().has(row.sessionId),
          working: row.running || !!s?.busy,
          lastActive,
          stages: branches.map((b) => b.stage),
          ...(positions.length ? { position: Math.min(...positions) } : {}),
        },
      };
    }),
  );
  const groups = createMemo(() => groupSessions(views(), (v) => v.facts, now()));

  // Token rates: the app's one agents poll asks for each session's tokens while a row here is working.
  const anyWorking = createMemo(() => views().some((v) => v.facts.working));
  createEffect(() => {
    if (anyWorking()) onCleanup(wantAgentsTokens());
  });
  const rates = createMemo(() => rowRates(agentsFeed()?.tokens, now()));
  const tokensReported = () => agentsFeed()?.tokens !== undefined;

  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [working, setWorking] = createSignal<string | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [startError, setStartError] = createSignal<string | null>(null);
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [openBranches, setOpenBranches] = createSignal<ReadonlySet<string>>(new Set());
  const [landedOpen, setLandedOpen] = createSignal(false);
  const [landedShown, setLandedShown] = createSignal(LANDED_PAGE);

  const start = async () => {
    if (starting() || props.archived) return;
    setStarting(true);
    try {
      const r = await startProjectCoding(po().projectId());
      po().info.refetch();
      po().worktrees.refetch();
      // Started, but its mode isn't set: it stays on this page, listed, to be opened and set by hand.
      if (r.modeNotSet) {
        setStartError(r.modeNotSet);
        return;
      }
      setStartError(null);
      toast(r.worktree ? `Coding session started on ${r.worktree.branch}.` : "Coding session started in the project root.");
      // Empty until the operator writes, so the list hides it: the app adopts it, as New Session's.
      const s = await getSessionSummaryById(r.sessionId).catch(() => null);
      if (!s || !adoptSession(s)) location.hash = sessionHref(r.path);
    } catch (x) {
      setStartError(unchangedError(errText(x), "No session was started."));
    } finally {
      setStarting(false);
    }
  };
  const clearError = (id: string) => setErrors(({ [id]: _, ...rest }) => rest);
  const act = async (w: CodingRow, fn: () => Promise<ProjectWorktrees>, done: string) => {
    if (working() || !po().worktrees.fresh()) return;
    setWorking(w.sessionId);
    try {
      po().worktrees.set(await fn());
      po().info.refetch();
      clearError(w.sessionId);
      toast(done);
      announce(done);
    } catch (x) {
      setErrors((e) => ({ ...e, [w.sessionId]: errText(x) }));
    } finally {
      setConfirming(null);
      setWorking(null);
    }
  };
  /** Land: the branch joins the project's merge queue at the commit this page read; the queue checks it on the
      target in its own copy and moves the target to exactly that commit. */
  const landBranch = async (v: SessionView, b: BranchState) => {
    if (working() || !b.land) return;
    setWorking(v.row.sessionId);
    try {
      const no = refusal(await land(b.land.worktree, b.land.commit ? { commit: b.land.commit } : {}));
      if (no) throw new Error(no);
      po().worktrees.refetch();
      clearError(v.row.sessionId);
      const done = `Queued ${b.branch} to land${v.row.target ? ` on ${v.row.target}` : ""}.`;
      toast(done);
      announce(done);
    } catch (x) {
      setErrors((e) => ({ ...e, [v.row.sessionId]: errText(x) }));
    } finally {
      setWorking(null);
    }
  };
  const retry = () => {
    po().info.refetch();
    po().worktrees.refetch();
  };

  const Row = (rp: { v: () => SessionView }) => {
    const v = rp.v;
    const row = () => v().row;
    const id = () => row().sessionId;
    const title = () => row().title || UNTITLED_CODING;
    const armed = () => confirming() === id();
    // Remove Worktree asks first what the folder holds that git can't bring back (§chat.worktrees/leftovers).
    const [hold] = createResource(
      () => (armed() ? id() : null),
      (sid) => codingWorktreeHold(po().projectId(), sid).catch((x): CodingWorktreeHold => ({ reason: errText(x) })),
    );
    const [listing, setListing] = createSignal(false);
    createEffect(on(armed, (a) => !a && setListing(false)));
    const folder = () => (row().worktree ? tildePath(row().worktree!, home()) : "");
    const gestures = () => rowGestures(row(), po().worktrees.fresh());
    const facts = () => (row().facts && row().state !== undefined ? (row() as CodingRow & CodingWorktree) : null);
    const landed = () => v().facts.stages.length > 0 && v().facts.stages.every((s) => s === "landed");
    // The ring means idle and worth a look: a landed session is done, so it never carries it.
    const quiet = () => !v().facts.working && !landed() && isQuiet(v().facts.lastActive, now());
    const summary = () => (v().s && showSummaries() ? summaryLineOf(v().s!) : "");
    const by = () => (row().playbook ? "Project verbs playbook run" : row().startedBy === "overseer" ? "Started by the overseer" : null);
    const ready = () => (v().facts.working ? undefined : rowLand(v().branches));
    const open = () => openBranches().has(id());
    const column = () => branchLines(v().branches, open());
    const rate = () => (v().facts.working ? rateCell(v().s ?? { live: null }, rates().get(id()), { reported: tokensReported(), remote: !row().path }) : null);
    const ctx = () => {
      const c = v().s?.context;
      return c?.window ? Math.min(100, Math.round((c.tokens / c.window) * 100)) : null;
    };
    const workers = () => v().s?.workers ?? v().s?.live?.workers;
    const questions = () => v().s?.align?.openQuestions ?? 0;
    const hasFacts = () => !landed() && (ctx() !== null || !!workers()?.total || questions() > 0);
    return (
      <li class="psess-row" classList={{ "psess-row-quiet": quiet() }}>
        <div class="psess-main">
          <Show when={row().path} fallback={<span class="psess-title" title={title()}>{title()}</span>}>
            {(path) => (
              <a class="psess-title psess-link" href={sessionHref(path())} title={v().s ? summaryTitleOf(v().s!) || title() : title()} onClick={(e) => !row().title && openUntitled(e, id())}>
                {title()}
              </a>
            )}
          </Show>
          <Show when={!landed()}>
            <Show when={summary()} fallback={<span class="psess-summary psess-summary-none">No summary yet</span>}>
              {(t) => <span class="psess-summary">{t()}</span>}
            </Show>
          </Show>
          <Show when={by()}>{(b) => <span class="psess-by">{b()}</span>}</Show>
          <Show when={!row().branch && row().inRoot}>{(why) => <span class="psess-by">In the project root: {why()}</span>}</Show>
        </div>
        <div class="psess-age" title={quiet() ? `No activity for ${OLD_DAYS} days or more` : undefined}>
          <Show
            when={rate()}
            fallback={
              <span class="psess-age-1">
                <Show when={quiet()}>
                  <span class="psess-quiet-mark" aria-hidden="true" />
                </Show>
                <Show when={landed()} fallback={<>active {relativeTime(v().facts.lastActive, now())}</>}>
                  started {shortDate(Date.parse(row().createdAt), now())}
                </Show>
              </span>
            }
          >
            {(r) => (
              <span class="psess-age-1 psess-rate" title={r().title}>
                <span class="live-dot" role="img" aria-label="Working" />
                <Show when={r().figure} fallback={<span>working</span>}>
                  {(f) => (
                    <>
                      <b class="text-num">{f().replace(/ tok\/min$/, "")}</b> <span class="psess-unit">tok/min</span>
                    </>
                  )}
                </Show>
              </span>
            )}
          </Show>
          <span class="psess-age-2">{ageWords(row().createdAt, now(), (t) => shortDate(t, now()))}</span>
        </div>
        <div class="psess-branches">
          <Show when={v().branches.length} fallback={<span class="psess-nobranch">No branch</span>}>
            <For each={column().lines}>
              {(l) => (
                <Show
                  when={l.said}
                  fallback={
                    <span class="psess-branch text-mono" title={l.b.branch}>
                      {l.b.branch}
                    </span>
                  }
                >
                  <span class="psess-state" title={l.b.why ? `${l.b.word} · ${l.b.why}` : undefined}>
                    <span class={`psess-word psess-tone-${l.b.tone} psess-stage-${l.b.stage}`}>{l.b.stage === "landed" && l.b.landedAt ? `Landed ${relativeTime(l.b.landedAt, now())}` : l.b.word}</span>
                    <Show when={v().branches.length > 1}>
                      <span class="psess-of text-mono">{l.b.branch}</span>
                    </Show>
                    <Show when={l.b.why}>{(w) => <span class="psess-why">{w()}</span>}</Show>
                  </span>
                  <Show when={v().branches.length === 1}>
                    <span class="psess-branch text-mono" title={l.b.branch}>
                      {l.b.branch}
                    </span>
                  </Show>
                </Show>
              )}
            </For>
            <Show when={v().branches.length > 3}>
              <button
                type="button"
                class="psess-more"
                aria-expanded={open() ? "true" : "false"}
                onClick={() =>
                  setOpenBranches((s) => {
                    const n = new Set(s);
                    if (!n.delete(id())) n.add(id());
                    return n;
                  })
                }
              >
                {open() ? "Show fewer" : `+${column().more} more`}
              </button>
            </Show>
          </Show>
        </div>
        <div class="psess-acts">
          <Show when={ready()}>
            {(b) => (
              <button
                type="button"
                class="button button-sm button-primary"
                aria-label={`Land ${b().branch}`}
                aria-disabled={working() ? "true" : undefined}
                onClick={() => void landBranch(v(), b())}
              >
                Land
              </button>
            )}
          </Show>
          <Show when={gestures().remove !== false || (!queue.setUp() && gestures().merge !== false)}>
            <ActionMenu label={`More for ${title()}`} title="More" icon="more">
              {(menu) => (
                <>
                  <Show when={!queue.setUp() && gestures().merge !== false}>
                    <menu.Item
                      label="Merge Branch"
                      aria={`Merge Branch: ${row().branch} into ${row().target}`}
                      icon={<Icon name="branch" small />}
                      description={`${row().branch} into ${row().target}`}
                      disabled={(gestures().merge || undefined) ?? (working() ? "Working" : undefined)}
                      onRun={() => void act(row(), () => mergeCodingWorktree(po().projectId(), id()), `Merged ${row().branch} into ${row().target}.`)}
                    />
                  </Show>
                  <Show when={gestures().remove !== false}>
                    <menu.Item
                      label="Remove Worktree…"
                      aria={`Remove Worktree: ${title()}`}
                      icon={<Icon name="trash" small />}
                      disabled={(gestures().remove || undefined) ?? (working() ? "Working" : undefined)}
                      onRun={() => setConfirming(id())}
                    />
                  </Show>
                </>
              )}
            </ActionMenu>
          </Show>
        </div>
        <Show when={hasFacts()}>
          <div class="psess-facts text-mono" aria-label="Session facts">
            <Show when={ctx() !== null}>
              <span class="psess-fact" title="Main thread context used">
                <i class="psess-fl">ctx</i>
                {ctx()}%
                <span class="psess-meter" aria-hidden="true">
                  <b style={{ width: `${ctx()}%` }} />
                </span>
              </span>
            </Show>
            <Show when={questions() > 0}>
              <span class="psess-fact">
                {questions()} <i class="psess-fl">open {questions() === 1 ? "question" : "questions"}</i>
              </span>
            </Show>
            <Show when={workers()?.total}>
              {(t) => (
                <span class="psess-fact">
                  {workers()!.working}/{t()} <i class="psess-fl">{t() === 1 ? "worker" : "workers"} active</i>
                </span>
              )}
            </Show>
          </div>
        </Show>
        <Show when={errors()[id()]}>{(e) => <p class="field-error psess-note">{e()}</p>}</Show>
        <Show when={armed() && facts() && po().worktrees.fresh()}>
          <div class="person-confirm psess-note" role="group" aria-label="Remove worktree">
            <Show
              when={listing() && hold()?.removeAnyway}
              fallback={
                <Show
                  when={hold()?.reason}
                  fallback={
                    <p class="orgs-line">
                      <Show
                        when={row().merged}
                        fallback={
                          <>
                            The folder <span class="orgs-mono">{folder()}</span> goes away. The branch <span class="orgs-mono">{row().branch}</span> keeps its commits, and the session and its transcript stay.
                          </>
                        }
                      >
                        The folder <span class="orgs-mono">{folder()}</span> and the merged branch <span class="orgs-mono">{row().branch}</span> go away. The session and its transcript stay.
                      </Show>
                    </p>
                  }
                >
                  {(r) => <p class="orgs-line">{r()}</p>}
                </Show>
              }
            >
              {(a) => <RemoveAnywayListing listing={a()} home={home()} />}
            </Show>
            <div class="button-row">
              <Show
                when={listing() && hold()?.removeAnyway}
                fallback={
                  <Show
                    when={!hold()?.reason}
                    fallback={
                      <Show when={hold()?.removeAnyway}>
                        <button type="button" class="button button-sm button-destructive" onClick={() => setListing(true)}>
                          Remove Anyway
                        </button>
                      </Show>
                    }
                  >
                    <button
                      type="button"
                      class="button button-sm button-destructive"
                      aria-disabled={working() || hold.loading ? "true" : undefined}
                      onClick={() => !hold.loading && void act(row(), () => removeCodingWorktree(po().projectId(), id()), "Worktree removed.")}
                    >
                      Remove Worktree
                    </button>
                  </Show>
                }
              >
                {(a) => (
                  <button
                    type="button"
                    class="button button-sm button-destructive"
                    aria-disabled={working() ? "true" : undefined}
                    onClick={() => void act(row(), () => removeCodingWorktreeAnyway(po().projectId(), id(), a().digest), "Worktree removed.")}
                  >
                    Delete and Remove Worktree
                  </button>
                )}
              </Show>
              <button type="button" class="button button-sm button-ghost" onClick={() => (listing() ? setListing(false) : setConfirming(null))}>
                {listing() ? "Back" : "Cancel"}
              </button>
            </div>
          </div>
        </Show>
      </li>
    );
  };

  const RowList = (lp: { items: SessionView[] }) => (
    <ul class="psess-list" role="list">
      <ForKey each={lp.items} by={(v) => v.row.sessionId}>
        {(v) => <Row v={v} />}
      </ForKey>
    </ul>
  );

  return (
    <section class="psess" aria-labelledby="project-coding">
      <div class="psess-head">
        <div class="psess-head-text">
          <h2 class="psess-h2" id="project-coding">
            Coding sessions
          </h2>
          <p class="psess-lede">
            Sorted by what needs you first. <span class="psess-quiet-mark" aria-hidden="true" /> marks a session with no activity for {OLD_DAYS} days or more.
          </p>
        </div>
        <button
          type="button"
          class="button button-primary"
          aria-disabled={starting() || props.archived ? "true" : undefined}
          title={props.archived ? "Archived" : undefined}
          onClick={() => void start()}
        >
          <Icon name="plus" small /> New Coding Session
        </button>
      </div>
      <Show when={startError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <Show when={!po().info.data() && po().info.error()}>
        <p class="field-error">
          Couldn't read the coding sessions.{" "}
          <button type="button" class="button button-sm" onClick={retry}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={po().info.data() && !wt() && po().worktrees.error()}>
        <p class="field-error">
          Couldn't read the branches. {po().worktrees.error()}{" "}
          <button type="button" class="button button-sm" onClick={() => po().worktrees.refetch()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={wt() && !wt()!.available && wt()!.reason}>{(r) => <p class="orgs-line project-muted">Coding sessions run in the project root: {r()}</p>}</Show>
      <Show when={unknown() && !po().info.error()}>
        <Placeholder lines={3} label="Coding sessions" />
      </Show>
      <Show when={!rows().length && !unknown()}>
        <p class="orgs-empty">No coding sessions yet. Yours and the overseer's are listed here.</p>
      </Show>
      <ForKey each={groups()} by={(g) => g.key}>
        {(group) => {
          const g = { get key() { return group().key; }, get items() { return group().items; } };
          const counts = () => groupCount(g.key, g.items.map((v) => v.facts.stages));
          if (g.key !== "landed")
            return (
              <section class="psess-group" aria-label={GROUP_NAME[g.key]}>
                <div class="psess-gside">
                  <h3 class="psess-gname">{GROUP_NAME[g.key]}</h3>
                  <span class="psess-gcount">{counts()}</span>
                </div>
                <RowList items={g.items} />
              </section>
            );
          const latest = () => {
            const v = g.items[0];
            const at = v?.branches.find((b) => b.landedAt)?.landedAt;
            return v ? { title: v.row.title || UNTITLED_CODING, when: at ? relativeTime(at, now()) : "" } : undefined;
          };
          return (
            <section class="psess-group" aria-label="Landed">
              <div class="psess-gside">
                <button type="button" class="psess-twist" aria-expanded={landedOpen() ? "true" : "false"} onClick={() => setLandedOpen((o) => !o)}>
                  <Icon name={landedOpen() ? "chevron-down" : "chevron-right"} small />
                  <span class="psess-gname">Landed</span>
                </button>
                <span class="psess-gcount">{counts()}</span>
              </div>
              <div class="psess-gbody">
                <Show
                  when={landedOpen()}
                  fallback={
                    <div class="psess-list psess-folded">
                      <span>{landedFoldWords(latest(), g.items.length)}</span>
                      <button type="button" class="button button-sm button-ghost" onClick={() => setLandedOpen(true)}>
                        Show Landed
                      </button>
                    </div>
                  }
                >
                  <RowList items={g.items.slice(0, landedShown())} />
                  <Show when={g.items.length > landedShown()}>
                    <div class="psess-more-landed">
                      <button type="button" class="button button-sm button-ghost" onClick={() => setLandedShown((n) => n + LANDED_PAGE)}>
                        Show {Math.min(LANDED_PAGE, g.items.length - landedShown())} More
                      </button>
                    </div>
                  </Show>
                </Show>
              </div>
            </section>
          );
        }}
      </ForKey>
    </section>
  );
}

/** Opens an untitled coding session: the list hides an empty one, so the app adopts it (else the plain link). */
function openUntitled(e: MouseEvent, sessionId: string): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const href = (e.currentTarget as HTMLAnchorElement).getAttribute("href") ?? "";
  void getSessionSummaryById(sessionId).then(
    (s) => adoptSession(s) || (location.hash = href),
    () => (location.hash = href),
  );
}
