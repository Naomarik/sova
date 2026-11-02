import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { relativeTime } from "../lib/format";
import { attribution, clock, short, sourceTag, verdictChip, type MergeQueueView, type MergeRun, type RunStep } from "../lib/merge-queue";
import { mergeChanged, readLog, readRun } from "../lib/merge-queue-client";
import { projectSessionHref, projectTabHref } from "../lib/projects-route";
import { Banner, Icon } from "./ui";
import { FromChat } from "./MergeQueueTab";
import { QueueChip } from "./WorktreesModal";

const RUN_POLL_MS = 3000;

const MARK: Record<RunStep["result"], { icon: "check" | "close" | "clock" | "chevron-right"; cls: string; word: string }> = {
  passed: { icon: "check", cls: "mq-pass", word: "Passed" },
  failed: { icon: "close", cls: "mq-fail", word: "Failed" },
  running: { icon: "clock", cls: "mq-running", word: "Running" },
  pending: { icon: "chevron-right", cls: "mq-wait", word: "Waiting" },
  skipped: { icon: "chevron-right", cls: "mq-skip", word: "Skipped" },
};

/**
 * One run of the queue (`#/projects/<pid>/merge-queue/<run>`): what was merged onto what and what it
 * tested, whose failure it was when it failed (checked against the target alone), and every step —
 * the copy and setup included — with where each check came from, why, its time and its log.
 */
export function MergeRunView(props: { projectId: string; view: MergeQueueView; runId: string; chatTitle?(path: string): string | undefined }) {
  const [run, { refetch }] = createResource(() => props.runId, readRun);
  // A running run moves: read it again while it runs, and on any queue change.
  createEffect(
    on(
      () => run()?.verdict,
      (verdict) => {
        if (verdict !== "running") return;
        const t = setTimeout(() => void refetch(), RUN_POLL_MS);
        return () => clearTimeout(t);
      },
    ),
  );
  createEffect(on(mergeChanged, () => void refetch(), { defer: true }));
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
      <Show when={run()} fallback={<p class="orgs-empty">{run.error ? `Couldn't read this run. ${run.error instanceof Error ? run.error.message : String(run.error)}` : "Reading the run."}</p>}>
        {(r) => (
          <>
            <div class="cluster">
              <h2 class="orgs-h2 text-mono" id="mq-run-title">
                {r().branch}
              </h2>
              <QueueChip row={verdictChip(r())} />
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
                  <FromChat projectId={props.projectId} entry={e()} chatTitle={props.chatTitle} /> · approved {relativeTime(e().approval.at)} by {e().approval.by === "typed" ? "your message in its chat" : "your Land"}
                </p>
              )}
            </Show>
            <div class="button-row">
              <AllLogs run={r()} />
              <Show when={props.view.thread}>
                {(t) => (
                  <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, t().session)}>
                    <Icon name="chat" small />
                    Open Merge Thread
                  </a>
                )}
              </Show>
              <a class="button button-sm button-ghost" href={projectTabHref(props.projectId, "merge-queue")}>
                Back to Queue
              </a>
            </div>
            <Verdict run={r()} target={props.view.target} />
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
              <div class="spread">
                <h3 class="text-heading-s" id="mq-steps-title">
                  Checks and why
                </h3>
                <p class="text-caption text-muted mq-legend">Required: the project's floor · Triggered: by the changed files · Added: by the merge thread</p>
              </div>
              <Show when={r().noChecks}>
                <p class="text-caption">This project declares no automated tests: it lands after a clean merge.</p>
              </Show>
              <ol class="mq-steps">
                <For each={r().steps}>{(s) => <StepRow run={r()} step={s} />}</For>
              </ol>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

