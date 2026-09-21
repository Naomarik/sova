import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import type { ExplanationInfo, SessionInsight, SessionSkillOffer, SessionSkillUse, SessionSummary, TranscriptItem, WorkerInfo } from "../../shared/protocol";
import { fetchTranscript } from "../lib/api";
import { formatTokens } from "../lib/context";
import { explainCaption, explainHref, explainState, newestFirst } from "../lib/explain";
import { relativeTime } from "../lib/format";
import { absoluteTime } from "../lib/spend";
import { activeTab, sessionContext, setActiveTab, toast } from "../lib/ui-state";
import { capTitle, usageHeadline, usageTitle, usageTotal, type UsageTotalView, workerLabel, workerTeam } from "../lib/workers";
import type { RewindControl } from "../lib/inputs";
import { jumpToEntry } from "../lib/jump";
import { RemotePaneStatus } from "./RemoteStatus";
import { SessionDetails } from "./SessionDetails";
import { SessionTimeline } from "./SessionTimeline";
import { SubagentPane } from "./SubagentPane";
import { Chip, Icon } from "./ui";

/** The open session's insight, loaded once in App.tsx for the head, the strip and this pane. */
export interface PaneInsight {
  data: SessionInsight | null;
  /** Message of the latest failed load, cleared by the next success. */
  error: string | null;
  /** True until the first load settles (either way). */
  pending: boolean;
  /** Bumped when a load that followed a change to the session's file lands — never by the
      pane's own status poll — so the Session tab refetches the transcript only when it moved. */
  changed: number;
}

export type TabId = "session" | "timeline" | "agents" | "skills" | "explain";
const TABS: readonly { id: TabId; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "timeline", label: "Timeline" },
  { id: "agents", label: "Agents" },
  { id: "skills", label: "Skills" },
  { id: "explain", label: "Explain" },
];
const isTab = (id: string | null): id is TabId => TABS.some((t) => t.id === id);

/**
 * The session detail pane (spec/11-subagents-pane.md §11): a head, a tab strip, and one tab's panel. Session
 * is the Session info modal's body (SessionDetails); Timeline is the session's one time axis;
 * Agents is the subagents pane it grew out
 * of; Skills says which skills loaded and when, here and in each worker; Explain lists this
 * session's /explain pages. The tab is kept per session path; with none kept, it opens on Agents while a worker is
 * working, else on Session. Read-only throughout, except the Timeline's rewind, which goes through the chat.
 */
