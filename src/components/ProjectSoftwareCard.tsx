import { createSignal, For, Show } from "solid-js";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import { ApiError, approveProjectRuntime, getProjectRuntime, runProjectVerbsPlaybook } from "../lib/api";
import { relativeTime } from "../lib/format";
import { createPoll } from "../lib/poll";
import { approveLabel, approveWhat, failedLine, liveWord, memoryWord, playbookLabel, portsWord, provenTail, runWord, SENSITIVE_TITLE, serviceFacts, STANDING_CHIP } from "../lib/project-software";
import { projectSessionHref, projectTabHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { Chip } from "./ui";

/** The registry changes on a merge, a conformance or a run: read it often enough to follow one. */
const SOFTWARE_POLL_MS = 15_000;
const FEED_SHOWN = 5;

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/**
 * The project's Software card (§app.project-runtime/software-card): the registry's standing, each declared
 * service with how it is isolated, where it runs now and the memory conformance measured, the proof, what
 * changed since registration, the Project verbs playbook's run, and the registry's latest feed. Run Playbook
 * and Approve show only while the statecharts would take them.
 */
export function ProjectSoftwareCard(props: { projectId: string; archived: boolean }) {
  const poll = createPoll(() => getProjectRuntime(props.projectId), SOFTWARE_POLL_MS);
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
            {/* Where each copy is started, stopped and read (§app.project-services/services-ui). */}
            <p class="orgs-line">
              <a href={projectTabHref(props.projectId, "services")}>Open Services</a>
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
            <Show when={approveWhat(v())}>{(w) => <p class="list-meta">{w()}</p>}</Show>
            <Show when={error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
            <div class="button-row project-software-actions">
              <Show when={approveLabel(v())}>
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
