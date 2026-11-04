import { createMemo, createResource, For, Show } from "solid-js";
import { sizeWords, sortFiles, type FolderItem, type FolderGroup } from "../lib/folder-viewer";
import { openMarkdown } from "../lib/markdown-viewer";
import { OPEN_FILE_FAILED } from "../lib/session-setup";
import { toast } from "../lib/ui-state";
import { Icon } from "./ui";
import "./FolderViewer.css";

export type { FolderItem, FolderGroup, FolderText } from "../lib/folder-viewer";

/** Opens one item in the reader, read now. An item the source can't show is never read: the reader
    says so. A failed read is a toast and the reader stays shut. `opener` gets focus back on close. */
export async function openItem(g: Pick<FolderGroup, "label" | "caption" | "read">, f: FolderItem, opener: HTMLElement): Promise<void> {
  const doc = { title: f.label ?? f.path, subtitle: g.caption ?? g.label, name: f.path, lang: f.lang, said: f.kind, opener };
  if (f.kind === "binary" || f.kind === "too-large") return openMarkdown({ ...doc, markdown: "" });
  try {
    const r = await g.read(f.path);
    openMarkdown({ ...doc, markdown: r.text, truncated: r.truncated });
  } catch (err) {
    toast(`${OPEN_FILE_FAILED} ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A read-only list of labelled groups of files; pressing one opens it in the reader. It knows
 * nothing about where the files come from: each group lists and reads its own (a project folder at
 * a commit, a folder Sova ships). Nothing in it changes a file.
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
  /** A change lists every group again. */
  refreshKey?: string | number;
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
  const groupOf = (id: string) => props.groups.find((g) => g.id === id);
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
                              const size = () => f.detail ?? sizeWords(f.size);
                              return (
                                <li>
                                  <button
                                    type="button"
                                    class="folder-viewer-file"
                                    classList={{ "text-mono": !f.label }}
                                    title={size() ? `${f.label ?? f.path} · ${size()}` : (f.label ?? f.path)}
                                    onClick={(e) => void openItem(g()!, f, e.currentTarget)}
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
    </section>
  );
}
