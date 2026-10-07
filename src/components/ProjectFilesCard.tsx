import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { ProjectFileRow } from "../../shared/project-files";
import { deleteProjectFile, getProjectFiles, projectFileHref } from "../lib/api";
import { relativeTime, stampTime } from "../lib/format";
import { createPoll } from "../lib/poll";
import { projectSessionHref } from "../lib/projects-route";
import { toast } from "../lib/ui-state";

const FILES_POLL_MS = 30_000;

/** `KB` under 1 MB, rounded; else one decimal. Pure. */
export const fileSizeLabel = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/**
 * Files people sent the project (§app.organizations/files-card): each with who sent it, its
 * gathering, when, its size and status; Download (the main listener's attachment route) and Delete
 * (asked first). Shown while the project is placed, or once it holds a file.
 */
export function ProjectFilesCard(props: { projectId: string; placed: boolean; tick: () => number }) {
  const poll = createPoll(() => getProjectFiles(props.projectId), FILES_POLL_MS);
  createEffect(on(props.tick, () => poll.refetch(), { defer: true }));
  const files = () => poll.data()?.files ?? [];
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const now = () => Date.now();
  const remove = async (f: ProjectFileRow) => {
    setBusy(true);
    try {
      await deleteProjectFile(props.projectId, f.id);
      setConfirm(null);
      poll.refetch();
    } catch (err) {
      toast(`Couldn't delete ${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={props.placed || files().length}>
      <section class="card orgs-section" aria-labelledby="project-files">
        <h2 class="orgs-h2" id="project-files">
          Files
        </h2>
        <Show when={poll.error() && !poll.data()}>
          <p class="field-error">Couldn't read the files. {poll.error()}</p>
        </Show>
        <Show when={poll.data()}>
          <Show when={files().length} fallback={<p class="orgs-line">Nothing yet. Files people send in a gathering session with files on list here.</p>}>
            <ul class="project-files">
              <For each={files()}>
                {(f) => (
                  <li class="project-file">
                    <div class="project-file-main">
                      <span class="icon project-file-icon" style={{ "--icon": "url(/icons/file.svg)" }} aria-hidden="true" />
                      <div class="project-file-text">
                        <span class="project-file-name" title={f.name}>
                          {f.name}
                        </span>
                        <span class="list-meta project-file-meta">
                          from {f.sender}
                          {" · "}
                          <Show when={f.gathering} fallback="a gathering no longer listed">
                            {(g) => (
                              <Show when={g().path} fallback={g().title}>
                                {(path) => <a href={projectSessionHref(props.projectId, path())}>{g().title}</a>}
                              </Show>
                            )}
                          </Show>
                          {" · "}
                          <time title={stampTime(f.at)}>{relativeTime(f.at, now())}</time>
                          {" · "}
                          {fileSizeLabel(f.size)}
                        </span>
                      </div>
                      <span class="chip" classList={{ "chip-success": f.status === "confirmed" }}>
                        {f.status === "confirmed" ? "Confirmed" : "Received"}
                      </span>
                    </div>
                    <div class="button-row project-file-actions">
                      <Show when={f.here} fallback={<span class="list-meta">Not on this host.</span>}>
                        <a class="button button-sm" href={projectFileHref(props.projectId, f.id)} download={f.name} aria-label={`Download ${f.name}`}>
                          Download
                        </a>
                      </Show>
                      <Show when={confirm() !== f.id}>
                        <button type="button" class="button button-sm button-ghost" aria-expanded="false" aria-label={`Delete ${f.name}`} onClick={() => setConfirm(f.id)}>
                          Delete
                        </button>
                      </Show>
                    </div>
                    <Show when={confirm() === f.id}>
                      <div class="orgs-owner-confirm" role="group" aria-label={`Delete ${f.name}`}>
                        <p class="orgs-line">Delete {f.name}? Its bytes go; the gathering's transcript keeps its line.</p>
                        <div class="button-row">
                          <button type="button" class="button button-sm button-destructive" aria-disabled={busy() ? "true" : undefined} onClick={() => !busy() && void remove(f)}>
                            Delete File
                          </button>
                          <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