export function SessionPane(props: {
  path: string;
  insight: PaneInsight;
  /** App-level session list row (undefined before the list loads), for Identity. */
  summary: SessionSummary | undefined;
  /** After Archive/Unarchive in the Session tab: re-read the session list. */
  onArchiveChanged(): void;
  /** After a group change in the Session tab: the same list, for the Groups region. */
  onGroupsChanged(): void;
  chatWorkers: WorkerInfo[] | null;
  /** The chat runtime's session-lifetime token Σ; null while watching or before the first one. */
  chatUsage: UsageTotalView | null;
  selected: string | null;
  onSelect(id: string): void;
  onClose(): void;
  now: number;
  /** The open chat's rewind hook for the Timeline's input rows; absent while watching or before the
      chat opens. */
  rewind?: RewindControl;
  /** App's last successful rewind of this session, whoever started it: the pane re-reads the
      transcript on it, and the Timeline draws the boundary. Never set by a refusal. */
  rewound?: { path: string; entryId: string; changed: number } | null;
  /** The Timeline's "Inputs Only" filter. App holds it for as long as the pane is open, so /tree
      and the composer's inputs row can open the tab with it on; nothing is persisted. */
  inputsOnly?: boolean;
  onInputsOnly?(on: boolean): void;
  /** The tab actually showing, reported on open, on every change, and as null when the pane goes.
      The composer's triggers key `aria-expanded` off it: the kept tab alone can't answer, since a
      session nobody has tabbed shows the fallback while `activeTab` is still null. */
  onTab?(tab: TabId | null): void;
}) {
  // The transcript, read once for the whole pane: the Session tab and the Timeline both want
  // the same rows, and a fetch per tab meant a refetch on every tab switch. It reloads when the
  // session's file moved (App's debounced insight reload) and after a rewind, whoever started it.
  const [items, setItems] = createSignal<TranscriptItem[] | null>(null);
  let run = 0;
  const loadItems = async () => {
    const mine = ++run;
    try {
      const next = await fetchTranscript(props.path);
      if (mine === run) setItems(next);
    } catch {
      // The rows on screen stay; the next change to the file retries.
    }
  };
  createEffect(on(() => props.insight.changed, () => void loadItems()));
  createEffect(on(() => props.rewound?.changed, (changed) => changed && props.rewound?.path === props.path && void loadItems(), { defer: true }));
  onCleanup(() => run++);

  const working = () => (props.chatWorkers ?? props.insight.data?.workers ?? []).filter((w) => w.working).length;
  /** The Σ the chat socket reports, else the insight's — a lifetime total either way. */
  const total = () => props.chatUsage ?? usageTotal(props.insight.data);
  // Settled once, on open: a default that followed the working count would move the tab under
  // the reader when the last worker finished.
  const fallback: TabId = untrack(working) > 0 ? "agents" : "session";
  const tab = (): TabId => {
    const kept = activeTab(props.path);
    return isTab(kept) ? kept : fallback;
  };

  createEffect(() => props.onTab?.(tab()));
  onCleanup(() => props.onTab?.(null));

  const tabEls: HTMLButtonElement[] = [];
  let aside!: HTMLElement;
  onMount(() =>
    queueMicrotask(() => {
      const row =
        tab() === "agents"
          ? aside.querySelector<HTMLElement>('.subagent-row[aria-current="true"]') ?? aside.querySelector<HTMLElement>(".subagent-row")
          : null;
      (row ?? tabEls[TABS.findIndex((t) => t.id === tab())])?.focus();
    }),
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    props.onClose();
  };
  /** Left/Right move focus along the strip (wrapping), Home/End jump; Enter or Space selects. */
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const last = TABS.length - 1;
    const next =
      e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    tabEls[next]?.focus();
  };

  return (
    <aside class="app-subagents" id="session-pane" aria-label="Session detail" ref={aside} onKeyDown={onKeyDown}>
      <header class="subagents-head">
        <h2 class="subagents-title">Session detail</h2>
        <Show when={working() > 0}>
          <span class="chip chip-count">{working()} working</span>
        </Show>
        <Show when={total()}>
          {(u) => (
            <span class="chip chip-count subagents-usage" title={usageTitle(u(), u().workers)}>
              {formatTokens(usageHeadline(u()))} tokens
            </span>
          )}
        </Show>
        <button type="button" class="button button-icon button-ghost subagents-close" aria-label="Close session detail" onClick={() => props.onClose()}>
          <Icon name="chevron-right" />
        </button>
      </header>
      {/* A remote session's identity, mount and connection, on every tab (the identity chip even
          before its chat reports one). */}
      <RemotePaneStatus path={props.path} summary={props.summary} />
      {/* Named apart from the landmark: both saying "Session detail" made a reader announce the
          same name twice, nesting into itself. */}
      <div class="tabs session-tabs" role="tablist" aria-label="Session detail tabs">
        <For each={TABS}>
          {(t, i) => (
            <button
              type="button"
              role="tab"
              class={tab() === t.id ? "tab tab-active" : "tab"}
              id={`session-tab-${t.id}`}
              aria-selected={tab() === t.id ? "true" : "false"}
              aria-controls={tab() === t.id ? "session-tabpanel" : undefined}
              tabindex={tab() === t.id ? 0 : -1}
              ref={(el) => (tabEls[i()] = el)}
              onClick={() => setActiveTab(props.path, t.id)}
              onKeyDown={(e) => onTabKey(e, i())}
            >
              {t.label}
            </button>
          )}
        </For>
      </div>
      <div class="session-panel" role="tabpanel" id="session-tabpanel" aria-labelledby={`session-tab-${tab()}`}>
        <Switch>
          <Match when={tab() === "session"}>
            <SessionTab
              path={props.path}
              insight={props.insight}
              summary={props.summary}
              items={items()}
              now={props.now}
              onArchiveChanged={props.onArchiveChanged}
              onGroupsChanged={props.onGroupsChanged}
            />
          </Match>
          <Match when={tab() === "timeline"}>
            <SessionTimeline
              path={props.path}
              items={items()}
              outline={props.insight.data?.outline ?? null}
              outlines={props.insight.data?.outlines}
              rewinds={props.insight.data?.rewinds}
              rewound={props.rewound}
              summary={props.summary}
              rewind={props.rewind}
              inputsOnly={props.inputsOnly ?? false}
              onInputsOnly={(on) => props.onInputsOnly?.(on)}
              pending={props.insight.pending}
              now={props.now}
              onReload={loadItems}
              onClose={props.onClose}
            />
          </Match>
          <Match when={tab() === "agents"}>
            <SubagentPane chatWorkers={props.chatWorkers} insight={props.insight} selected={props.selected} onSelect={props.onSelect} />
          </Match>
          <Match when={tab() === "skills"}>
            <SkillsTab
              insight={props.insight}
              now={props.now}
              onShowWorker={(id) => {
                props.onSelect(id);
                setActiveTab(props.path, "agents");
              }}
            />
          </Match>
          <Match when={tab() === "explain"}>
            <ExplainTab insight={props.insight} now={props.now} />
          </Match>
        </Switch>
      </div>
    </aside>
  );
}

