import { createMemo, For, Show } from "solid-js";
import type { MergeQueueView } from "../../../shared/merge-queue";
import type { ReleaseHistoryItem, ReleaseRecord, ReleaseView } from "../../../shared/release";
import { relativeTime } from "../../lib/format";
import { releaseChip, releaseStepState } from "../../lib/pipeline";
import type { Poll } from "../../lib/poll";
import { pipelineHref, projectTabHref } from "../../lib/projects-route";
import { chatHref, type ChatOf } from "../MergeQueueTab";
import { Sheet, Timeline, ToneChip, type TimelineItem } from "./PipelineParts";

interface ReleaseRow {
  key: string;
  name: string;
  chip: ReturnType<typeof releaseChip>;
  meta: string;
  record?: ReleaseRecord;
  item?: ReleaseHistoryItem;
}

function rowsOf(r: ReleaseView): ReleaseRow[] {
  const rows: ReleaseRow[] = [];
  const seen = new Set<string>();
  for (const rec of [r.open, r.last]) {
    if (!rec) continue;
    const name = rec.tag ?? rec.version ?? "Release in progress";
    seen.add(name);
    rows.push({ key: rec.id, name, chip: releaseChip(rec), meta: `started ${relativeTime(rec.startedAt)}${rec.publish ? ` · published ${relativeTime(rec.publish.at)}` : ""}`, record: rec });
  }
  for (const h of r.history) {
    if (seen.has(h.tag)) continue;
    rows.push({ key: h.tag, name: h.tag, chip: h.withdrawn ? { label: "Withdrawn", tone: "warn" } : { label: "Released", tone: "success" }, meta: `${new Date(h.date).toLocaleDateString([], { month: "short", day: "numeric" })}${h.channels.length ? ` · ${h.channels.join(", ")}` : ""}${h.deployedTo.length ? ` · deployed to ${h.deployedTo.join(", ")}` : ""}`, item: h });
  }
  return rows;
}

