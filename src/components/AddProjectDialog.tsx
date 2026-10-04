import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { ProjectRegistered } from "../../shared/projects";
import { addProject, ApiError, cloneProject, listCwds } from "../lib/api";
import { tildePath } from "../lib/format";
import { cloneFolder, cloneUrl } from "../lib/projects";
import { projectHref } from "../lib/projects-route";
import { localOnly } from "../lib/remote-session";
import { announce, home, toast } from "../lib/ui-state";
import { FolderPicker } from "./FolderPicker";
import { Banner, Icon, trapFocus } from "./ui";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

type Way = "folder" | "clone";
const WAYS: readonly { id: Way; label: string }[] = [
  { id: "folder", label: "Folder" },
  { id: "clone", label: "Clone from GitHub" },
];

/** What is said once a project is added: its name, or its checkout root when that is not the folder picked. */
export function addedLine(r: ProjectRegistered, homeDir: string | null): string {
  return r.normalizedFrom ? `Added ${tildePath(r.project.root, homeDir)}, the checkout root of ${tildePath(r.normalizedFrom, homeDir)}.` : `${r.project.name} added.`;
}

/**
 * Add Project (§app/projects): a folder on this host becomes a project, or a GitHub repository is
 * cloned into a new folder under a parent folder and becomes one. A folder inside a checkout adds
 * the checkout's root. On success it opens the new project's page.
 */
export function AddProjectDialog(props: { onCancel(): void; onAdded?(r: ProjectRegistered): void }) {
  const [way, setWay] = createSignal<Way>("folder");
  const [cwds] = createResource(() => listCwds().catch(() => [] as string[]));
  const recents = createMemo(() => localOnly(cwds() ?? []));
  const [root, setRoot] = createSignal("");
  const [repo, setRepo] = createSignal("");
  const [parent, setParent] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const [picking, setPicking] = createSignal<"root" | "parent" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);
  const url = () => cloneUrl(repo());
  const folderShown = () => folder().trim() || (url() ? cloneFolder(url()!) : "");
  const ready = () => (way() === "folder" ? !!root().trim() : !!url() && !!parent().trim());
  const cancel = () => !pending() && props.onCancel();

  const submit = async (e: Event) => {
    e.preventDefault();
    if (pending() || !ready()) return;
    setPending(true);
    setError(null);
    try {
      const r =
        way() === "folder"
          ? await addProject(root().trim())
          : await cloneProject({ repo: url()!, parent: parent().trim(), ...(folder().trim() ? { folder: folder().trim() } : {}) });
      const done = addedLine(r, home());
      toast(done);
      announce(done);
      props.onAdded?.(r);
      location.hash = projectHref(r.project.id);
      props.onCancel();
    } catch (err) {
      setError(errText(err));
    } finally {
      setPending(false);
    }
  };

  const FolderField = (f: { id: string; label: string; value: string; hint: string; which: "root" | "parent"; onPick(p: string): void }) => (
    <>
      <div class="field">
        <label class="field-label" for={f.id}>
          {f.label}
        </label>
        <button
          type="button"
          class="input input-mono folder-field"
          id={f.id}
          title={f.value || undefined}
          aria-expanded={picking() === f.which ? "true" : "false"}
          aria-describedby={`${f.id}-hint`}
          onClick={() => setPicking(picking() === f.which ? null : f.which)}
        >
          <span class="folder-field-value truncate" classList={{ "folder-field-empty": !f.value }}>
            {f.value ? tildePath(f.value, home()) : "Choose a folder"}
          </span>
          <Icon name="chevron-down" small class="icon-twist" />
        </button>
        <span class="field-hint" id={`${f.id}-hint`}>
          {f.hint}
        </span>
      </div>
      <Show when={picking() === f.which}>
        <FolderPicker start={f.value} recents={recents()} onPick={f.onPick} onClose={() => setPicking(null)} />
      </Show>
    </>
  );

  return (
    <>
      <div class="scrim" onClick={cancel} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ap-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="ap-title">
            Add Project
          </h2>
        </div>
        <form class="modal-body" id="ap-form" onSubmit={submit}>
          <Show when={error()}>{(e) => <Banner tone="error" title="Couldn't add the project." body={`${e()} Nothing was added.`} />}</Show>
          <div class="tabs" role="tablist" aria-label="How to add it" style={{ flex: "none" }}>
            <For each={WAYS}>
              {(w) => (
                <button
                  type="button"
                  role="tab"
                  class={way() === w.id ? "tab tab-active" : "tab"}
                  id={`ap-tab-${w.id}`}
                  aria-selected={way() === w.id ? "true" : "false"}
                  aria-controls="ap-tabpanel"
                  tabindex={way() === w.id ? 0 : -1}
                  onClick={() => {
                    setWay(w.id);
                    setPicking(null);
                    setError(null);
                  }}
                >
                  <Icon name={w.id === "folder" ? "folder" : "branch"} small />
                  {w.label}
                </button>
              )}
            </For>
          </div>
          <div class="stack" role="tabpanel" id="ap-tabpanel" aria-labelledby={`ap-tab-${way()}`}>
            <Show when={way() === "folder"}>
              <FolderField
                id="ap-root"
                label="Folder"
                value={root()}
                which="root"
                onPick={setRoot}
                hint="A folder inside a git checkout adds the whole checkout."
              />
            </Show>
            <Show when={way() === "clone"}>
              <label class="field">
                <span class="field-label">Repository</span>
                <input
                  class="input input-mono"
                  value={repo()}
                  onInput={(e) => setRepo(e.currentTarget.value)}
                  placeholder="owner/repo or https://github.com/owner/repo"
                  aria-invalid={repo().trim() && !url() ? "true" : undefined}
                  autocomplete="off"
                  spellcheck={false}
                />
                <span class="field-hint">Cloned with this computer's own git credentials.</span>
              </label>
              <FolderField id="ap-parent" label="Parent folder" value={parent()} which="parent" onPick={setParent} hint="The clone goes in a new folder inside this one." />
              <label class="field">
                <span class="field-label">Folder name</span>
                <input class="input input-mono" value={folder()} onInput={(e) => setFolder(e.currentTarget.value)} placeholder={url() ? cloneFolder(url()!) : "The repository's name"} spellcheck={false} />
                <Show when={parent().trim() && folderShown()}>
                  <span class="field-hint orgs-mono">{tildePath(`${parent().trim().replace(/\/+$/, "")}/${folderShown()}`, home())}</span>
                </Show>
              </label>
            </Show>
          </div>
        </form>
        <div class="modal-foot">
          <button type="submit" form="ap-form" class="button button-primary" aria-disabled={pending() || !ready() ? "true" : undefined}>
            {pending() ? (way() === "clone" ? "Cloning…" : "Adding…") : way() === "clone" ? "Clone and Add" : "Add Project"}
          </button>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
