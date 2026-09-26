import { createResource, Show } from "solid-js";
import { getProjectOverseer } from "../lib/api";
import { projectHref } from "../lib/orgs-route";
import { Chip } from "./ui";
import "../orgs.css";

/**
 * Above a project overseer's conversation (§app/project-overseer): which project it oversees, how
 * far it may act on its own right now, and the way back to the project page, where autonomy, its
 * activity, ideas and to-do items live. The conversation below is the live view: its tool cards
 * are what it does.
 */
export function ProjectOverseerStrip(props: { orgId: string; projectId: string; busy: boolean }) {
  // Re-read when a turn ends: a run may have started sessions or changed what is pending.
  const key = () => ({ o: props.orgId, p: props.projectId, busy: props.busy });
  const [info] = createResource(key, (k) => getProjectOverseer(k.o, k.p));
  return (
    <section class="baton-strip" aria-label="Project overseer">
      <div class="baton-strip-main">
        <span class="baton-strip-title">Overseer of {info()?.projectName ?? "this project"}</span>
        <Show when={info()}>
          {(i) => (
            <span class="baton-strip-meta">
              On its own: {i().effective.autonomy}
              {i().effective.reason ? ` — ${i().effective.reason}` : ""} · {i().settings.watch ? "watching" : "not watching"} · {i().started.length}{" "}
              {i().started.length === 1 ? "session" : "sessions"} started
            </span>
          )}
        </Show>
      </div>
      <Show when={props.busy}>
        <Chip tone="accent" live>
          Working
        </Chip>
      </Show>
      <div class="baton-strip-actions">
        <a class="button button-sm" href={projectHref(props.orgId, props.projectId)}>
          Project Page
        </a>
      </div>
    </section>
  );
}
