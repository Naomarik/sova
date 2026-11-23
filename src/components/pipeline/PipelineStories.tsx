import { createEffect, createMemo, createResource, For, on, Show } from "solid-js";
import { restartCount, type MergeEntry, type MergeQueueView } from "../../../shared/merge-queue";
import type { MergeQueueHealth } from "../../../shared/merge-queue-health";
import { getMergeEvents } from "../../lib/api";
import { duration, relativeTime } from "../../lib/format";
import { mergeChanged } from "../../lib/merge-queue-client";
import { attemptsOf, BY_WORD, eventState, eventTitle, threadHealthOf, threadWaitOf, type QueueEvent } from "../../lib/pipeline";
import { pipelineHref, projectSessionHref } from "../../lib/projects-route";
import { chatHref, type ChatOf } from "../MergeQueueTab";
import { Sheet, Timeline, ToneChip, type TimelineItem } from "./PipelineParts";

const attemptWords = (n: number) => `${n} ${n === 1 ? "attempt" : "attempts"}`;
const hm = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const day = (at: string) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });

const asItem = (e: QueueEvent): TimelineItem => ({
  key: String(e.seq),
  state: eventState(e),
  title: eventTitle(e),
  meta: (
    <>
      {day(e.at)} {hm(e.at)} · {BY_WORD[e.by]}
    </>
  ),
  body: <>{e.why}</>,
  ...(e.kind === "ruled" && e.read.length ? { read: e.read } : {}),
});

interface Story {
  branch: string;
  entries: MergeEntry[];
  latest: MergeEntry;
}

function storiesOf(v: MergeQueueView): Story[] {
  const all = [...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix, ...(v.waitingOnHost ?? []), ...v.recent.map((l) => l.entry)];
  const by = new Map<string, MergeEntry[]>();
  for (const e of all) by.set(e.branch, [...(by.get(e.branch) ?? []), e]);
  return [...by.entries()]
    .map(([branch, entries]) => {
      const sorted = [...entries].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return { branch, entries: sorted, latest: sorted[0]! };
    })
    .sort((a, b) => Date.parse(b.latest.updatedAt) - Date.parse(a.latest.updatedAt));
}

const STATE_CHIP: Partial<Record<MergeEntry["state"], { label: string; tone: "accent" | "success" | "warn" | "error" | "neutral" }>> = {
  checking: { label: "Landing", tone: "accent" },
  queued: { label: "Waiting", tone: "neutral" },
  landed: { label: "Landed", tone: "success" },
  pushed: { label: "Pushed", tone: "success" },
  "with-chat": { label: "Sent back", tone: "warn" },
  "needs-fix": { label: "Sent back", tone: "warn" },
  conflict: { label: "Conflict", tone: "warn" },
  "needs-user": { label: "Waits for you", tone: "warn" },
  cancelled: { label: "Removed", tone: "neutral" },
};
const chipOf = (e: MergeEntry) => STATE_CHIP[e.state] ?? { label: "Waits for you", tone: "warn" as const };

/**
 * Branch stories: each branch across every attempt — its recorded changes grouped by run, its restarts and why, what
 * its chat answered — beside the merge thread's own decisions and health.
 */
