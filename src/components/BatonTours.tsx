import { createResource, createSignal, For, Show } from "solid-js";
import { conversationTourApi } from "../lib/tour-api";
import { announce, toast } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The tours attached to this hand-off conversation, in the operator's own view of it, each with
 * Detach. Keyed by the conversation, so a tour whose source chat was deleted (or that came with a
 * restored organization) can still be detached. Nothing shows when none is attached.
 */
export function BatonTours(props: { orgId: string; sessionId: string; version: string }) {
  const api = () => conversationTourApi(props.orgId, props.sessionId);
  const [tours, { refetch }] = createResource(
    () => ({ org: props.orgId, session: props.sessionId, v: props.version }),
    () => api().list().catch(() => []),
  );
  const [confirm, setConfirm] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const detach = async (handle: string) => {
    setBusy(true);
    try {
      await api().detach(handle);
      setConfirm(undefined);
      setError(null);
      toast("Tour detached.");
      announce("Tour detached.");
      await refetch();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={tours.latest?.length}>
      <details class="disclosure baton-strip-fold">
        <summary class="disclosure-summary">
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="disclosure-label">Tours ({tours.latest!.length})</span>
        </summary>
        <div class="disclosure-body">
          <For each={tours.latest}>
            {(tour) => (
              <div class="baton-strip-row tour-binding">
                <p>
                  <b>{tour.title}</b> · {tour.steps} {tour.steps === 1 ? "step" : "steps"}
                </p>
                <Show
                  when={confirm() === tour.handle}
                  fallback={
                    <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => setConfirm(tour.handle)}>
                      Detach
                    </button>
                  }
                >
                  <p>The tour stops opening in this hand-off. Its conversation and the original tour stay.</p>
                  <div class="button-row">
                    <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => void detach(tour.handle)}>
                      Detach Tour
                    </button>
                    <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(undefined)}>
                      Cancel
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show when={error()}>{(e) => <Banner tone="error" title="That didn't go through." body={e()} />}</Show>
        </div>
      </details>
    </Show>
  );
}
