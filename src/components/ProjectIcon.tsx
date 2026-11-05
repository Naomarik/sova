import { createSignal, Show } from "solid-js";
import type { ProjectSummary } from "../../shared/projects";
import { projectLetters, projectTint } from "../lib/project-monogram";
import "../project-icon.css";

/**
 * A project's icon (§app.projects/icon): its picture (uploaded, or found in its folder) on a sunken tile, else its two
 * letters white on its colour. Decorative: the project's name is always beside it. A peer's project (`local` false) is
 * drawn as letters in this build.
 */
export function ProjectIcon(props: { project: Pick<ProjectSummary, "id" | "name" | "icon">; size: 24 | 32 | 40; local: boolean; class?: string }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const src = () => {
    const icon = props.project.icon;
    if (!icon || !props.local) return null;
    const url = `/api/projects/${encodeURIComponent(props.project.id)}/icon?v=${encodeURIComponent(icon.v)}`;
    return failed() === url ? null : url;
  };
  return (
    <span
      class={`project-icon${props.class ? ` ${props.class}` : ""}`}
      classList={{ "project-icon-picture": !!src() }}
      style={{ "--project-icon-size": `${props.size}px`, ...(src() ? {} : { "--project-icon-tint": projectTint(props.project.id) }) }}
      aria-hidden="true"
    >
      <Show when={src()} fallback={<span class="project-icon-letters">{projectLetters(props.project.name)}</span>}>
        {(url) => <img src={url()} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(url())} />}
      </Show>
    </span>
  );
}
