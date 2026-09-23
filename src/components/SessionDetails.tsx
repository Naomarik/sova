import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import type { CompactionInfo, ContextInfo, GitFileChange, GitRepoSummary, GitSummary, ModelSpend, SessionInsight, SessionSummary, TokenUsage, TranscriptItem } from "../../shared/protocol";
import { contextSentence, contextStateFor, formatTokens } from "../lib/context";
import { compactModel, relativeTime, thousands } from "../lib/format";
import { absoluteTime, anyCost, firstLine, originLabel, spendRows, timelineEntries } from "../lib/spend";
import { setSessionArchived } from "../lib/api";
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
import { copyText, home, toast } from "../lib/ui-state";
import { formatCost, sessionWorking, usageHeadline, usageTitle, usageTotal } from "../lib/workers";
import { Banner, CopyButton, Icon } from "./ui";
import { sessionHref } from "./Sidebar";
import { GroupWithParent, MoveToGroupMenu } from "./Groups";

/** Long machine facts wrap instead of widening the sheet. */
const wrapMono = { margin: 0, "overflow-wrap": "anywhere" } as const;

/**
 * What a session is and what it has spent (spec/04-composer.md §4h), read-only: the body of the Session
 * info modal and the session pane's Session tab, one implementation for both. Its parent owns
 * the data and the scroll box; this renders sections as siblings for a flex column with gaps.
 *
 *   path      the session file (shown and copyable)
 *   insight   the session's insight, or null before the first load
 *   error     a failed insight load to report, or null
 *   onRetry   what the error's Retry does; without it the banner offers none
 *   skeleton  the load has been slow: show the skeleton while `insight` is still null
 *   summary   App-level session list row (undefined before the list loads)
 *   context   the transcript's context fill from the server (ContextGauge's source)
 *   items     transcript rows (the model/thinking/mode timeline, and "compacted" for context)
 *   now       the clock relative times are measured against
 *   onArchiveChanged  after Archive/Unarchive succeeds: re-read the session list, with the
 *                     session's path and its new archived state
 *   onGroupsChanged   after the session's group changes: re-read the session list
 *   gitChanged  bumped when the session's file changed (the pane's insight reload): the Repository
 *               section reads git again once the bumps settle
 *   gitRefresh  bumped by a surface's own Refresh: the Repository section reads git again now
 *   idPrefix  prefix of the section heading ids ("si", the modal's, by default), so the modal and
 *             the pane can both be open without duplicate ids
 */
