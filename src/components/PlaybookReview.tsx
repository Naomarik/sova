import { createSignal, Show } from "solid-js";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import { reviewAction, reviewBanner, type PlaybookReviewWords } from "../../shared/playbook-review";
import { ApiError, mergeProjectRun } from "../lib/api";
import { requestListRefresh } from "../lib/list-refresh";
import { projectSessionHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { Banner } from "./ui";
import { landBranch, refusal } from "../lib/merge-queue-client";
import { queueRow } from "../lib/merge-queue";
import { createProjectQueue } from "../lib/project-queue";
import { QueueChip } from "./WorktreesModal";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** A proposed run's words from the registry the page reads, or null while nothing is proposed. */
export function proposedRun(v: ProjectRuntimeView | undefined): (PlaybookReviewWords & { path?: string; commit?: string }) | null {
  const pb = v?.playbook;
  if (!v || v.playbookState !== "proposed" || !pb) return null;
  return {
    label: pb.label,
    branch: pb.branch ?? "its branch",
    target: pb.target ?? "main",
    ...(pb.branchHash ? { hash: pb.branchHash } : {}),
    proposes: pb.proposes,
    ...(pb.path ? { path: pb.path } : {}),
    // The branch tip whose definition the review read: Land pins it, as the old hash check did.
    ...(pb.commit ? { commit: pb.commit } : {}),
  };
}

/**
 * Merge Branch (§app.project-runtime/merge): merges the branch of the run that proposes this hash. A refusal is
 * said under the button; done, the list and digest are read again so the Needs-you item goes at once.
 * A project whose merge queue is set up gets Land instead: the branch joins the queue at its head, and the
 * button's place shows its queue state from then on.
 */
export function MergeRunButton(props: {
  projectId: string;
  run: Pick<PlaybookReviewWords, "hash" | "target" | "branch"> & { commit?: string };
  class?: string;
  onDone?(view?: ProjectRuntimeView): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const label = () => reviewAction(props.run);
  const queue = createProjectQueue(() => props.projectId);
  const entry = () => queue.info(props.run.branch);
  /** In the queue and not back with its chat: its state stands where the button was. */
  const queued = () => {
    const e = entry();
    return e && e.state !== "needs-fix" && e.state !== "drafts-changed" ? e : undefined;
  };
  const land = async () => {
    const root = queue.root();
    if (busy() || !root) return;
    setBusy(true);
    setError(null);
    try {
      const no = refusal(await landBranch(root, props.run.branch, { commit: props.run.commit }));
      if (no) {
        setError(no);
        announce(no);
      } else {
        const done = `Queued ${props.run.branch} to land on ${props.run.target}.`;
        toast(done);
        announce(done);
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
      requestListRefresh();
    }
  };
  const go = async () => {
    const hash = props.run.hash;
    if (busy() || !hash) return;
    setBusy(true);
    setError(null);
    try {
      const view = await mergeProjectRun(props.projectId, hash);
      const done = `Merged into ${props.run.target}.`;
      toast(done);
      announce(done);
      props.onDone?.(view);
    } catch (err) {
      const why = errText(err);
      setError(why);
      announce(why);
      props.onDone?.();
    } finally {
      setBusy(false);
      requestListRefresh();
    }
  };
  return (
    <Show when={label()}>
      {(l) => (
        <span class="playbook-review-act">
          <Show
            when={queue.setUp()}
            fallback={
              <button type="button" class={`button button-sm button-primary${props.class ? ` ${props.class}` : ""}`} aria-disabled={busy() ? "true" : undefined} onClick={() => void go()}>
                {l()}
              </button>
            }
          >
            <Show
              when={queued()}
              fallback={
                <button
                  type="button"
                  class={`button button-sm button-primary${props.class ? ` ${props.class}` : ""}`}
                  aria-label={`Land ${props.run.branch}`}
                  aria-disabled={busy() ? "true" : undefined}
                  title={`Queues ${props.run.branch}: checked on ${props.run.target} first, then ${props.run.target} moves to it.`}
                  onClick={() => void land()}
                >
                  Land
                </button>
              }
            >
              {(q) => {
                const qr = () => queueRow({ status: "active", exists: true, readiness: undefined, branch: props.run.branch, queue: q() });
                return (
                  <span class="cluster playbook-review-queue">
                    <QueueChip row={qr()} />
                    <Show when={qr().detail}>{(d) => <span class="text-caption text-mono">{d()}</span>}</Show>
                  </span>
                );
              }}
            </Show>
          </Show>
          <Show when={error()}>{(e) => <span class="field-error" role="status">{e()}</span>}</Show>
        </span>
      )}
    </Show>
  );
}

/**
 * The project page's banner while a verb playbook run is proposed (§app.project-runtime/review): what it
 * proposes and what to do, Merge Branch, and the run's session (its last message is the report).
 */
export function PlaybookReviewBanner(props: { projectId: string; runtime: ProjectRuntimeView | undefined; onDone(view?: ProjectRuntimeView): void }) {
  return (
    <Show when={proposedRun(props.runtime)}>
      {(run) => {
        // With the merge queue set up the run's branch lands through it, so the banner says Land.
        const queue = createProjectQueue(() => props.projectId);
        const words = () => {
          const w = reviewBanner(run());
          return queue.setUp() && run().hash ? { ...w, body: `Read it, then land it: it's checked on ${run().target} first.` } : w;
        };
        return (
          <div class="project-archive-confirm">
            <Banner
              tone="warn"
              icon="branch"
              title={words().title}
              body={words().body}
              action={
                <span class="playbook-banner-actions">
                  <Show when={run().path}>
                    {(path) => (
                      <a class="button button-sm" href={projectSessionHref(props.projectId, path())}>
                        Read Report
                      </a>
                    )}
                  </Show>
                  <MergeRunButton projectId={props.projectId} run={run()} onDone={props.onDone} />
                </span>
              }
            />
          </div>
        );
      }}
    </Show>
  );
}
