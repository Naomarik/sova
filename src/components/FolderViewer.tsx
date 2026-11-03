import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { fileKind, firstFile, sizeWords, sortFiles, type FolderItem, type FolderGroup } from "../lib/folder-viewer";
import { Markdown } from "./Markdown";
import { Icon } from "./ui";
import "./FolderViewer.css";

export type { FolderItem, FolderGroup, FolderText } from "../lib/folder-viewer";

/**
 * A read-only view of labelled groups of files: the files on the left, grouped and labelled; the
 * picked file on the right, markdown rendered and anything else shown as plain text, never run. It
 * knows nothing about where the files come from: each group lists and reads its own (a project
 * folder at a commit, a folder Sova ships). Nothing in it changes a file.
 */
export function FolderViewer(props: {
  /** For the DOM ids, unique on the page. */
  id: string;
  title: string;
  /** One line under the title. */
  subtitle?: string;
  groups: FolderGroup[];
  onClose?(): void;
  /** List each group's items as it gave them, not in reading order. */
  keepOrder?: boolean;
  /** A change lists every group again and re-reads the picked item. */
  refreshKey?: string | number;
  /** Hide the "shown as text, never run" note (items that are not files, such as a tool's declaration). */
  hideTextNote?: boolean;
  /** The item it opens on, until one is picked (default: the first). */
  initial?: { group: string; path: string };
}) {
  const ids = createMemo(() => `${props.groups.map((g) => g.id).join("\u0000")}\u0001${props.refreshKey ?? ""}`);
  // Every group's files, listed once per set of groups (and refreshKey): a refresh of the caller's
  // props that keeps the same groups doesn't list them again.
  const [lists] = createResource(ids, async () =>
    Promise.all(
      props.groups.map(async (g) => {
        try {
          const files = await g.list();
          return { group: g.id, files: props.keepOrder ? files : sortFiles(files), error: null as string | null };
        } catch (err) {
          return { group: g.id, files: [] as FolderItem[], error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
  );
  const [picked, setPicked] = createSignal<{ group: string; path: string } | null>(null);
  const current = createMemo(() => picked() ?? props.initial ?? (lists() ? firstFile(lists()!, props.keepOrder) : null));
  const groupOf = (id: string) => props.groups.find((g) => g.id === id);
  const key = createMemo(() => {
    const c = current();
    return c ? `${c.group}\u0000${c.path}\u0001${props.refreshKey ?? ""}` : null;
  });
  /** The picked file as the source listed it. */
  const item = () => {
    const c = current();
    return c ? lists()?.find((l) => l.group === c.group)?.files.find((f) => f.path === c.path) : undefined;
  };
  /** What the source said about the picked file when it listed it. */
  const said = () => item()?.kind;
  const [file] = createResource(key, async () => {
    const c = current()!;
    // A file the source can't show is never read.
    if (said() === "binary" || said() === "too-large") return { text: "" };
    const g = groupOf(c.group);
    if (!g) throw new Error("That folder isn't shown any more.");
    return g.read(c.path);
  });
  const kind = () => {
    const c = current();
    return c ? fileKind(c.path, file.state === "ready" ? file()?.text : undefined, said()) : "text";
  };
  const domId = (s: string) => `${props.id}-${s}`;

  return (
    <section class="folder-viewer" aria-labelledby={domId("title")}>
      <div class="folder-viewer-head">
        <div class="folder-viewer-titles">
          <h4 class="folder-viewer-title" id={domId("title")}>
            {props.title}
          </h4>
          <Show when={props.subtitle}>{(s) => <p class="text-caption text-muted">{s()}</p>}</Show>
        </div>
        <Show when={props.onClose}>
          {(close) => (
            <button type="button" class="button button-sm button-ghost" onClick={() => close()()}>
              Close
            </button>
          )}
        </Show>
      </div>
      <div class="folder-viewer-body">
        <nav class="folder-viewer-files" aria-label={`${props.title}: files`}>
          <Show when={lists()} fallback={<p class="text-caption text-muted">{lists.error ? String(lists.error) : "Listing the files."}</p>}>
            {(ls) => (
              <For each={ls()}>
                {(l) => {
                  const g = () => groupOf(l.group);
                  return (
                    <div class="folder-viewer-group" data-group={l.group}>
                      <Show when={props.groups.length > 1 || g()?.caption}>
                        <p class="folder-viewer-group-label">{g()?.label}</p>
                        <Show when={g()?.caption}>{(c) => <p class="folder-viewer-group-caption text-mono">{c()}</p>}</Show>
                      </Show>
                      <Show when={!l.error} fallback={<p class="text-caption folder-viewer-error">Couldn't list these files. {l.error}</p>}>
                        <Show when={l.files.length > 0} fallback={<p class="text-caption text-muted">No files here.</p>}>
                          <ul class="folder-viewer-list">
                            <For each={l.files}>
                              {(f) => {
                                const on = () => current()?.group === l.group && current()?.path === f.path;
                                const size = () => f.detail ?? sizeWords(f.size);
                                return (
                                  <li>
                                    <button
                                      type="button"
                                      class="folder-viewer-file"
                                      classList={{ "is-on": on(), "text-mono": !f.label }}
                                      aria-current={on() ? "true" : undefined}
                                      title={size() ? `${f.label ?? f.path} · ${size()}` : (f.label ?? f.path)}
                                      onClick={() => setPicked({ group: l.group, path: f.path })}
                                    >
                                      <Show when={f.label} fallback={<><Icon name="file" small /><span class="folder-viewer-file-name">{f.path}</span></>}>
                                        <span class="folder-viewer-file-name">{f.label}</span>
                                        <Show when={size()}>{(d) => <span class="folder-viewer-file-detail text-muted">{d()}</span>}</Show>
                                      </Show>
                                    </button>
                                  </li>
                                );
                              }}
                            </For>
                          </ul>
                        </Show>
                      </Show>
                    </div>
                  );
                }}
              </For>
            )}
          </Show>
        </nav>
        <div class="folder-viewer-doc" role="region" aria-label={current() ? `File ${item()?.label ?? current()!.path}` : "File"} tabindex="0">
          <Show when={current()} fallback={<p class="text-caption text-muted">{lists() ? "These folders have no files." : ""}</p>}>
            {(c) => (
              <>
                <p class="folder-viewer-path" classList={{ "text-mono": !item()?.label }}>
                  {item()?.label ?? c().path}
                  <Show when={kind() === "text" && !props.hideTextNote}>
                    <span class="text-muted"> · shown as text, never run</span>
                  </Show>
                </p>
                <Switch>
                  <Match when={file.error}>
                    <p class="text-caption folder-viewer-error">Couldn't read this file. {file.error instanceof Error ? file.error.message : String(file.error)}</p>
                  </Match>
                  <Match when={file.loading}>
                    <p class="text-caption text-muted">Reading the file.</p>
                  </Match>
                  <Match when={kind() === "binary"}>
                    <p class="text-caption text-muted">Not a text file, so it isn't shown.</p>
                  </Match>
                  <Match when={kind() === "too-large"}>
                    <p class="text-caption text-muted">Too large to show here.</p>
                  </Match>
                  <Match when={kind() === "markdown"}>
                    <Markdown text={file()?.text ?? ""} />
                  </Match>
                  <Match when={true}>
                    <pre class="folder-viewer-text">{file()?.text ?? ""}</pre>
                  </Match>
                </Switch>
                <Show when={file()?.truncated}>
                  <p class="text-caption text-muted">The file is longer; this is its start.</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}