export function SessionDetails(props: {
  path: string;
  insight: SessionInsight | null;
  error: string | null;
  onRetry?: () => void;
  skeleton: boolean;
  summary: SessionSummary | undefined;
  context: ContextInfo | null;
  items: TranscriptItem[];
  now: number;
  onArchiveChanged?: (path: string, archived: boolean) => void;
  onGroupsChanged?: () => void;
  gitChanged?: number;
  gitRefresh?: number;
  idPrefix?: string;
}) {
  const id = (section: string) => `${props.idPrefix ?? "si"}-${section}-label`;
  const insight = () => props.insight;
  const now = () => props.now;
  const summary = () => props.summary;
  const usage = () => insight()?.usage;
  const rows = () => spendRows(usage());
  const workers = () => insight()?.workers ?? [];
  const working = () => workers().filter((w) => w.working).length;
  const subagentTotal = () => usageTotal(insight());
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
        {(message) => (
          <Banner
            tone="error"
            title="Couldn't load this session's insight."
            body={`Nothing was changed. ${message()}`}
            action={
              props.onRetry && (
                <button type="button" class="button button-sm" onClick={() => props.onRetry?.()}>
                  Retry
                </button>
              )
            }
          />
        )}
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

      {/* 2 · Usage. One row per model × origin, plus the two Σs those rows can't carry. */}
      <Show when={usage()}>
        {(u) => (
          <section class="stack-2" aria-labelledby={id("usage")}>
            <h3 class="text-eyebrow" id={id("usage")}>
              Usage
            </h3>
            <p class="text-mono" style={{ margin: 0 }} title={usageTitle(u().total)}>
              {formatTokens(usageHeadline(u().total))} tokens in and out
              <Show when={formatCost(u().total.cost)}>{(cost) => <> · {cost()}</>}</Show>
            </p>
            <Show when={rows().length > 0}>
              <div class="md md-table-wrap">
                <table>
                  <caption class="visually-hidden">Tokens by model and where they were spent</caption>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th scope="col">Where</th>
                      <th scope="col" align="right">
                        In
                      </th>
                      <th scope="col" align="right">
                        Out
                      </th>
                      <th scope="col" align="right">
                        Cache read
                      </th>
                      <th scope="col" align="right">
                        Cache write
                      </th>
                      <Show when={anyCost(rows())}>
                        <th scope="col" align="right">
                          Cost
                        </th>
                      </Show>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={rows()}>{(row) => <SpendRow row={row} cost={anyCost(rows())} />}</For>
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={2}>
                        Main thread Σ
                      </th>
                      <Cells usage={u().main} cost={anyCost(rows())} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Show>
            <p class="usage-note">Main thread counts the active branch only.</p>
            <Show when={u().workersTotal}>
              {(total) => (
                <p class="usage-note text-muted" title={usageTitle(total(), total().workers)}>
                  Subagent lifetime: {formatTokens(usageHeadline(total()))} tokens
                  <Show when={formatCost(total().cost)}>{(cost) => <> · {cost()}</>}</Show> across {total().workers}{" "}
                  {total().workers === 1 ? "worker" : "workers"} (includes evicted).
                </p>
              )}
            </Show>
          </section>
        )}
      </Show>

      {/* 3 · Context. The gauge's own sentence, so the two never drift. */}
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

      {/* 4 · Identity. What this session is, where it runs, and since when. */}
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
                  session was branched from that file — never at which entry (spec/14 "Data"). */}
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
              <MoveToGroupMenu session={s()} onChanged={() => props.onGroupsChanged?.()} />
              {/* The same assignment, read as a place to work: file it and open that group's
                  workspace with this session focused. */}
              <MoveToGroupMenu session={s()} onChanged={() => props.onGroupsChanged?.()} variant="beside" />
              {/* Forked from a session and in no group: one press puts the pair in one workspace. */}
              <GroupWithParent session={s()} onChanged={() => props.onGroupsChanged?.()} />
              <Show when={s().origin === "web"}>
                <ArchiveAction
                  session={s()}
                  archived={archived()}
                  working={Math.max(sessionWorking(s()), working())}
                  onDone={(next) => {
                    setArchivedNow(next);
                    props.onArchiveChanged?.(props.path, next);
                  }}
                />
              </Show>
            </div>
          </section>
        )}
      </Show>

      {/* 5 · Repository. The git state of the folder the session works in, read on its own
          schedule: never part of the insight poll. */}
      <RepositorySection path={props.path} now={now()} changed={props.gitChanged} refresh={props.gitRefresh} labelId={id("repository")} />

      <Show when={props.skeleton && !props.insight}>
        <div class="stack-2" aria-hidden="true">
          <span class="skeleton skeleton-title" />
          <span class="skeleton skeleton-line" />
          <span class="skeleton skeleton-line" />
        </div>
      </Show>

      {/* 6 · Subagents. This session's own workers — never the session's own spend. */}
      <Show when={workers().length > 0 || subagentTotal()}>
        <section class="stack-2" aria-labelledby={id("subagents")}>
          <h3 class="text-eyebrow" id={id("subagents")}>
            Subagents
          </h3>
          <p class="usage-note">
            {workers().length} {workers().length === 1 ? "subagent" : "subagents"} in this session · {working()} working
          </p>
          <Show when={subagentTotal()}>
            {(total) => (
              <p class="usage-note text-muted" title={usageTitle(total(), total().workers)}>
                {formatTokens(usageHeadline(total()))} tokens across {total().workers} {total().workers === 1 ? "worker" : "workers"}
              </p>
            )}
          </Show>
        </section>
      </Show>

      {/* 7 · Compactions. Where the transcript was summarized, on demand. */}
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

      {/* 8 · Changes. Model, thinking and mode changes, in the order they happened. The pane's
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

/** A settled burst of file changes, before the Repository section reads git again: an agent's turn
    moves the session file every few seconds, and one read after it quiets beats one per write. */
const GIT_SETTLE_MS = 2_000;

/**
 * The repository around the session's folder: branch, what's changed, the upstream as this repo
 * last saw it, the latest commit, and, folded, every changed path with its line counts (never its
 * contents). Mounted only while its surface shows (the pane's Session tab, the info modal), so
 * that is when it reads: on open, when the session's file settles after a change, every
 * GIT_REFRESH_MS while the page is visible, on return to the page, and on Refresh. The server
 * caches ~10s; Refresh skips that.
 */
function RepositorySection(props: { path: string; now: number; changed?: number; refresh?: number; labelId: string }) {
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
  // Memos, so the effects below fire on a new VALUE only: `on` re-runs whenever anything it read
  // changed, and the pane's insight object is new on every poll while `changed` stays put.
  const changed = createMemo(() => props.changed);
  const refresh = createMemo(() => props.refresh);
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
  createEffect(on(refresh, () => void load(true), { defer: true }));
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
          <div class="stack-2" aria-hidden="true">
            <span class="skeleton skeleton-line" />
            <span class="skeleton skeleton-line" />
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
      <Show when={git()}>
        <p class="usage-note text-muted">
          Read {checked()}
          <Show when={error()}>{(message) => <> · the last refresh failed: {message()}</>}</Show>
        </p>
      </Show>
    </section>
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
      <Show when={s().moved}>
        <p class="usage-note text-muted">
          This folder moved since the session started. Read at <span class="text-mono">{s().cwd}</span>.
        </p>
      </Show>
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
 * Archive/Unarchive for a web-spawned session (spec/02-session-list.md §2 "Archiving"). Archiving closes the
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
      await setSessionArchived(props.session.path, next);
      toast(next ? "Archived. Find it under Archive." : "Moved back to Live & web.");
      props.onDone(next);
    } catch (err) {
      toast(`Couldn't ${next ? "archive" : "unarchive"} this session. ${(err as Error).message}`);
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

/** The four token columns and, when any row reports one, the cost. */
function Cells(props: { usage: TokenUsage; cost: boolean }) {
  const cell = (n: number) => (
    <td align="right" class="text-mono text-num">
      {formatTokens(n)}
    </td>
  );
  return (
    <>
      {cell(props.usage.input)}
      {cell(props.usage.output)}
      {cell(props.usage.cacheRead)}
      {cell(props.usage.cacheWrite)}
      <Show when={props.cost}>
        <td align="right" class="text-mono text-num">
          <Show
            when={formatCost(props.usage.cost)}
            fallback={
              <>
                <span class="text-muted" aria-hidden="true">
                  —
                </span>
                <span class="visually-hidden">Not reported</span>
              </>
            }
          >
            {(cost) => cost()}
          </Show>
        </td>
      </Show>
    </>
  );
}

/** A model × origin row. The id is shortened; the full one stays in the `title`. */
function SpendRow(props: { row: ModelSpend; cost: boolean }) {
  return (
    <tr>
      <td class="text-mono" title={props.row.model}>
        {compactModel(props.row.model) ?? props.row.model}
      </td>
      <td>{originLabel(props.row.origin)}</td>
      <Cells usage={props.row} cost={props.cost} />
    </tr>
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
