import { createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchMesh, fetchMeshResync, startMeshResync } from "../lib/api";
import { setMeshState } from "../lib/mesh";
import { jobRunning, jobText, type MeshResync, RESYNC_POLL_MS, sheetText, tailLines } from "../lib/mesh-resync";
import { announce } from "../lib/ui-state";
import { Banner, trapFocus } from "./ui";

// Styles: src/mesh.css (see MeshHostMenu.tsx for why they are not imported here).

/**
 * The resync confirm sheet (§mesh.peers/resync): what the host gets and what its restart stops (a
 * warning, never a refusal), then the job as it runs. A modal that becomes a bottom sheet at folded
 * width. It re-reads /api/mesh/resync while a job runs and not otherwise.
 */
export function MeshResyncSheet(props: { hostId: string; info: MeshResync; onChanged(info: MeshResync): void; onClose(): void }) {
  const [info, setInfo] = createSignal(props.info);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const host = () => info().hosts.find((h) => h.id === props.hostId);
  // The job view once one started here, or when one was already running for this host.
  const [following, setFollowing] = createSignal(jobRunning(host()?.job));
  // The words as they were when the sheet opened: a refresh never rewrites what the user is confirming.
  const opened = host();
  const text = opened ? sheetText(opened, props.info.self) : null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  onCleanup(() => {
    closed = true;
    clearTimeout(timer);
  });
  const poll = async () => {
    try {
      const next = await fetchMeshResync();
      if (closed) return;
      const was = host()?.job?.state;
      setInfo(next);
      props.onChanged(next);
      const job = host()?.job;
      if (job && job.state !== was && (job.state === "done" || job.state === "failed")) {
        announce(jobText(job, host()!.label));
        // the host list shows the new state now, not at the next 15 s poll
        if (job.state === "done") void fetchMesh().then(setMeshState, () => {});
      }
    } catch {
      // keep what is on screen; try again
    }
    if (!closed && jobRunning(host()?.job)) timer = setTimeout(poll, RESYNC_POLL_MS);
  };
  if (following()) timer = setTimeout(poll, RESYNC_POLL_MS);

  const start = async () => {
    const commit = props.info.self.commit;
    if (!commit || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await startMeshResync(props.hostId, commit);
      setFollowing(true);
      await poll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal mesh-resync"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mesh-resync-title"
        aria-describedby="mesh-resync-what"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id="mesh-resync-title">
            {/* A question until it is answered; then the job's name. */}
            {following() ? (text?.action ?? "Resync") : (text?.title ?? "Resync")}
          </h2>
        </div>
        <div class="modal-body mesh-resync-body">
          <Show when={text} fallback={<p id="mesh-resync-what">This host is no longer in the mesh.</p>}>
            {(t) => (
              <Show
                when={following() && host()?.job}
                fallback={
                  <>
                    <p id="mesh-resync-what">{t().what}</p>
                    <Show when={(opened?.activity?.turnsRunning ?? 0) + (opened?.activity?.workers ?? 0) > 0} fallback={<p class="mesh-resync-note">{t().running}</p>}>
                      <Banner tone="warn" title={t().running} />
                    </Show>
                    <p class="mesh-resync-note">{t().job}</p>
                    <Show when={error()}>{(e) => <Banner tone="error" title={e()} />}</Show>
                  </>
                }
              >
                {(job) => (
                  <>
                    <Show
                      when={job().state === "failed"}
                      fallback={
                        <p id="mesh-resync-what" role="status">
                          {jobText(job(), host()!.label)}
                        </p>
                      }
                    >
                      <Banner tone="error" title="The resync failed" body={jobText(job(), host()!.label)} />
                    </Show>
                    <Show when={tailLines(job().tail)}>
                      {(tail) => (
                        <pre class="mesh-code mesh-resync-log" tabindex="0" aria-label="The deploy script's last lines">
                          {tail()}
                        </pre>
                      )}
                    </Show>
                    <p class="mesh-resync-note">The whole log is on this host, in Sova's state folder: mesh-resync/{props.hostId}.log.</p>
                  </>
                )}
              </Show>
            )}
          </Show>
        </div>
        <div class="modal-foot">
          <Show
            when={!following() && text}
            fallback={
              <button type="button" class="button" onClick={() => props.onClose()}>
                Close
              </button>
            }
          >
            {(t) => (
              <>
                <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
                  Cancel
                </button>
                <button type="button" class="button button-primary" aria-disabled={busy() ? "true" : undefined} onClick={start}>
                  {busy() ? "Starting…" : t().action}
                </button>
              </>
            )}
          </Show>
        </div>
      </div>
    </Portal>
  );
}
