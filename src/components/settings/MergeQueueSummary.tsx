import { Show } from "solid-js";
import type { MergeQueueView } from "../../lib/merge-queue";
import { summaryLine } from "../../lib/merge-queue-settings";
import { openSettings } from "../../lib/settings-nav";

/** The Merge Queue tab's one line under its title: "11 checks · review on, Opus 5.5 · pushes to origin". Nothing when the server sends no settings. */
export function QueueSummaryLine(props: { view: MergeQueueView }) {
  return (
    <Show when={props.view.settings}>
      {(s) => <p class="text-caption text-muted mq-queue-summary">{summaryLine(s(), props.view.heads.hasOrigin ?? !!props.view.heads.pushed)}</p>}
    </Show>
  );
}

/** Queue Settings: opens Settings at its Merge Queue tab, on this project. */
export function QueueSettingsButton(props: { projectId: string }) {
  return (
    <button type="button" class="button button-sm" onClick={() => openSettings("merge-queue", null, { project: props.projectId })}>
      Queue Settings
    </button>
  );
}