export function StoriesView(props: { projectId: string; view: MergeQueueView; item?: string; wide: boolean; health?: MergeQueueHealth; chatOf?: ChatOf }) {
  const stories = createMemo(() => storiesOf(props.view));
  const selected = createMemo(() => (props.item ? stories().find((s) => s.branch === props.item) : undefined) ?? (props.wide ? stories()[0] : undefined));
  return (
    <>
      <ThreadCard projectId={props.projectId} view={props.view} />
      <div class="pl-split">
        <div class="pl-master">
          <div>
            <h2 class="pl-section-title">Branch stories</h2>
            <p class="pl-section-sub">A branch across every attempt: why it restarted or went back, what its chat answered, and where it is now.</p>
          </div>
          <Show when={stories().length} fallback={<p class="pl-hint">No branch has been through the queue yet.</p>}>
            <ul class="pl-rows" aria-label="Branches">
              <For each={stories()}>
                {(s) => {
                  const runs = () => s.entries.reduce((n, e) => n + e.runs.length, 0);
                  const restarts = () => s.entries.reduce((n, e) => n + restartCount(e), 0);
                  return (
                    <li>
                      <a class="pl-row" href={pipelineHref(props.projectId, "queue", "stories", s.branch)} aria-current={selected()?.branch === s.branch ? "true" : undefined}>
                        <span class="pl-row-top">
                          <span class="pl-row-name">{s.branch}</span>
                          <ToneChip tone={chipOf(s.latest).tone}>{chipOf(s.latest).label}</ToneChip>
                        </span>
                        <span class="pl-row-meta">
                          {attemptWords(runs())}
                          {restarts() ? ` · restarted ${restarts()}×` : ""}
                          {threadWaitOf(s.latest) ? ` · waiting on the merge thread` : ""} · {relativeTime(s.latest.updatedAt)}
                        </span>
                      </a>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
          <p class="pl-hint">Every run carries its branch’s activity too: open one in Runs to read it beside the plan and the steps.</p>
        </div>
        <Show when={props.wide && selected()}>
          {(s) => (
            <div class="pl-detail">
              <StoryDetail projectId={props.projectId} view={props.view} story={s()} chatOf={props.chatOf} />
            </div>
          )}
        </Show>
      </div>
      <Show when={!props.wide && props.item ? selected() : undefined}>
        {(s) => (
          <Sheet title={s().branch} sub="Branch story" onClose={() => (location.hash = pipelineHref(props.projectId, "queue", "stories"))}>
            <StoryDetail projectId={props.projectId} view={props.view} story={s()} chatOf={props.chatOf} />
          </Sheet>
        )}
      </Show>
    </>
  );
}

function StoryDetail(props: { projectId: string; view: MergeQueueView; story: Story; chatOf?: ChatOf }) {
  const [events, { refetch }] = createResource(
    () => props.story.branch,
    (branch) => getMergeEvents(props.projectId, { branch, limit: 200 }).catch(() => null),
  );
  createEffect(on(mergeChanged, () => refetch(), { defer: true }));
  const attempts = createMemo(() => attemptsOf(events()?.events ?? []));
  const e = () => props.story.latest;
  const reply = () => {
    const rq = [...(e().requests ?? [])].reverse().find((r) => r.answer);
    return rq;
  };
  const first = () => props.story.entries[props.story.entries.length - 1]!;
  return (
    <>
      <header class="pl-detail-head">
        <span class="pl-kicker">Branch story</span>
        <h3 class="pl-detail-title">{props.story.branch}</h3>
        <p class="pl-detail-meta">
          <Show when={e().session}>
            <a href={chatHref(props.projectId, e().session!, props.chatOf)}>{props.chatOf?.(e().session!)?.title ?? "Its chat"}</a>
            {" · "}
          </Show>
          {attemptWords(props.story.entries.reduce((n, x) => n + x.runs.length, 0))} · first approved {relativeTime(first().createdAt)}
          {e().landed ? ` · landed ${relativeTime(e().landed!.at)}` : ""}
        </p>
        <Show when={e().reason}>
          <p class="pl-detail-lead">{e().reason}</p>
        </Show>
      </header>
      <Show when={threadWaitOf(e())}>
        {(w) => (
          <p class="pl-factbox is-warn">
            <b>Waiting on the merge thread.</b> Its {w().what === "fix" ? "fix" : "conflict"} has waited {duration(Date.now() - Date.parse(w().since))}.
            {w().fresh ? (w().fresh!.ok === false ? ` A fresh thread couldn’t start: ${w().fresh!.error ?? "no answer"}.` : " A fresh thread was started.") : ""}
          </p>
        )}
      </Show>
      <Show when={attempts().length} fallback={<p class="pl-hint">{events() === null ? "The activity record isn’t readable here yet." : "Nothing recorded for this branch yet."}</p>}>
        <For each={attempts()}>
          {(a) => (
            <div class="pl-attempt">
              <div class="pl-attempt-head">
                <span class="pl-attempt-label">{a.label}</span>
                <span class="pl-attempt-meta">
                  {day(a.events[0]!.at)} {hm(a.events[0]!.at)}
                  {a.run ? (
                    <>
                      {" · "}
                      <a href={pipelineHref(props.projectId, "queue", "runs", a.run)}>Open Run</a>
                    </>
                  ) : null}
                </span>
              </div>
              <div class="pl-attempt-body">
                <Timeline items={a.events.map(asItem)} label={a.label} />
              </div>
            </div>
          )}
        </For>
      </Show>
      <Show when={reply()}>
        {(r) => (
          <div class="pl-factbox">
            <b>Its chat answered {r().answer!.kind === "fixed" ? "Fixed" : r().answer!.kind === "needs-you" ? "Needs you" : "Can’t"}</b>
            {r().answer && "text" in r().answer! && (r().answer as { text?: string }).text ? ` · ${(r().answer as { text?: string }).text}` : ""}
          </div>
        )}
      </Show>
    </>
  );
}

/** The merge thread: how it answers, what waits on it and since when, the fresh threads Sova started, its decisions. */
function ThreadCard(props: { projectId: string; view: MergeQueueView }) {
  const t = () => props.view.thread;
  const h = () => threadHealthOf(t());
  const [decisions, { refetch }] = createResource(() => getMergeEvents(props.projectId, { by: "thread", limit: 20 }).catch(() => null));
  createEffect(on(mergeChanged, () => refetch(), { defer: true }));
  const items = () => (decisions()?.events ?? []).filter((e) => e.kind === "ruled" || e.kind === "thread-health").map(asItem);
  const word = () => ({ ok: "Answering", waiting: "Something waits on it", slow: "Slow: a fresh thread is starting", failed: "Not answering: you were told" })[h()?.state ?? "ok"];
  const tone = () => ({ ok: "success", waiting: "info", slow: "warn", failed: "error" }) as const;
  const decisionsCount = () => (decisions()?.events ?? []).filter((e) => e.kind === "ruled").length;
  return (
    <section class="pl-strip" aria-labelledby="pl-thread-title">
      <div class="pl-strip-head">
        <h3 id="pl-thread-title">Merge thread</h3>
        <Show when={t()} fallback={<span class="text-caption pl-muted">Not started yet: it starts with the first landing.</span>}>
          <ToneChip tone={tone()[h()?.state ?? "ok"]}>{word()}</ToneChip>
        </Show>
        <span class="pl-spacer" />
        <Show when={t()?.path}>
          <a class="button button-sm" href={projectSessionHref(props.projectId, t()!.path!)}>
            Open Merge Thread
          </a>
        </Show>
      </div>
      <Show when={t()}>
        <dl class="pl-health">
          <div>
            <dt>Waiting on it</dt>
            <dd>
              <Show when={h()?.waiting} fallback="Nothing">
                {(w) => (
                  <>
                    <span class="pl-mono">{w().branch}</span>’s {w().what} · {duration(Date.now() - Date.parse(w().since))} of {h()!.deadlineMin}m
                  </>
                )}
              </Show>
            </dd>
          </div>
          <div>
            <dt>Fresh threads</dt>
            <dd>
              <Show when={h()?.restarts.length} fallback="None">
                {h()!.restarts.length} · last {relativeTime(h()!.restarts[h()!.restarts.length - 1]!.at)}
                {h()!.restarts[h()!.restarts.length - 1]!.ok ? "" : " (failed)"}
              </Show>
            </dd>
          </div>
          <div>
            <dt>Failed deliveries</dt>
            <dd>{h()?.failures.length ? `${h()!.failures.length} · last ${relativeTime(h()!.failures[h()!.failures.length - 1]!.at)}` : "None"}</dd>
          </div>
          <div>
            <dt>Last event</dt>
            <dd>{t()!.lastEvent ? `${t()!.lastEvent!.kind} · ${relativeTime(t()!.lastEvent!.at)}` : "None yet"}</dd>
          </div>
          <div>
            <dt>Decisions</dt>
            <dd>{decisions() === null ? "Not recorded here yet" : `${decisionsCount()} recent`}</dd>
          </div>
        </dl>
        <Show when={items().length}>
          <details style={{ padding: "var(--space-3) var(--space-4)", "border-top": "var(--stroke-thin) solid var(--color-border)" }}>
            <summary class="text-caption">Its decisions, with what it read · {items().length}</summary>
            <div style={{ "margin-top": "var(--space-3)" }}>
              <Timeline items={items()} label="Merge thread decisions" />
            </div>
          </details>
        </Show>
      </Show>
    </section>
  );
}