// ---- Session ----------------------------------------------------------------------------------

/**
 * The Session info modal's body, fed from App's shared insight and the pane's shared transcript
 * read, which the Changes list and the context sentence need — no fetch of its own.
 */
function SessionTab(props: {
  path: string;
  insight: PaneInsight;
  summary: SessionSummary | undefined;
  items: TranscriptItem[] | null;
  now: number;
  onArchiveChanged(): void;
  onGroupsChanged(): void;
}) {
  /** The gauge's reading; "compacted" is re-derived from the items, as in the modal. */
  const context = () => {
    const c = sessionContext()[props.path];
    return c && c !== "compacted" ? c : null;
  };
  /** The poller keeps the last insight through a failure, so only a first-load failure shows;
      it retries on its own, so the banner offers no Retry. */
  const failure = () => (props.insight.data ? null : props.insight.error);

  return (
    <div class="session-panel-scroll" tabindex="0">
      <SessionDetails
        path={props.path}
        insight={props.insight.data}
        error={failure()}
        skeleton={props.insight.pending}
        summary={props.summary}
        context={context()}
        items={props.items ?? []}
        now={props.now}
        onArchiveChanged={props.onArchiveChanged}
        onGroupsChanged={props.onGroupsChanged}
        idPrefix="sp"
      />
    </div>
  );
}

// ---- Explain ----------------------------------------------------------------------------------

/**
 * This session's /explain pages, newest first, as text rows: the gallery (from the insight strip)
 * owns thumbnails, and both open the same page through `explainHref`. Read off the shared insight.
 */
function ExplainTab(props: { insight: PaneInsight; now: number }) {
  const items = () => newestFirst(props.insight.data?.explanations ?? []);
  return (
    <div class="session-panel-scroll" tabindex="0">
      <Show
        when={items().length > 0}
        fallback={
          <Show when={!props.insight.pending}>
            <div class="empty subagents-empty">
              <p class="empty-title">0 explanations in this session.</p>
              <p class="empty-body">
                Run <code>/explain &lt;topic&gt;</code> to add one.
              </p>
            </div>
          </Show>
        }
      >
        <ul class="list explain-list" aria-label="Explanations">
          <For each={items()}>{(item) => <ExplainRow item={item} now={props.now} />}</For>
        </ul>
      </Show>
    </div>
  );
}

/**
 * One explanation, in ExplainCard's three states: ok links out; failed (`error`) wrote no page, so
 * it is not a link and states its reason; noted (`note`) links out and carries the note.
 */
