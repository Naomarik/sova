import { createSignal, Show } from "solid-js";
import type { ProjectRuntimeView } from "../../shared/project-runtime";
import { reviewAction, reviewBanner, type PlaybookReviewWords } from "../../shared/playbook-review";
import { ApiError, mergeProjectRun } from "../lib/api";
import { requestListRefresh } from "../lib/list-refresh";
import { projectSessionHref } from "../lib/projects-route";
import { announce, toast } from "../lib/ui-state";
import { Banner } from "./ui";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** A proposed run's words from the registry the page reads, or null while nothing is proposed. */
export function proposedRun(v: ProjectRuntimeView | undefined): (PlaybookReviewWords & { path?: string }) | null {
  const pb = v?.playbook;
  if (!v || v.playbookState !== "proposed" || !pb) return null;
  return {
    label: pb.label,
    branch: pb.branch ?? "its branch",
    target: pb.target ?? "main",
    ...(pb.branchHash ? { hash: pb.branchHash } : {}),
    proposes: pb.proposes,
    ...(pb.path ? { path: pb.path } : {}),
  };
}

/**
 * Merge Branch (§app.project-runtime/merge): merges the branch of the run that proposes this hash. A refusal is
 * said under the button; done, the list and digest are read again so the Needs-you item goes at once.
 */
export function MergeRunButton(props: {
  projectId: string;
  run: Pick<PlaybookReviewWords, "hash" | "target">;
  class?: string;
  onDone?(view?: ProjectRuntimeView): void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const label = () => reviewAction(props.run);
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
          <button type="button" class={`button button-sm button-primary${props.class ? ` ${props.class}` : ""}`} aria-disabled={busy() ? "true" : undefined} onClick={() => void go()}
          >
            {l()}
          </button>
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
        const words = () => reviewBanner(run());
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
