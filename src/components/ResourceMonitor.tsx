import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { MonitorHistory, MonitorPoint, MonitorSnapshot } from "../../shared/protocol";
import { fetchMonitor, fetchMonitorHistory } from "../lib/api";
import { relativeTime } from "../lib/format";
import { sessionHrefOn } from "../lib/mesh";
import {
  bytes,
  CHART_SPAN_MS,
  appendHistory,
  chargedTo,
  chartModel,
  cpuText,
  degradedLine,
  type GroupRow,
  idleSummary,
  isHeuristic,
  liveRows,
  livePids,
  mergeHistory,
  meters,
  type MeterView,
  momentText,
  MONITOR_POLL_MS,
  nearestIndex,
  type ProcRow,
  rowsAt,
  samplerLine,
  scopeLine,
  statusText,
  type TabMemory,
  type TitleOf,
  type WorkerLabels,
  workerNamer,
  labelsWithTitles,
  withTitles,
  tabLine,
  transient,
  transientName,
  viaWords,
  type WorkerRow,
} from "../lib/monitor-view";
import { createPoll } from "../lib/poll";
import { Banner, Icon, trapFocus } from "./ui";
import "../monitor.css";

/**
 * The Resource Monitor (§app/resource-monitor): what the server's sessions, workers and their
 * processes cost in CPU and memory, now and over the last hour. Read-only; the server samples in
 * the background whether or not this is open, and this polls GET /api/monitor every 5 s only
 * while it exists (paused in a hidden tab). The history is fetched once in full, then as a delta
 * after each poll.
 */