function ExplainRow(props: { item: ExplanationInfo; now: number }) {
  const state = () => explainState(props.item);
  const body = () => (
    <span class="list-main">
      <span class="list-title">{props.item.topic}</span>
      <Show when={props.item.summary}>
        <span class="explain-row-summary">{props.item.summary}</span>
      </Show>
      <span class="list-meta">{explainCaption(props.item, props.now)}</span>
      <Show when={state() === "failed"}>
        <span class="explain-row-state">{props.item.error}</span>
      </Show>
      <Show when={state() === "noted"}>
        <span class="explain-row-state text-muted">{props.item.note}</span>
      </Show>
    </span>
  );
  return (
    <li>
      <Show
        when={state() !== "failed"}
        fallback={
          <div class="list-row explain-row">
            {body()}
            <Chip tone="error">Failed</Chip>
          </div>
        }
      >
        <a class="list-row list-row-interactive explain-row" href={explainHref(props.item.id)}>
          <span class="visually-hidden">Explanation: </span>
          {body()}
        </a>
      </Show>
    </li>
  );
}

// ---- Skills -----------------------------------------------------------------------------------

/** The certainty of a load, in words: the chip text and what it means. See server/skills.ts. */
const HOW: Record<SessionSkillUse["how"], { word: string; title: string }> = {
  invoked: { word: "invoked", title: "Invoked explicitly: /skill:name, or a Claude Code Skill call." },
  read: { word: "read", title: "The agent read its SKILL.md." },
  shell: { word: "inferred", title: "Read through a shell command. We infer this." },
};

/**
 * Which skills loaded, and when: this session's own loads, then each worker's, oldest first. Only
 * this session's rows jump — a worker's evidence is in its own transcript, which the Agents tab
 * opens. What the prompt offered sits below, folded: offered is not loaded.
 */
