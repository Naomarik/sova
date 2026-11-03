import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";
import type { MergeAnswer } from "../../shared/merge-queue";
import { relativeTime } from "../lib/format";
import { mins, notesOf, unattributedWhy, sentence, pausedTitle, pushedWords, queueStateChip, runProgress, short, waitingHead, type MergeEntry, type MergeQueueView } from "../lib/merge-queue";
import { answerEntry, cancelEntry, landBranch, type LandOptions, mergeChanged, mergeFeed, pauseQueue, readQueue, refusal, resumeQueue } from "../lib/merge-queue-client";
import { createPoll } from "../lib/poll";
import { mergeRunHref, projectSessionHref, projectTabHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { MergeOnboarding } from "./MergeOnboarding";
import { MergeRunView } from "./MergeRunView";
import { Banner, Icon } from "./ui";
import { LandSpecsConfirm, LandSplit, QueueChip, UnclearChecks } from "./WorktreesModal";
import type { MergeReady } from "../../shared/merge-queue";
import { home } from "../lib/ui-state";
import { tildePath } from "../lib/format";
import type { DiffScope } from "../../shared/protocol";
import { ReviewChangesButton } from "./ReviewChanges";

/** How often the tab reads the queue while it shows (a run's steps move by the second). */
const POLL_MS = 4000;

/**
 * A project's Merge Queue tab: the target and what's pushed, the queue's state with Pause / Resume and
 * the merge thread's chat, what's being checked now, the line with its estimates, what waits for you,
 * what went back to its chat, and recent landings with their notes. A project with no checks declared
 * gets the onboarding instead. `run`: one run's page (`…/merge-queue/<run>`).
 */
export function MergeQueueTab(props: { projectId: string; root: string; name: string; run?: string; chatOf?: ChatOf }) {
  const poll = createPoll(() => readQueue(props.root), POLL_MS, { cacheKey: `project:${props.projectId}:merge-queue` });
  createEffect(on(mergeChanged, () => poll.refetch(), { defer: true }));
  // What the feed pushes for this project is the newest view: adopt it as is.
  createEffect(
    on(mergeFeed, (f) => {
      if (f && f.project === props.projectId) poll.set(f.view);
    }, { defer: true }),
  );
  const view = () => poll.data();
  return (
    <section class="card orgs-section mq-tab" aria-labelledby="mq-title">
      <Show
        when={view()}
        fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read this project's merge queue. ${poll.error()}` : "Reading the merge queue."}</p>}
      >
        {(v) => (
          <Show
            when={!props.run}
            fallback={<MergeRunView projectId={props.projectId} view={v()} runId={props.run!} chatOf={props.chatOf} />}
          >
            {/* An invalid definition reads "unset" too: its error is said, never the onboarding. */}
            <Show when={!notSetUp(v())} fallback={<NotSetUp projectId={props.projectId} name={props.name} view={v()} onSaved={() => poll.refetch()} />}>
              <QueueBody projectId={props.projectId} view={v()} chatOf={props.chatOf} onChanged={() => poll.refetch()} />
            </Show>
          </Show>
        )}
      </Show>
    </section>
  );
}

/** The release holding the queue, as the Releases tab names it: its tag, else its version. */
const holdName = (r: { version: string | null; tag?: string | null }): string => (r.tag ? `release ${r.tag}` : r.version ? `release ${r.version}` : "a release");

/** The queue doesn't serve this listed project: it has no merge setup (an invalid one is still a setup, said as such). */
const notSetUp = (v: Pick<MergeQueueView, "served" | "checks" | "invalid">): boolean => !v.invalid && (v.served === false || v.checks === "unset");

/**
 * A listed project with no merge setup: its chats merge plainly. The tab says so, and Initialize opens the
 * setup (the onboarding: Try It on Main, then Save Checks).
 */
function NotSetUp(props: { projectId: string; name: string; view: MergeQueueView; onSaved(): void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show
      when={!open()}
      fallback={<MergeOnboarding projectId={props.projectId} name={props.name} view={props.view} onSaved={props.onSaved} />}
    >
      <div class="stack mq-body mq-unset">
        <div class="cluster">
          <h2 class="orgs-h2" id="mq-title">
            Merge queue
          </h2>
          <QueueChip row={{ label: "Not set up", tone: "warn" }} />
        </div>
        <Banner
          tone="info"
          title="No merge queue settings are set up for this project"
          body={`Until they are, its chats merge branches into ${props.view.target} themselves when you ask.`}
          action={
            <button type="button" class="button button-sm" onClick={() => setOpen(true)}>
              Initialize
            </button>
          }
        />
      </div>
    </Show>
  );
}

/** The strip: the target's head, and what origin has. */
export function HeadsStrip(props: { view: MergeQueueView }) {
  const v = () => props.view;
  const pushed = () => pushedWords(v().heads);
  return (
    <div class="mq-strip" role="group" aria-label={`${v().target} and origin`}>
      <div class="mq-cell">
        <p class="text-eyebrow">{v().target}</p>
        <p class="mq-cell-value text-mono">{short(v().heads.target)}</p>
        <Show when={v().heads.targetRed?.length}>
          <p class="text-caption mq-red">Red on {v().target} alone: {v().heads.targetRed!.join(", ")}</p>
        </Show>
      </div>
      <div class="mq-cell">
        <p class="text-eyebrow">Pushed to origin</p>
        <p class="mq-cell-value">
          <Show when={v().heads.pushed}>
            <span class="text-mono">{short(v().heads.pushed)}</span>
          </Show>
          <QueueChip row={pushed()} />
        </p>
        <p class="text-caption text-muted">{sentence(pushed().why) || "After every landing."}</p>
      </div>
    </div>
  );
}

/** A chat the page's session list knows, by its id (a queue records ids): where it opens and what it's called. */
export interface ChatRef {
  path: string;
  title?: string;
  archived?: boolean;
}
export type ChatOf = (id: string) => ChatRef | undefined;

/** Where a chat recorded by its id opens: its own route when the list carries it, else the id route the app resolves. */
export const chatHref = (projectId: string, id: string, chatOf?: ChatOf): string => {
  const c = chatOf?.(id);
  return c ? projectSessionHref(projectId, c.path) : `#/sid/${encodeURIComponent(id)}`;
};

/** "from <chat>": a link to the branch's own chat when the entry knows it (the run's page). */
export function FromChat(props: { projectId: string; entry: Pick<MergeEntry, "session">; chatOf?: ChatOf }) {
  return (
    <Show when={props.entry.session} fallback={<span>from its chat</span>}>
      {(s) => (
        <span>
          from <a href={chatHref(props.projectId, s(), props.chatOf)}>{props.chatOf?.(s())?.title ?? "its chat"}</a>
        </span>
      )}
    </Show>
  );
}

/** The worktree folder: its full path on a wide row, its last name on a phone (the full path in its title). */
function Folder(props: { path: string }) {
  const full = () => tildePath(props.path, home());
  const last = () => props.path.replace(/\/+$/, "").split("/").pop() || props.path;
  return (
    <span class="mq-folder text-mono" title={props.path}>
      <span class="mq-folder-full">{full()}</span>
      <span class="mq-folder-last">{last()}</span>
    </span>
  );
}

/**
 * A row's chat line: "Chat <title>" (a real link; "· archived" after an archived one) and the worktree's folder, or
 * "No chat found for this worktree". `tail`: the row's own facts after it.
 */
function ChatLine(props: { projectId: string; session?: string; archived?: boolean; worktree?: string; chatOf?: ChatOf; tail?: JSX.Element }) {
  const chat = () => (props.session ? props.chatOf?.(props.session) : undefined);
  return (
    <p class="list-meta mq-chat">
      <Show when={props.session} fallback={<span class="text-muted">No chat found for this worktree</span>}>
        {(s) => (
          <>
            <span class="text-muted">Chat</span>{" "}
            <a class="mq-chat-link" href={chatHref(props.projectId, s(), props.chatOf)} onClick={keepSelection}>
              {chat()?.title ?? "its chat"}
            </a>
            <Show when={props.archived || chat()?.archived}>
              <span class="text-muted"> · archived</span>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.worktree}>
        {(w) => (
          <>
            <span class="text-muted"> · </span>
            <Folder path={w()} />
          </>
        )}
      </Show>
      {props.tail}
    </p>
  );
}

/** The chat link: a click that ends a text selection in its row doesn't follow it. */
function keepSelection(e: MouseEvent) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const row = (e.currentTarget as Element).closest(".mq-tap");
  const sel = window.getSelection();
  if (row && sel && !sel.isCollapsed && sel.anchorNode && row.contains(sel.anchorNode)) e.preventDefault();
}

/**
 * The whole row opens its chat (the Agents board's rule): a plain primary click anywhere but its links, buttons,
 * menus and fields, and not one that ends a text selection in it. A click inside the changes viewer (a portal, so
 * outside the row's own elements) never counts.
 */
export function rowOpens(href: () => string | undefined) {
  return (e: MouseEvent & { currentTarget: HTMLElement }) => {
    const to = href();
    if (!to || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as Element;
    if (!e.currentTarget.contains(target)) return;
    if (target.closest("a, button, input, textarea, select, label, form, summary, [role=menuitem], [popover]")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
    location.hash = to;
  };
}

/** A queue row's Review Changes: the queue's own comparison, steps from its chat's turns when the list knows it. */
function QueueReview(props: { projectId: string; branch: string; scope: DiffScope; session?: string; chatOf?: ChatOf }) {
  return (
    <ReviewChangesButton
      branch={props.branch}
      class="mq-review"
      scope={() => props.scope}
      stepsFrom={props.session ? props.chatOf?.(props.session)?.path : undefined}
      title={
        props.scope.kind === "queue" && props.scope.branch
          ? "The branch as it is now against the branch it lands on, its uncommitted files marked. Nothing is changed."
          : "The commit that was approved against the branch it lands on, or, once landed, what its landing brought in. Nothing is changed."
      }
    />
  );
}

/** One action button with its pending state; a refusal shows under the row and is announced. */
function useAct(onChanged: () => void) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (key: string, call: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string) => {
    if (busy()) return;
    setBusy(key);
    setError(null);
    try {
      const no = refusal(await call());
      if (no) {
        setError(no);
        announce(no);
      } else {
        toast(done);
        announce(done);
        onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

function QueueBody(props: { projectId: string; view: MergeQueueView; chatOf?: ChatOf; onChanged(): void }) {
  const v = () => props.view;
  const chip = () => (v().release && v().state !== "paused" && !v().invalid ? { label: "Frozen for a release", tone: "warn" as const } : queueStateChip(v()));
  const head = useAct(props.onChanged);
  const paused = () => v().state === "paused";
  return (
    <div class="stack mq-body">
      <HeadsStrip view={v()} />
      <div class="spread mq-head">
        <div class="cluster">
          <h2 class="orgs-h2" id="mq-title">
            Merge queue
          </h2>
          <QueueChip row={chip()} />
        </div>
        <div class="button-row">
          <Show
            when={paused()}
            fallback={
              <button type="button" class="button button-sm" disabled={!!head.busy()} onClick={() => void head.run("pause", () => pauseQueue(v().root), "Paused the merge queue.")}>
                Pause Queue
              </button>
            }
          >
            <button type="button" class="button button-sm button-primary" disabled={!!head.busy()} onClick={() => void head.run("resume", () => resumeQueue(v().root), "Resumed the merge queue.")}>
              Resume Queue
            </button>
          </Show>
          <Show when={v().thread}>
            {(t) => (
              <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, t().session)}>
                <Icon name="chat" small />
                Open Merge Thread
              </a>
            )}
          </Show>
        </div>
      </div>
      <p class="text-caption text-muted mq-intro">
        One branch at a time, in order. Each is merged onto {v().target} in a separate copy and checked there; {v().target} then moves to exactly that commit.
        <Show when={v().checks === "none"}> This project declares no automated tests: landings say "No checks declared".</Show>
      </p>
      <Show when={head.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <Show when={v().invalid}>
        {(bad) => <Banner tone="error" title="This project's .sova/project.json doesn't parse." body={`${bad().trim().replace(/[.]$/, "")}. Fix it on ${v().target}, or land a branch that fixes it; nothing else lands until it parses.`} />}
      </Show>
      {/* The definition's own pause is said by the banner above, once. */}
      <Show when={paused() && !(v().paused?.kind === "definition-invalid" && v().invalid)}>
        <Banner
          tone="warn"
          title={pausedTitle(v())}
          body={
            <>
              {v().paused?.kind !== "operator" ? sentence(v().paused?.why) : "Approvals are still taken; nothing is checked until you resume."}
              <Show when={v().paused?.run}>
                {(r) => (
                  <>
                    {" "}
                    <a href={mergeRunHref(props.projectId, r())}>View the Run</a>
                  </>
                )}
              </Show>
            </>
          }
          action={
            <button type="button" class="button button-sm" disabled={!!head.busy()} onClick={() => void head.run("resume", () => resumeQueue(v().root), "Resumed the merge queue.")}>
              Resume
            </button>
          }
        />
      </Show>
      {/* An open release freezes the target on it (§app.release): only its own entries land until it's published or abandoned. */}
      <Show when={v().release}>
        {(rel) => (
          <Banner
            tone="info"
            title={`${v().target} is frozen for ${holdName(rel())}`}
            body="Other landings wait in line, and nothing is pushed, until the release is published or abandoned."
            action={
              <a class="button button-sm" href={projectTabHref(props.projectId, "releases")}>
                Open Releases
              </a>
            }
          />
        )}
      </Show>
      <CheckingNow projectId={props.projectId} view={v()} chatOf={props.chatOf} />
      <Waiting projectId={props.projectId} view={v()} chatOf={props.chatOf} onChanged={props.onChanged} />
      <Show when={v().needsYou.length > 0}>
        <div class="stack-2">
          <h3 class="text-heading-s">Needs you</h3>
          <ul class="list mq-list">
            <For each={v().needsYou}>{(e) => <NeedsYouRow projectId={props.projectId} root={v().root} entry={e} target={v().target} chatOf={props.chatOf} onChanged={props.onChanged} />}</For>
          </ul>
        </div>
      </Show>
      <Show when={(v().ready ?? []).length > 0}>
        <div class="stack-2">
          <h3 class="text-heading-s">Ready to land, not approved</h3>
          <ul class="list mq-list">
            <For each={v().ready}>{(r) => <ReadyRow projectId={props.projectId} root={v().root} ready={r} review={v().review} chatOf={props.chatOf} onChanged={props.onChanged} />}</For>
          </ul>
        </div>
      </Show>
      <Show when={v().needsFix.length > 0}>
        <div class="stack-2">
          <h3 class="text-heading-s">Sent back to its chat</h3>
          <ul class="list mq-list">
            <For each={v().needsFix}>
              {(e) => (
                <li class="list-row mq-row" classList={{ "mq-tap": !!e.session }} data-branch={e.branch} data-state="needs-fix" onClick={rowOpens(() => e.session && chatHref(props.projectId, e.session, props.chatOf))}>
                  <div class="list-main">
                    <p class="list-title mq-branch text-mono">{e.branch}</p>
                    <p class="mq-facts">
                      <QueueChip row={{ label: "Needs a fix", tone: "error" }} />
                      <span class="text-mono text-muted">{short(e.commit)}</span>
                    </p>
                    <p class="list-meta">{e.reason ?? "It failed a check that passes on the target."}</p>
                    <ChatLine projectId={props.projectId} session={e.session} worktree={e.worktree} chatOf={props.chatOf} tail={<span class="text-muted"> · {relativeTime(e.updatedAt)}</span>} />
                  </div>
                  <div class="button-row mq-row-act">
                    <QueueReview projectId={props.projectId} branch={e.branch} scope={{ kind: "queue", project: props.projectId, entry: e.id }} session={e.session} chatOf={props.chatOf} />
                    <Show when={e.run}>
                      {(r) => (
                        <a class="button button-sm button-ghost" href={mergeRunHref(props.projectId, r())}>
                          See Why
                        </a>
                      )}
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <div class="stack-2">
        <h3 class="text-heading-s">Recent</h3>
        <Show when={v().recent.length > 0} fallback={<p class="text-caption text-muted">Nothing has landed through the queue yet.</p>}>
          <ul class="list mq-list">
            <For each={v().recent}>
              {(l) => (
                <li class="list-row mq-row" classList={{ "mq-tap": !!l.entry.session }} data-branch={l.entry.branch} data-state="landed" onClick={rowOpens(() => l.entry.session && chatHref(props.projectId, l.entry.session, props.chatOf))}>
                  <div class="list-main">
                    <p class="list-title mq-branch text-mono">{l.entry.branch}</p>
                    <p class="mq-facts">
                      <QueueChip row={{ label: "Landed", tone: "success" }} />
                      <Show when={l.entry.landed}>
                        {(ld) => (
                          <span>
                            as <span class="text-mono">{short(ld().sha)}</span> · {relativeTime(ld().at)}
                            {ld().pushed === "not-pushed" ? ` · not pushed${ld().pushWhy ? `: ${ld().pushWhy}` : ""}` : ld().pushed === "pushed" ? " · pushed" : ""}
                            <Show when={l.run?.noChecks}> · No checks declared</Show>
                          </span>
                        )}
                      </Show>
                    </p>
                    <ChatLine projectId={props.projectId} session={l.entry.session} worktree={l.entry.worktree} chatOf={props.chatOf} />
                    <For each={notesOf(l.entry.notes)}>
                      {(n) => (
                        <p class="list-meta mq-note">
                          <span class="text-muted">{n.label}:</span> {n.text}
                        </p>
                      )}
                    </For>
                  </div>
                  <div class="button-row mq-row-act">
                    <QueueReview projectId={props.projectId} branch={l.entry.branch} scope={{ kind: "queue", project: props.projectId, entry: l.entry.id }} session={l.entry.session} chatOf={props.chatOf} />
                    <Show when={l.run}>
                      {(r) => (
                        <a class="button button-sm button-ghost" href={mergeRunHref(props.projectId, r().id)} aria-label={`View checks for ${l.entry.branch}`}>
                          View Checks
                        </a>
                      )}
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

function CheckingNow(props: { projectId: string; view: MergeQueueView; chatOf?: ChatOf }) {
  const cur = () => props.view.current;
  /** The entry the run checks, from whichever list holds it. */
  const entry = () => {
    const r = cur();
    if (!r) return undefined;
    const v = props.view;
    return [...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix].find((e) => e.id === r.entry);
  };
  return (
    <Show
      when={cur()}
      fallback={
        <p class="mq-empty text-caption">
          {props.view.release
            ? props.view.waiting.length
              ? `${props.view.waiting.length} waiting for ${holdName(props.view.release)}: they start once it's published or abandoned.`
              : `Nothing being checked. A branch you land now waits for ${holdName(props.view.release)}.`
            : props.view.waiting.length
              ? `${props.view.waiting.length} waiting. The next one starts in a moment.`
              : "Nothing being checked. A branch starts as soon as you press Land."}
        </p>
      }
    >
      {(r) => {
        const p = () => runProgress(r());
        return (
          <div
            class="mq-card"
            classList={{ "mq-tap": !!entry()?.session }}
            role="group"
            aria-label="Checking now"
            data-branch={r().branch}
            onClick={rowOpens(() => entry()?.session && chatHref(props.projectId, entry()!.session!, props.chatOf))}
          >
            <div class="spread">
              <div class="cluster">
                <h3 class="text-heading-s">Checking now</h3>
                <QueueChip row={{ label: "Checking", tone: "accent", live: true }} />
              </div>
              <div class="button-row mq-row-act">
                <QueueReview projectId={props.projectId} branch={r().branch} scope={{ kind: "queue", project: props.projectId, entry: r().entry }} session={entry()?.session} chatOf={props.chatOf} />
                <a class="button button-sm" href={mergeRunHref(props.projectId, r().id)}>
                  View Checks
                </a>
              </div>
            </div>
            <p class="mq-branch mq-card-title text-mono">{r().branch}</p>
            <p class="mq-facts">
              <span class="text-mono text-muted">{short(r().commit)}</span>
            </p>
            <ChatLine projectId={props.projectId} session={entry()?.session} worktree={entry()?.worktree} chatOf={props.chatOf} />
            <p class="text-caption">
              <span class="text-mono">
                {props.view.target} {short(r().base)}
              </span>{" "}
              + this branch{r().tip ? <> → testing <span class="text-mono">{short(r().tip)}</span></> : null}
            </p>
            <p class="text-caption mq-now">
              {p().label}
              {p().of ? ` · check ${p().index} of ${p().of}` : ""}
            </p>
            <div class="meter">
              <div class="meter-track" role="img" aria-label={`${p().done} of ${p().of} checks done`}>
                <div class="meter-fill" style={{ width: `${p().of ? Math.round((100 * p().done) / p().of) : 0}%` }} />
              </div>
            </div>
            <p class="text-caption text-muted">
              Started {relativeTime(r().startedAt)}
              {entry()?.eta ? ` · takes ~${mins(entry()!.eta!.takesMs)}` : ""}
              {r().checks.filter((c) => c.source === "picked").length ? ` · ${r().checks.filter((c) => c.source === "picked").length} added by the merge thread` : ""}
            </p>
          </div>
        );
      }}
    </Show>
  );
}

function Waiting(props: { projectId: string; view: MergeQueueView; chatOf?: ChatOf; onChanged(): void }) {
  return (
    <div class="stack-2">
      <h3 class="text-heading-s">{waitingHead(props.view.waiting)}</h3>
      <Show when={props.view.waiting.length > 0} fallback={<p class="text-caption text-muted">Nothing waiting. A branch joins when you press Land or type "land it" in its chat.</p>}>
        <ul class="list mq-list">
          <For each={props.view.waiting}>
            {(e) => {
              const act = useAct(props.onChanged);
              return (
                <li class="list-row mq-row" classList={{ "mq-tap": !!e.session }} data-branch={e.branch} data-state="queued" onClick={rowOpens(() => e.session && chatHref(props.projectId, e.session, props.chatOf))}>
                  <div class="list-main">
                    <p class="list-title mq-branch text-mono">{e.branch}</p>
                    <p class="mq-facts">
                      <QueueChip row={e.release ? { label: "Release", tone: "accent" } : { label: `In line · ${e.position ?? "?"}`, tone: "neutral" }} />
                      <span class="text-mono text-muted">{short(e.commit)}</span>
                      <span>
                        approved {relativeTime(e.approval.at)} · {e.approval.by === "typed" ? "typed in its chat" : "Land button"}
                        {e.approval.withoutReview ? " · without review" : ""}
                        {e.approval.withoutSpecs ? " · without its specs" : ""}
                      </span>
                    </p>
                    <ChatLine projectId={props.projectId} session={e.session} worktree={e.worktree} chatOf={props.chatOf} />
                    {/* While a release holds the queue, no estimate holds: the row's reason says what it waits for. */}
                    <Show when={props.view.release && !e.release ? null : e.eta}>
                      {(t) => (
                        <p class="list-meta">
                          <Icon name="clock" small /> starts in ~{mins(t().startsInMs)} · takes ~{mins(t().takesMs)}
                        </p>
                      )}
                    </Show>
                    <Show when={e.release ? null : e.reason}>
                      {(why) => <p class="list-meta">{why()}</p>}
                    </Show>
                    <Show when={e.newerCommits}>
                      <p class="list-meta">
                        {e.newerCommits} newer commit{e.newerCommits === 1 ? "" : "s"} not included
                      </p>
                    </Show>
                    <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
                  </div>
                  <div class="button-row mq-row-act">
                    <QueueReview projectId={props.projectId} branch={e.branch} scope={{ kind: "queue", project: props.projectId, entry: e.id }} session={e.session} chatOf={props.chatOf} />
                    <button type="button" class="button button-sm button-ghost" aria-label={`Cancel landing ${e.branch}`} disabled={!!act.busy()} onClick={() => void act.run("cancel", () => cancelEntry(e), `Cancelled landing ${e.branch}.`)}>
                      Cancel Landing
                    </button>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** An entry that waits for you, with its two actions; or a conflict the merge thread is judging. */
function NeedsYouRow(props: { projectId: string; root: string; target: string; entry: MergeEntry; chatOf?: ChatOf; onChanged(): void }) {
  const e = () => props.entry;
  const act = useAct(props.onChanged);
  const answer = (a: MergeAnswer, done: string) => void act.run(a, () => answerEntry(e(), a), done);
  return (
    <li
      class="list-row mq-row mq-needs"
      classList={{ "mq-tap": !!e().session }}
      data-branch={e().branch}
      data-state={e().state}
      onClick={rowOpens(() => e().session && chatHref(props.projectId, e().session!, props.chatOf))}
    >
      <div class="list-main">
        <p class="list-title mq-branch text-mono">{e().branch}</p>
        <p class="mq-facts">
          <QueueChip
            row={
              e().state === "behaviour-differs"
                ? { label: "Behaviour differs · waiting for you", tone: "warn" }
                : e().state === "review-flagged"
                  ? { label: "Review flagged · waiting for you", tone: "warn" }
                  : e().state === "unattributed"
                    ? { label: "Can't tell whose failure · waiting for you", tone: "warn" }
                  : e().state === "drafts-changed"
                    ? { label: "Drafts changed since you approved", tone: "warn" }
                    : { label: "Conflict", tone: "warn" }
            }
          />
          <span class="text-mono text-muted">{short(e().commit)}</span>
        </p>
        <Show when={e().state === "behaviour-differs" && e().conflict}>
          {(c) => (
            <dl class="mq-sides">
              <div>
                <dt class="text-eyebrow">{props.target}</dt>
                <dd>{c().ours}</dd>
              </div>
              <div>
                <dt class="text-eyebrow">This branch</dt>
                <dd>{c().theirs}</dd>
              </div>
              <div>
                <dt class="text-eyebrow">Merge thread proposes</dt>
                <dd>{c().proposal}</dd>
              </div>
            </dl>
          )}
        </Show>
        <Show when={e().state === "review-flagged"}>
          <p class="list-meta">{e().review?.text ?? e().reason ?? "The review found something that blocks it."}</p>
        </Show>
        <Show when={e().state === "unattributed"}>
          <p class="list-meta">{unattributedWhy(e().reason, props.target)} Land Anyway lands the commit it tested; Send Back hands it to its chat.</p>
          <UnclearChecks projectId={props.projectId} unclear={e().unclear} target={props.target} class="list-meta" />
        </Show>
        <Show when={e().state === "drafts-changed"}>
          <p class="list-meta">{e().reason ?? "Its spec drafts changed after you approved. Land again to approve them as they are now."}</p>
        </Show>
        <Show when={e().state === "conflict"}>
          <p class="list-meta">{e().reason ?? "The merge thread is judging the conflict. The line moves on meanwhile."}</p>
        </Show>
        <ChatLine
          projectId={props.projectId}
          session={e().session}
          worktree={e().worktree}
          chatOf={props.chatOf}
          tail={
            <Show when={e().run}>
              {(r) => (
                <>
                  {" · "}
                  <a href={mergeRunHref(props.projectId, r())}>See Why</a>
                </>
              )}
            </Show>
          }
        />
        <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="button-row mq-row-act">
        <QueueReview projectId={props.projectId} branch={e().branch} scope={{ kind: "queue", project: props.projectId, entry: e().id }} session={e().session} chatOf={props.chatOf} />
        <Show when={e().state === "behaviour-differs"}>
          <button type="button" class="button button-sm button-primary" aria-label={`Accept the resolution for ${e().branch}`} disabled={!!act.busy()} onClick={() => answer("accept", `Accepted the resolution for ${e().branch}.`)}>
            Accept
          </button>
        </Show>
        <Show when={e().state === "review-flagged" || e().state === "unattributed"}>
          <button type="button" class="button button-sm button-primary" aria-label={`Land ${e().branch} anyway`} disabled={!!act.busy()} onClick={() => answer("land-anyway", `Landing ${e().branch} anyway.`)}>
            Land Anyway
          </button>
        </Show>
        <Show when={e().state === "drafts-changed"}>
          <button type="button" class="button button-sm button-primary" aria-label={`Land ${e().branch}`} disabled={!!act.busy()} onClick={() => void act.run("land", () => landBranch(props.root, e().branch), `Queued ${e().branch}.`)}>
            Land
          </button>
        </Show>
        <Show when={e().state === "behaviour-differs" || e().state === "review-flagged" || e().state === "unattributed"}>
          <button type="button" class="button button-sm button-destructive" aria-label={`Send ${e().branch} back to its chat`} disabled={!!act.busy()} onClick={() => answer("send-back", `Sent ${e().branch} back to its chat.`)}>
            Send Back
          </button>
        </Show>
      </div>
    </li>
  );
}

/** A branch ready to land that nobody approved yet: Review Changes, and Land with its ▾. Land names the row's chat. */
function ReadyRow(props: { projectId: string; root: string; ready: MergeReady; review: boolean; chatOf?: ChatOf; onChanged(): void }) {
  const r = () => props.ready;
  const act = useAct(props.onChanged);
  const [askSpecs, setAskSpecs] = createSignal(false);
  // Land names no chat: the server records the branch's owner by the same rule that put this row's chat here
  // (server/merge-queue/owners.ts).
  const doLand = (o: LandOptions = {}) =>
    void act.run("land", () => landBranch(props.root, r().branch, { ...o, commit: r().commit }), `Queued ${r().branch}${o.withoutReview ? " without review" : ""}${o.withoutSpecs ? " without its specs" : ""}.`);
  const lines = () => (r().added !== undefined && r().removed !== undefined ? ` · +${r().added} −${r().removed}` : "");
  return (
    <li class="list-row mq-row" classList={{ "mq-tap": !!r().session }} data-branch={r().branch} data-state="ready" onClick={rowOpens(() => r().session && chatHref(props.projectId, r().session!, props.chatOf))}>
      <div class="list-main">
        <p class="list-title mq-branch text-mono">{r().branch}</p>
        <p class="mq-facts">
          <QueueChip row={{ label: "Ready", tone: "success" }} />
          <span class="text-mono text-muted">{short(r().commit)}</span>
          <span>
            {r().ahead} {r().ahead === 1 ? "commit" : "commits"} ahead{lines()}
          </span>
        </p>
        <ChatLine projectId={props.projectId} session={r().session} archived={r().sessionArchived} worktree={r().worktree} chatOf={props.chatOf} />
        <Show when={askSpecs()}>
          <LandSpecsConfirm
            branch={r().branch}
            busy={!!act.busy()}
            onConfirm={() => {
              setAskSpecs(false);
              doLand({ withoutSpecs: true });
            }}
            onCancel={() => setAskSpecs(false)}
          />
        </Show>
        <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="mq-row-act">
        <QueueReview projectId={props.projectId} branch={r().branch} scope={{ kind: "queue", project: props.projectId, branch: r().branch }} session={r().session} chatOf={props.chatOf} />
        <LandSplit branch={r().branch} review={props.review} busy={!!act.busy()} onLand={doLand} onWithoutSpecs={() => setAskSpecs(true)} />
      </div>
    </li>
  );
}