export function ResourceMonitor(props: { onClose(): void; titleOf?: TitleOf }) {
  const [points, setPoints] = createSignal<MonitorPoint[]>([]);
  const [rawLabels, setLabels] = createSignal<MonitorHistory["groups"]>({});
  const [workerLabels, setWorkerLabels] = createSignal<WorkerLabels>({});
  /** Merge a history answer's worker names (group → id → name), when it carries them. */
  const takeWorkerLabels = (...hs: Array<MonitorHistory | null | undefined>) => {
    const add: WorkerLabels = {};
    for (const h of hs) {
      const w = (h as { workerLabels?: WorkerLabels } | null | undefined)?.workerLabels;
      if (w && typeof w === "object") for (const [g, ids] of Object.entries(w)) add[g] = { ...add[g], ...ids };
    }
    if (Object.keys(add).length) setWorkerLabels((cur) => {
      const next = { ...cur };
      for (const [g, ids] of Object.entries(add)) next[g] = { ...next[g], ...ids };
      return next;
    });
  };
  // Session names as the sidebar says them; the monitor's own labels are only a fallback.
  const labels = createMemo(() => (props.titleOf ? labelsWithTitles(rawLabels(), props.titleOf) : rawLabels()));
  /** The scrubbed moment; null = now. */
  const [pickedAt, setPickedAt] = createSignal<number | null>(null);
  const [tab, setTab] = createSignal<string | null>(null);

  let historyLoaded = false;
  const syncHistory = async (now: number) => {
    try {
      if (!historyLoaded) {
        const since = now - CHART_SPAN_MS;
        const [fine, coarse] = await Promise.all([fetchMonitorHistory(since, "5s"), fetchMonitorHistory(since, "30s").catch(() => null)]);
        setLabels({ ...(coarse?.groups ?? {}), ...fine.groups });
        takeWorkerLabels(coarse, fine);
        setPoints(mergeHistory(fine.points, coarse?.points ?? [], now));
        historyLoaded = true;
      } else {
        const held = points();
        const last = held.length ? held[held.length - 1]!.at : now - CHART_SPAN_MS;
        const delta = await fetchMonitorHistory(last + 1, "5s");
        setLabels((l) => ({ ...l, ...delta.groups }));
        takeWorkerLabels(delta);
        setPoints(appendHistory(held, delta.points, now));
      }
    } catch {
      // The chart keeps what it has; the snapshot's own error says the server is unreachable.
    }
  };

  const poll = createPoll(async () => {
    const snap = await fetchMonitor();
    await syncHistory(snap.at);
    const mem = (performance as unknown as { memory?: TabMemory }).memory;
    setTab(tabLine(mem));
    return snap;
  }, MONITOR_POLL_MS);

  const snap = createMemo((): MonitorSnapshot | undefined => {
    const s = poll.data();
    return s && props.titleOf ? withTitles(s, props.titleOf) : s;
  });
  const now = () => snap()?.at ?? Date.now();
  const picked = createMemo(() => {
    const at = pickedAt();
    if (at === null) return null;
    const i = nearestIndex(points(), at);
    return i < 0 ? null : points()[i]!;
  });
  const rows = createMemo((): GroupRow[] => {
    const p = picked();
    const s = snap();
    if (p) return rowsAt(p, labels(), s, workerLabels());
    return s ? liveRows(s) : [];
  });
  const nameOf = createMemo(() => workerNamer(snap(), workerLabels()));
  const transients = createMemo(() => {
    const s = snap();
    return s ? transient(points(), livePids(s)) : [];
  });

  const close = () => props.onClose();

  return (
    <Portal>
      <div class="scrim" onClick={close} />
      <div
        class="modal modal-wide monitor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitor-title"
        tabindex="-1"
        ref={(el) => {
          trapFocus(el);
          queueMicrotask(() => el.focus());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head monitor-head">
          <h2 class="modal-title" id="monitor-title">
            Resource monitor
          </h2>
          <Show when={snap()}>
            {(s) => (
              <span class="text-caption text-muted">
                {scopeLine(s())} · as of <span class="text-mono">{momentText(s().at)}</span>
              </span>
            )}
          </Show>
        </div>
        <div class="modal-body monitor-body">
          <Show when={poll.error()}>
            {(message) => <Banner tone="error" title="Couldn't read the monitor." body={`${message()}. We'll try again in a few seconds.`} />}
          </Show>
          <Show when={poll.pending()}>
            <p class="text-caption text-muted">Reading the latest sample…</p>
          </Show>
          <Show when={snap()}>
            {(s) => (
              <>
                <Show when={degradedLine(s())}>{(line) => <Banner tone="info" title={line()} />}</Show>
                <div class="monitor-meters">
                  <For each={meters(s())}>{(m) => <Meter m={m} />}</For>
                </div>
                <Show when={tab()}>{(line) => <p class="text-caption text-muted monitor-tab">{line()}</p>}</Show>
                <Show when={s().scope !== "none"}>
                  <Chart points={points()} labels={labels()} now={now()} picked={picked()} onPick={setPickedAt} />
                  <section class="monitor-section" aria-labelledby="monitor-table-title">
                    <div class="monitor-section-head">
                      <h3 class="monitor-section-title" id="monitor-table-title">
                        {picked() ? (
                          <>
                            At <span class="text-mono">{momentText(picked()!.at)}</span>
                          </>
                        ) : (
                          "Now, by session"
                        )}
                      </h3>
                      <Show when={picked()}>
                        <button type="button" class="button button-sm button-ghost" onClick={() => setPickedAt(null)}>
                          Back to Now
                        </button>
                      </Show>
                    </div>
                    <Show when={!picked() && idleSummary(s())}>{(line) => <p class="text-caption text-muted">{line()}</p>}</Show>
                    <MonitorTable rows={rows()} now={now()} live={!picked()} onOpen={close} />
                  </section>
                  <Show when={transients().length}>
                    <section class="monitor-section" aria-labelledby="monitor-transient-title">
                      <h3 class="monitor-section-title" id="monitor-transient-title">
                        Transient work in this window
                      </h3>
                      <p class="text-caption text-muted">Processes that were among a tick's busiest and aren't running now.</p>
                      <div class="monitor-table-wrap">
                        <table class="monitor-table">
                          <thead>
                            <tr>
                              <th scope="col">Process</th>
                              <th scope="col">Charged to</th>
                              <th scope="col" class="monitor-num">
                                Peak CPU
                              </th>
                              <th scope="col" class="monitor-num">
                                Last seen
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={transients()}>
                              {(t) => (
                                <tr>
                                  <td class="monitor-cmd text-mono">{transientName(t)}</td>
                                  <td>{chargedTo(t, labels(), nameOf())}</td>
                                  <td class="monitor-num">{cpuText(t.peakCpuPct)}</td>
                                  <td class="monitor-num">{relativeTime(t.lastAt, now())}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </Show>
                </Show>
                <Show when={s().notes.length}>
                  <section class="monitor-section" aria-labelledby="monitor-notes-title">
                    <h3 class="monitor-section-title" id="monitor-notes-title">
                      What this can't see
                    </h3>
                    <ul class="monitor-notes">
                      <For each={s().notes}>{(n) => <li>{n}</li>}</For>
                    </ul>
                  </section>
                </Show>
              </>
            )}
          </Show>
        </div>
        <div class="modal-foot">
          <Show when={snap()}>{(s) => <span class="monitor-cost">{samplerLine(s().sampler, s().totals.procCount)}</span>}</Show>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}

function Meter(props: { m: MeterView }) {
  return (
    <div class="meter" classList={{ "meter-ghost": !!props.m.ghost }}>
      <p class="meter-head">
        <span class="meter-label">{props.m.label}</span>
        <span class="meter-value">
          {props.m.value}
          <Show when={props.m.of}>
            <span class="meter-of">{props.m.of}</span>
          </Show>
        </span>
      </p>
      <Show when={props.m.pct !== null || props.m.ghost}>
        <div class="meter-track" aria-hidden="true">
          <span class="meter-fill" style={{ "--meter-pct": `${props.m.pct ?? 0}%` }} />
        </div>
      </Show>
      <Show when={props.m.context}>
        <p class="meter-context">{props.m.context}</p>
      </Show>
    </div>
  );
}

const CHART_W = 720;
const CHART_H = 120;

/**
 * The last hour as one inline SVG: CPU stacked by session (the heaviest few, the rest folded), and
 * memory as a dashed line. Pressing or dragging picks a moment and the table below shows it;
 * the arrow keys step through the ticks, Home and End jump to the ends.
 */
function Chart(props: { points: MonitorPoint[]; labels: MonitorHistory["groups"]; now: number; picked: MonitorPoint | null; onPick(at: number | null): void }) {
  const model = createMemo(() => chartModel(props.points, props.labels, { width: CHART_W, height: CHART_H, now: props.now }));
  const pickedIndex = () => (props.picked ? props.points.indexOf(props.picked) : -1);
  const at = (e: PointerEvent, svg: SVGSVGElement) => {
    const box = svg.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - box.left) / Math.max(1, box.width)));
    return model().t0 + f * (model().t1 - model().t0);
  };
  const step = (d: number) => {
    const pts = props.points;
    if (!pts.length) return;
    const i = pickedIndex();
    const next = i < 0 ? (d < 0 ? pts.length - 1 : -1) : i + d;
    if (next < 0 || next >= pts.length) return props.onPick(next >= pts.length ? null : pts[0]!.at);
    props.onPick(pts[next]!.at);
  };
  const shown = () => props.picked ?? props.points[props.points.length - 1];
  const readout = () => {
    const p = shown();
    if (!p) return "No samples yet in this window.";
    const mem = p.anonBytes ?? p.rssBytes;
    return `CPU ${cpuText(p.cpuPct)}${p.cpuPctMax ? ` (peak ${cpuText(p.cpuPctMax)})` : ""} · memory ${bytes(mem)} · load ${p.load1.toFixed(2)}`;
  };
  const crossX = () => {
    const i = pickedIndex();
    return i < 0 ? null : model().xs[i]!;
  };

  return (
    <section class="monitor-chart" aria-labelledby="monitor-chart-title">
      <div class="monitor-section-head">
        <h3 class="monitor-section-title" id="monitor-chart-title">
          Last hour
        </h3>
        <span class="text-caption text-muted">
          <Show when={props.picked} fallback="Now">
            <span class="text-mono">{momentText(props.picked!.at)}</span>
          </Show>
          {" · "}
          {readout()}
        </span>
      </div>
      <div class="monitor-plot">
        <span class="monitor-axis monitor-axis-top text-mono">{cpuText(model().cpuMax)} CPU</span>
        <Show when={model().memory.length}>
          <span class="monitor-axis monitor-axis-top-end text-mono">{bytes(model().memTop)} memory</span>
        </Show>
        <svg
          class="monitor-svg"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="slider"
          tabindex="0"
          aria-label="Moment in the last hour"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, props.points.length - 1)}
          aria-valuenow={pickedIndex() < 0 ? Math.max(0, props.points.length - 1) : pickedIndex()}
          aria-valuetext={`${props.picked ? momentText(props.picked.at) : "Now"}, ${readout()}`}
          onPointerDown={(e) => {
            const svg = e.currentTarget;
            svg.setPointerCapture(e.pointerId);
            props.onPick(at(e, svg));
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) props.onPick(at(e, e.currentTarget));
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") step(-1);
            else if (e.key === "ArrowRight") step(1);
            else if (e.key === "Home" && props.points.length) props.onPick(props.points[0]!.at);
            else if (e.key === "End") props.onPick(null);
            else return;
            e.preventDefault();
          }}
        >
          <line class="monitor-grid" x1="0" x2={CHART_W} y1={CHART_H / 2} y2={CHART_H / 2} vector-effect="non-scaling-stroke" />
          <For each={model().series}>
            {(s, i) => (
              <For each={s.paths}>{(d) => <path class={`monitor-area monitor-series-${s.key === "*" ? "rest" : i()}`} d={d} vector-effect="non-scaling-stroke" />}</For>
            )}
          </For>
          <For each={model().memory}>{(d) => <path class="monitor-mem" d={d} vector-effect="non-scaling-stroke" />}</For>
          <Show when={crossX() !== null}>
            <line class="monitor-cross" x1={crossX()!} x2={crossX()!} y1="0" y2={CHART_H} vector-effect="non-scaling-stroke" />
          </Show>
        </svg>
        <span class="monitor-axis monitor-axis-start">1h ago</span>
        <span class="monitor-axis monitor-axis-end">now</span>
      </div>
      <ul class="monitor-legend">
        <For each={model().series}>
          {(s, i) => (
            <li>
              <span class={`monitor-swatch monitor-series-${s.key === "*" ? "rest" : i()}`} aria-hidden="true" />
              <span class="monitor-legend-name" title={s.label}>
                {s.label}
              </span>
            </li>
          )}
        </For>
        <Show when={model().memory.length}>
          <li>
            <span class="monitor-swatch monitor-swatch-mem" aria-hidden="true" />
            Memory
          </li>
        </Show>
      </ul>
    </section>
  );
}

