import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import { ApiError, approveProjectRuntime, getProjectRuntime, runProjectVerbsPlaybook } from "../lib/api";
import { relativeTime } from "../lib/format";
import { createPoll, type Poll } from "../lib/poll";
import { approveLabel, approveWhat, deployTickBlock, failedLine, liveWord, memoryWord, openWord, playbookLabel, portsWord, provenTail, reviewDefProblem, reviewProofWord, runStrip, runWord, SENSITIVE_TITLE, serviceFacts, shareWord, STANDING_CHIP } from "../lib/project-software";
import { projectSessionHref, projectTabHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { ApproveMergeButton, proposedRun } from "./PlaybookReview";
import { DeployReviewTicks } from "./ProjectDeployPanel";
import { tickProgress } from "../lib/project-deploy";
import { Chip, Icon } from "./ui";

/** The registry changes on a merge, a conformance or a run: read it often enough to follow one. */
const SOFTWARE_POLL_MS = 15_000;
const FEED_SHOWN = 5;

/** The page's one read of the registry: the Software card and the proposed run's banner share it. */
export const createRuntimePoll = (projectId: string): Poll<ProjectRuntimeView> => createPoll(() => getProjectRuntime(projectId), SOFTWARE_POLL_MS);

/** The run strip's state chip: working is the live indicator; waiting on you is warn. */
const STRIP_TONE: Record<string, "accent" | "warn" | "info" | undefined> = { Working: "accent", "Waiting for your answers": "warn", Proposed: "info", Idle: undefined };

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/**
 * The project's Software card (§app.project-runtime/software-card): the registry's standing, each declared
 * service with how it is isolated, where it runs now and the memory conformance measured, the proof, what
 * changed since registration, the Project verbs playbook's run, and the registry's latest feed. Run Playbook
 * and Approve show only while the statecharts would take them.
 */
export function ProjectSoftwareCard(props: { projectId: string; archived: boolean; runtime: Poll<ProjectRuntimeView> }) {
  const poll = props.runtime;
  // A deploy recipe's ticks (§app.project-services/deploy-trust), kept for the recipe shown: a new hash starts over.
  const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set());
  const deployReview = () => (poll.data()?.playbookState === "proposed" ? poll.data()?.playbook?.review?.deploy : undefined);
  createEffect(on(() => deployReview()?.deployHash, () => setTicked(new Set<string>())));
  const tick = (key: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const tickBlock = () => {
    const r = deployReview();
    return r ? deployTickBlock(r, ticked()) : null;
  };
  const [busy, setBusy] = createSignal<"approve" | "run" | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const act = async (kind: "approve" | "run", fn: () => Promise<string>) => {
    if (busy()) return;
    setBusy(kind);
    setError(null);
    try {
      const done = await fn();
      toast(done);
      announce(done);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
      poll.refetch();
    }
  };
  const approve = (v: ProjectRuntimeView) =>
    act("approve", async () => {
      const hash = v.can.approve!;
      poll.set(await approveProjectRuntime(props.projectId, hash));
      return `Approved ${hash.replace(/^sha256:/, "").slice(0, 12)} on this host.`;
    });
  const run = () =>
    act("run", async () => {
      const out = await runProjectVerbsPlaybook(props.projectId);
      return out.worktree ? `The Project verbs playbook started on ${out.worktree.branch}.` : "The Project verbs playbook started.";
    });

  return (
    <section class="card orgs-section" aria-labelledby="project-software">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-software">
          Software
        </h2>
        <Show when={poll.data()}>{(v) => <Chip tone={STANDING_CHIP[v().standing].tone}>{STANDING_CHIP[v().standing].word}</Chip>}</Show>
      </div>
      <Show when={poll.data()} fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read the software registry. ${poll.error()}` : "Reading the software registry."}</p>}>
        {(v) => (
          <>
            <Show when={failedLine(v())}>{(line) => <p class="orgs-line project-software-failed">{line()}</p>}</Show>
            <Show when={v().drift?.length}>
              <p class="orgs-line">
                Changed since: <span class="text-mono">{v().drift!.join(", ")}</span>
              </p>
            </Show>
            <Show
              when={v().services.length}
              fallback={<p class="orgs-empty">{v().def?.state === "absent" || !v().def ? "Main declares no software yet. Run Playbook writes its definition on a branch for you to approve." : "No services declared."}</p>}
            >
              <ul class="orgs-history-list project-software-list">
                <For each={v().services}>
                  {(s) => (
                    <li class="orgs-change project-software-row">
                      <span class="orgs-change-main">
                        <span class="project-software-name">{s.name}</span> <span class="list-meta" title={s.isolation?.why}>{serviceFacts(s)}</span>
                        <Show when={portsWord(s)}>{(p) => <span class="list-meta text-mono"> · {p()}</span>}</Show>
                        <Show when={liveWord(s)}>{(l) => <span class="project-muted"> · {l()}</span>}</Show>
                        <Show when={memoryWord(s.memory)}>{(m) => <span class="list-meta"> · {m()}</span>}</Show>
                      </span>
                    </li>
                  )}
                </For>
                <For each={v().data}>
                  {(r) => (
                    <li class="orgs-change project-software-row">
                      <span class="orgs-change-main">
                        <span class="project-software-name">{r.name}</span> <span class="list-meta">data · {r.kind}</span>
                      </span>
                      <Show when={r.sensitive}>
                        <Chip tone="warn" title={SENSITIVE_TITLE}>
                          Sensitive
                        </Chip>
                      </Show>
                    </li>
                  )}
                </For>
                <For each={v().orphans}>
                  {(o) => (
                    <li class="orgs-change project-software-row">
                      <span class="orgs-change-main">
                        <span class="project-software-name">{o.name}</span> <span class="list-meta">still running in {o.label}, no longer declared</span>
                      </span>
                      <Chip tone="warn">Orphan</Chip>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            {/* Where each copy is started, stopped, opened and read (§app.project-services/services-ui). */}
            <p class="orgs-line">
              <a class="project-software-open" href={projectTabHref(props.projectId, "branches")}>
                Open Branches
                <Icon name="chevron-right" small />
              </a>
            </p>
            <Show when={provenTail(v())}>
              {(tail) => (
                <p class="list-meta">
                  Proven <time title={v().proof!.at}>{relativeTime(v().proof!.at)}</time> {tail()}
                </p>
              )}
            </Show>
            <Show when={runWord(v())}>
              {(w) => (
                <p class="orgs-line">
                  <Show when={v().playbook?.path} fallback={w()}>
                    {(path) => <a href={projectSessionHref(props.projectId, path())}>{w()}</a>}
                  </Show>
                  .
                </p>
              )}
            </Show>
            {/* A live run as it goes (§app.project-runtime/run-progress): from its session, no tool of its own. */}
            <Show when={runStrip(v(), Date.now())}>
              {(strip) => (
                <p class="project-run-strip" aria-label={`${v().playbook!.label} run`}>
                  <Chip tone={STRIP_TONE[strip().state]} live={strip().state === "Working"}>
                    {strip().state}
                  </Chip>
                  <Show when={strip().elapsed}>{(e) => <span class="list-meta">{e()}</span>}</Show>
                  <Show when={strip().questions ?? strip().now}>{(line) => <span class="project-run-now">{line()}</span>}</Show>
                  <Show when={v().playbook?.path}>
                    {(path) => (
                      <a class="project-software-open" href={projectSessionHref(props.projectId, path())}>
                        {strip().questions ? "Answer in Its Session" : "Open Session"}
                        <Icon name="chevron-right" small />
                      </a>
                    )}
                  </Show>
                </p>
              )}
            </Show>
            {/* What a proposed run's branch proposes, read by Sova (§app.project-runtime/run-report). */}
            <Show when={v().playbookState === "proposed" ? v().playbook?.review : undefined}>
              {(r) => (
                <div class="project-run-review" role="group" aria-label="What the run proposes">
                  <Show
                    when={!reviewDefProblem(r())}
                    fallback={<p class="orgs-line project-software-failed">{reviewDefProblem(r())}</p>}
                  >
                    <ul class="orgs-history-list project-software-list">
                      <For each={r().services}>
                        {(s) => (
                          <li class="orgs-change project-software-row">
                            <span class="orgs-change-main">
                              <span class="project-software-name">{s.name}</span> <span class="list-meta" title={s.isolation?.why}>{serviceFacts(s)}</span>
                              <Show when={portsWord(s)}>{(p) => <span class="list-meta text-mono"> · {p()}</span>}</Show>
                              <Show when={memoryWord(s.memory)}>{(m) => <span class="list-meta"> · {m()}</span>}</Show>
                            </span>
                          </li>
                        )}
                      </For>
                      <For each={r().data}>
                        {(d) => (
                          <li class="orgs-change project-software-row">
                            <span class="orgs-change-main">
                              <span class="project-software-name">{d.name}</span> <span class="list-meta">data · {d.kind}</span>
                            </span>
                            <Show when={d.sensitive}>
                              <Chip tone="warn" title={SENSITIVE_TITLE}>
                                Sensitive
                              </Chip>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                    <p class="list-meta">
                      {shareWord(r())} · {openWord(r())}
                    </p>
                  </Show>
                  <p class="list-meta">{reviewProofWord(r())}</p>
                  {/* A deploy-setup run: its recipe, every resolved step ticked before Approve & Merge. */}
                  <Show when={r().deploy}>
                    {(d) => (
                      <>
                        <DeployReviewTicks review={d()} ticked={ticked()} onTick={tick} />
                        <p class="list-meta" role="status">
                          {tickProgress(d(), ticked()).line}
                        </p>
                      </>
                    )}
                  </Show>
                  <Show when={v().playbook?.path}>
                    {(path) => (
                      <p class="orgs-line">
                        <a class="project-software-open" href={projectSessionHref(props.projectId, path())}>
                          Read Report
                          <Icon name="chevron-right" small />
                        </a>
                      </p>
                    )}
                  </Show>
                </div>
              )}
            </Show>
            <Show when={!proposedRun(v()) && approveWhat(v())}>{(w) => <p class="list-meta">{w()}</p>}</Show>
            <Show when={error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
            <div class="button-row project-software-actions">
              {/* While a run is proposed: one gesture, Approve & Merge (§app.project-runtime/approve-merge). */}
              <Show when={proposedRun(v())}>
                {(run) => (
                  <ApproveMergeButton
                    projectId={props.projectId}
                    run={run()}
                    {...(deployReview() ? { ticked: [...ticked()], blocked: tickBlock() } : {})}
                    onDone={(view) => (view ? poll.set(view) : poll.refetch())}
                  />
                )}
              </Show>
              <Show when={!proposedRun(v()) && approveLabel(v())}>
                {(label) => (
                  <button type="button" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => void approve(v())}>
                    {label()}
                  </button>
                )}
              </Show>
              <Show when={v().can.onboard && !props.archived}>
                <button type="button" class="button button-sm" aria-disabled={busy() ? "true" : undefined} onClick={() => void run()}>
                  {playbookLabel(v())}
                </button>
              </Show>
            </div>
            <Show when={v().feed.length}>
              <ul class="orgs-history-list project-software-feed" aria-label="Software registry feed">
                <For each={v().feed.slice(0, FEED_SHOWN)}>
                  {(f) => (
                    <li class="orgs-change">
                      <span class="orgs-change-main">
                        {f.line} <span class="list-meta">· <time title={f.at}>{relativeTime(f.at)}</time></span>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
