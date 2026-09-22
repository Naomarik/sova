import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import type { FolderListing } from "../../shared/protocol";
import { ApiError, fetchTargetFolders, listFolders } from "../lib/api";
import { tildePath } from "../lib/format";
import { remoteCrumbs, remoteParent } from "../lib/remote-session";
import { home, setHome } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";

/** What the list shows: one folder's subfolders, or the folders sessions already use. */
type View = { kind: "folder"; path: string | undefined } | { kind: "recent" };
type Load =
  | { state: "loading" }
  | { state: "ok"; listing: FolderListing }
  | { state: "error"; status: number; message: string };
interface Row {
  id: string;
  label: string;
  path: string;
  symlink?: boolean;
}

const LIST_ID = "ns-picker-list";

/**
 * The New Session folder picker (spec/05-new-session-dialog.md §5): an in-place panel under the Folder field.
 * The folder being browsed IS the choice: every folder you open is reported through `onPick`.
 * Opening focuses the panel itself, never the filter, so a phone doesn't raise its keyboard. The
 * panel or the filter drives the listbox through aria-activedescendant; typing on the panel moves
 * into the filter.
 * With `remote` it browses that target instead (§5 "Remote"): paths are the target's, so crumbs start
 * at "/" and nothing is shown relative to our $HOME; no path means the target's configured folder.
 */