/** Sessions, each with its workers; a worker row expands to its heaviest processes, a bucket to its processes. */
function MonitorTable(props: { rows: GroupRow[]; now: number; live: boolean; onOpen(): void }) {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const isOpen = (key: string) => open().has(key);

  return (
    <div class="monitor-table-wrap">
      <table class="monitor-table">
        <thead>
          <tr>
            <th scope="col">Session · worker · process</th>
            <th scope="col" class="monitor-num">
              CPU
            </th>
            <th scope="col" class="monitor-num">
              Memory
            </th>
            <th scope="col" class="monitor-num monitor-col-swap">
              Swap
            </th>
          </tr>
        </thead>
        <For each={props.rows}>
          {(g) => (
            <tbody class="monitor-group">
              <tr class="monitor-row-group">
                <th scope="row">
                  <div class="monitor-name">
                    <Show when={g.procs.length && !g.workers.length} fallback={<span class="monitor-twist-space" aria-hidden="true" />}>
                      <Twist open={isOpen(g.key)} label={g.label} onToggle={() => toggle(g.key)} />
                    </Show>
                    <span class="monitor-label">{g.label}</span>
                    <Show when={g.sessionPath}>
                      {(path) => (
                        <a class="monitor-open" href={sessionHrefOn(null, path())} onClick={() => props.onOpen()}>
                          Open Session
                        </a>
                      )}
                    </Show>
                  </div>
                  <Show when={g.caption || g.procCount}>
                    <div class="monitor-caption">
                      {[g.caption, g.procCount ? `${g.procCount} ${g.procCount === 1 ? "process" : "processes"}` : ""].filter(Boolean).join(" · ")}
                    </div>
                  </Show>
                </th>
                <td class="monitor-num">{cpuText(g.cpuPct)}</td>
                <td class="monitor-num">{bytes(g.rssBytes)}</td>
                <td class="monitor-num monitor-col-swap">{g.swapBytes === undefined ? "" : bytes(g.swapBytes)}</td>
              </tr>
              {/* Without workers the group's processes hang off the group; with them, off a "Session's own tools" line. */}
              <Show when={g.procs.length && !g.workers.length && isOpen(g.key)}>
                <For each={g.procs}>{(p) => <ProcLine p={p} depth={1} />}</For>
              </Show>
              <Show when={g.procs.length && g.workers.length}>
                <OwnRow g={g} open={isOpen(`${g.key}#own`)} onToggle={() => toggle(`${g.key}#own`)} />
                <Show when={isOpen(`${g.key}#own`)}>
                  <For each={g.procs}>{(p) => <ProcLine p={p} depth={2} />}</For>
                </Show>
              </Show>
              <For each={g.workers}>
                {(w) => (
                  <>
                    <WorkerLine w={w} now={props.now} live={props.live} open={isOpen(w.key)} onToggle={() => toggle(w.key)} />
                    <Show when={isOpen(w.key)}>
                      <For each={w.top} fallback={<EmptyLine text={props.live ? "No descendants busy now." : "None of its processes was among that tick's busiest."} />}>
                        {(p) => <ProcLine p={p} depth={2} />}
                      </For>
                    </Show>
                  </>
                )}
              </For>
            </tbody>
          )}
        </For>
      </table>
    </div>
  );
}

