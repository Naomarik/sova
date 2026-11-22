import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { restartCount, type MergeEntry, type MergeQueueView, type MergeRun, type RunStep } from "../../../shared/merge-queue";
import type { MergeFlakyTest, MergeHistorySlim, MergeQueueHealth } from "../../../shared/merge-queue-health";
import { fixFlakyTest, getFlakyTests, getMergeEvents, getMergeHistory, runMergeVerb, startCleanRun } from "../../lib/api";
import { duration, relativeTime } from "../../lib/format";
import { clock, sentence, short, tildeIn } from "../../lib/merge-queue";
import { mergeChanged, noteMergeChanged, readRun, refusal } from "../../lib/merge-queue-client";
import { createRunRead } from "../../lib/merge-run";
import { BY_WORD, eventState, eventTitle, ownReviewOf, planRows, runChip, scanOf, stepState, threadWaitOf, type QueueEvent } from "../../lib/pipeline";
import { mergeRunHref, pipelineHref, projectSessionHref } from "../../lib/projects-route";
import { announce, home, toast } from "../../lib/ui-state";
import { chatHref, type ChatOf } from "../MergeQueueTab";
import { Icon } from "../ui";
import { SearchField } from "../form";
import { Mark, Sheet, Timeline, ToneChip, type TimelineItem } from "./PipelineParts";

const RUN_POLL_MS = 3000;
const HISTORY_PAGE = 20;
/** A number on the health summary needs at least this many runs behind it. */
const ENOUGH = 3;

type Filter = "all" | "queue" | "landed" | "back";

/** One row of the Runs list: a run in flight, a branch in line, one handed back, or a finished one from the history. */
interface RunRow {
  key: string;
  branch: string;
  run?: string;
  entry: string;
  session?: string;
  chip: { label: string; tone: "accent" | "success" | "warn" | "error" | "neutral" | "info"; live?: boolean };
  filter: Exclude<Filter, "all">;
  meta: string;
  at?: string;
  restarts: number;
}

const SENT_WORD: Record<string, string> = { drafts: "spec drafts", checks: "a failing check", conflict: "a conflict", user: "your decision", host: "the host", review: "a review finding" };

function liveRows(v: MergeQueueView): RunRow[] {
  const rows: RunRow[] = [];
  const cur = v.current;
  for (const e of v.checking) {
    const running = cur && cur.entry === e.id;
    rows.push({ key: e.id, branch: e.branch, ...(e.run ? { run: e.run } : {}), entry: e.id, ...(e.session ? { session: e.session } : {}), chip: running ? { label: "Landing", tone: "accent", live: true } : { label: "Held", tone: "warn" }, filter: "queue", meta: running ? `running ${cur.startedAt ? clock(Date.now() - Date.parse(cur.startedAt)) : ""}` : (e.reason ?? "tested, held"), at: e.updatedAt, restarts: restartCount(e) });
  }
  for (const e of v.waiting) rows.push({ key: e.id, branch: e.branch, ...(e.run ? { run: e.run } : {}), entry: e.id, ...(e.session ? { session: e.session } : {}), chip: { label: "Waiting", tone: "neutral" }, filter: "queue", meta: `position ${e.position ?? "?"}${e.reason ? ` · ${e.reason}` : ""}`, at: e.createdAt, restarts: restartCount(e) });
  for (const e of v.needsYou) rows.push({ key: e.id, branch: e.branch, ...(e.run ? { run: e.run } : {}), entry: e.id, ...(e.session ? { session: e.session } : {}), chip: { label: "Waits for you", tone: "warn" }, filter: "queue", meta: e.reason ?? "waits for your decision", at: e.updatedAt, restarts: restartCount(e) });
  for (const e of v.needsFix.filter((x) => !x.settled)) rows.push({ key: e.id, branch: e.branch, ...(e.run ? { run: e.run } : {}), entry: e.id, ...(e.session ? { session: e.session } : {}), chip: { label: "Sent back", tone: "warn" }, filter: "back", meta: e.sentBackFor ? `sent back for ${SENT_WORD[e.sentBackFor] ?? e.sentBackFor}` : (e.reason ?? "sent back"), at: e.updatedAt, restarts: restartCount(e) });
  return rows;
}

