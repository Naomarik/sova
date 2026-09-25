import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show } from "solid-js";
import { IDEA_ID_RE, IDEA_STATUSES, type IdeaConflict, type IdeaPatch, type IdeaRecord, type IdeaStatus, type OverseerIdeaDetail, type OverseerIdeasInfo } from "../../shared/protocol";
import { ApiError, getOverseerIdea, patchOverseerIdea } from "../lib/api";
import { relativeTime, tildePath } from "../lib/format";
import { LABEL_GAP, layoutGraph, neighbours } from "../lib/idea-graph";
import { canonicalId, countsLine, exploreMessage, IDEA_STATUS_CHIP, ideasCount, parseTags, settled, startMessage, tocGroups } from "../lib/ideas";
import { announce, home } from "../lib/ui-state";
import type { OverseerSender } from "./ChatView";
import { Markdown } from "./Markdown";
import { Banner, Icon } from "./ui";
import "../overseer-ideas.css";

type View = "list" | "graph";

/** A status, said twice: the dot's colour and the word. */
export function IdeaChip(props: { status: IdeaStatus }) {
  const c = () => IDEA_STATUS_CHIP[props.status];
  return (
    <span class={`chip ${c().tone}`}>
      <i class="chip-dot" />
      {c().label}
    </span>
  );
}

/**
 * The Overseer page's Ideas panel: the backlog the Overseer files from chat, as a ToC grouped by
 * namespace, a link graph, and one idea's detail. Its two actions send an ordinary message through
 * the Overseer's composer, so the turn they start is the user's (caps apply); an edit here is a
 * PATCH that refuses to overwrite a newer version. The page owns the data (it also counts the
 * ideas on the head's button); this panel reads it.
 */
export function OverseerIdeas(props: {
  ideas: OverseerIdeasInfo | undefined;
  error: string | null;
  refetch(): void;
  /** Bumps whenever the backlog may have changed (an Overseer turn ended, the list refreshed). */
  version: number;
  sender(): OverseerSender | null;
  now: number;
  onClose(): void;
  /** A message went to the Overseer: the page may close the panel so its answer is in view. */
  onSent(): void;
}) {
  const [view, setView] = createSignal<View>("list");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [showSettled, setShowSettled] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let titleEl!: HTMLHeadingElement;
  onMount(() => titleEl.focus());

  const records = createMemo(() => new Map((props.ideas?.ideas ?? []).map((r) => [r.id, r])));
  const groups = createMemo(() => (props.ideas ? tocGroups(props.ideas.toc, { showSettled: showSettled(), query: query() }) : []));
  const settledCount = createMemo(() => (props.ideas?.ideas ?? []).filter((r) => settled(r.status)).length);
  const meta = () => {
    const i = props.ideas;
    if (!i) return "";
    const ns = i.toc.namespaces.length;
    return `${ideasCount(i.toc.total)} · ${ns} ${ns === 1 ? "project" : "projects"}`;
  };

  const open = (id: string) => setSelected(id);
  const back = () => {
    const was = selected();
    setSelected(null);
    queueMicrotask(() => (was && document.querySelector<HTMLElement>(`[data-idea="${CSS.escape(was)}"]`)?.focus()) || titleEl.focus());
  };

  return (
    <aside
      class="ideas-panel"
      id="overseer-ideas"
      aria-labelledby="ideas-title"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        if (selected()) back();
        else props.onClose();
      }}
    >
      <header class="ideas-head">
        <div class="ideas-head-main">
          <h2 class="ideas-title" id="ideas-title" tabindex="-1" ref={titleEl}>
            Ideas
          </h2>
          <p class="ideas-meta">{meta()}</p>
        </div>
        <button type="button" class="button button-icon button-ghost" aria-label="Close Ideas" onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </header>

      <Show
        when={selected()}
        keyed
        fallback={
          <>
            <div class="tabs ideas-tabs" role="tablist" aria-label="Ideas view">
              <For each={["list", "graph"] as View[]}>
                {(v) => (
                  <button
                    type="button"
                    role="tab"
                    class="tab"
                    id={`ideas-tab-${v}`}
                    aria-selected={view() === v}
                    aria-controls="ideas-view"
                    onClick={() => setView(v)}
                  >
                    {v === "list" ? "Contents" : "Graph"}
                  </button>
                )}
              </For>
            </div>
            <div class="ideas-tools">
              <Show when={view() === "list"}>
                <input
                  class="input ideas-search"
                  type="search"
                  placeholder="Filter by id or title"
                  aria-label="Filter ideas by id or title"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                />
              </Show>
              <label class="toggle ideas-settled">
                <input type="checkbox" checked={showSettled()} onChange={(e) => setShowSettled(e.currentTarget.checked)} />
                <span class="toggle-box" aria-hidden="true" />
                Done and dropped ({settledCount()})
              </label>
            </div>
            <div class="ideas-body" id="ideas-view" role="tabpanel" aria-labelledby={`ideas-tab-${view()}`}>
              <Show when={props.ideas} fallback={<Loading error={props.error} retry={props.refetch} />}>
                {(info) => (
                  <Show
                    when={info().toc.total > 0}
                    fallback={
                      <div class="empty ideas-empty">
                        <p class="empty-title">No ideas filed yet.</p>
                        <p class="empty-body">Tell the Overseer about something you'd like someday. It files it here, by project.</p>
                      </div>
                    }
                  >
                    <Show when={view() === "graph"} fallback={<IdeasToc groups={groups()} records={records()} showSettled={showSettled()} onOpen={open} query={query()} />}>
                      <IdeasGraph info={info()} showSettled={showSettled()} onOpen={open} />
                    </Show>
                  </Show>
                )}
              </Show>
            </div>
          </>
        }
      >
        {(id) => (
          <IdeaDetailView
            id={id}
            records={records()}
            version={props.version}
            now={props.now}
            sender={props.sender}
            onBack={back}
            onOpen={open}
            onChanged={props.refetch}
            onSent={props.onSent}
          />
        )}
      </Show>
      <Show when={props.ideas && !selected()}>
        <p class="ideas-file">
          Stored in <code>{tildePath(props.ideas!.dir, home())}</code>.
        </p>
      </Show>
    </aside>
  );
}