/** Releases: the release in progress, the last one and every numbered release, each with its timeline. */
export function ReleasesView(props: { projectId: string; releases: Poll<ReleaseView>; item?: string; wide: boolean }) {
  const r = () => props.releases.data();
  const rows = createMemo(() => (r() ? rowsOf(r()!) : []));
  const selected = createMemo(() => (props.item ? rows().find((x) => x.key === props.item || x.name === props.item) : undefined) ?? (props.wide ? rows()[0] : undefined));
  return (
    <Show when={r()} fallback={<p class="orgs-empty">{props.releases.error() ? `Couldn't read the releases. ${props.releases.error()}` : "Reading the releases."}</p>}>
      <Show
        when={r()!.initialized}
        fallback={
          <p class="orgs-empty">
            Releases aren’t set up for this project. <a href={projectTabHref(props.projectId, "releases")}>Set them up on the Releases tab.</a>
          </p>
        }
      >
        <div class="pl-split">
          <div class="pl-master">
            <div>
              <h2 class="pl-section-title">Releases</h2>
              <p class="pl-section-sub">{r()!.open ? "One is in progress." : `${r()!.history.length} numbered ${r()!.history.length === 1 ? "release" : "releases"}.`}</p>
            </div>
            <Show when={rows().length} fallback={<p class="pl-hint">No release yet. Start one on the Releases tab.</p>}>
              <ul class="pl-rows" aria-label="Releases">
                <For each={rows()}>
                  {(x) => (
                    <li>
                      <a class="pl-row" href={pipelineHref(props.projectId, "releases", "releases", x.key)} aria-current={selected()?.key === x.key ? "true" : undefined}>
                        <span class="pl-row-top">
                          <span class="pl-row-name">{x.name}</span>
                          <ToneChip tone={x.chip.tone}>{x.chip.label}</ToneChip>
                        </span>
                        <span class="pl-row-meta">{x.meta}</span>
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <p class="pl-hint">Start, continue and publish a release on the Releases tab.</p>
          </div>
          <Show when={props.wide && selected()}>
            {(x) => (
              <div class="pl-detail">
                <ReleaseDetail projectId={props.projectId} row={x()} />
              </div>
            )}
          </Show>
        </div>
        <Show when={!props.wide && props.item ? selected() : undefined}>
          {(x) => (
            <Sheet title={x().name} sub="Release" onClose={() => (location.hash = pipelineHref(props.projectId, "releases", "releases"))}>
              <ReleaseDetail projectId={props.projectId} row={x()} />
            </Sheet>
          )}
        </Show>
      </Show>
    </Show>
  );
}

function ReleaseDetail(props: { projectId: string; row: ReleaseRow }) {
  const rec = () => props.row.record;
  const steps = (): TimelineItem[] =>
    (rec()?.steps ?? [])
      .filter((s) => s.phase !== "withdraw" || rec()!.withdrawn)
      .map((s) => ({
        key: s.id,
        state: releaseStepState(s),
        title: s.label,
        meta: <>{[s.at ? relativeTime(s.at) : s.state === "waiting" ? "not started" : "", s.held ? "waits for your Continue" : "", s.by ? `by ${s.by === "thread" ? "the release chat" : s.by === "operator" ? "you" : "Sova"}` : ""].filter(Boolean).join(" · ")}</>,
        ...(s.summary || s.fact ? { body: <>{s.summary ?? ""}{s.fact && !s.fact.ok ? ` ${s.fact.why}` : ""}</> } : {}),
      }));
  return (
    <>
      <header class="pl-detail-head">
        <div class="cluster">
          <ToneChip tone={props.row.chip.tone}>{props.row.chip.label}</ToneChip>
          <span class="pl-kicker">{props.row.meta}</span>
        </div>
        <h3 class="pl-detail-title" style={{ "font-size": "var(--fs-heading-m)" }}>
          {props.row.name}
        </h3>
        <Show when={rec()?.abandoned}>
          <p class="pl-detail-lead">Abandoned: {rec()!.abandoned!.why}</p>
        </Show>
        <a class="button button-sm" href={projectTabHref(props.projectId, "releases")} style={{ "align-self": "flex-start" }}>
          Open on the Releases Tab
        </a>
      </header>
      <Show
        when={rec()}
        fallback={
          <section class="pl-card">
            <div class="pl-card-head">
              <h3>Release notes</h3>
            </div>
            <div class="pl-card-body">
              <p class="pl-detail-lead" style={{ "white-space": "pre-wrap" }}>
                {props.row.item?.notes ?? "This tag carries no notes."}
              </p>
              <p class="pl-factbox">
                Tag <span class="pl-mono">{props.row.item?.tag}</span> at <span class="pl-mono">{props.row.item?.sha.slice(0, 7)}</span>
                {props.row.item?.withdrawn ? ` · withdrawn: ${props.row.item.withdrawn.why}` : ""}.
              </p>
            </div>
          </section>
        }
      >
        <section class="pl-card">
          <div class="pl-card-head">
            <h3>The release</h3>
            <span class="pl-mono pl-muted">{rec()!.steps.length} steps</span>
          </div>
          <div class="pl-card-body">
            <Timeline items={steps()} label="Release steps" />
          </div>
        </section>
      </Show>
    </>
  );
}

/** Branches: what landed since the newest release, and what is landing now: the next release's content. */
export function ReleaseBranchesView(props: { projectId: string; releases: Poll<ReleaseView>; view?: MergeQueueView; chatOf?: ChatOf }) {
  const latest = () => props.releases.data()?.history[0];
  const since = () => (latest() ? Date.parse(latest()!.date) : 0);
  const landed = () => (props.view?.recent ?? []).filter((l) => l.entry.landed && Date.parse(l.entry.landed.at) > since());
  const inLine = () => [...(props.view?.checking ?? []), ...(props.view?.waiting ?? [])];
  const n = () => props.releases.data()?.landingsSince;
  return (
    <>
      <div>
        <h2 class="pl-section-title">{latest() ? `Branches since ${latest()!.tag}` : "Branches since the start"}</h2>
        <p class="pl-section-sub">
          {n() != null ? `${n()} ${n() === 1 ? "landing" : "landings"} on the main branch since then` : "What the next release will carry"}
          {inLine().length ? `; ${inLine().length} in the queue now` : ""}.
        </p>
      </div>
      <Show when={landed().length || inLine().length} fallback={<p class="pl-hint">Nothing landed since the newest release.</p>}>
        <ul class="pl-rows" aria-label="Branches">
          <For each={inLine()}>
            {(e) => (
              <li class="pl-strip-row" style={{ "border-bottom": "var(--stroke-thin) solid var(--color-border)" }}>
                <div class="pl-strip-main">
                  <a class="pl-row-name" href={pipelineHref(props.projectId, "queue", "runs", e.run ?? e.id)}>
                    {e.branch}
                  </a>
                  <span class="pl-strip-meta">{e.session ? <a href={chatHref(props.projectId, e.session, props.chatOf)}>{props.chatOf?.(e.session)?.title ?? "its chat"}</a> : null}</span>
                </div>
                <ToneChip tone={e.state === "checking" ? "accent" : "neutral"}>{e.state === "checking" ? "Landing" : "Waiting"}</ToneChip>
              </li>
            )}
          </For>
          <For each={landed()}>
            {(l) => (
              <li class="pl-strip-row" style={{ "border-bottom": "var(--stroke-thin) solid var(--color-border)" }}>
                <div class="pl-strip-main">
                  <a class="pl-row-name" href={pipelineHref(props.projectId, "queue", "stories", l.entry.branch)}>
                    {l.entry.branch}
                  </a>
                  <span class="pl-strip-meta">{l.entry.session ? <a href={chatHref(props.projectId, l.entry.session, props.chatOf)}>{props.chatOf?.(l.entry.session)?.title ?? "its chat"}</a> : null}</span>
                </div>
                <ToneChip tone="success">Landed</ToneChip>
                <span class="pl-strip-time">{relativeTime(l.entry.landed!.at)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={(n() ?? 0) > landed().length}>
        <p class="pl-hint">{(n() ?? 0) - landed().length} older landings since then aren’t listed here: the Releases tab’s changelog has them all.</p>
      </Show>
    </>
  );
}