function SkillsTab(props: { insight: PaneInsight; now: number; onShowWorker(id: string): void }) {
  const own = () => props.insight.data?.skills;
  const workers = () => props.insight.data?.workers ?? [];
  const teams = () => props.insight.data?.teams;
  /** Workers with loads, in the order their first load happened. */
  const workerLoads = () =>
    Object.entries(props.insight.data?.workerSkills ?? {})
      .filter(([, sk]) => sk.used.length > 0)
      .sort(([, a], [, b]) => a.used[0]!.at.localeCompare(b.used[0]!.at))
      .map(([id, skills]) => ({ id, skills, worker: workers().find((w) => w.id === id) }));
  const loads = () => (own()?.used.length ?? 0) + workerLoads().reduce((n, w) => n + w.skills.used.length, 0);

  const jump = (entryId: string) => {
    if (!jumpToEntry(entryId)) toast("That entry isn't in the transcript on screen.");
  };

  return (
    <div class="session-panel-scroll" tabindex="0">
      <Show
        when={loads() > 0}
        fallback={
          <Show when={!props.insight.pending}>
            <div class="empty subagents-empty">
              <p class="empty-title">0 skills loaded in this session.</p>
              <p class="empty-body">
                A skill loads when the agent reads a SKILL.md, or when you invoke <code>/skill:name</code>.
              </p>
            </div>
          </Show>
        }
      >
        <section class="stack-2" aria-labelledby="skills-session-label">
          <h3 class="text-eyebrow" id="skills-session-label">
            This session
          </h3>
          <Show when={(own()?.used.length ?? 0) > 0} fallback={<p class="usage-note">0 loads on this session's own branch.</p>}>
            <ul class="list skill-list" aria-labelledby="skills-session-label">
              <For each={own()!.used}>{(use) => <SkillLoad use={use} now={props.now} onJump={jump} />}</For>
            </ul>
            <p class="usage-note text-muted">Active branch only. A row jumps to its entry in the transcript.</p>
          </Show>
        </section>

        <For each={workerLoads()}>
          {(w) => {
            const label = () => (w.worker ? workerLabel(w.worker, teams()) : w.id);
            const team = () => (w.worker ? workerTeam(w.worker, teams()) : null);
            const headId = `skills-worker-${w.id}`;
            return (
              <section class="stack-2" aria-labelledby={headId}>
                <div class="spread">
                  <h3 class="text-eyebrow skill-worker-head" id={headId}>
                    <span>{label()}</span>
                    <Show when={team()}>{(t) => <span class="skill-worker-team">Team · {t().name}</span>}</Show>
                  </h3>
                  <Show when={w.worker}>
                    <button type="button" class="button button-sm button-ghost" onClick={() => props.onShowWorker(w.id)}>
                      Open in Agents
                    </button>
                  </Show>
                </div>
                <ul class="list skill-list" aria-labelledby={headId}>
                  <For each={w.skills.used}>{(use) => <SkillLoad use={use} now={props.now} />}</For>
                </ul>
                <Show
                  when={w.skills.offered.length > 0}
                  fallback={
                    <p class="usage-note text-muted">
                      {w.worker?.backend === "claude-code"
                        ? "Claude Code transcripts don't record which skills were offered."
                        : "Its prompt recorded no offered skills."}
                    </p>
                  }
                >
                  <OfferedSkills offered={w.skills.offered} now={props.now} />
                </Show>
              </section>
            );
          }}
        </For>
      </Show>

      <Show when={own()?.offered.length}>
        <section class="stack-2" aria-labelledby="skills-offered-label">
          <h3 class="text-eyebrow" id="skills-offered-label">
            Offered
          </h3>
          <p class="usage-note text-muted">What this session's prompt listed. Being offered isn't being loaded.</p>
          <OfferedSkills offered={own()!.offered} now={props.now} />
        </section>
      </Show>
    </div>
  );
}

/**
 * One load: name, the certainty in words, when. With `onJump` (this session's own loads) the row
 * is a button to its transcript entry and says so with a trailing arrow; without it the row is
 * plain text — no hover, no pointer, no arrow — so it never passes for a control.
 */
function SkillLoad(props: { use: SessionSkillUse; now: number; onJump?: (entryId: string) => void }) {
  const how = () => HOW[props.use.how];
  const body = () => (
    <>
      <span class="list-main">
        <span class="list-title">{props.use.name}</span>
        <span class="list-meta" title={absoluteTime(props.use.at, props.now) || undefined}>
          {relativeTime(props.use.at, props.now)}
        </span>
        <Show when={props.use.args}>
          {(a) => (
            <span class="list-meta skill-args" title={capTitle(a())}>
              {a()}
            </span>
          )}
        </Show>
      </span>
      <span class="chip chip-count" title={how().title}>
        {how().word}
      </span>
    </>
  );
  return (
    <li>
      <Show when={props.onJump} fallback={<div class="list-row skill-row">{body()}</div>}>
        {(jump) => (
          <button type="button" class="list-row list-row-interactive skill-row" title="Jump to this entry in the transcript" onClick={() => jump()(props.use.entryId)}>
            {body()}
            <Icon name="arrow-right" small />
          </button>
        )}
      </Show>
    </li>
  );
}

/** The offer windows, folded: quieter than the loads, and only on demand. */
function OfferedSkills(props: { offered: SessionSkillOffer[]; now: number }) {
  const span = (o: SessionSkillOffer) => {
    const from = o.from ? relativeTime(o.from, props.now) : "";
    if (!o.until) return from ? `Since ${from} · still offered` : "Still offered";
    const until = relativeTime(o.until, props.now);
    return from ? `${from} → ${until}` : `Until ${until}`;
  };
  return (
    <details class="disclosure">
      <summary class="disclosure-summary">
        <Icon name="chevron-right" small class="icon-twist" />
        <span class="disclosure-label">
          {props.offered.length} offered
        </span>
      </summary>
      <div class="disclosure-body">
        <ul class="list">
          <For each={props.offered}>
            {(o) => (
              <li class="list-row skill-row">
                <span class="list-main">
                  <span class="list-title">{o.name}</span>
                  <Show when={o.description}>
                    {(d) => (
                      <span class="list-meta" title={capTitle(d())}>
                        {d()}
                      </span>
                    )}
                  </Show>
                  <span class="list-meta" title={[o.from && absoluteTime(o.from, props.now), o.until && absoluteTime(o.until, props.now)].filter(Boolean).join(" → ") || undefined}>
                    {span(o)}
                  </span>
                </span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </details>
  );
}
