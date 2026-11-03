import { createEffect, createMemo, createResource, createSignal, For, Match, on, Show, Switch } from "solid-js";
import type { TeamInfo, WorkerInfo } from "../../shared/protocol";
import { fetchSessionContextView, fetchSetupFile } from "../lib/api";
import { formatTokens } from "../lib/context";
import { approxTokens, contextHeadline, contextLines, contextRoom, flatParts, type ContextPart, type ContextPartGroup } from "../lib/context-parts";
import type { FolderGroup } from "../lib/folder-viewer";
import { workerLabel } from "../lib/workers";
import { FolderViewer } from "./FolderViewer";
import { Icon } from "./ui";
import "./ContextTab.css";

/** The viewer's groups, in the order the window is built. */
const GROUPS: readonly { id: ContextPartGroup; label: string }[] = [
  { id: "instructions", label: "Project instructions" },
  { id: "subfolder", label: "Subfolder instructions" },
  { id: "mode", label: "Mode" },
  { id: "rules", label: "Rules and docs" },
  { id: "skills", label: "Skills offered" },
  { id: "tools", label: "Tools" },
];

/**
 * The Context tab: what fills this chat's window (or one of its workers'), as of the last reply.
 * The total is the reply's own usage; each part is an estimate, and Other is what the estimates
 * don't explain. A line opens its part in the folder viewer, read-only. It reads once on open and
 * again on each change to the session's file (`changed`, the pane's insight signal); never polls.
 */
