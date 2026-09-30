import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import type { CompactionInfo, ContextInfo, GitFileChange, GitRepoSummary, GitSummary, SessionInsight, SessionSummary, SessionWorktreeInfo, TranscriptItem } from "../../shared/protocol";
import { contextSentence, contextStateFor } from "../lib/context";
import { relativeTime, thousands, tildePath } from "../lib/format";
import { readinessChip, type WorktreeChip, worktreeChips, worktreesSummary, worktreeStatus } from "../lib/worktrees";
import { absoluteTime, firstLine, timelineEntries } from "../lib/spend";
import { orgProjectOf } from "../lib/drag-archive";
import { archiveSession } from "../lib/session-actions";
import { cwdLabel } from "../lib/remote-session";
import { resumeCommand } from "../lib/session-command";
import { groupNameOf, sessionGroups } from "../lib/session-groups";
import {
  capNote,
  changeLabel,
  changesLabel,
  fileLines,
  filesHeadline,
  GIT_REFRESH_MS,
  headLabel,
  linesNote,
  loadGitSummary,
  placeLabel,
  rootLabel,
  UPSTREAM_TITLE,
  upstreamLabel,
  visiblePath,
} from "../lib/git-summary";
import { copyText, home } from "../lib/ui-state";
import { sessionWorking } from "../lib/workers";
import { Banner, CopyButton, Icon } from "./ui";
import { sessionHref } from "./Sidebar";
import { GroupWithParent, MoveToGroupMenu } from "./Groups";
import { ChangesDialog } from "./ChangesViewer";
import { RecipientChip, ShareSheet } from "./ShareSheet";
import type { SessionShare } from "../../shared/session-share";
import { hostOf } from "../lib/mesh";
import { openedLine, SHARES_HREF, shareLine } from "../lib/session-shares";
import { shareHref } from "../lib/share-slice";

/** Long machine facts wrap instead of widening the sheet. */
const wrapMono = { margin: 0, "overflow-wrap": "anywhere" } as const;

/**
 * What a session is, read-only: the session pane's Session tab (what it has spent is the Usage
 * tab's, SessionUsage.tsx). Its parent owns the data and the scroll box; this renders sections as
 * siblings for a flex column with gaps. Repository and Worktrees sit above Identity and hold about
 * their settled height while they load, so Identity's buttons don't move under the pointer.
 *
 *   path      the session file (shown and copyable)
 *   insight   the session's insight, or null before the first load
 *   error     a failed first insight load to report, or null (the poll retries on its own)
 *   pending   the first insight load is still out: Worktrees shows a placeholder, never its empty line
 *   summary   App-level session list row (undefined before the list loads)
 *   context   the transcript's context fill from the server (ContextGauge's source)
 *   items     transcript rows (the model/thinking/mode timeline, and "compacted" for context)
 *   now       the clock relative times are measured against
 *   onArchiveChanged  after Archive/Unarchive succeeds: re-read the session list, with the
 *                     session's path and its new archived state
 *   onGroupsChanged   after the session's group changes: re-read the session list
 *   gitChanged  bumped when the session's file changed (the pane's insight reload): the Repository
 *               section reads git again once the bumps settle
 */