function Loading(props: { error: string | null; retry(): void }) {
  return (
    <Show when={props.error} fallback={<p class="ideas-note">Loading the ideas…</p>}>
      {(e) => (
        <Banner
          tone="error"
          title="Couldn't load the ideas."
          body={`${e().replace(/\.$/, "")}. Nothing was changed.`}
          action={
            <button type="button" class="button button-sm" onClick={() => props.retry()}>
              Try Again
            </button>
          }
        />
      )}
    </Show>
  );
}

function IdeasToc(props: {
  groups: ReturnType<typeof tocGroups>;
  records: Map<string, IdeaRecord>;
  showSettled: boolean;
  query: string;
  onOpen(id: string): void;
}) {
  return (
    <Show when={props.groups.length > 0} fallback={<p class="ideas-note">No idea matches “{props.query.trim()}”.</p>}>
      <For each={props.groups}>
        {(g) => (
          <section class="ideas-group" aria-labelledby={`ideas-ns-${g.ns}`}>
            <h3 class="list-group-label ideas-group-label" id={`ideas-ns-${g.ns}`}>
              <span>§{g.ns}</span>
              <span class="ideas-group-counts">{countsLine(g.counts, props.showSettled)}</span>
            </h3>
            <Show when={g.rows.length > 0} fallback={<p class="ideas-note">{`${ideasCount(g.hidden)} done or dropped.`}</p>}>
              <ul class="list">
                <For each={g.rows}>
                  {(row) => {
                    const tags = () => props.records.get(row.id)?.tags ?? [];
                    return (
                      <li>
                        <button
                          type="button"
                          class={`list-row list-row-interactive ideas-row${row.depth ? " ideas-row-sub" : ""}`}
                          data-idea={row.id}
                          onClick={() => props.onOpen(row.id)}
                        >
                          <span class="list-main">
                            <span class="list-title">{row.title}</span>
                            <span class="list-meta">
                              <span class="text-mono">{row.id}</span>
                              <Show when={tags().length > 0}>
                                {" · "}
                                {tags().join(", ")}
                              </Show>
                            </span>
                          </span>
                          <IdeaChip status={row.status} />
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </For>
    </Show>
  );
}

/** Node fill per status: the chip's colour, in the graph's own vocabulary. */
const NODE_CLASS: Record<IdeaStatus, string> = {
  open: "ideas-node-open",
  exploring: "ideas-node-exploring",
  started: "ideas-node-started",
  done: "ideas-node-done",
  dropped: "ideas-node-dropped",
};

const GRAPH_W = 480;
const GRAPH_H = 360;
/** A node's label: project and name, so a link that crosses projects reads as one. A sub-entry's
    parent is its dashed line, so the label leaves it out. */
const labelOf = (id: string) => {
  const m = IDEA_ID_RE.exec(id);
  const text = m ? `${m[1]}/${m[3]}` : id.replace(/^§/, "");
  return text.length > 26 ? `${text.slice(0, 25)}…` : text;
};
/** The label's advance per character: JetBrains Mono at 11px is 0.6em. */
const LABEL_CHAR = 6.6;

function IdeasGraph(props: { info: OverseerIdeasInfo; showSettled: boolean; onOpen(id: string): void }) {
  const shown = createMemo(() => props.info.ideas.filter((r) => props.showSettled || !settled(r.status)));
  /** A sub-entry hangs off its main entry: drawn dashed, with no arrow, and pulled close like a link. */
  const partOf = createMemo(() => new Set(shown().flatMap((r) => (r.parent ? [`${r.parent}\0${r.id}`] : []))));
  const layout = createMemo(() => {
    const ids = new Set(shown().map((r) => r.id));
    const parts = shown().flatMap((r) => (r.parent ? [{ from: r.parent, to: r.id }] : []));
    return layoutGraph(
      shown().map((r) => ({ id: r.id, group: r.ns })),
      [...props.info.edges.filter((e) => ids.has(e.from) || ids.has(e.to)), ...parts.filter((e) => ids.has(e.from))],
      { width: GRAPH_W, height: GRAPH_H, pad: 28, labelWidth: (id) => labelOf(id).length * LABEL_CHAR },
    );
  });
  const isPart = (e: { from: string; to: string }) => partOf().has(`${e.from}\0${e.to}`);
  const byId = createMemo(() => new Map(shown().map((r) => [r.id, r])));
  const [hot, setHot] = createSignal<string | null>(null);
  const lit = createMemo(() => {
    const h = hot();
    return h ? neighbours(h, layout().edges) : null;
  });
  const linkCount = () => layout().edges.filter((e) => !isPart(e)).length;
  // A dangling link here is one to an idea the toggle hides, or to one that no longer parses.
  const hiddenLinks = () => layout().dangling.length;

  return (
    <div class="ideas-graph">
      <p class="ideas-note">
        {`${ideasCount(layout().nodes.length)}, ${linkCount()} ${linkCount() === 1 ? "link" : "links"}.`}
        <Show when={hiddenLinks() > 0}>{` ${hiddenLinks()} more ${hiddenLinks() === 1 ? "link goes" : "links go"} to hidden ideas.`}</Show>{" "}
        Arrows point from an idea to what it links to; a dashed line joins a sub-entry to its idea.
      </p>
      <svg class="ideas-graph-svg" viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`} role="group" aria-label="Link graph of the ideas">
        <defs>
          <marker id="ideas-arrow" viewBox="0 0 10 10" refX="17" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" class="ideas-arrow" />
          </marker>
        </defs>
        <g aria-hidden="true">
          <For each={layout().edges}>
            {(e) => (
              <line
                class="ideas-edge"
                classList={{
                  "ideas-edge-part": isPart(e), "ideas-edge-lit": !!lit() && lit()!.has(e.from) && lit()!.has(e.to) && (e.from === hot() || e.to === hot()), "ideas-dim": !!lit() && !(e.from === hot() || e.to === hot()) }}
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                marker-end={isPart(e) ? undefined : "url(#ideas-arrow)"}
              />
            )}
          </For>
        </g>
        <For each={layout().nodes}>
          {(n) => {
            const r = () => byId().get(n.id)!;
            const right = n.anchor === "end";
            return (
              <g
                class="ideas-node"
                classList={{ "ideas-dim": !!lit() && !lit()!.has(n.id), "ideas-node-hot": hot() === n.id }}
                transform={`translate(${n.x} ${n.y})`}
                role="button"
                tabindex="0"
                data-idea={n.id}
                aria-label={`${r().title}, ${n.id}, ${IDEA_STATUS_CHIP[r().status].label}`}
                onClick={() => props.onOpen(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onOpen(n.id);
                  }
                }}
                onPointerEnter={() => setHot(n.id)}
                onPointerLeave={() => setHot(null)}
                onFocus={() => setHot(n.id)}
                onBlur={() => setHot(null)}
              >
                <title>{`${r().title} — ${n.id}`}</title>
                <circle class="ideas-node-hit" r="16" />
                <circle class={`ideas-node-dot ${NODE_CLASS[r().status]}`} r={r().parent ? 5 : 7} />
                <text class="ideas-node-label" x={right ? -LABEL_GAP : LABEL_GAP} y="4" text-anchor={n.anchor}>
                  {labelOf(n.id)}
                </text>
              </g>
            );
          }}
        </For>
      </svg>
      <ul class="ideas-legend" aria-label="Status colours">
        <For each={IDEA_STATUSES.filter((s) => props.showSettled || !settled(s))}>
          {(s) => (
            <li>
              <IdeaChip status={s} />
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function IdeaDetailView(props: {
  id: string;
  records: Map<string, IdeaRecord>;
  version: number;
  now: number;
  sender(): OverseerSender | null;
  onBack(): void;
  onOpen(id: string): void;
  onChanged(): void;
  onSent(): void;
}) {
  const [detail, { mutate, refetch }] = createResource(() => props.id, getOverseerIdea);
  const [editing, setEditing] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal({ title: "", tags: "", links: "", text: "" });
  const loaded = (): OverseerIdeaDetail | undefined => (detail.error ? undefined : detail());

  // Focus lands on the idea's title once it has loaded (each idea opened, links included).
  // A memo, so a refetch (a fresh object, same id) never pulls focus back to the title.
  const loadedId = createMemo(() => loaded()?.idea.id ?? null);
  createEffect(on(loadedId, (id) => id && queueMicrotask(() => document.getElementById("ideas-detail-title")?.focus())));

  // The backlog changed (an Overseer turn): follow it, unless an edit is open over this copy.
  createEffect(on(() => props.version, () => !editing() && !saving() && void refetch(), { defer: true }));

  const titleOf = (id: string) => props.records.get(id)?.title ?? null;
  const blocked = () => {
    const s = props.sender();
    return s ? s.blocked() : "Connecting to the Overseer…";
  };
  const sendToOverseer = (text: string) => {
    const s = props.sender();
    if (!s || !s.send(text)) return;
    announce(`Sent to the Overseer: ${text}`);
    props.onSent();
  };

  const startEdit = (d: OverseerIdeaDetail) => {
    setDraft({ title: d.idea.title, tags: d.idea.tags.join(", "), links: d.idea.links.join(" "), text: d.text });
    setSaveError(null);
    setNotice(null);
    setEditing(true);
    queueMicrotask(() => document.getElementById("idea-edit-title")?.focus());
  };

  const patch = async (body: Omit<IdeaPatch, "base">, done: string) => {
    const d = loaded();
    if (!d || saving()) return false;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const next = await patchOverseerIdea(d.idea.id, { ...body, base: d.idea.updatedAt });
      mutate(next);
      announce(done);
      props.onChanged();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as IdeaConflict | undefined)?.current;
        if (current) mutate(current);
        else void refetch();
        setNotice("This idea changed while you were editing it, so nothing was saved. This is its latest version.");
      } else setSaveError((err instanceof Error ? err.message : String(err)).replace(/\.$/, ""));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    const d = draft();
    const ok = await patch(
      { title: d.title.trim(), tags: parseTags(d.tags), links: parseTags(d.links).map(canonicalId), text: d.text },
      "Idea saved.",
    );
    if (ok) setEditing(false);
  };

  return (
    <div class="ideas-body ideas-detail">
      <button type="button" class="button button-sm button-ghost ideas-back" onClick={() => props.onBack()}>
        <Icon name="chevron-left" small />
        All Ideas
      </button>
      <Show when={loaded()} fallback={<DetailLoading error={detail.error} retry={() => void refetch()} />}>
        {(d) => (
          <>
            <div class="ideas-detail-head">
              <h3 class="ideas-detail-title" id="ideas-detail-title" tabindex="-1">
                {d().idea.title}
              </h3>
              <IdeaChip status={d().idea.status} />
            </div>
            <p class="ideas-detail-meta">
              <span class="text-mono">{d().idea.id}</span>
              {` · filed ${relativeTime(d().idea.createdAt, props.now)} · updated ${relativeTime(d().idea.updatedAt, props.now)}`}
            </p>
            <Show when={d().idea.tags.length > 0}>
              <ul class="ideas-tags" aria-label="Tags">
                <For each={d().idea.tags}>{(t) => <li class="chip chip-count">{t}</li>}</For>
              </ul>
            </Show>

            <Show when={notice()}>{(n) => <Banner tone="info" title="Showing the latest version." body={n()} />}</Show>
            <Show when={saveError()}>{(e) => <Banner tone="error" title="Couldn't save the idea." body={`${e()}. The saved idea is unchanged.`} />}</Show>

            <Show when={!editing()}>
              <div class="ideas-actions">
                <button
                  type="button"
                  class="button button-primary"
                  aria-disabled={blocked() || d().idea.status === "dropped" ? "true" : undefined}
                  title={blocked() ?? (d().idea.explorerId ? `Asks the Overseer what explorer ${d().idea.explorerId} has found.` : "Asks the Overseer to launch an exploratory agent for this idea.")}
                  onClick={() => !blocked() && d().idea.status !== "dropped" && sendToOverseer(exploreMessage(d().idea))}
                >
                  {d().idea.explorerId ? "Ask the Explorer" : "Explore"}
                </button>
                <button
                  type="button"
                  class="button"
                  aria-disabled={blocked() || d().idea.status === "dropped" ? "true" : undefined}
                  title={blocked() ?? "Asks the Overseer to start a session for this idea. It asks which folder only when that is unclear."}
                  onClick={() => !blocked() && d().idea.status !== "dropped" && sendToOverseer(startMessage(d().idea))}
                >
                  Start a Session
                </button>
                <button type="button" class="button button-ghost" disabled={saving()} onClick={() => startEdit(d())}>
                  <Icon name="pencil" small />
                  Edit
                </button>
              </div>
              <Show when={blocked()}>{(b) => <p class="field-hint">{b()}</p>}</Show>

              <div class="field ideas-status-field">
                <label class="field-label" for="idea-status">
                  Status
                </label>
                <div class="select-wrap">
                  <select
                    class="select"
                    id="idea-status"
                    disabled={saving() || d().idea.status === "dropped"}
                    aria-describedby="idea-status-hint"
                    onChange={(e) => {
                      const next = e.currentTarget.value as IdeaStatus;
                      void patch({ status: next }, `Status: ${IDEA_STATUS_CHIP[next].label}.`).then((ok) => {
                        if (!ok) e.currentTarget.value = loaded()?.idea.status ?? next;
                      });
                    }}
                  >
                    <For each={IDEA_STATUSES}>
                      {(s) => (
                        <option value={s} selected={s === d().idea.status}>
                          {IDEA_STATUS_CHIP[s].label}
                        </option>
                      )}
                    </For>
                  </select>
                  <span class="select-caret" aria-hidden="true">
                    ▾
                  </span>
                </div>
                <span class="field-hint" id="idea-status-hint">
                  {d().idea.status === "dropped" ? "Dropped is final." : "Explore and Start a Session set it for you. Dropped is final."}
                </span>
              </div>

              <section class="ideas-section" aria-label="The idea">
                <Show when={d().text.trim()} fallback={<p class="ideas-note">No text yet. It grows as you talk it through with the Overseer.</p>}>
                  <div class="ideas-prose">
                    <Markdown text={d().text} />
                  </div>
                </Show>
              </section>
            </Show>

            <Show when={editing()}>
              <form
                class="ideas-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveEdit();
                }}
              >
                <div class="field">
                  <label class="field-label" for="idea-edit-title">
                    Title
                  </label>
                  <input
                    class="input"
                    id="idea-edit-title"
                    maxLength={120}
                    value={draft().title}
                    disabled={saving()}
                    onInput={(e) => setDraft({ ...draft(), title: e.currentTarget.value })}
                  />
                </div>
                <div class="field">
                  <label class="field-label" for="idea-edit-tags">
                    Tags
                  </label>
                  <input class="input" id="idea-edit-tags" value={draft().tags} disabled={saving()} onInput={(e) => setDraft({ ...draft(), tags: e.currentTarget.value })} />
                  <span class="field-hint">Separated by commas or spaces.</span>
                </div>
                <div class="field">
                  <label class="field-label" for="idea-edit-links">
                    Links
                  </label>
                  <input
                    class="input text-mono"
                    id="idea-edit-links"
                    value={draft().links}
                    disabled={saving()}
                    onInput={(e) => setDraft({ ...draft(), links: e.currentTarget.value })}
                  />
                  <span class="field-hint">Other ideas' ids, such as §sova/graph.</span>
                </div>
                <div class="field">
                  <label class="field-label" for="idea-edit-text">
                    Text
                  </label>
                  <textarea class="input textarea ideas-edit-text" id="idea-edit-text" rows={10} value={draft().text} disabled={saving()} onInput={(e) => setDraft({ ...draft(), text: e.currentTarget.value })} />
                </div>
                <div class="ideas-actions">
                  <span class="modal-spacer" />
                  <button type="button" class="button button-ghost" disabled={saving()} onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button type="submit" class="button button-primary" disabled={saving() || !draft().title.trim()}>
                    {saving() ? "Saving…" : "Save Idea"}
                  </button>
                </div>
              </form>
            </Show>

            <Show when={d().idea.sessionId || d().idea.explorerId}>
              <section class="ideas-section" aria-labelledby="ideas-work-title">
                <h4 class="ideas-section-title" id="ideas-work-title">
                  Work on it
                </h4>
                <ul class="ideas-links">
                  <Show when={d().idea.sessionId}>
                    {(sid) => (
                      <li>
                        <a class="ideas-link" href={`#/sid/${encodeURIComponent(sid())}`}>
                          <Icon name="chat" small />
                          <span>Session</span>
                          <span class="text-mono ideas-link-title">{sid()}</span>
                        </a>
                      </li>
                    )}
                  </Show>
                  <Show when={d().idea.explorerId}>
                    {(ag) => (
                      <li class="ideas-link ideas-link-static">
                        <Icon name="worker" small />
                        <span>Explorer</span>
                        <span class="text-mono ideas-link-title">{ag()}</span>
                      </li>
                    )}
                  </Show>
                </ul>
              </section>
            </Show>

            <LinkSection title="Links to" empty="Links to no other idea." ids={d().idea.links} titleOf={titleOf} onOpen={props.onOpen} />
            <LinkSection title="Linked from" empty="No idea links here." ids={d().linkedBy} titleOf={titleOf} onOpen={props.onOpen} />
            <Show when={d().scope.length > d().idea.links.length}>
              <LinkSection
                title={`In scope (${d().scope.length})`}
                empty=""
                ids={d().scope}
                titleOf={titleOf}
                onOpen={props.onOpen}
                hint="Everything it reaches through links, and its sub-entries. An explorer starts with all of it."
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function LinkSection(props: { title: string; empty: string; ids: string[]; hint?: string; titleOf(id: string): string | null; onOpen(id: string): void }) {
  const slug = () => props.title.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <section class="ideas-section" aria-labelledby={`ideas-${slug()}`}>
      <h4 class="ideas-section-title" id={`ideas-${slug()}`}>
        {props.title}
      </h4>
      <Show when={props.hint}>{(h) => <p class="field-hint">{h()}</p>}</Show>
      <Show when={props.ids.length > 0} fallback={<p class="ideas-note">{props.empty}</p>}>
        <ul class="ideas-links">
          <For each={props.ids}>
            {(id) => (
              <li>
                <Show when={props.titleOf(id)} fallback={<span class="ideas-link ideas-link-static text-mono">{id}</span>}>
                  {(t) => (
                    <button type="button" class="ideas-link" onClick={() => props.onOpen(id)}>
                      <span class="text-mono">{id}</span>
                      <span class="ideas-link-title">{t()}</span>
                    </button>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

function DetailLoading(props: { error: unknown; retry(): void }) {
  return (
    <Show when={props.error} fallback={<p class="ideas-note">Loading the idea…</p>}>
      {(e) => (
        <Banner
          tone="error"
          title={e() instanceof ApiError && (e() as ApiError).status === 404 ? "That idea isn't in the backlog." : "Couldn't load the idea."}
          body={`${String((e() as Error).message ?? e()).replace(/\.$/, "")}. Nothing was changed.`}
          action={
            <button type="button" class="button button-sm" onClick={() => props.retry()}>
              Try Again
            </button>
          }
        />
      )}
    </Show>
  );
}