export function FolderPicker(props: {
  start: string;
  recents: string[];
  remote?: { target: string; name: string };
  onPick(path: string): void;
  onClose(): void;
}) {
  const [view, setView] = createSignal<View>({ kind: "folder", path: props.start || undefined });
  const [hidden, setHidden] = createSignal(false);
  const [load, setLoad] = createSignal<Load>({ state: "loading" });
  const [filter, setFilter] = createSignal("");
  const [active, setActive] = createSignal(0);
  /** The folder the listing came from (or was asked for), for breadcrumbs and Up. */
  const [at, setAt] = createSignal<string | null>(props.start || null);
  let seq = 0;
  let filterEl!: HTMLInputElement;
  let root!: HTMLDivElement;

  const fetchFolder = async (path: string | undefined, showHidden: boolean) => {
    const my = ++seq;
    setLoad({ state: "loading" });
    try {
      const r = props.remote;
      const listing = r ? await fetchTargetFolders(r.target, path, showHidden) : await listFolders(path, showHidden);
      if (my !== seq) return; // a newer navigation won
      if (!r && path === undefined && !home()) setHome(listing.path);
      setAt(listing.path);
      setLoad({ state: "ok", listing });
      props.onPick(listing.path);
    } catch (err) {
      if (my !== seq) return;
      if (path) setAt(path);
      setLoad({ state: "error", status: err instanceof ApiError ? err.status : 0, message: (err as Error).message });
    }
  };

  createEffect(
    on([view, hidden], ([v, h]) => {
      setFilter("");
      setActive(0);
      if (v.kind === "folder") void fetchFolder(v.path, h);
    }),
  );
  onMount(() => root.focus({ preventScroll: true }));

  const open = (path: string) => setView({ kind: "folder", path });
  const up = () => {
    const v = view();
    if (v.kind === "recent") return setView({ kind: "folder", path: at() ?? undefined });
    const l = load();
    const parent = l.state === "ok" ? l.listing.parent : at() ? remoteParent(at()!) : null;
    if (parent) open(parent);
  };

  const allRows = createMemo<Row[]>(() => {
    if (view().kind === "recent")
      return props.recents.map((p, i) => ({ id: `ns-pr-${i}`, label: props.remote ? p : tildePath(p, home()), path: p }));
    const l = load();
    return l.state === "ok" ? l.listing.entries.map((e, i) => ({ id: `ns-pf-${i}`, label: e.name, path: e.path, symlink: e.symlink })) : [];
  });
  const rows = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? allRows().filter((r) => r.label.toLowerCase().includes(q)) : allRows();
  });
  const activeRow = () => rows()[active()];
  createEffect(
    on(activeRow, (r) => {
      if (r) document.getElementById(r.id)?.scrollIntoView({ block: "nearest" });
    }),
  );

  /** Path segments, starting at `~` inside $HOME, else at `/`. The last one is where you are. */
  const crumbs = createMemo(() => {
    const p = at();
    if (view().kind === "recent" || !p) return [];
    if (props.remote) return remoteCrumbs(p);
    const h = home();
    const inHome = !!h && (p === h || p.startsWith(`${h}/`));
    const out = [{ label: inHome ? "~" : "/", path: inHome ? h! : "/" }];
    let acc = inHome ? h! : "";
    for (const seg of p.slice(inHome ? h!.length : 0).split("/").filter(Boolean)) {
      acc = `${acc}/${seg}`;
      out.push({ label: seg, path: acc });
    }
    return out;
  });
  const hereName = () => crumbs()[crumbs().length - 1]?.label ?? "this folder";

  const note = (): string | null => {
    const q = filter().trim();
    if (view().kind === "recent") {
      if (allRows().length === 0)
        return props.remote ? `No recent folders on ${props.remote.name} yet.` : "No recent folders yet. Sessions you start add theirs here.";
      return q && rows().length === 0 ? `0 of ${allRows().length} match “${q}”.` : null;
    }
    const l = load();
    if (l.state === "loading") return props.remote ? `Asking ${props.remote.name} for its folders…` : "Loading folders…";
    if (l.state === "error") {
      const r = props.remote;
      if (r) {
        if (l.status === 403) return `Sova can't read this folder on ${r.name}. Pick another one.`;
        if (l.status === 404) return `This folder doesn't exist on ${r.name}. Pick another one.`;
        // 502 covers both "unreachable" and "no such folder": the server's message says which.
        if (l.status === 504 || l.status === 0) return `Couldn't reach ${r.name}. ${l.message}`;
        return `Couldn't list this folder on ${r.name}. ${l.message}`;
      }
      if (l.status === 403) return "Sova can't read this folder. Pick another one.";
      if (l.status === 404) return "This folder doesn't exist. Pick another one.";
      return `Couldn't list this folder. ${l.message}`;
    }
    if (l.listing.entries.length === 0) return `No subfolders in ${hereName()}. You can still start the session here.`;
    if (q && rows().length === 0) return `0 of ${l.listing.entries.length} match “${q}”.`;
    if (l.listing.truncated) return `Showing the first ${l.listing.entries.length} folders, A to Z. Filter to narrow them.`;
    return null;
  };

  /** Keys shared by the filter and the panel. `fromFilter`: Backspace/← edit a non-empty filter. */
  const onNavKey = (e: KeyboardEvent, fromFilter: boolean) => {
    const n = rows().length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (n) setActive((a) => Math.min(n - 1, a + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (n) setActive((a) => Math.max(0, a - 1));
        break;
      case "Home":
      case "End":
        if (!n) return; // nothing to move to: keep the caret keys
        e.preventDefault();
        setActive(e.key === "Home" ? 0 : n - 1);
        break;
      case "Enter": {
        e.preventDefault(); // never submits the dialog from here
        const r = activeRow();
        if (r) open(r.path);
        else props.onClose();
        break;
      }
      case "Backspace":
      case "ArrowLeft":
        if (filter()) {
          if (fromFilter) return; // editing the filter
          if (e.key === "ArrowLeft") return;
          e.preventDefault();
          typeIntoFilter(filter().slice(0, -1));
          return;
        }
        e.preventDefault();
        up();
        break;
      default:
        // Typing on the panel means the user wants the filter: move there with the character.
        if (!fromFilter && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          typeIntoFilter(filter() + e.key);
        }
    }
  };
  const typeIntoFilter = (value: string) => {
    setFilter(value);
    setActive(0);
    filterEl.focus();
    filterEl.setSelectionRange(value.length, value.length);
  };

  return (
    <div
      class="folder-picker"
      id="ns-picker"
      role="group"
      aria-label={props.remote ? `Choose a folder on ${props.remote.name}` : "Choose a folder"}
      tabindex="-1"
      aria-activedescendant={activeRow()?.id}
      ref={(el) => {
        root = el;
        trapFocus(el);
      }}
      onKeyDown={(e) => {
        if (e.target === root) {
          onNavKey(e, false);
          if (e.key === "Tab" && e.shiftKey) {
            // The panel sits before its first control; wrap like trapFocus does.
            e.preventDefault();
            root.querySelector<HTMLElement>(".folder-picker-foot .button")?.focus();
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation(); // closes the picker, not the dialog
          props.onClose();
        } else if (e.key === "Enter" && (e.target as HTMLElement).matches("input[type=checkbox]")) {
          e.preventDefault(); // Enter on the checkbox would submit the dialog's form
        }
      }}
    >
      <div class="folder-picker-bar">
        <nav class="folder-crumbs" aria-label="Path">
          <Show when={view().kind === "folder"} fallback={<span class="folder-crumb-current" aria-current="location">Recent folders</span>}>
            <ol>
              <For each={crumbs()}>
                {(c, i) => (
                  <li classList={{ "folder-crumbs-root": c.label === "/" }}>
                    <Show
                      when={i() < crumbs().length - 1}
                      fallback={
                        <span class="folder-crumb-current" aria-current="location" title={c.path}>
                          {c.label}
                        </span>
                      }
                    >
                      <button type="button" class="folder-crumb" title={c.path} onClick={() => open(c.path)}>
                        {c.label}
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </nav>
        <button
          type="button"
          class="button button-ghost"
          title={props.remote ? `The folder ${props.remote.name} is set to start in` : undefined}
          onClick={() => setView({ kind: "folder", path: undefined })}
        >
          {props.remote ? "Start" : "Home"}
        </button>
        <button
          type="button"
          class="button button-ghost"
          aria-pressed={view().kind === "recent" ? "true" : "false"}
          onClick={() => (view().kind === "recent" ? up() : setView({ kind: "recent" }))}
        >
          Recent
        </button>
      </div>

      <div class="search">
        <Icon name="search" />
        <input
          ref={filterEl}
          class="input"
          type="text"
          role="combobox"
          aria-label={view().kind === "recent" ? "Filter recent folders" : `Filter folders in ${hereName()}`}
          aria-expanded="true"
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeRow()?.id}
          aria-describedby="ns-picker-note"
          placeholder="Filter"
          autocomplete="off"
          spellcheck={false}
          value={filter()}
          onInput={(e) => {
            setFilter(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(e) => onNavKey(e, true)}
        />
      </div>

      <ul
        class="list folder-list folder-picker-list"
        id={LIST_ID}
        role="listbox"
        aria-label={view().kind === "recent" ? "Recent folders" : `Subfolders of ${hereName()}`}
        aria-busy={view().kind === "folder" && load().state === "loading" ? "true" : undefined}
      >
        <For each={rows()}>
          {(r, i) => (
            <li
              id={r.id}
              class="list-row list-row-interactive"
              role="option"
              aria-selected={i() === active() ? "true" : "false"}
              title={r.path}
              onMouseDown={(e) => e.preventDefault() /* keep focus in the filter */}
              onClick={() => open(r.path)}
            >
              <Icon name="folder" small />
              <span class="list-title truncate">{r.label}</span>
              <Show when={r.symlink}>
                <span class="folder-picker-link">link</span>
              </Show>
              <Icon name="chevron-right" small />
            </li>
          )}
        </For>
      </ul>
      <p class="folder-picker-note" id="ns-picker-note" aria-live="polite">
        {note()}
      </p>

      <div class="folder-picker-foot">
        <label class="folder-picker-hidden">
          <input type="checkbox" checked={hidden()} onChange={(e) => setHidden(e.currentTarget.checked)} />
          Show hidden folders
        </label>
        <span class="modal-spacer" />
        <button type="button" class="button" onClick={() => props.onClose()}>
          Use This Folder
        </button>
      </div>
    </div>
  );
}
