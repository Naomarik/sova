import { createEffect, createResource, createSignal, For, on, Show, type JSX } from "solid-js";
import type { MergeHistorySlim } from "../../../shared/merge-queue-health";
import { getMergeHealth, getMergeHistory } from "../../lib/api";
import { duration, relativeTime } from "../../lib/format";
import { short } from "../../lib/merge-queue";
import { mergeChanged } from "../../lib/merge-queue-client";
import { mergeRunHref, pipelineHref } from "../../lib/projects-route";
import { announce } from "../../lib/ui-state";
import { HealthSummary } from "./PipelineRuns";
import { ToneChip } from "./PipelineParts";
import "./pipeline.css";

const PAGE = 20;
const landedRow = (h: MergeHistorySlim) => h.state === "landed" || h.state === "pushed" || !!h.landedAt;

/**
 * The Merge Queue tab's Landed (§app.merge-queue/health): the health summary on top, a search by branch across the whole
 * history, and Show Older under the newest landings, 20 at a time. `newest`: the view's own rows, drawn as they always
 * were; a search replaces them with what the history finds, and Show Older adds what is older than them.
 */
export function LandedHistory(props: { projectId: string; newest: JSX.Element; newestIds: string[] }) {
  const [health, { refetch }] = createResource(() => props.projectId, (id) => getMergeHealth(id, 30).catch(() => undefined));
  createEffect(on(mergeChanged, () => refetch(), { defer: true }));
  const [search, setSearch] = createSignal("");
  const [rows, setRows] = createSignal<MergeHistorySlim[]>([]);
  const [next, setNext] = createSignal<string | undefined>();
  const [started, setStarted] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One page; with no search, the newest landings the tab already draws are left out. */
  const read = async (before?: string) => {
    setBusy(true);
    setFailed(null);
    try {
      const q = search().trim();
      let page = await getMergeHistory(props.projectId, { limit: PAGE, ...(q ? { branch: q } : {}), ...(before ? { before } : {}) });
      let got = page.rows.filter((r) => landedRow(r) && (q || !props.newestIds.includes(r.id)));
      // The first page without a search may be exactly the rows already shown: read on to the older ones.
      while (!q && !got.length && page.next) {
        page = await getMergeHistory(props.projectId, { limit: PAGE, before: page.next });
        got = page.rows.filter((r) => landedRow(r) && !props.newestIds.includes(r.id));
      }
      setRows(before ? [...rows(), ...got] : got);
      setNext(page.next);
      setStarted(true);
      announce(q ? `${got.length} landings match “${q}”.` : `${got.length} older landings shown.`);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const onSearch = (v: string) => {
    setSearch(v);
    clearTimeout(timer);
    if (!v.trim()) {
      setRows([]);
      setNext(undefined);
      setStarted(false);
      return;
    }
    timer = setTimeout(() => void read(), 250);
  };
  const searching = () => !!search().trim();
  return (
    <>
      <div class="pl-screen">
        <HealthSummary health={health()} />
      </div>
      <div class="pl-filterbar" role="search">
        <input class="input pl-search" type="search" placeholder="Search landings by branch" aria-label="Search landings by branch" value={search()} onInput={(e) => onSearch(e.currentTarget.value)} />
        <a class="button button-sm button-ghost" href={pipelineHref(props.projectId, "queue", "runs")}>
          Queue Overview
        </a>
      </div>
      <Show when={!searching()}>{props.newest}</Show>
      <Show when={started() && (rows().length || searching())}>
        <ul class="list mq-list" aria-label={searching() ? "Landings found" : "Older landings"}>
          <For each={rows()} fallback={<li class="list-row text-caption text-muted">No landing of a branch matching “{search()}”.</li>}>
            {(h) => (
              <li class="list-row mq-row" data-branch={h.branch} data-state="landed">
                <div class="list-main">
                  <a class="list-title text-mono" href={pipelineHref(props.projectId, "queue", "stories", h.branch)}>
                    {h.branch}
                  </a>
                  <p class="mq-facts">
                    <ToneChip tone="success">Landed</ToneChip>
                    <span>
                      <span class="text-mono">{short(h.commit)}</span> · {relativeTime(h.landedAt ?? h.finalAt)}
                      {h.timeToLandMs ? ` · ${duration(h.timeToLandMs)} to land` : ""} · {h.runs} {h.runs === 1 ? "run" : "runs"}
                      {h.sentBack?.length ? ` · sent back ${h.sentBack.length}×` : ""}
                    </span>
                  </p>
                </div>
                <Show when={h.run}>
                  <div class="button-row mq-row-act">
                    <a class="button button-sm button-ghost" href={mergeRunHref(props.projectId, h.run!, "landed")} aria-label={`View checks for ${h.branch}`}>
                      View Checks
                    </a>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={started() && !searching() && !rows().length && !next()}>
        <p class="text-caption text-muted">No older landings: every landing is shown.</p>
      </Show>
      <Show when={failed()}>{(m) => <p class="text-caption mq-error" role="alert">Couldn’t read the history. {m()}</p>}</Show>
      <Show when={!started() || next()}>
        <button type="button" class="button button-sm pl-more" disabled={busy()} onClick={() => void read(started() ? next() : undefined)}>
          {busy() ? "Reading Older Landings" : "Show Older"}
        </button>
      </Show>
    </>
  );
}
