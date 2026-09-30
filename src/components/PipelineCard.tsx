import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { HeldAct, PipelineInfo, PipelineRow, TimelineRow } from "../../shared/pipeline";
import { DECISION_STATE } from "../lib/decisions-view";
import { ApiError, getGapTimeline, getPipeline, holdGap, resumeGap } from "../lib/api";
import { stampTime } from "../lib/format";
import { createPoll } from "../lib/poll";
import {
  byWord,
  followUpLine,
  heldFromLine,
  heldWaitLine,
  inPhaseFor,
  logStamp,
  moveLine,
  phaseChip,
  phaseDetail,
  pipelineOrder,
  pipelineSummary,
  stalledTitle,
  timelineOrder,
} from "../lib/pipeline-view";
import { announce, toast } from "../lib/ui-state";
import { CancelHeldButton } from "./HeldAct";
import { Chip, Icon } from "./ui";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** Read as often as the org page: a gap moves on its own (a reply, a timer, a build ending). */
export const PIPELINE_POLL_MS = 10_000;
/** The held acts' minutes and the rows' "for 2h" move on this clock. */
const CLOCK_MS = 15_000;

/** Rows carry `id` (their item id) so a poll reconciles them in place: an open timeline and focus survive. */
type Row = PipelineRow & { id: string };
type Info = { rows: Row[]; held: HeldAct[] };
const heldWaitOf = (h: HeldAct) => ({
  what: h.what,
  goesAt: Date.parse(h.goesAt),
  wait: h.wait,
  person: h.person,
  reviewSince: h.reviewSince ? Date.parse(h.reviewSince) : undefined,
});
const keyed = (p: PipelineInfo): Info => ({ rows: p.rows.map((r) => ({ ...r, id: r.itemId })), held: p.held });

/**
 * The project's Pipeline (§app.project-overseer/pipeline): the acts waiting in a hold, each with
 * Cancel (§app.project-overseer/holds), then one row per gap, each with its phase, how long, Stalled,
 * its gatherings, decisions and builds, Hold or Resume, and its timeline.
 */