function historyRow(h: MergeHistorySlim): RunRow {
  const landed = h.state === "landed" || h.state === "pushed" || !!h.landedAt;
  const chip = landed ? { label: "Landed", tone: "success" as const } : h.verdict ? runChip(h.verdict) : { label: h.state ?? "Finished", tone: "neutral" as const };
  const back = h.sentBack?.length ? ` · sent back ${h.sentBack.length}×` : "";
  return {
    key: `h:${h.id}`,
    branch: h.branch,
    ...(h.run ? { run: h.run } : {}),
    entry: h.id,
    ...(h.session ? { session: h.session } : {}),
    chip,
    filter: landed ? "landed" : "back",
    meta: `${h.runs} ${h.runs === 1 ? "run" : "runs"}${h.timeToLandMs ? ` · ${duration(h.timeToLandMs)} to land` : ""}${back}`,
    at: h.finalAt,
    restarts: 0,
  };
}

/** The view's own landed rows, until the history read answers (or when it can't). */
const recentRows = (v: MergeQueueView): RunRow[] =>
  v.recent.map((l) => ({ key: `h:${l.entry.id}`, branch: l.entry.branch, ...(l.run ? { run: l.run.id } : l.entry.run ? { run: l.entry.run } : {}), entry: l.entry.id, ...(l.entry.session ? { session: l.entry.session } : {}), chip: { label: "Landed", tone: "success" }, filter: "landed", meta: `${l.entry.runs.length} ${l.entry.runs.length === 1 ? "run" : "runs"}`, at: l.entry.landed?.at ?? l.entry.updatedAt, restarts: restartCount(l.entry) }));

/**
 * The Runs view: the queue now, the health summary over the last 30 days, every run (in line, landed, sent back) with
 * a search by branch and Show Older through the whole history, and the open run's plan beside what it did.
 */