function Twist(props: { open: boolean; label: string; onToggle(): void }) {
  return (
    <button
      type="button"
      class="button button-icon monitor-twist"
      aria-expanded={props.open ? "true" : "false"}
      aria-label={`${props.open ? "Hide" : "Show"} processes of ${props.label}`}
      onClick={() => props.onToggle()}
    >
      <Icon name={props.open ? "chevron-down" : "chevron-right"} small />
    </button>
  );
}

/** A session's own processes (hosted tools, its Claude Code provider), as one expandable line above its workers. */
function OwnRow(props: { g: GroupRow; open: boolean; onToggle(): void }) {
  const cpu = () => props.g.procs.reduce((n, p) => n + p.cpuPct, 0);
  const rss = () => props.g.procs.reduce((n, p) => n + p.rssBytes, 0);
  return (
    <tr class="monitor-row-worker">
      <th scope="row">
        <div class="monitor-name">
          <Twist open={props.open} label={`${props.g.label}'s own tools`} onToggle={() => props.onToggle()} />
          <span class="monitor-label">Session's own tools</span>
        </div>
      </th>
      <td class="monitor-num">{cpuText(cpu())}</td>
      <td class="monitor-num">{bytes(rss())}</td>
      <td class="monitor-num monitor-col-swap" />
    </tr>
  );
}

