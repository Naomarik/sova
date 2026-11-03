import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js";
import { relativeTime } from "../lib/format";
import { attribution, clock, sentence, short, sourceTag, stepCounts, stepDetail, stepMark, stepTime, unattributedWhy, verdictChip, type MergeEntry, type MergeQueueView, type MergeRun, type RunStep } from "../lib/merge-queue";
import { answerEntry, mergeChanged, readLog, readRun, refusal } from "../lib/merge-queue-client";
import { createFollowedRead, createRunRead } from "../lib/merge-run";
import type { MergeAnswer } from "../../shared/merge-queue";
import { announce, home, toast } from "../lib/ui-state";
import { projectSessionHref, projectTabHref } from "../lib/projects-route";
import { Banner, Icon } from "./ui";
import { type ChatOf, FromChat } from "./MergeQueueTab";
import { QueueChip, UnclearChecks } from "./WorktreesModal";

const RUN_POLL_MS = 3000;
/** An open log of a step (or run) still running is read again this often. */
const LOG_FOLLOW_MS = 3000;

/**
 * One run of the queue (`#/projects/<pid>/merge-queue/<run>`): what was merged onto what and what it
 * tested, whose failure it was when it failed (checked against the target alone), and every step —
 * the copy and setup included — with where each check came from, why, its time and its log.
 */