export function SessionDetails(props: {
  path: string;
  insight: SessionInsight | null;
  error: string | null;
  pending: boolean;
  summary: SessionSummary | undefined;
  context: ContextInfo | null;
  items: TranscriptItem[];
  now: number;
  onArchiveChanged(path: string, archived: boolean): void;
  onGroupsChanged(): void;
  gitChanged: number;
}) {
  const id = (section: string) => `sp-${section}-label`;
  const insight = () => props.insight;
  const now = () => props.now;
  const summary = () => props.summary;
  const working = () => (insight()?.workers ?? []).filter((w) => w.working).length;
  const compactions = () => insight()?.compactions ?? [];
  const timeline = () => timelineEntries(props.items);
  /** The gauge's own state, so the sentence here and the one in the head can't disagree. */
  const context = () => contextStateFor(props.context, props.items);
  const live = () => summary()?.live ?? null;
  /** What Archive/Unarchive just did, until the list row catches up (or without a refresh). */
  const [archivedNow, setArchivedNow] = createSignal<boolean | null>(null);
  createEffect(on(() => summary()?.archived, () => setArchivedNow(null), { defer: true }));
  const archived = () => archivedNow() ?? summary()?.archived === true; // older servers send none

  return (
    <>
      <Show when={props.error}>
        {(message) => <Banner tone="error" title="Couldn't load this session's insight." body={`Nothing was changed. ${message()}`} />}
      </Show>

      {/* 1 · Path. The one fact the user came here to copy. */}
      <section class="stack-2" aria-labelledby={id("path")}>
        <h3 class="text-eyebrow" id={id("path")}>
          Path
        </h3>
        <p class="text-mono" style={wrapMono}>
          {props.path}
        </p>
        <div class="cluster">
          <CopyButton label="Copy Session Path" text={() => props.path} onCopy={(t) => copyText(t, "Copied path.")} />
          <CopyButton
            label="Copy Resume Command"
            title="Open this session in a terminal."
            text={() => resumeCommand(props.path)}
            onCopy={(t) => copyText(t, "Copied resume command.")}
          />
        </div>
      </section>

      {/* 2 · Context. The gauge's own sentence, so the two never drift. */}
      <Show when={context()}>
        {(state) => (
          <section class="stack-2" aria-labelledby={id("context")}>
            <h3 class="text-eyebrow" id={id("context")}>
              Context
            </h3>
            <p class="usage-note">{contextSentence(state())}</p>
          </section>
        )}
      </Show>

      {/* 3 · Repository. The git state of the folder the session works in, read on its own
          schedule: never part of the insight poll. */}
      <RepositorySection path={props.path} cwd={summary()?.cwd} now={now()} changed={props.gitChanged} labelId={id("repository")} />

      {/* 4 · Worktrees. The ones this session tracks (the worktrees extension's entry on the
          branch), read with the insight; the pane only shows them, the agent's tool changes them.
          Present from the first paint: a placeholder while the insight loads, as tall as the empty
          line (most sessions track none), then the rows or that line. Only a failed first load (the
          banner above says so) leaves it out. */}
      <Show
        when={insight()}
        fallback={
          <Show when={props.pending}>
            <section class="stack-2" aria-labelledby={id("worktrees")} aria-busy="true">
              <h3 class="text-eyebrow" id={id("worktrees")}>
                Worktrees
              </h3>
              <p class="usage-note text-skeleton" aria-hidden="true">
                <Bone width="45%" />
              </p>
            </section>
          </Show>
        }
      >
        {(i) => <WorktreesSection rows={i().worktrees ?? []} path={props.path} cwd={summary()?.cwd} labelId={id("worktrees")} />}
      </Show>

      {/* 5 · Identity. What this session is, where it runs, and since when. */}
      <Show when={summary()}>
        {(s) => (
          <section class="stack-2" aria-labelledby={id("identity")}>
            <h3 class="text-eyebrow" id={id("identity")}>
              Identity
            </h3>
            <dl class="stack-2" style={{ margin: 0 }}>
              <Fact label="Session id">
                <span class="text-mono" style={wrapMono}>
                  {s().id}
                </span>
              </Fact>
              <Fact label="Folder">
                <span class="text-mono" style={wrapMono} title={cwdLabel(s(), null)}>
                  {cwdLabel(s(), home())}
                </span>
              </Fact>
              <Fact label="Created">
                <span title={absoluteTime(s().createdAt, now())}>{relativeTime(s().createdAt, now())}</span>
              </Fact>
              <Fact label="Last active">
                <span title={absoluteTime(s().lastActiveAt, now())}>{relativeTime(s().lastActiveAt, now())}</span>
              </Fact>
              <Fact label="Origin">{s().origin === "web" ? "Started here" : "Started in a terminal"}</Fact>
              <Fact label="Archived">{archived() ? "Yes" : "No"}</Fact>
              <Fact label="Group">{groupNameOf(sessionGroups(), s().groupId) ?? "None"}</Fact>
              {/* Lineage from the session header, read-only: Sova never writes it. It says this
                  session was branched from that file — never at which entry. */}
              <Show when={s().parent}>
                {(parent) => (
                  <Fact label="Forked from">
                    <a class="text-mono" style={wrapMono} href={sessionHref(parent())} title={parent()}>
                      {parent().split("/").pop()}
                    </a>
                  </Fact>
                )}
              </Show>
              <Show when={live()}>
                {(l) => (
                  <Fact label="Live">
                    <span class="text-mono">pid {l().pid}</span> · {l().status}
                  </Fact>
                )}
              </Show>
            </dl>
            {/* Archiving is ours to define only for sessions Sova started (it closes their
                runtime); grouping is Sova's own bookkeeping for any session. */}
            <div class="cluster">
              <MoveToGroupMenu session={s()} onChanged={() => props.onGroupsChanged()} />
              {/* The same assignment, read as a place to work: file it and open that group's
                  workspace with this session focused. */}
              <MoveToGroupMenu session={s()} onChanged={() => props.onGroupsChanged()} variant="beside" />
              {/* Forked from a session and in no group: one press puts the pair in one workspace. */}
              <GroupWithParent session={s()} onChanged={() => props.onGroupsChanged()} />
              <Show when={s().origin === "web"}>
                <ArchiveAction
                  session={s()}
                  archived={archived()}
                  working={Math.max(sessionWorking(s()), working())}
                  onDone={(next) => {
                    setArchivedNow(next);
                    props.onArchiveChanged(props.path, next);
                  }}
                />
              </Show>
            </div>
          </section>
        )}
      </Show>

      {/* 6 · Compactions. Where the transcript was summarized, on demand. */}
      <Show when={compactions().length > 0}>
        <details class="disclosure">
          <summary class="disclosure-summary">
            <Icon name="chevron-right" small class="icon-twist" />
            <span class="disclosure-label">
              {compactions().length} {compactions().length === 1 ? "compaction" : "compactions"}
            </span>
          </summary>
          <div class="disclosure-body">
            <ul class="list">
              <For each={compactions()}>{(c) => <CompactionRow compaction={c} now={now()} />}</For>
            </ul>
          </div>
        </details>
      </Show>

      {/* 7 · Changes. Model, thinking and mode changes, in the order they happened. The pane's
          Timeline tab is the session's whole axis; this stays the settings history. */}
      <Show when={timeline().length > 0}>
        <details class="disclosure">
          <summary class="disclosure-summary">
            <Icon name="chevron-right" small class="icon-twist" />
            <span class="disclosure-label">Changes</span>
            <span class="disclosure-preview">
              · {timeline().length} {timeline().length === 1 ? "change" : "changes"}
            </span>
          </summary>
          <div class="disclosure-body">
            <ul class="list">
              <For each={timeline()}>
                {(entry) => (
                  <li class="list-row">
                    <div class="list-main">
                      <p class="list-title" style={wrapMono}>
                        {entry.text}
                      </p>
                      <Show when={entry.at}>
                        {(at) => (
                          <p class="list-meta" title={absoluteTime(at(), now())}>
                            {relativeTime(at(), now())}
                          </p>
                        )}
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </details>
      </Show>
    </>
  );
}

/**
 * The Sharing tab's body (§app.session-share/sheet): each share's title, its slice or mode line and
 * its recipients with presence and opens, Manage for each, and Share Session, which opens the share
 * page. The pane owns the read (`shares`, `error`), so its tab's badge and this list agree.
 */
export function SharingSection(props: {
  session: SessionSummary;
  shares: SessionShare[] | null;
  error: string | null;
  now: number;
  /** The sheet changed a share: read the list again. */
  onChanged(): void;
}) {
  const host = () => hostOf(props.session.path);
  const [sheet, setSheet] = createSignal<SessionShare | null>(null);
  const abs = (iso: string) => absoluteTime(iso, props.now);
  const newShare = () => shareHref(props.session.id, { host: host() });

  return (
    <section class="stack-2" aria-labelledby="sharing-label">
      <div class="spread">
        <h3 class="text-eyebrow" id="sharing-label">
          Sharing
        </h3>
        <a class="button button-sm button-ghost" href={SHARES_HREF}>
          All Shares
        </a>
      </div>
      <Switch>
        <Match when={props.error}>{(msg) => <p class="usage-note">{msg()}</p>}</Match>
        <Match when={props.shares === null}>
          <p class="usage-note text-skeleton" aria-hidden="true">
            <Bone width="40%" />
          </p>
        </Match>
        <Match when={props.shares!.length === 0}>
          <p class="usage-note">Not shared with anyone.</p>
        </Match>
        <Match when={props.shares!.length > 0}>
          <ul class="list sharing-list">
            <For each={props.shares}>
              {(sh) => (
                <li class="list-row sharing-row">
                  <div class="list-main">
                    <p class="list-title">{sh.title}</p>
                    <p class="list-meta">{sh.stoppedAt ? `Stopped ${relativeTime(sh.stoppedAt, props.now)}` : shareLine(sh, abs)}</p>
                    <ul class="shares-recipients">
                      <For each={sh.recipients}>
                        {(r) => (
                          <li class="shares-recipient">
                            <span class="shares-recipient-name">{r.label}</span>
                            <RecipientChip state={r.state} presence={r.presence} />
                            <span class="text-caption text-muted">{openedLine(r.opened, r.lastAt, (iso) => relativeTime(iso, props.now))}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                  <button type="button" class="button button-sm" aria-label={`Manage ${sh.title}`} onClick={() => setSheet(sh)}>
                    Manage
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Match>
      </Switch>
      <Show when={!props.error}>
        <div class="cluster">
          <a class="button" href={newShare()}>
            Share Session
          </a>
        </div>
      </Show>
      <Show when={sheet()}>
        {(open) => (
          <ShareSheet
            host={host()}
            share={open()}
            onChanged={() => props.onChanged()}
            onClose={() => {
              setSheet(null);
              props.onChanged();
            }}
          />
        )}
      </Show>
    </section>
  );
}

/** A settled burst of file changes, before the Repository section reads git again: an agent's turn
    moves the session file every few seconds, and one read after it quiets beats one per write. */
const GIT_SETTLE_MS = 2_000;

/**
 * The repository around the session's folder: branch, what's changed, the upstream as this repo
 * last saw it, the latest commit, and, folded, every changed path with its line counts (never its
 * contents). Mounted only while the pane's Session tab shows, so that is when it reads: on open,
 * when the session's file settles after a change, every GIT_REFRESH_MS while the page is visible,
 * on return to the page, and on Refresh. The server caches ~10s; Refresh skips that.
 */
function RepositorySection(props: { path: string; cwd?: string; now: number; changed: number; labelId: string }) {
  const [git, setGit] = createSignal<GitSummary | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  let run = 0;
  const load = async (fresh: boolean) => {
    const mine = ++run;
    setLoading(true);
    try {
      const next = await loadGitSummary(props.path, fresh);
      if (mine !== run) return;
      setGit(next);
      setError(null);
    } catch (err) {
      if (mine === run) setError((err as Error).message);
    } finally {
      if (mine === run) setLoading(false);
    }
  };
  // A memo, so a new summary object for the same session never reads as a new session.
  const path = createMemo(() => props.path);
  createEffect(
    on(path, () => {
      setGit(null);
      setError(null);
      void load(false);
    }),
  );
  // A memo, so the effect below fires on a new VALUE only: `on` re-runs whenever anything it read
  // changed, and the pane's insight object is new on every poll while `changed` stays put.
  const changed = createMemo(() => props.changed);
  const visible = () => document.visibilityState === "visible";
  /** A settled change that landed while the page was hidden, owed a fresh read on return. */
  let owed = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      changed,
      () => {
        clearTimeout(settle);
        settle = setTimeout(() => {
          if (visible()) void load(true);
          else owed = true;
        }, GIT_SETTLE_MS);
      },
      { defer: true },
    ),
  );
  const stale = () => {
    const g = git();
    return !g || Date.now() - g.checkedAt >= GIT_REFRESH_MS;
  };
  const tick = setInterval(() => visible() && !loading() && stale() && void load(false), GIT_REFRESH_MS);
  const onVisible = () => {
    if (!visible()) return;
    if (owed) {
      owed = false;
      void load(true);
    } else if (stale()) void load(false);
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => {
    run++; // an answer that lands after the surface closed writes to nothing
    clearTimeout(settle);
    clearInterval(tick);
    document.removeEventListener("visibilitychange", onVisible);
  });

  const repo = () => {
    const g = git();
    return g?.state === "repo" ? g : null;
  };
  /** The viewer on the folder's uncommitted changes (§chat.changes/entry). */
  const [reviewing, setReviewing] = createSignal(false);
  const checked = () => {
    const g = git();
    return g ? relativeTime(new Date(g.checkedAt).toISOString(), props.now) : "";
  };

  return (
    <section class="stack-2" aria-labelledby={props.labelId} aria-busy={loading() ? "true" : undefined}>
      <div class="spread">
        <h3 class="text-eyebrow" id={props.labelId}>
          Repository
        </h3>
        <button
          type="button"
          class="button button-sm button-ghost"
          aria-label="Refresh Repository"
          title="Read git again. Nothing is fetched or changed."
          aria-disabled={loading() ? "true" : undefined}
          onClick={() => !loading() && void load(true)}
        >
          <Icon name="refresh" small />
          Refresh
        </button>
      </div>
      <Switch>
        <Match when={!git() && error()}>
          {(message) => <p class="usage-note">Couldn't read this session's repository. Nothing was changed. {message()}</p>}
        </Match>
        <Match when={!git()}>
          {/* A clean repository's layout, built from the same elements: its root, three facts, the
              last commit with a two-line subject, and the "Read" line. So what sits below doesn't
              jump when git answers; only uncommitted changes (the fold and Review Changes) add height. */}
          <div class="git-skeleton" aria-hidden="true">
            <p class="text-mono text-skeleton" aria-hidden="true">
              <Bone width="60%" />
            </p>
            <dl class="stack-2" style={{ margin: 0 }} aria-hidden="true">
              <For each={["30%", "45%", "25%"]}>
                {(width) => (
                  <div class="spread">
                    <dt class="text-caption text-skeleton">
                      <Bone width={width} />
                    </dt>
                  </div>
                )}
              </For>
              <div class="git-commit">
                <div class="spread">
                  <dt class="text-caption text-skeleton">
                    <Bone width="35%" />
                  </dt>
                </div>
                <dd class="git-commit-subject text-caption">
                  <span class="text-skeleton">
                    <Bone width="100%" />
                  </span>
                  <span class="text-skeleton">
                    <Bone width="55%" />
                  </span>
                </dd>
              </div>
            </dl>
            <p class="usage-note text-skeleton" aria-hidden="true">
              <Bone width="25%" />
            </p>
          </div>
        </Match>
        <Match when={git()?.state === "none" && git()}>
          {(g) => (
            <p class="usage-note">
              <span class="text-mono" style={wrapMono}>
                {placeLabel(g(), home())}
              </span>{" "}
              isn't inside a git repository.
            </p>
          )}
        </Match>
        <Match when={git()?.state === "unavailable" && (git() as Extract<GitSummary, { state: "unavailable" }>)}>
          {(g) => <p class="usage-note">{g().reason}</p>}
        </Match>
        <Match when={repo()}>{(s) => <RepositoryFacts summary={s()} now={props.now} />}</Match>
      </Switch>
      <Show when={repo() && repo()!.filesTotal > 0 && props.cwd}>
        {(cwd) => (
          <div class="git-review">
            <div class="git-review-text">
              <p class="git-review-title">Uncommitted changes</p>
              <p class="text-caption text-muted">{filesHeadline(repo()!)}</p>
            </div>
            <button
              type="button"
              class="button button-sm git-review-action"
              title="Every uncommitted change, against HEAD. Nothing is changed."
              onClick={() => setReviewing(true)}
            >
              Review Changes
            </button>
            <Show when={reviewing()}>
              <ChangesDialog scope={{ kind: "dirty", sessionPath: props.path, cwd: cwd() }} cwd={cwd()} onClose={() => setReviewing(false)} />
            </Show>
          </div>
        )}
      </Show>
      <Show when={git()}>
        <p class="usage-note text-muted">
          Read {checked()}
          <Show when={error()}>{(message) => <> · the last refresh failed: {message()}</>}</Show>
        </p>
      </Show>
    </section>
  );
}

/** One placeholder bar over a line of text: the line keeps the height its real text would have. */
function Bone(props: { width: string }) {
  return (
    <>
      &nbsp;
      <span class="skeleton" style={{ width: props.width }} />
    </>
  );
}

/** The session's tracked worktrees, dropped and merged ones included, or the line saying it tracks
    none. Read-only. */
function WorktreesSection(props: { rows: SessionWorktreeInfo[]; path: string; cwd?: string; labelId: string }) {
  return (
    <section class="stack-2" aria-labelledby={props.labelId}>
      <h3 class="text-eyebrow" id={props.labelId}>
        Worktrees
      </h3>
      <p class="usage-note">{worktreesSummary(props.rows)}</p>
      <Show when={props.rows.length > 0}>
        <ul class="list worktree-list">
          <For each={props.rows}>{(w) => <WorktreeRow worktree={w} path={props.path} cwd={props.cwd} />}</For>
        </ul>
      </Show>
    </section>
  );
}

const chipTone = (c: Pick<WorktreeChip, "tone">) => (c.tone === "neutral" ? "chip" : `chip chip-${c.tone}`);

/** One worktree: its branch, where it is, its status and what runs there. */
function WorktreeRow(props: { worktree: SessionWorktreeInfo; path: string; cwd?: string }) {
  const w = () => props.worktree;
  const status = () => worktreeStatus(w());
  /** The viewer on the branch against its merge-base (§chat.changes/entry): active, existing rows. */
  const [reviewing, setReviewing] = createSignal(false);
  return (
    <li class="list-row worktree-row">
      <div class="list-main">
        <p class="list-title text-mono" style={wrapMono} title={w().path}>
          {w().branch}
        </p>
        <p class="list-meta text-mono" style={wrapMono}>
          {tildePath(w().path, home())}
        </p>
        <div class="worktree-facts">
          <span class={chipTone(status())} title={status().title}>
            <span class="chip-dot" aria-hidden="true" />
            {status().label}
          </span>
          <Show when={status().detail}>
            {(detail) => (
              <span class="text-caption text-mono" title={status().title}>
                {detail()}
              </span>
            )}
          </Show>
          <Show when={readinessChip(w())}>
            {(c) => (
              <span class={chipTone(c())} title={c().title}>
                <span class="chip-dot" aria-hidden="true" />
                {c().label}
              </span>
            )}
          </Show>
          <For each={worktreeChips(w())}>
            {(c) => (
              <span class={`${chipTone(c)} chip-count`} title={c.title}>
                {c.label}
              </span>
            )}
          </For>
          <Show when={w().sharedWith}>
            {(sid) => (
              <span class="text-caption text-muted">
                Shared with <a href={`#/sid/${encodeURIComponent(sid())}`}>session {sid().slice(0, 8)}</a>
              </span>
            )}
          </Show>
        </div>
      </div>
      <Show when={w().status === "active" && w().exists}>
        <button
          type="button"
          class="button button-sm worktree-row-action"
          aria-label={`Review Changes on ${w().branch}`}
          title="The branch's commits against where it left its base branch, or, once merged, what its merge brought in. Nothing is changed."
          onClick={() => setReviewing(true)}
        >
          Review Changes
        </button>
        <Show when={reviewing()}>
          <ChangesDialog scope={{ kind: "worktree", sessionPath: props.path, worktreePath: w().path }} cwd={props.cwd} onClose={() => setReviewing(false)} />
        </Show>
      </Show>
    </li>
  );
}

/** A read repository: where it is, its facts, and the changed paths folded underneath. */
function RepositoryFacts(props: { summary: GitRepoSummary; now: number }) {
  const s = () => props.summary;
  const commit = () => s().lastCommit;
  const note = () => linesNote(s());
  const cap = () => capNote(s());
  return (
    <>
      <p class="text-mono" style={wrapMono} title={s().root}>
        {rootLabel(s(), home())}
      </p>
      <dl class="stack-2" style={{ margin: 0 }}>
        <Fact label="Branch">
          <span class="text-mono" style={wrapMono}>
            {headLabel(s())}
          </span>
        </Fact>
        <Fact label="Upstream">
          <span title={UPSTREAM_TITLE}>{upstreamLabel(s())}</span>
        </Fact>
        <Fact label="Changes">{changesLabel(s())}</Fact>
        <Show
          when={commit()}
          fallback={
            <Fact label="Last commit">
              {/* "None yet" only where there is no commit to show; an existing repository whose log
                  couldn't be read says that instead. */}
              {s().unborn ? "None yet" : <span title="git log didn't answer. Refresh to try again.">Couldn't read it</span>}
            </Fact>
          }
        >
          {(c) => {
            const iso = () => new Date(c().at).toISOString();
            return (
              <div class="git-commit">
                {/* Label left, short hash and age right; the subject gets its own full-width line
                    and wraps whole, so nothing hides behind a hover. */}
                <div class="spread">
                  <dt class="text-caption text-muted">Last commit</dt>
                  <dd class="git-commit-meta text-caption">
                    <span class="text-mono" title={c().oid}>{c().oid.slice(0, 7)}</span>
                    <span class="text-muted"> · </span>
                    <span title={absoluteTime(iso(), props.now)}>{relativeTime(iso(), props.now)}</span>
                  </dd>
                </div>
                <dd class="git-commit-subject text-caption">
                  {c().subject.trim() ? c().subject : <span class="text-muted">No subject</span>}
                </dd>
              </div>
            );
          }}
        </Show>
      </dl>
      <Show when={s().filesTotal > 0}>
        <details class="disclosure git-files">
          <summary class="disclosure-summary">
            <Icon name="chevron-right" small class="icon-twist" />
            <span class="disclosure-label">{filesHeadline(s())}</span>
          </summary>
          {/* Bounded: a repository with thousands of changes scrolls here, not the whole panel. */}
          <div class="disclosure-body git-files-body" tabindex="0" aria-label="Changed paths">
            <ul class="list">
              <For each={s().files}>{(f) => <GitFileRow file={f} />}</For>
            </ul>
            <Show when={cap()}>{(text) => <p class="usage-note text-muted">{text()}</p>}</Show>
            <Show when={note()}>{(text) => <p class="usage-note text-muted">{text()}</p>}</Show>
          </div>
        </details>
      </Show>
    </>
  );
}

/** One changed path: the path, what happened to it, and its line counts or why there are none. */
function GitFileRow(props: { file: GitFileChange }) {
  const lines = () => props.file.lines;
  const counted = () => {
    const l = lines();
    return l !== null && l !== "binary" && props.file.kind !== "untracked" ? l : null;
  };
  return (
    <li class="list-row git-file-row">
      <div class="list-main">
        <p class="list-title text-mono" style={wrapMono} title={props.file.path}>
          {visiblePath(props.file.path)}
        </p>
        <p class="list-meta" style={wrapMono}>
          {visiblePath(changeLabel(props.file))}
        </p>
      </div>
      <Show when={counted()} fallback={<span class="git-file-lines text-muted">{fileLines(props.file)}</span>}>
        {(l) => (
          <span class="git-file-lines text-mono text-num" aria-label={`${l().added} added, ${l().removed} removed`}>
            <span class="git-add">+{l().added}</span> <span class="git-del">−{l().removed}</span>
          </span>
        )}
      </Show>
    </li>
  );
}

/**
 * Archive/Unarchive for a web-spawned session. Archiving closes the
 * session's runtime, so it's refused while the session is live in a TUI (it would stay on top
 * anyway) and while its subagents work (they'd stop with it); unarchiving always works.
 */
function ArchiveAction(props: { session: SessionSummary; archived: boolean; working: number; onDone(archived: boolean): void }) {
  const [pending, setPending] = createSignal(false);
  const blocked = (): string | null => {
    if (props.archived) return null;
    if (props.session.live !== null) return "Open in a TUI. It stays on top while live.";
    const n = props.working;
    if (n > 0) return `${n} ${n === 1 ? "subagent" : "subagents"} working. Archiving closes this session's runtime, so ${n === 1 ? "it stops" : "they stop"}.`;
    return null;
  };
  const click = async () => {
    if (pending() || blocked()) return;
    const next = !props.archived;
    setPending(true);
    try {
      if (await archiveSession(props.session.path, next, orgProjectOf(props.session))) props.onDone(next);
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      class={props.archived ? "button" : "button button-destructive"}
      title={blocked() ?? undefined}
      aria-disabled={blocked() || pending() ? "true" : undefined}
      onClick={click}
    >
      <Icon name="archive" />
      {props.archived ? "Unarchive Session" : "Archive Session"}
    </button>
  );
}

/** One label/value pair in the Identity list. `<dd>` carries its own reset: base.css has none. */
function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="spread">
      <dt class="text-caption text-muted">{props.label}</dt>
      <dd class="text-caption" style={{ margin: 0, "text-align": "right", "min-width": 0 }}>
        {props.children}
      </dd>
    </div>
  );
}

/** One compaction: when it happened, what it summarized away, and the first line of the summary. */
function CompactionRow(props: { compaction: CompactionInfo; now: number }) {
  const preview = () => firstLine(props.compaction.summary);
  const tokens = () => props.compaction.tokensBefore;
  return (
    <li class="list-row">
      <div class="list-main">
        <p class="list-meta" title={absoluteTime(props.compaction.timestamp, props.now)}>
          {relativeTime(props.compaction.timestamp, props.now)}
          <Show when={tokens() !== null} fallback=" · earlier messages summarized">
            {" · "}
            <span class="text-mono">{thousands(tokens()!)}</span> tokens summarized
          </Show>
        </p>
        <Show when={preview()}>
          <p class="list-title" style={wrapMono}>
            {preview()}
          </p>
        </Show>
      </div>
    </li>
  );
}