/** The verdict banner and, for a red run, whose failure it is. */
function Verdict(props: { run: MergeRun; target: string }) {
  const r = () => props.run;
  const rows = () => attribution(r());
  const failedStep = () => r().steps.find((s) => s.result === "failed" && (s.kind === "check" || s.kind === "setup" || s.kind === "install" || s.kind === "review"));
  return (
    <>
      <Show when={r().verdict === "failed" && r().blame === "branch"}>
        <Banner tone="error" title={`${r().branch} broke ${failedStep()?.label ?? "a check"}. It didn't land; ${props.target} didn't move.`} body={`${r().why ?? "It passes on the target alone and fails with this branch."} It went back to its chat with the log.`} />
      </Show>
      <Show when={r().verdict === "failed" && r().blame === "resolution"}>
        <Banner tone="warn" title="The merge thread's resolution failed a check." body={`${r().why ?? ""} It comes back to you; the branch isn't blamed.`.trim()} />
      </Show>
      <Show when={r().verdict === "failed" && (r().blame === "master" || r().blame === "flaky")}>
        <Banner tone="warn" title={r().blame === "master" ? `Red on ${props.target} too.` : "Flaky: it passed on a rerun."} body={`${r().why ?? ""} Noted on the landing; it doesn't block.`.trim()} />
      </Show>
      <Show when={r().verdict === "machine"}>
        <Banner tone="warn" title={`Stopped at ${failedStep()?.label ?? "setup"}. It's not the branch's fault, and nothing was merged.`} body={`${r().why ?? `It failed on ${props.target} alone too.`} Retried once, then paused. No chat was told to fix anything; the branch keeps its place.`} />
      </Show>
      <Show when={r().verdict === "void"}>
        <Banner tone="info" title="This run stopped before it finished. Nothing was blamed." body={r().why ?? "It runs again from the start."} />
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

function StepRow(props: { run: MergeRun; step: RunStep }) {
  const s = () => props.step;
  const tag = () => sourceTag(s().source);
  const mark = () => MARK[s().result];
  const [open, setOpen] = createSignal(false);
  const [log] = createResource(
    () => (open() ? [props.run.id, s().id, s().result] : null),
    ([run, step]) => readLog(run as string, step as string),
  );
  const counts = () => {
    const c = s().counts;
    if (!c) return "";
    return [c.passed != null ? `${c.passed} passed` : "", c.failed ? `${c.failed} failed` : "", c.skipped ? `${c.skipped} skipped` : ""].filter(Boolean).join(" · ");
  };
  return (
    <li class={`mq-step mq-step-${s().result}`} data-step={s().id}>
      <span class={`mq-mark ${mark().cls}`} title={mark().word}>
        <Icon name={mark().icon} small />
        <span class="visually-hidden">{mark().word}</span>
      </span>
      <div class="mq-step-main">
        <p class="cluster mq-step-name">
          <span>{s().label}</span>
          <Show when={tag()}>{(t) => <QueueChip row={t()} />}</Show>
        </p>
        <Show when={s().why || s().detail}>
          <p class="text-caption text-muted">{[s().why, s().detail].filter(Boolean).join(" · ")}</p>
        </Show>
        <For each={s().failures ?? []}>
          {(f) => (
            <p class="text-caption mq-fail-line">
              <span class="text-mono">{[f.file, f.name].filter(Boolean).join(" · ")}</span>
              {f.message ? `: ${f.message}` : ""}
            </p>
          )}
        </For>
        <Show when={open()}>
          <pre class="mq-log text-mono" aria-label={`Log of ${s().label}`}>
            {log.loading ? "Reading the log." : log.error ? `Couldn't read the log. ${log.error instanceof Error ? log.error.message : ""}` : log() || "Nothing logged yet."}
          </pre>
        </Show>
      </div>
      <div class="mq-step-end">
        <span class="text-caption text-mono text-muted">
          {s().result === "pending" || s().result === "skipped" ? "" : clock(s().ms)}
          {counts() ? ` · ${counts()}` : ""}
        </span>
        <Show when={s().result !== "pending"}>
          <button type="button" class="button button-sm button-ghost" aria-expanded={open() ? "true" : "false"} aria-label={`${open() ? "Hide" : "Show"} the log of ${s().label}`} onClick={() => setOpen(!open())}>
            Log
          </button>
        </Show>
      </div>
    </li>
  );
}

/** View Logs: every step's log, in order, from the run's first step (the copy and setup included). */
function AllLogs(props: { run: MergeRun }) {
  const [open, setOpen] = createSignal(false);
  const [log] = createResource(
    () => (open() ? props.run.id : null),
    (run) => readLog(run),
  );
  return (
    <>
      <button type="button" class="button button-sm" aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(!open())}>
        <Icon name="terminal" small />
        {open() ? "Hide Logs" : "View Logs"}
      </button>
      <Show when={open()}>
        <pre class="mq-log mq-log-all text-mono" aria-label="Every step's log">
          {log.loading ? "Reading the logs." : log.error ? `Couldn't read the logs. ${log.error instanceof Error ? log.error.message : ""}` : log() || "Nothing logged yet."}
        </pre>
      </Show>
    </>
  );
}