export function PipelineCard(props: { orgId: string; projectId: string }) {
  const poll = createPoll(async () => keyed(await getPipeline(props.orgId, props.projectId)), PIPELINE_POLL_MS);
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
  onCleanup(() => clearInterval(clock));
  const rows = createMemo(() => pipelineOrder(poll.data()?.rows ?? []));
  const held = createMemo(() => [...(poll.data()?.held ?? [])].sort((a, b) => Date.parse(a.goesAt) - Date.parse(b.goesAt)));
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const holdOrResume = async (r: Row, hold: boolean) => {
    if (busy()) return;
    setBusy(r.itemId);
    try {
      poll.set(keyed(await (hold ? holdGap : resumeGap)(props.orgId, props.projectId, r.itemId)));
      setError(null);
      const done = hold ? `${r.title} is on hold. Nothing starts for it until you resume it.` : `${r.title} is back where it was: ${phaseDetail(r.held?.from ?? r.phase).toLowerCase()}.`;
      toast(done);
      announce(done);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="card orgs-section pipeline" aria-labelledby="project-pipeline">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-pipeline">
          Pipeline
        </h2>
      </div>
      <Show when={pipelineSummary(poll.data()?.rows ?? [])}>{(line) => <p class="orgs-line project-muted">{line()}</p>}</Show>
      <Show when={error() ?? (poll.data() ? null : poll.error())}>{(e) => <p class="field-error" role="alert">{e()}</p>}</Show>

      <Show when={held().length}>
        <div class="pipeline-held">
          <h3 class="orgs-h3">Waiting to start</h3>
          <ul class="pipeline-held-list">
            <For each={held()}>
              {(h) => (
                <li class="pipeline-held-row">
                  <p class="pipeline-held-line" title={h.reviewSince ? undefined : `Goes ahead at ${stampTime(h.goesAt)}.`}>
                    {heldWaitLine(heldWaitOf(h), now())}
                  </p>
                  <CancelHeldButton orgId={props.orgId} holdId={h.id} what={h.what} onDone={() => poll.refetch()} />
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <Show
        when={rows().length}
        fallback={
          <Show when={poll.data()}>
            <p class="orgs-empty">No gaps yet. When the overseer files a decision the project needs that nobody has made, it gets a row here.</p>
          </Show>
        }
      >
        <ul class="pipeline-rows">
          <For each={rows()}>{(r) => <GapRow orgId={props.orgId} projectId={props.projectId} row={r} now={now()} busy={busy()} onHold={(hold) => void holdOrResume(r, hold)} />}</For>
        </ul>
      </Show>
    </section>
  );
}

function GapRow(props: { orgId: string; projectId: string; row: Row; now: number; busy: string | null; onHold(hold: boolean): void }) {
  const r = () => props.row;
  const chip = () => phaseChip(r().phase);
  const onHold = () => r().phase === "on-hold";
  const [timelineOpen, setTimelineOpen] = createSignal(false);
  const timelineId = `pipeline-timeline-${r().itemId}`;
  const decisionWords = () => {
    const by = new Map<string, number>();
    for (const d of r().decisions) by.set(d.state, (by.get(d.state) ?? 0) + 1);
    return [...by].map(([s, n]) => `${n} ${(DECISION_STATE[s as keyof typeof DECISION_STATE]?.word ?? s).toLowerCase()}`).join(", ");
  };
  return (
    <li class="pipeline-row">
      <div class="pipeline-head">
        <span class="pipeline-title">{r().title}</span>
        <span class="pipeline-chips">
          <Chip tone={chip().tone} live={chip().live}>
            {chip().word}
          </Chip>
          <Show when={r().stalled}>
            <Chip tone="warn" title={stalledTitle(r(), props.now)}>
              Stalled
            </Chip>
          </Show>
        </span>
      </div>
      <p class="pipeline-meta">
        <span>{phaseDetail(r().phase)}</span> · <span title={stampTime(r().since)}>{inPhaseFor(r().since, props.now)}</span> ·{" "}
        <span class="orgs-mono">{r().gap}</span>
      </p>
      <Show when={r().held}>
        <p class="pipeline-meta">{heldFromLine(r())}</p>
      </Show>
      <Show when={followUpLine(r().followUp)}>
        {(f) => <p class="pipeline-meta" classList={{ "pipeline-meta-warn": f().warn }}>{f().text}</p>}
      </Show>

      <Show when={r().gatherings.length || r().builds.length || r().decisions.length}>
        <ul class="pipeline-links">
          <For each={r().gatherings}>
            {(g) => (
              <li>
                <LinkOrText path={g.path} class="pipeline-link">
                  <span class="pipeline-link-kind">Gathering</span> <span class="pipeline-link-title">{g.title}</span>
                  <span class="pipeline-link-state">{gatheringState(g)}</span>
                </LinkOrText>
              </li>
            )}
          </For>
          <For each={r().builds}>
            {(b) => (
              <li>
                <LinkOrText path={b.path} class="pipeline-link">
                  <span class="pipeline-link-kind">Build</span> <span class="pipeline-link-title">{b.title}</span>
                  <span class="pipeline-link-state">{buildState(b)}</span>
                </LinkOrText>
                {/* F20: its mode could not be set, so its first prompt never went: the server's sentence. */}
                <Show when={b.notPrompted}>{(s) => <p class="pipeline-build-note">{s()}</p>}</Show>
              </li>
            )}
          </For>
          <Show when={r().decisions.length}>
            <li>
              <details class="pipeline-decisions">
                <summary class="pipeline-link">
                  <Icon name="chevron-right" small class="icon-twist" />
                  <span class="pipeline-link-kind">{r().decisions.length === 1 ? "Decision" : `${r().decisions.length} decisions`}</span>{" "}
                  <span class="pipeline-link-title">{decisionWords()}</span>
                </summary>
                <ul class="pipeline-decision-list">
                  <For each={r().decisions}>
                    {(d) => (
                      <li>
                        <button type="button" class="pipeline-link pipeline-decision" onClick={() => showDecision(d.id)}>
                          <span class="pipeline-link-title">{d.statement}</span>
                          <span class="pipeline-link-state">{DECISION_STATE[d.state as keyof typeof DECISION_STATE]?.word ?? d.state}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </li>
          </Show>
        </ul>
      </Show>

      <div class="button-row pipeline-actions">
        <Show when={onHold() ? r().canResume : r().canHold}>
          <button
            type="button"
            class="button button-sm"
            aria-label={`${onHold() ? "Resume" : "Hold"} ${r().title}`}
            aria-disabled={props.busy ? "true" : undefined}
            onClick={() => props.onHold(!onHold())}
          >
            {onHold() ? "Resume Gap" : "Hold Gap"}
          </button>
        </Show>
        <button type="button" class="button button-sm button-ghost" aria-expanded={timelineOpen()} aria-controls={timelineId} onClick={() => setTimelineOpen(!timelineOpen())}>
          Timeline
        </button>
      </div>
      <Show when={timelineOpen()}>
        <GapTimeline id={timelineId} orgId={props.orgId} projectId={props.projectId} row={r()} now={props.now} />
      </Show>
    </li>
  );
}

const GATHERING_WORD: Record<string, string> = { open: "Open", "needs-you": "Needs you", done: "Done", closed: "Closed" };
const gatheringState = (g: PipelineRow["gatherings"][number]) =>
  g.state === "open" && g.holder ? `With ${g.holder}` : (GATHERING_WORD[g.state] ?? g.state);
const BRANCH_WORD: Record<string, string> = { "no-commits": "No commits yet", unmerged: "Not merged", merged: "Merged", "new-since-merge": "New commits since merge" };
const buildState = (b: PipelineRow["builds"][number]) =>
  b.turn === "working" ? "Working" : b.turn === "failed" ? "Last turn failed" : b.branch ? (BRANCH_WORD[b.branch] ?? b.branch) : "Idle";

/** A session's link when its file is on this host; its words alone when it isn't. */
function LinkOrText(props: { path?: string; class: string; children: import("solid-js").JSX.Element }) {
  return (
    <Show when={props.path} fallback={<span class={`${props.class} pipeline-link-away`} title="On another host">{props.children}</span>}>
      {(p) => (
        <a class={props.class} href={`#/s/${encodeURIComponent(p())}`}>
          {props.children}
        </a>
      )}
    </Show>
  );
}

/** Bring a decision's row on the Decisions card into view and focus it. */
function showDecision(id: string) {
  const el = document.getElementById(`decision-${id}`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus({ preventScroll: true });
}

/** One gap's timeline from the transition log, newest first; read again when the gap moves. */
function GapTimeline(props: { id: string; orgId: string; projectId: string; row: Row; now: number }) {
  const [data, { refetch }] = createResource(() => getGapTimeline(props.orgId, props.projectId, props.row.itemId));
  createEffect(on(() => `${props.row.phase}|${props.row.since}|${props.row.gatherings.length}|${props.row.builds.length}|${props.row.decisions.length}`, () => void refetch(), { defer: true }));
  const rows = () => timelineOrder(data()?.rows ?? []);
  return (
    <div class="pipeline-timeline" id={props.id}>
      <Show when={data.error}>{(e) => <p class="field-error">{errText(e())}</p>}</Show>
      <Show when={data()}>
        <Show when={rows().length} fallback={<p class="orgs-empty">Nothing has moved yet.</p>}>
          <ol class="pipeline-timeline-list">
            <For each={rows()}>{(t) => <TimelineItem row={t} now={props.now} />}</For>
          </ol>
        </Show>
      </Show>
    </div>
  );
}

function TimelineItem(props: { row: TimelineRow; now: number }) {
  const t = () => props.row;
  return (
    <li class="pipeline-timeline-row" classList={{ "pipeline-timeline-refused": !!t().refused }}>
      <span class="pipeline-timeline-when orgs-mono" title={stampTime(t().at)}>
        {logStamp(t().at, props.now)}
      </span>
      <span class="pipeline-timeline-main">
        <span class="pipeline-timeline-line">{t().line}</span>
        <span class="pipeline-timeline-meta">
          {byWord(t().by, t().via)}
          <Show when={moveLine(t())}>{(m) => <> · {m()}</>}</Show>
        </span>
        <Show when={t().reason}>{(why) => <span class="pipeline-timeline-meta">Reason: {why()}</span>}</Show>
        <Show when={t().refused}>{(why) => <span class="pipeline-timeline-refusal">Refused: {why()}</span>}</Show>
      </span>
    </li>
  );
}
