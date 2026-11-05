import { createResource, createSignal, Show } from "solid-js";
import type { ProjectIconInfo, ProjectSummary } from "../../shared/projects";
import { getProjectIconInfo, removeProjectIcon, setProjectIconLetters, uploadProjectIcon } from "../lib/api";
import { ICON_ACCEPT, iconPngFromFile } from "../lib/project-icon-upload";
import { announce } from "../lib/ui-state";
import { ProjectIcon } from "./ProjectIcon";
import { Banner } from "./ui";
import "../project-icon.css";

/** Where the icon in use comes from, in words. */
export function iconSource(info: ProjectIconInfo): string {
  if (info.use === "upload") return "Uploaded";
  if (info.use === "found") return `Found in the project: ${info.found?.path ?? ""}`;
  return "Letters";
}

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

/**
 * The Settings tab's Icon card (§app.projects/icon): the icon in use and where it comes from; Upload Image… (Replace
 * Image… once there is one), Remove Image, and Use Letters / Use Picture. Kept on this host only. After each change the
 * project is re-read, so every icon on the page picks up the new picture.
 */
export function ProjectIconCard(props: { project: ProjectSummary; onChanged(): void }) {
  const pid = () => props.project.id;
  const [info, { mutate }] = createResource(pid, (id) => getProjectIconInfo(id));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let file!: HTMLInputElement;

  const act = async (fn: () => Promise<ProjectIconInfo>, said: string) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      mutate(await fn());
      announce(said);
      props.onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const onFile = (e: Event & { currentTarget: HTMLInputElement }) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!f) return;
    void act(async () => uploadProjectIcon(pid(), await iconPngFromFile(f)), "Icon uploaded.");
  };
  /** The preview: the page's own summary carries the picture's version, refreshed after each change. */
  const preview = () => props.project;
  const hasPicture = (i: ProjectIconInfo) => !!i.uploaded || !!i.found;

  return (
    <section class="card orgs-section project-icon-card" aria-labelledby="project-icon-card">
      <h2 class="orgs-h2" id="project-icon-card">
        Icon
      </h2>
      <Show when={info.error && !info()}>
        <p class="orgs-line">Couldn't read the icon: {errText(info.error)}</p>
      </Show>
      <Show when={info()}>
        {(i) => (
          <>
            <div class="project-icon-card-row">
              <ProjectIcon project={preview()} size={40} local />
              <p class="orgs-line project-icon-card-source">{iconSource(i())}</p>
            </div>
            <p class="orgs-line">Shown on Home, on this page and in All Projects. PNG, JPEG, WebP, GIF or SVG, up to 5 MB; kept on this computer only.</p>
            <div class="project-icon-card-actions">
              <input ref={file} type="file" accept={ICON_ACCEPT} hidden onChange={onFile} />
              <button type="button" class="button button-sm" disabled={busy()} onClick={() => file.click()}>
                {i().uploaded ? "Replace Image…" : "Upload Image…"}
              </button>
              <Show when={i().uploaded}>
                <button type="button" class="button button-sm" disabled={busy()} onClick={() => void act(() => removeProjectIcon(pid()), "Image removed.")}>
                  Remove Image
                </button>
              </Show>
              <Show when={i().use !== "letters"}>
                <button type="button" class="button button-sm" disabled={busy()} onClick={() => void act(() => setProjectIconLetters(pid(), true), "Letters in use.")}>
                  Use Letters
                </button>
              </Show>
              <Show when={i().letters && hasPicture(i())}>
                <button type="button" class="button button-sm" disabled={busy()} onClick={() => void act(() => setProjectIconLetters(pid(), false), "Picture in use.")}>
                  Use Picture
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>
      <Show when={error()}>{(e) => <Banner tone="error" title="Couldn't change the icon." body={e()} />}</Show>
    </section>
  );
}