export function RunsView(props: { projectId: string; view: MergeQueueView; item?: string; wide: boolean; health?: MergeQueueHealth; chatOf?: ChatOf }) {
  const [filter, setFilter] = createSignal<Filter>("all");
  const [search, setSearch] = createSignal("");
  const [pages, setPages] = createSignal<MergeHistorySlim[]>([]);
  const [next, setNext] = createSignal<string | undefined>();
  const [historyOk, setHistoryOk] = createSignal<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const readFirst = async () => {
    try {
      const p = await getMergeHistory(props.projectId, { limit: HISTORY_PAGE, ...(search().trim() ? { branch: search().trim() } : {}) });
      setPages(p.rows);
      setNext(p.next);
      setHistoryOk(true);
    } catch {
      setHistoryOk(false);
    }
  };
  createEffect(on(search, () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void readFirst(), 250);
  }));
  createEffect(on(mergeChanged, () => void readFirst(), { defer: true }));
  const older = async () => {
    if (!next()) return;
    setLoadingOlder(true);
    try {
      const p = await getMergeHistory(props.projectId, { before: next(), limit: HISTORY_PAGE, ...(search().trim() ? { branch: search().trim() } : {}) });
      setPages([...pages(), ...p.rows]);
      setNext(p.next);
      announce(`${p.rows.length} older runs shown.`);
    } finally {
      setLoadingOlder(false);
    }
  };
  const rows = createMemo((): RunRow[] => {
    const q = search().trim().toLowerCase();
    const live = liveRows(props.view).filter((r) => !q || r.branch.toLowerCase().includes(q));
    const liveIds = new Set(live.map((r) => r.entry));
    const done = historyOk() ? pages().map(historyRow) : recentRows(props.view).filter((r) => !q || r.branch.toLowerCase().includes(q));
    return [...live, ...done.filter((r) => !liveIds.has(r.entry))];
  });
  const shown = () => rows().filter((r) => filter() === "all" || r.filter === filter());
  const count = (f: Filter) => (f === "all" ? rows().length : rows().filter((r) => r.filter === f).length);
  const selected = createMemo(() => {
    const it = props.item;
    const rs = rows();
    return (it ? rs.find((r) => r.run === it || r.entry === it || r.key === it) : undefined) ?? (props.wide ? rs[0] : undefined);
  });
  const href = (r: RunRow) => pipelineHref(props.projectId, "queue", "runs", r.run ?? r.entry);
  return (
    <>
      <QueueStrip projectId={props.projectId} view={props.view} />
      <HealthSummary health={props.health} />
      <div class="pl-split">
        <div class="pl-master">
          <div>
            <h2 class="pl-section-title">Runs</h2>
            <p class="pl-section-sub">One row per branch: in line, landed, or sent back. Search reaches the whole history.</p>
          </div>
          <div class="pl-filterbar" role="group" aria-label="Filter runs">
            <For each={["all", "queue", "landed", "back"] as Filter[]}>
              {(f) => (
                <button type="button" class="pl-filter" aria-pressed={filter() === f ? "true" : "false"} onClick={() => setFilter(f)}>
                  {{ all: "All", queue: "In queue", landed: "Landed", back: "Sent back" }[f]} <span class="pl-fc">{count(f)}</span>
                </button>
              )}
            </For>
            <SearchField class="pl-search" label="Search by branch" placeholder="Search by branch" spellcheck={false} value={search()} onInput={setSearch} />
          </div>
          <Show when={shown().length} fallback={<p class="pl-hint">{search() ? `No branch matching “${search()}”.` : "Nothing here yet. A branch shows here once you land it."}</p>}>
            <ul class="pl-rows" aria-label="Runs">
              <For each={shown()}>
                {(r) => (
                  <li>
                    <a class="pl-row" href={href(r)} aria-current={selected()?.key === r.key ? "true" : undefined} data-branch={r.branch}>
                      <span class="pl-row-top">
                        <span class="pl-row-name">{r.branch}</span>
                        <ToneChip tone={r.chip.tone} live={r.chip.live}>
                          {r.chip.label}
                        </ToneChip>
                      </span>
                      <span class="pl-row-meta">
                        <span>{r.meta}</span>
                        <Show when={r.restarts > 0}>
                          <span aria-hidden="true">·</span>
                          <span>restarted {r.restarts}×</span>
                        </Show>
                        <Show when={r.at}>
                          <span aria-hidden="true">·</span>
                          <span>{relativeTime(r.at!)}</span>
                        </Show>
                      </span>
                    </a>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={historyOk() && next()}>
            <button type="button" class="button button-sm pl-more" disabled={loadingOlder()} onClick={() => void older()}>
              {loadingOlder() ? "Reading Older Runs" : "Show Older"}
            </button>
          </Show>
          <Show when={historyOk() === false}>
            <p class="pl-hint">The full history isn’t readable here yet: the newest {props.view.recent.length} landings show.</p>
          </Show>
          <FlakyList projectId={props.projectId} view={props.view} />
        </div>
        <Show when={props.wide && selected()}>
          {(r) => (
            <div class="pl-detail">
              <RunDetail projectId={props.projectId} view={props.view} row={r()} chatOf={props.chatOf} />
            </div>
          )}
        </Show>
      </div>
      <Show when={!props.wide && props.item ? selected() : undefined}>
        {(r) => (
          <Sheet title={r().branch} sub="Run" onClose={() => (location.hash = pipelineHref(props.projectId, "queue", "runs"))}>
            <RunDetail projectId={props.projectId} view={props.view} row={r()} chatOf={props.chatOf} />
          </Sheet>
        )}
      </Show>
    </>
  );
}

/** In the queue: the run landing now and the line behind it, with Clean Run on the head of the queue. */
function QueueStrip(props: { projectId: string; view: MergeQueueView }) {
  const v = () => props.view;
  const [busy, setBusy] = createSignal(false);
  const clean = async () => {
    setBusy(true);
    try {
      await startCleanRun(props.projectId);
      noteMergeChanged();
      toast("The next run starts from an empty merge copy.");
      announce("Clean Run asked for.");
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const line = () => [...v().checking, ...v().waiting];
  return (
    <section class="pl-strip" aria-labelledby="pl-queue-title">
      <div class="pl-strip-head">
        <h3 id="pl-queue-title">In the queue</h3>
        <span class="chip chip-count">{line().length}</span>
        <Show when={v().state === "paused"}>
          <ToneChip tone="warn">Paused</ToneChip>
        </Show>
        <span class="pl-spacer" />
        <Show when={v().clean?.next} fallback={<button type="button" class="button button-sm" disabled={busy()} onClick={() => void clean()} title="The next run starts from an empty merge copy: nothing installed or built is reused.">Clean Run</button>}>
          <span class="text-caption pl-muted">Next run starts clean</span>
        </Show>
      </div>
      <Show when={v().paused}>
        {(p) => (
          <p class="pl-stage-warn">
            {p().self ? "The queue paused itself: " : "Paused: "}
            {p().why}
          </p>
        )}
      </Show>
      <Show
        when={line().length}
        fallback={
          <div class="empty">
            <p class="empty-title">{v().recent.length ? `${v().recent.length} recent landings` : "Nothing landed yet"}</p>
            <p class="empty-body">Nothing in the queue right now. A branch joins here when you press Land.</p>
          </div>
        }
      >
        <ul class="pl-strip-rows">
          <For each={line()}>
            {(e) => <StripRow projectId={props.projectId} view={v()} e={e} />}
          </For>
        </ul>
      </Show>
      <div class="pl-strip-foot">
        <span>
          <Show when={v().clean?.dueAt} fallback={v().clean?.last ? `Last clean run ${relativeTime(v().clean!.last!.at)}` : "No clean run yet"}>
            {Date.parse(v().clean!.dueAt!) <= Date.now() ? "The next run is the weekly clean run" : `Weekly clean run due ${relativeTime(v().clean!.dueAt!)}`}
          </Show>
        </span>
        <Show when={v().recent[0]?.entry.landed}>
          <span class="pl-mono">last landed {relativeTime(v().recent[0]!.entry.landed!.at)}</span>
        </Show>
      </div>
    </section>
  );
}

function StripRow(props: { projectId: string; view: MergeQueueView; e: MergeEntry }) {
  const running = () => props.view.current?.entry === props.e.id;
  const step = () => props.view.current?.steps.find((s) => s.result === "running");
  const n = () => restartCount(props.e);
  return (
    <li class="pl-strip-row">
      <Show when={running()} fallback={<span class="pl-strip-pos">{props.e.position ?? "–"}</span>}>
        <span class="pl-live-dot" aria-hidden="true" />
      </Show>
      <div class="pl-strip-main">
        <a class="pl-row-name" href={pipelineHref(props.projectId, "queue", "runs", props.e.run ?? props.e.id)}>
          {props.e.branch}
        </a>
        <span class="pl-strip-meta">
          <span>{running() ? `landing · ${step()?.label ?? "starting"}` : props.e.state === "checking" ? "tested, held" : `waiting · ${props.e.reason ?? `position ${props.e.position}`}`}</span>
          <Show when={n() > 0}>
            <span>restarted {n()}×</span>
          </Show>
          <Show when={threadWaitOf(props.e)}>
            {(w) => <span>waited {duration(Date.now() - Date.parse(w().since))} on the merge thread</span>}
          </Show>
        </span>
      </div>
      <span class="pl-strip-time">{running() && props.view.current?.startedAt ? clock(Date.now() - Date.parse(props.view.current.startedAt)) : relativeTime(props.e.createdAt)}</span>
    </li>
  );
}

/** The health summary over the window: each number only when enough runs stand behind it. */
export function HealthSummary(props: { health?: MergeQueueHealth }) {
  return (
    <Show when={props.health}>
      {(h) => (
        <section class="pl-strip" aria-labelledby="pl-health-title">
          <div class="pl-strip-head">
            <h3 id="pl-health-title">Last 30 days</h3>
            <span class="pl-spacer" />
            <span class="text-caption pl-muted">
              {h().landed} landed · {h().finished} finished
            </span>
          </div>
          <dl class="pl-health">
            <div>
              <dt>Time to land</dt>
              <dd>
                <Show when={h().timeToLand.medianMs != null && h().landed >= ENOUGH} fallback={<span class="pl-muted">Too few landings</span>}>
                  <span class="pl-figure">{duration(h().timeToLand.medianMs!)}</span> usual
                </Show>
              </dd>
            </div>
            <div>
              <dt>Pass rate</dt>
              <dd>
                <Show when={h().passRate.rate != null && h().passRate.runs >= ENOUGH} fallback={<span class="pl-muted">Too few runs</span>}>
                  <span class="pl-figure">{Math.round(h().passRate.rate! * 100)}%</span> · {h().passRate.passed} of {h().passRate.runs}
                </Show>
              </dd>
            </div>
            <div>
              <dt>Slowest checks</dt>
              <dd>
                <Show when={h().slowestChecks.filter((c) => c.runs >= ENOUGH).length} fallback={<span class="pl-muted">Too few runs</span>}>
                  {h()
                    .slowestChecks.filter((c) => c.runs >= ENOUGH)
                    .slice(0, 3)
                    .map((c) => `${c.label} ${duration(c.medianMs)}`)
                    .join(" · ")}
                </Show>
              </dd>
            </div>
            <div>
              <dt>Flaky tests</dt>
              <dd>
                <span class="pl-figure">{h().flaky.length}</span> {h().flaky.length === 1 ? "test" : "tests"}
              </dd>
            </div>
            <div>
              <dt>Usually sent back for</dt>
              <dd>
                <Show when={h().sendBacks.length} fallback={<span class="pl-muted">Nothing sent back</span>}>
                  {h()
                    .sendBacks.slice(0, 2)
                    .map((s) => `${SENT_WORD[s.why] ?? s.why} (${s.count})`)
                    .join(" · ")}
                </Show>
              </dd>
            </div>
          </dl>
        </section>
      )}
    </Show>
  );
}

/** The flaky tests the queue counted across landings, most often first, each with Fix in New Chat. */
function FlakyList(props: { projectId: string; view: MergeQueueView }) {
  const [all, { refetch }] = createResource(() => getFlakyTests(props.projectId).catch(() => null));
  const tests = (): MergeFlakyTest[] => all()?.tests ?? props.view.flaky ?? [];
  const [busy, setBusy] = createSignal<string | null>(null);
  const fix = async (t: MergeFlakyTest) => {
    setBusy(t.key);
    try {
      const r = await fixFlakyTest(props.projectId, t.key);
      toast(`A new chat is fixing ${t.name ?? t.file ?? t.checkLabel}.`);
      refetch();
      location.hash = projectSessionHref(props.projectId, r.path);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section class="pl-strip" aria-labelledby="pl-flaky-title">
      <div class="pl-strip-head">
        <h3 id="pl-flaky-title">Flaky tests</h3>
        <span class="chip chip-count">{tests().length}</span>
      </div>
      <Show when={tests().length} fallback={<p class="pl-hint" style={{ padding: "var(--space-3) var(--space-4)" }}>No test has failed and then passed on its rerun yet.</p>}>
        <ul class="pl-rows" style={{ border: "0", "border-radius": "0", "box-shadow": "none" }}>
          <For each={tests()}>
            {(t) => (
              <li class="pl-strip-row" style={{ "border-bottom": "var(--stroke-thin) solid var(--color-border)" }}>
                <div class="pl-strip-main">
                  <span class="pl-row-name">{t.name ?? t.file ?? t.checkLabel}</span>
                  <span class="pl-strip-meta">
                    <span>{t.checkLabel}</span>
                    <Show when={t.file && t.name}>
                      <span class="pl-mono">{t.file}</span>
                    </Show>
                    <span>
                      {t.count} {t.count === 1 ? "time" : "times"} · last {relativeTime(t.lastAt)}
                    </span>
                  </span>
                </div>
                <Show when={t.fix} fallback={<button type="button" class="button button-sm" disabled={busy() === t.key} onClick={() => void fix(t)}>Fix in New Chat</button>}>
                  {(f) => (
                    <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, f().path)}>
                      Open Fix Chat
                    </a>
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

/** One run: its plan beside what it did, what it ran with, and every recorded change of its branch's entry. */
function RunDetail(props: { projectId: string; view: MergeQueueView; row: RunRow; chatOf?: ChatOf }) {
  const read = createRunRead(() => props.row.run ?? "", (id) => (id ? readRun(id) : Promise.reject(new Error("Nothing has run yet."))), RUN_POLL_MS);
  createEffect(on(mergeChanged, () => props.row.run && read.refetch(), { defer: true }));
  const run = () => (props.row.run ? read.run() : undefined);
  const [events] = createResource(
    () => [props.row.entry, props.view.at] as const,
    ([entry]) => getMergeEvents(props.projectId, { entry, limit: 100 }).catch(() => null),
  );
  const entry = createMemo(() => {
    const v = props.view;
    return [...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix].find((e) => e.id === props.row.entry) ?? v.recent.find((l) => l.entry.id === props.row.entry)?.entry;
  });
  const attempt = () => {
    const e = entry();
    const r = run();
    return e && r ? e.runs.indexOf(r.id) + 1 : 0;
  };
  const plan = createMemo(() => (run() ? planRows(run()!) : null));
  const counts = () => {
    const rows = plan()?.rows ?? [];
    return { inn: rows.filter((r) => !r.skip).length, skip: rows.filter((r) => r.skip).length };
  };
  const timeline = (): TimelineItem[] =>
    (run()?.steps ?? []).map((s) => ({
      key: s.id,
      state: stepState(s),
      title: s.label,
      meta: <>{stepMeta(s)}</>,
      body: s.kind === "scan" && scanOf(s) ? <ScanBody projectId={props.projectId} view={props.view} step={s} entry={props.row.entry} /> : s.detail ? <>{sentence(tildeIn(s.detail, home()))}</> : s.why ? <>{sentence(s.why)}</> : undefined,
    }));
  const activity = (): TimelineItem[] =>
    (events()?.events ?? [])
      .filter((e) => e.kind !== "step-ended")
      .map((e: QueueEvent) => ({
        key: String(e.seq),
        state: eventState(e),
        title: eventTitle(e),
        meta: (
          <>
            {new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} · {BY_WORD[e.by]}
            {e.step ? ` · ${e.step}` : ""}
          </>
        ),
        body: <>{e.why}</>,
        ...(e.kind === "ruled" && e.read.length ? { read: e.read } : {}),
      }));
  const failed = () => run()?.verdict === "failed" || run()?.verdict === "machine" || run()?.verdict === "conflict";
  const [cleaning, setCleaning] = createSignal(false);
  const cleanThis = async () => {
    setCleaning(true);
    try {
      await startCleanRun(props.projectId, props.row.entry);
      noteMergeChanged();
      toast(`${props.row.branch} goes back in line and runs from an empty merge copy.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };
  return (
    <>
      <header class="pl-detail-head">
        <div class="cluster">
          <ToneChip tone={props.row.chip.tone} live={props.row.chip.live}>
            {props.row.chip.label}
          </ToneChip>
          <span class="pl-kicker">
            {attempt() ? `Attempt ${attempt()}` : "Not started"}
            {props.row.restarts > 0 ? ` · restarted ${props.row.restarts}×` : ""}
            {entry()?.position ? ` · position ${entry()!.position}` : ""}
          </span>
        </div>
        <h3 class="pl-detail-title">{props.row.branch}</h3>
        <p class="pl-detail-meta">
          <Show when={props.row.session}>
            <a href={chatHref(props.projectId, props.row.session!, props.chatOf)}>{props.chatOf?.(props.row.session!)?.title ?? "Its chat"}</a>
            {" · "}
          </Show>
          <Show when={run()} fallback={props.row.at ? `in line since ${relativeTime(props.row.at)}` : ""}>
            {(r) => (
              <>
                <span class="pl-mono">{short(r().commit)}</span> onto <span class="pl-mono">{short(r().base)}</span> · started {relativeTime(r().startedAt)}
                {r().endedAt ? ` · took ${clock(Date.parse(r().endedAt!) - Date.parse(r().startedAt))}` : ""}
              </>
            )}
          </Show>
        </p>
        <Show when={run()?.why ?? entry()?.reason}>{(w) => <p class="pl-detail-lead">{sentence(w())}</p>}</Show>
        <div class="cluster">
          <Show when={props.row.run}>
            <a class="button button-sm" href={mergeRunHref(props.projectId, props.row.run!)}>
              Open Logs
            </a>
          </Show>
          <Show when={failed() && entry() && entry()!.state !== "landed"}>
            <button type="button" class="button button-sm" disabled={cleaning()} onClick={() => void cleanThis()} title="Put it back in line and run it from an empty merge copy.">
              Clean Run
            </button>
          </Show>
        </div>
      </header>
      <Show when={run()?.rules?.changed?.length || (run() && ownReviewOf(run()!).length)}>
        <p class="pl-factbox is-info">
          <Show when={run()?.rules?.changed?.length}>
            <b>This branch changed its own folder rules.</b> {run()!.rules!.changed!.join("; ")}
            {run()!.rules!.more ? ` and ${run()!.rules!.more} more` : ""}.{" "}
          </Show>
          <Show when={run() && ownReviewOf(run()!).length}>
            <b>This branch changed its own review.</b> {ownReviewOf(run()!).map((c) => c.path).join(", ")}.
          </Show>
        </p>
      </Show>
      <Show
        when={run()}
        fallback={
          <div class="pl-card">
            <div class="pl-card-body">
              <div class="empty">
                <span class="empty-mark" aria-hidden="true">
                  <Icon name="clock" />
                </span>
                <p class="empty-title">Nothing has run yet</p>
                <p class="empty-body">It starts when the queue reaches it. Its plan is worked out then, from its commit and the newest main branch.</p>
              </div>
            </div>
          </div>
        }
      >
        <div class="pl-cols">
          <section class="pl-card" aria-labelledby="pl-plan-title">
            <div class="pl-card-head">
              <h3 id="pl-plan-title">The plan</h3>
              <span class="chip chip-count">
                {counts().inn} in · {counts().skip} skipped
              </span>
            </div>
            <div class="pl-card-body">
              <ul class="pl-plan">
                <For each={plan()?.rows}>
                  {(p) => (
                    <li class="pl-plan-row" classList={{ "is-skip": !!p.skip }}>
                      <Mark state={p.skip ? "skipped" : p.maybe ? "waiting" : "done"} late={p.late} />
                      <span>
                        <span class="pl-plan-name">
                          {p.name}
                          {p.late ? " · added after the start" : p.maybe ? " · only if needed" : ""}
                        </span>
                        <Show when={p.note}>
                          <span class="pl-plan-note">{p.note}</span>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={plan()?.fingerprint} fallback={<p class="pl-factbox">This run started before plans were saved: the plan above is read from its steps.</p>}>
                <p class="pl-factbox">
                  Plan <span class="pl-mono">{plan()!.fingerprint!.slice(0, 12)}</span>
                  {plan()!.sameAs ? <> · the same inputs as run <span class="pl-mono">{plan()!.sameAs}</span>, so the same plan</> : ""}
                  {plan()!.grew ? " · grew with a late pick" : ""}.
                </p>
              </Show>
            </div>
          </section>
          <section class="pl-card" aria-labelledby="pl-did-title">
            <div class="pl-card-head">
              <h3 id="pl-did-title">What the run did</h3>
              <span class="pl-mono pl-muted">{run()!.verdict === "running" ? "running" : run()!.verdict}</span>
            </div>
            <div class="pl-card-body">
              <Timeline items={timeline()} label="Steps" />
              <RanWith run={run()!} />
            </div>
          </section>
        </div>
      </Show>
      <section class="pl-card" aria-labelledby="pl-activity-title">
        <div class="pl-card-head">
          <h3 id="pl-activity-title">Activity</h3>
          <span class="pl-muted text-caption">every change to this branch in the queue, newest first</span>
        </div>
        <div class="pl-card-body">
          <Show when={activity().length} fallback={<p class="pl-hint">{events() === null ? "The activity record isn’t readable here yet." : "Nothing recorded yet."}</p>}>
            <Timeline items={activity()} label="Activity" />
          </Show>
        </div>
      </section>
    </>
  );
}

function stepMeta(s: RunStep): string {
  const t = s.startedAt ? new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
  const took = s.result === "running" && s.startedAt ? clock(Date.now() - Date.parse(s.startedAt)) : s.ms ? clock(s.ms) : "";
  const c = s.counts && (s.counts.passed || s.counts.failed) ? ` · ${s.counts.passed ?? 0} passed${s.counts.failed ? `, ${s.counts.failed} failed` : ""}` : "";
  const reused = s.reused ? ` · ${s.reused} reused` : "";
  return [t, took].filter(Boolean).join(" · ") + c + reused || (s.result === "pending" ? "not started" : s.result === "skipped" ? "skipped" : "");
}

/** What a run ran with: the copy reused or fresh, the setup steps reused, the tools and settings in force. */
function RanWith(props: { run: MergeRun }) {
  const w = () => props.run.ranWith;
  return (
    <Show when={w()} fallback={<p class="pl-factbox">This run didn’t record what it ran with.</p>}>
      {(r) => (
        <details class="pl-factbox">
          <summary>
            <b>Ran with</b> {r().copy === "fresh" ? `an empty merge copy${r().clean ? ` (${r().clean === "operator" ? "Clean Run" : r().clean === "weekly" ? "the weekly clean run" : "a new copy"})` : ""}` : "the merge copy reused"}
            {r().setup.some((s) => s.reused) ? ` · ${r().setup.filter((s) => s.reused).length} setup steps unchanged` : ""}
            {r().checksReused?.length ? ` · passes reused in ${r().checksReused!.length} checks` : ""}
          </summary>
          <dl class="pl-facts">
            <For each={r().tools}>
              {(t) => (
                <div>
                  <dt>{t.name}</dt>
                  <dd class="pl-mono">{t.version ?? "didn’t say"}</dd>
                </div>
              )}
            </For>
            <For each={r().settings}>
              {(s) => (
                <div>
                  <dt>{s.name}</dt>
                  <dd>{s.value}</dd>
                </div>
              )}
            </For>
          </dl>
        </details>
      )}
    </Show>
  );
}

/** The Private names and secrets step: where each hit is (never the matched text) and the user's three answers. */
function ScanBody(props: { projectId: string; view: MergeQueueView; step: RunStep; entry: string }) {
  const s = () => scanOf(props.step)!;
  const [busy, setBusy] = createSignal(false);
  const answer = async (a: "allow" | "send-back" | "ask-thread") => {
    setBusy(true);
    try {
      const r = await runMergeVerb(null, "merge.answer", { entry: props.entry, answer: a, ...(a === "allow" ? { matches: (s().hits ?? []).map((h) => h.key) } : {}) });
      noteMergeChanged();
      const why = refusal(r);
      if (why) toast(why);
      else {
        toast(a === "allow" ? "Marked fine for this project. The push goes on." : a === "send-back" ? "Sent back: its chat removes them." : "The merge thread has the places. Open it to see the names.");
        if (a === "ask-thread" && props.view.thread?.path) location.hash = projectSessionHref(props.projectId, props.view.thread.path);
      }
    } finally {
      setBusy(false);
    }
  };
  const none = async () => {
    setBusy(true);
    try {
      const r = await runMergeVerb(props.view.root, "merge.names", { action: "none" });
      noteMergeChanged();
      toast(refusal(r) ?? "Answered: no private names. The push goes on.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {s().state === "clean" ? `Nothing found in ${s().commits ?? "the"} ${s().commits === 1 ? "commit" : "commits"}.${s().allowed ? ` ${s().allowed} allowed matches skipped.` : ""}` : s().state === "unanswered" ? "Secrets were scanned. Private names aren’t answered yet, so the push waits for you." : s().state === "unreadable" ? `The scan couldn’t look${s().why ? `: ${s().why}` : ""}. Nothing is pushed until one passes.` : `${s().hits?.length ?? 0} found. Nothing was pushed.`}
      <Show when={s().hits?.length}>
        <ul class="pl-tl-read" aria-label="Where">
          <For each={s().hits}>
            {(h) => (
              <li>
                {h.what} · {h.where}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={s().state === "hits"}>
        <span class="pl-tl-actions">
          <button type="button" class="button button-sm" disabled={busy()} onClick={() => void answer("ask-thread")}>
            Ask the Merge Thread
          </button>
          <button type="button" class="button button-sm" disabled={busy()} onClick={() => void answer("send-back")}>
            Send Back
          </button>
          <button type="button" class="button button-sm" disabled={busy()} onClick={() => void answer("allow")} title="Mark these matches fine for this project.">
            Allow
          </button>
        </span>
      </Show>
      <Show when={s().state === "unanswered"}>
        <span class="pl-tl-actions">
          <button type="button" class="button button-sm" disabled={busy()} onClick={() => void none()}>
            No Private Names
          </button>
        </span>
      </Show>
    </>
  );
}