export function MergeRunView(props: { projectId: string; view: MergeQueueView; runId: string; chatOf?: ChatOf }) {
  // A running run moves: it's read again while it runs, and on any queue change. Each read is reconciled into
  // the last (lib/merge-run), so the step rows stay put and an open log stays open.
  const read = createRunRead(() => props.runId, readRun, RUN_POLL_MS);
  const run = read.run;
  createEffect(on(mergeChanged, () => read.refetch(), { defer: true }));
  const running = createMemo(() => run()?.verdict === "running");
  // A running step's time counts up: one clock for the page, ticking only while the run runs.
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!running()) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  const [allLogs, setAllLogs] = createSignal(false);
  const entry = () => {
    const r = run();
    const v = props.view;
    return r ? ([...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix].find((e) => e.id === r.entry) ?? v.recent.find((l) => l.entry.id === r.entry)?.entry) : undefined;
  };
  return (
    <div class="stack mq-run" aria-labelledby="mq-run-title">
      <nav class="mq-crumbs text-caption" aria-label="Breadcrumb">
        <a href={projectTabHref(props.projectId, "merge-queue")}>Merge queue</a>
        <span aria-hidden="true"> › </span>
        <span>{run()?.branch ?? props.runId}</span>
      </nav>
      <Show when={run()} fallback={<p class="orgs-empty">{read.error() ? `Couldn't read this run. ${read.error() instanceof Error ? (read.error() as Error).message : String(read.error())}` : "Reading the run."}</p>}>
        {(r) => (
          <>
            <div class="stack-2">
            <div class="cluster">
              <h2 class="orgs-h2 text-mono" id="mq-run-title">
                {r().branch}
              </h2>
              <QueueChip row={r().verdict === "waiting" && entry()?.state === "unattributed" ? { label: "Can't tell whose failure · waiting for you", tone: "warn" } : verdictChip(r())} />
            </div>
            <p class="text-caption">
              <span class="text-mono">
                {props.view.target} {short(r().base)}
              </span>{" "}
              + <span class="text-mono">{short(r().commit)}</span>
              <Show when={r().tip}>
                {" "}
                → tested commit <span class="text-mono">{short(r().tip)}</span>
              </Show>{" "}
              · started {relativeTime(r().startedAt)}
              <Show when={r().endedAt}> · took {clock(Date.parse(r().endedAt!) - Date.parse(r().startedAt))}</Show>
            </p>
            <Show when={entry()}>
              {(e) => (
                <p class="text-caption text-muted">
                  <FromChat projectId={props.projectId} entry={e()} chatOf={props.chatOf} /> · approved {relativeTime(e().approval.at)} by {e().approval.by === "typed" ? "your message in its chat" : "your Land"}
                </p>
              )}
            </Show>
            </div>
            <div class="button-row mq-run-actions">
              <button type="button" class="button button-sm" aria-expanded={allLogs() ? "true" : "false"} aria-controls="mq-run-all-logs" onClick={() => setAllLogs(!allLogs())}>
                <Icon name="terminal" small />
                {allLogs() ? "Hide Logs" : "View Logs"}
              </button>
              <Show when={props.view.thread}>
                {(t) => (
                  <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, t().session)}>
                    <Icon name="chat" small />
                    Open Merge Thread
                  </a>
                )}
              </Show>
              <a class="button button-sm button-ghost" href={projectTabHref(props.projectId, "merge-queue")}>
                <Icon name="chevron-left" small />
                Back to Queue
              </a>
            </div>
            <Show when={allLogs()}>
              <AllLogs run={r()} />
            </Show>
            <Verdict run={r()} target={props.view.target} unattributed={entry()?.state === "unattributed"} />
            <Show when={entry()?.state === "unattributed" && (entry()!.run ?? r().id) === r().id && entry()}>
              {(e) => <Unattributed projectId={props.projectId} entry={e()} target={props.view.target} />}
            </Show>
            <Show when={entry()?.conflict}>
              {(c) => (
                <div class="mq-card" role="group" aria-label="The conflict">
                  <h3 class="text-heading-s">The conflict</h3>
                  <p class="text-caption">
                    In <span class="text-mono">{c().files.join(", ")}</span> ·{" "}
                    {c().verdict === "no-behaviour-change" ? "no change of behaviour: resolved by the merge thread" : "the two sides want different behaviour"}
                  </p>
                  <dl class="mq-sides">
                    <div>
                      <dt class="text-eyebrow">{props.view.target}</dt>
                      <dd>{c().ours}</dd>
                    </div>
                    <div>
                      <dt class="text-eyebrow">This branch</dt>
                      <dd>{c().theirs}</dd>
                    </div>
                    <div>
                      <dt class="text-eyebrow">Resolution</dt>
                      <dd>{c().proposal}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </Show>
            <div class="mq-card" role="group" aria-labelledby="mq-steps-title">
              <div class="mq-card-head">
                <h3 class="text-heading-s" id="mq-steps-title">
                  Checks and why
                </h3>
                <p class="text-caption text-muted mq-legend">Required: the project's floor · Triggered: by the changed files · Added: by the merge thread</p>
              </div>
              <Show when={r().noChecks}>
                <p class="text-caption">This project declares no automated tests: it lands after a clean merge.</p>
              </Show>
              <ol class="mq-steps">
                <For each={r().steps}>{(s) => <StepRow run={r()} step={s} now={now} />}</For>
              </ol>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

/** Can't tell whose failure: what failed on both sides, and your two answers (merge verbs; nothing goes to the chat). */
function Unattributed(props: { projectId: string; entry: MergeEntry; target: string }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const answer = async (a: MergeAnswer, done: string) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      const no = refusal(await answerEntry(props.entry, a));
      if (no) setError(no);
      else {
        toast(done);
        announce(done);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="banner banner-warn mq-unattributed" role="status">
      <Icon name="alert-circle" class="banner-icon" />
      <div class="banner-main">
        <p class="banner-title">Can't tell whose failure. Nothing landed; {props.target} didn't move.</p>
        <p class="banner-body">{unattributedWhy(props.entry.reason, props.target)} Nobody is blamed. Land Anyway lands the commit it tested; Send Back hands it to its chat.</p>
        <UnclearChecks projectId={props.projectId} unclear={props.entry.unclear} target={props.target} />
        <Show when={error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
        <div class="button-row mq-card-actions">
          <button type="button" class="button button-sm button-primary" aria-label={`Land ${props.entry.branch} anyway`} disabled={busy()} onClick={() => void answer("land-anyway", `Landing ${props.entry.branch} anyway.`)}>
            Land Anyway
          </button>
          <button type="button" class="button button-sm button-destructive" aria-label={`Send ${props.entry.branch} back to its chat`} disabled={busy()} onClick={() => void answer("send-back", `Sent ${props.entry.branch} back to its chat.`)}>
            Send Back
          </button>
        </div>
      </div>
    </div>
  );
}

/** The verdict banner and, for a red run, whose failure it is. */
function Verdict(props: { run: MergeRun; target: string; /** Its own banner says it: no generic line above it. */ unattributed?: boolean }) {
  const r = () => props.run;
  const rows = () => attribution(r());
  const failedStep = () => r().steps.find((s) => s.result === "failed" && (s.kind === "check" || s.kind === "setup" || s.kind === "install" || s.kind === "review"));
  return (
    <>
      <Show when={r().verdict === "failed" && r().blame === "branch"}>
        <Banner tone="error" title={`${r().branch} broke ${failedStep()?.label ?? "a check"}. It didn't land; ${props.target} didn't move.`} body={`${sentence(r().why) || "It passes on the target alone and fails with this branch."} It went back to its chat with the log.`} />
      </Show>
      <Show when={r().verdict === "failed" && r().blame === "resolution"}>
        <Banner tone="warn" title="The merge thread's resolution failed a check." body={`${sentence(r().why)} It comes back to you; the branch isn't blamed.`.trim()} />
      </Show>
      <Show when={r().verdict === "failed" && (r().blame === "master" || r().blame === "flaky")}>
        <Banner tone="warn" title={r().blame === "master" ? `Red on ${props.target} too.` : "Flaky: it passed on a rerun."} body={`${sentence(r().why)} Noted on the landing; it doesn't block.`.trim()} />
      </Show>
      <Show when={r().verdict === "machine"}>
        <Banner tone="warn" title={`Stopped at ${failedStep()?.label ?? "setup"}. It's not the branch's fault, and nothing was merged.`} body={`${sentence(r().why) || `It failed on ${props.target} alone too.`} Retried once, then paused. No chat was told to fix anything; the branch keeps its place.`} />
      </Show>
      <Show when={r().verdict === "void"}>
        <Banner tone="info" title="This run stopped before it finished. Nothing was blamed." body={sentence(r().why) || "It runs again from the start."} />
      </Show>
      <Show when={!props.unattributed && (r().verdict === "running" || r().verdict === "waiting" || r().verdict === "conflict")}>
        <p class="text-caption mq-nothing">Nothing has merged from this run. {props.target} moves only once every check passes.</p>
      </Show>
      <Show when={r().verdict === "passed"}>
        <Banner tone="success" title={`Passed. ${props.target} moved to exactly the tested commit.`} />
      </Show>
      <Show when={rows()}>
        {(list) => (
          <div class="mq-card" role="group" aria-labelledby="mq-whose">
            <div class="spread">
              <h3 class="text-heading-s" id="mq-whose">
                Whose failure is it?
              </h3>
              <p class="text-caption text-muted">Checked in the same copy, in this order</p>
            </div>
            <dl class="mq-whose">
              <For each={list()}>
                {(q) => (
                  <div>
                    <dt class="text-caption text-muted">{q.question}</dt>
                    <dd class={`mq-whose-${q.result}`}>{q.answer}</dd>
                  </div>
                )}
              </For>
            </dl>
          </div>
        )}
      </Show>
    </>
  );
}

/** Keeps an open log at its bottom while it grows, only when it was already there (or opened following a running step). */
function followScroll(text: Accessor<string | undefined>, startAtBottom: boolean) {
  let pre: HTMLPreElement | undefined;
  let stuck = startAtBottom;
  createEffect(
    on(text, () => {
      if (pre && stuck) pre.scrollTop = pre.scrollHeight;
    }),
  );
  return {
    ref: (el: HTMLPreElement) => (pre = el),
    onScroll: () => {
      if (pre) stuck = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    },
  };
}

function StepRow(props: { run: MergeRun; step: RunStep; now: Accessor<number> }) {
  const s = () => props.step;
  const tag = () => sourceTag(s().source);
  const mark = () => stepMark(s());
  const [open, setOpen] = createSignal(false);
  const live = () => open() && s().result === "running";
  const log = createFollowedRead(
    () => (open() ? `${props.run.id}\n${s().id}\n${s().result}` : null),
    (key) => {
      const [run, step] = key.split("\n");
      return readLog(run!, step!);
    },
    live,
    LOG_FOLLOW_MS,
  );
  const detail = () => stepDetail(s(), home());
  const counts = () => stepCounts(s());
  const line = () => [s().why, detail().map((d) => d.text).join(""), counts().map((c) => c.text).join(" · ")].filter(Boolean).join(" · ");
  const scroll = followScroll(log.text, s().result === "running");
  return (
    <li class={`mq-step mq-step-${s().result}`} data-step={s().id}>
      <span class={`mq-mark ${mark().cls}`} title={mark().word}>
        <Show when={mark().icon} fallback={<span class="mq-ring" aria-hidden="true" />}>
          {(icon) => <Icon name={icon()} small />}
        </Show>
        <span class="visually-hidden">{mark().word}</span>
      </span>
      <div class="mq-step-main">
        <p class="cluster mq-step-name">
          <span>{s().label}</span>
          <Show when={tag()}>{(t) => <QueueChip row={t()} />}</Show>
        </p>
        <Show when={line()}>
          <p class="text-caption text-muted mq-step-desc" title={line()}>
            <Show when={s().why}>{s().why}</Show>
            <For each={detail()}>
              {(d, i) => (
                <>
                  {i() === 0 && s().why ? " · " : ""}
                  {d.mono ? <span class="text-mono">{d.text}</span> : d.text}
                </>
              )}
            </For>
            <For each={counts()}>
              {(c, i) => (
                <>
                  {i() > 0 || s().why || detail().length ? " · " : ""}
                  {c.failed ? <span class="mq-fail">{c.text}</span> : c.text}
                </>
              )}
            </For>
          </p>
        </Show>
        <For each={s().failures ?? []}>
          {(f) => (
            <p class="text-caption mq-fail-line">
              <span class="text-mono">{[f.file, f.name].filter(Boolean).join(" · ")}</span>
              {f.message ? `: ${f.message}` : ""}
            </p>
          )}
        </For>
      </div>
      <span class="mq-step-time text-caption text-mono text-muted">{stepTime(s(), props.now())}</span>
      <span class="mq-step-log">
        <Show when={s().result !== "pending"}>
          <button type="button" class="button button-sm button-ghost" aria-expanded={open() ? "true" : "false"} aria-label={`${open() ? "Hide" : "Show"} the log of ${s().label}`} onClick={() => setOpen(!open())}>
            Log
          </button>
        </Show>
      </span>
      <Show when={open()}>
        <pre class="mq-log text-mono" aria-label={`Log of ${s().label}`} ref={scroll.ref} onScroll={scroll.onScroll}>
          {log.text() === undefined ? (log.error() ? `Couldn't read the log. ${log.error()}` : "Reading the log.") : log.text() || "Nothing logged yet."}
        </pre>
      </Show>
    </li>
  );
}

/** View Logs: every step's log, in order, from the run's first step (the copy and setup included); it follows the run while it runs. */
function AllLogs(props: { run: MergeRun }) {
  const log = createFollowedRead(
    () => `${props.run.id}\n${props.run.verdict}`,
    (key) => readLog(key.split("\n")[0]!),
    () => props.run.verdict === "running",
    LOG_FOLLOW_MS,
  );
  const scroll = followScroll(log.text, props.run.verdict === "running");
  return (
    <pre id="mq-run-all-logs" class="mq-log mq-log-all text-mono" aria-label="Every step's log" ref={scroll.ref} onScroll={scroll.onScroll}>
      {log.text() === undefined ? (log.error() ? `Couldn't read the logs. ${log.error()}` : "Reading the logs.") : log.text() || "Nothing logged yet."}
    </pre>
  );
}
