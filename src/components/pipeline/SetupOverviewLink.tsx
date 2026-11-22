import { createEffect, createResource, on, Show } from "solid-js";
import { getSetupChat } from "../../lib/api";
import { pipelineHref } from "../../lib/projects-route";

/**
 * In the project's Setup chat's head: Queue Overview, the queue screen (§app.merge-queue/explainer) on its Proposal
 * while the chat changes the setup, else on Setup. Shown only in the chat Sova records as the project's Setup chat.
 */
export function SetupOverviewLink(props: { projectId: string; path: string; busy: () => boolean }) {
  const [status, { refetch }] = createResource(() => props.projectId, (pid) => getSetupChat(pid).catch(() => null));
  createEffect(on(props.busy, () => void refetch(), { defer: true }));
  const chat = () => {
    const c = status()?.chat;
    return c && c.path === props.path ? c : null;
  };
  return (
    <Show when={chat()}>
      {(c) => (
        <a class="button button-sm" href={pipelineHref(props.projectId, "queue", c().proposal || c().state === "working" ? "proposal" : "setup")} title="The whole merge queue on one screen, with this chat's proposal beside the setup in force">
          Queue Overview
        </a>
      )}
    </Show>
  );
}