function WorkerLine(props: { w: WorkerRow; now: number; live: boolean; open: boolean; onToggle(): void }) {
  const caption = () =>
    [props.w.backend, statusText(props.w, props.now), props.w.procCount ? `${props.w.procCount} ${props.w.procCount === 1 ? "process" : "processes"}` : ""].filter(Boolean).join(" · ");
  return (
    <tr class="monitor-row-worker">
      <th scope="row">
        <div class="monitor-name">
          <Twist open={props.open} label={props.w.label} onToggle={() => props.onToggle()} />
          <span class="monitor-label" title={viaWords(props.w.via)}>
            {props.w.label}
          </span>
          <Show when={isHeuristic(props.w.via)}>
            <span class="monitor-guess" title={viaWords(props.w.via)}>
              Guess
            </span>
          </Show>
        </div>
        <Show when={caption()}>
          <div class="monitor-caption">{caption()}</div>
        </Show>
      </th>
      <td class="monitor-num">{cpuText(props.w.cpuPct)}</td>
      <td class="monitor-num">{bytes(props.w.rssBytes)}</td>
      <td class="monitor-num monitor-col-swap">{props.w.swapBytes === undefined ? "" : bytes(props.w.swapBytes)}</td>
    </tr>
  );
}

function ProcLine(props: { p: ProcRow; depth: 1 | 2 }) {
  const hint = () => [props.p.chargedTo, props.p.via ? viaWords(props.p.via) : ""].filter(Boolean).join(" · ");
  return (
    <tr class="monitor-row-proc" classList={{ "monitor-depth-2": props.depth === 2 }}>
      <th scope="row">
        <div class="monitor-name">
          <span class="monitor-cmd text-mono" title={`pid ${props.p.pid}`}>
            {props.p.cmd}
          </span>
          <Show when={isHeuristic(props.p.via)}>
            <span class="monitor-guess" title={viaWords(props.p.via)}>
              Guess
            </span>
          </Show>
        </div>
        <Show when={hint()}>
          <div class="monitor-caption">{hint()}</div>
        </Show>
        <Show when={props.p.cwd}>
          <div class="monitor-caption text-mono">{props.p.cwd}</div>
        </Show>
      </th>
      <td class="monitor-num">{cpuText(props.p.cpuPct)}</td>
      <td class="monitor-num">{bytes(props.p.rssBytes)}</td>
      <td class="monitor-num monitor-col-swap" />
    </tr>
  );
}

function EmptyLine(props: { text: string }) {
  return (
    <tr class="monitor-row-proc monitor-depth-2">
      <td colSpan={4} class="monitor-caption">
        {props.text}
      </td>
    </tr>
  );
}