export function ContextTab(props: { path: string; workers: WorkerInfo[]; teams?: TeamInfo[]; changed: number }) {
  const pickable = () => props.workers.filter((w) => w.sessionFile);
  const [who, setWho] = createSignal(props.path);
  /** The session read: this chat, or the picked worker while it is still listed. */
  const target = createMemo(() => (pickable().some((w) => w.sessionFile === who()) ? who() : props.path));
  const [view] = createResource(
    () => `${props.changed}\u0001${target()}`,
    (key) => fetchSessionContextView(key.slice(key.indexOf("\u0001") + 1)),
  );
  const ok = createMemo(() => {
    const v = view.latest;
    return v?.state === "ok" ? { ...v, parts: flatParts(v), incomplete: v.nestedIncomplete } : null;
  });
  const [open, setOpen] = createSignal<string | null>(null);
  createEffect(on(target, () => setOpen(null), { defer: true }));
  let viewerEl: HTMLDivElement | undefined;
  const show = (partId: string) => {
    setOpen(partId);
    queueMicrotask(() => viewerEl?.scrollIntoView({ block: "nearest" }));
  };

  const lines = () => {
    const v = ok();
    return v ? contextLines(v) : [];
  };
  const subfolder = () => ok()?.parts.filter((p) => p.group === "subfolder") ?? [];
  const groupOf = (partId: string) => ok()?.parts.find((p) => p.id === partId)?.group;
  const groups = (): FolderGroup[] => {
    const v = ok();
    if (!v) return [];
    const read = async (id: string) => {
      const p = v.parts.find((x) => x.id === id);
      if (!p) throw new Error("That part isn't in this chat's context any more.");
      if (p.text !== undefined) return { text: p.text };
      if (!p.path) return { text: "" };
      return { text: (await fetchSetupFile(target(), p.path)).text };
    };
    return GROUPS.flatMap((g) => {
      const of = v.parts.filter((p) => p.group === g.id);
      if (of.length === 0) return [];
      return [
        {
          id: g.id,
          label: g.label,
          list: async () => of.map((p) => ({ path: p.id, label: p.label, detail: partDetail(p), kind: p.group === "tools" ? ("text" as const) : ("markdown" as const) })),
          read,
        },
      ];
    });
  };

  return (
    <div class="session-panel-scroll" tabindex="0">
      <div class="stack-4">
        <Show when={pickable().length > 0}>
          <label class="field">
            <span class="field-label">Whose context</span>
            <span class="select-wrap">
              <select class="select" onChange={(e) => setWho(e.currentTarget.value)}>
                <option value={props.path} selected={target() === props.path}>
                  This chat
                </option>
                <For each={pickable()}>
                  {(w) => (
                    <option value={w.sessionFile} selected={target() === w.sessionFile}>
                      {workerLabel(w, props.teams)}
                    </option>
                  )}
                </For>
              </select>
              <span class="select-caret" aria-hidden="true">
                <Icon name="chevron-down" small />
              </span>
            </span>
          </label>
        </Show>

        <Switch>
          <Match when={!view.latest && view.error}>
            <p class="usage-note field-error">Couldn't read this chat's context. {String(view.error instanceof Error ? view.error.message : view.error)}</p>
          </Match>
          <Match when={!view.latest}>
            <p class="usage-note text-muted">Reading this chat's context.</p>
          </Match>
          <Match when={view.latest?.state === "remote"}>
            <p class="usage-note text-muted">This chat runs on another machine, so its context can't be read here.</p>
          </Match>
          <Match when={view.latest?.state === "unavailable" && view.latest}>
            {(v) => <p class="usage-note text-muted">{v().state === "unavailable" ? (v() as { reason: string }).reason : ""}</p>}
          </Match>
          <Match when={ok()}>
            {(v) => (
              <>
                <section class="stack-2" aria-labelledby="context-window-label">
                  <h3 class="text-eyebrow" id="context-window-label">
                    Context window
                  </h3>
                  <p class="context-headline">
                    {contextHeadline(v().total, v().window)}
                    <Show when={contextRoom(v().total, v().window)}>{(r) => <span class="text-muted"> · {r()}</span>}</Show>
                  </p>
                  <p class="usage-note text-muted">
                    {v().total === null ? "Each size below is an estimate (≈)." : "As of the last reply. Each part is an estimate (≈); Other is what the estimates don't explain."}
                    <Show when={!v().prompt}> This chat isn't open here, so its mode, rules and tools are unknown and fall under Other.</Show>
                  </p>
                  <ul class="list context-lines" aria-labelledby="context-window-label">
                    <For each={lines()}>
                      {(l) => {
                        const size = () => (l.kind === "free" ? formatTokens(l.tokens) : approxTokens(l.tokens));
                        const body = () => (
                          <>
                            <span class="list-main">
                              <span class="list-title" classList={{ "list-title-muted": l.kind === "free" }}>
                                {l.label}
                              </span>
                            </span>
                            <span class="list-meta context-line-size">{size()}</span>
                          </>
                        );
                        return (
                          <li>
                            <Show when={l.opens} fallback={<div class="list-row">{body()}</div>}>
                              {(id) => (
                                <button type="button" class="list-row list-row-interactive" aria-expanded={open() === id()} onClick={() => show(id())}>
                                  {body()}
                                </button>
                              )}
                            </Show>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </section>

                <div ref={viewerEl}>
                  <Show when={open()} keyed>
                    {(id) => (
                      <FolderViewer
                        id="context-viewer"
                        title="What's in the window"
                        subtitle="Read-only. Sizes are estimates."
                        groups={groups()}
                        keepOrder
                        hideTextNote
                        refreshKey={v().checkedAt}
                        initial={groupOf(id) ? { group: groupOf(id)!, path: id } : undefined}
                        onClose={() => setOpen(null)}
                      />
                    )}
                  </Show>
                </div>

                <Show when={subfolder().length > 0 || v().incomplete}>
                  <section class="stack-2" aria-labelledby="context-subfolder-label">
                    <h3 class="text-eyebrow" id="context-subfolder-label">
                      Subfolder instructions
                    </h3>
                    <p class="usage-note text-muted">
                      Each loads the first time the agent reads, edits or writes a file in its folder. A loaded file counts toward the total.
                      <Show when={v().incomplete}> This list may be incomplete.</Show>
                    </p>
                    <ul class="list context-subfolder" aria-labelledby="context-subfolder-label">
                      <For each={subfolder()}>
                        {(p) => (
                          <li>
                            <button type="button" class="list-row list-row-interactive" aria-expanded={open() === p.id} onClick={() => show(p.id)}>
                              <span class="list-main">
                                <span class="list-title">{p.label}</span>
                                <span class="list-meta">
                                  {p.folder ?? ""} · {approxTokens(p.tokens)} tokens
                                </span>
                              </span>
                              <span class={p.loaded ? "chip chip-count" : "chip chip-count text-muted"}>{p.loaded ? "Loaded" : "Not yet loaded"}</span>
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </section>
                </Show>
              </>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}

/** A part's size in the viewer's list; a subfolder file says whether it is loaded. */
function partDetail(p: ContextPart): string {
  const size = approxTokens(p.tokens);
  if (p.group !== "subfolder") return size;
  return `${p.loaded ? "Loaded" : "Not yet"} · ${size}`;
}
