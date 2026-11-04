import { createEffect, createMemo, createResource, createSignal, For, Match, on, Show, Switch } from "solid-js";
import type { TeamInfo, WorkerInfo } from "../../shared/protocol";
import { fetchSessionContextView, fetchSetupFile } from "../lib/api";
import { formatTokens } from "../lib/context";
import { approxTokens, contextHeadline, contextLines, contextRoom, flatParts, partLang, workerReplyKey, type ContextLine, type ContextPart } from "../lib/context-parts";
import { workerLabel } from "../lib/workers";
import { FolderViewer, openItem } from "./FolderViewer";
import { Icon } from "./ui";
import "./ContextTab.css";

/**
 * The Context tab: what fills this chat's window (or one of its workers'), as of the last reply.
 * The total is the reply's own usage; each part is an estimate, and Other is what the estimates
 * don't explain. A line of one part opens it in the reader; a line of several lists them in the
 * folder viewer, whose rows open in the reader. An open reader isn't refreshed. It reads once on
 * open and again on each change to the session's file (`changed`, the pane's insight signal) and, for a
 * picked worker, when one of its replies ends (`workerReplyKey`); never polls.
 */
export function ContextTab(props: { path: string; workers: WorkerInfo[]; teams?: TeamInfo[]; changed: number }) {
  const pickable = () => props.workers.filter((w) => w.sessionFile);
  const [who, setWho] = createSignal(props.path);
  /** The session read: this chat, or the picked worker while it is still listed. */
  const target = createMemo(() => (pickable().some((w) => w.sessionFile === who()) ? who() : props.path));
  /** A picked worker's own reply-end signal: its replies don't move the parent's file. */
  const workerKey = createMemo(() => workerReplyKey(pickable().find((w) => w.sessionFile === target())));
  const [view] = createResource(
    () => `${props.changed}\u0002${workerKey()}\u0001${target()}`,
    (key) => fetchSessionContextView(key.slice(key.indexOf("\u0001") + 1)),
  );
  const ok = createMemo(() => {
    const v = view.latest;
    return v?.state === "ok" ? { ...v, parts: flatParts(v), incomplete: v.nestedIncomplete } : null;
  });
  const [listed, setListed] = createSignal<ContextLine | null>(null);
  createEffect(on(target, () => setListed(null), { defer: true }));
  let viewerEl: HTMLDivElement | undefined;
  const list = (line: ContextLine) => {
    setListed(line);
    queueMicrotask(() => viewerEl?.scrollIntoView({ block: "nearest" }));
  };

  const lines = () => {
    const v = ok();
    return v ? contextLines(v) : [];
  };
  const subfolder = () => ok()?.parts.filter((p) => p.group === "subfolder") ?? [];
  const read = async (id: string) => {
    const p = ok()?.parts.find((x) => x.id === id);
    if (!p) throw new Error("That part isn't in this chat's context any more.");
    if (p.text !== undefined) return { text: p.text };
    if (!p.path) return { text: "" };
    return { text: (await fetchSetupFile(target(), p.path)).text };
  };
  const item = (p: ContextPart) => ({ path: p.id, label: p.label, detail: approxTokens(p.tokens), lang: partLang(p) });
  const openPart = (id: string, opener: HTMLElement) => {
    const p = ok()?.parts.find((x) => x.id === id);
    if (p) void openItem({ label: p.path === p.label ? "" : (p.path ?? ""), read }, item(p), opener);
  };

  return (
    <div class="session-panel-scroll" tabindex="0">
      <div class="stack">
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
                    <Show when={!v().prompt}> This chat isn't running here, so its mode, rules and tools are unknown and fall under Other.</Show>
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
                            <Switch fallback={<div class="list-row">{body()}</div>}>
                              <Match when={l.opens}>
                                {(id) => (
                                  <button type="button" class="list-row list-row-interactive" aria-haspopup="dialog" onClick={(e) => openPart(id(), e.currentTarget)}>
                                    {body()}
                                  </button>
                                )}
                              </Match>
                              <Match when={l.lists}>
                                <button type="button" class="list-row list-row-interactive" aria-expanded={listed()?.id === l.id} onClick={() => list(l)}>
                                  {body()}
                                </button>
                              </Match>
                            </Switch>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </section>

                <div class="context-viewer-slot" ref={viewerEl}>
                  <Show when={listed()} keyed>
                    {(l) => (
                      <FolderViewer
                        id="context-viewer"
                        title={l.label}
                        subtitle="Read-only. Sizes are estimates."
                        groups={[{ id: l.id, label: l.label, list: async () => (ok()?.parts ?? []).filter((p) => p.group === l.lists).map(item), read }]}
                        keepOrder
                        refreshKey={v().checkedAt}
                        onClose={() => setListed(null)}
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
                            <button type="button" class="list-row list-row-interactive" aria-haspopup="dialog" onClick={(e) => openPart(p.id, e.currentTarget)}>
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
