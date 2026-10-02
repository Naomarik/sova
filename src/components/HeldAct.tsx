import { createSignal } from "solid-js";
import { cancelHeldAct, ApiError } from "../lib/api";
import { requestListRefresh } from "../lib/list-refresh";
import { cancelLabel, cancelledLine } from "../lib/pipeline-view";
import { announce, toast } from "../lib/ui-state";

/**
 * Cancel on an act waiting in a hold (§app.project-overseer/holds): in the Organizations region's
 * Needs you and in the project page's Pipeline. Done or refused, the digest and the list are read
 * again, so the item goes (or says it went ahead) at once rather than at the next poll.
 */
export function CancelHeldButton(props: { projectId: string; holdId: string; what: string; class?: string; onDone?(): void }) {
  const [busy, setBusy] = createSignal(false);
  const cancel = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      await cancelHeldAct(props.projectId, props.holdId);
      const done = cancelledLine(props.what);
      toast(done);
      announce(done);
    } catch (err) {
      const why = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      toast(why);
      announce(why);
    } finally {
      setBusy(false);
      requestListRefresh();
      props.onDone?.();
    }
  };
  return (
    <button
      type="button"
      class={`button button-sm${props.class ? ` ${props.class}` : ""}`}
      aria-label={cancelLabel(props.what)}
      title={cancelLabel(props.what)}
      aria-disabled={busy() ? "true" : undefined}
      onClick={() => void cancel()}
    >
      Cancel
    </button>
  );
}
