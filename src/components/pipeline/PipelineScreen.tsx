import { createEffect, createMemo, For, Match, on, Show, Switch } from "solid-js";
import type { ReleaseView } from "../../../shared/release";
import { getMergeHealth, getSetupMap } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { mergeChanged, mergeFeed, readQueue } from "../../lib/merge-queue-client";
import { queueStages, releaseStages } from "../../lib/pipeline";
import { createPoll, type Poll } from "../../lib/poll";
import { mergeQueueTabHref, pipelineHref, PIPELINE_VIEWS, projectSessionHref, projectTabHref, type PipelineAt, type PipelineView } from "../../lib/projects-route";
import type { ChatOf } from "../MergeQueueTab";
import type { SetupPoll } from "../SetupChat";
import { Icon } from "../ui";
import { createWide } from "./PipelineParts";
import { SetupFlow } from "./PipelineSetup";
import { RunsView } from "./PipelineRuns";
import { StoriesView } from "./PipelineStories";
import { ProposalView, proposalState, SetupHistoryView } from "./PipelineProposal";
import { ReleaseBranchesView, ReleasesView } from "./PipelineReleases";
import "./pipeline.css";

const QUEUE_POLL_MS = 4000;
const MAP_POLL_MS = 6000;
const HEALTH_POLL_MS = 60_000;
const DAY = 86_400_000;

const VIEW_LABEL: Record<PipelineView, string> = { setup: "Setup", runs: "Runs", stories: "Branch stories", proposal: "Proposal", history: "Setup history", releases: "Releases", branches: "Branches" };
const RELEASE_LABEL: Partial<Record<PipelineView, string>> = { setup: "Release setup", history: "Release history" };

/**
 * The queue screen (§app.merge-queue/explainer): one screen that explains the whole merge queue — its setup stage by
 * stage, every run's plan beside what it did, each branch's story across its attempts, the Setup chat's proposal beside
 * the setup in force (live while the chat writes it) and the setup's history — and, through the scope switch, the same
 * views over releases. Read-only, except Confirm on a ready proposal, Clean Run, Fix in New Chat on a flaky test, and a
 * Private names step's answers, each the user's own click.
 */
export function PipelineScreen(props: { projectId: string; root: string; name: string; at: PipelineAt; releases: Poll<ReleaseView>; setup: SetupPoll; chatOf?: ChatOf }) {
  const queue = createPoll(() => readQueue(props.root), QUEUE_POLL_MS, { cacheKey: `project:${props.projectId}:merge-queue` });
  createEffect(on(mergeChanged, () => queue.refetch(), { defer: true }));
  createEffect(on(mergeFeed, (f) => f && f.project === props.projectId && queue.set(f.view), { defer: true }));
  const map = createPoll(() => getSetupMap(props.projectId), MAP_POLL_MS, { cacheKey: `project:${props.projectId}:setup-map` });
  const health = createPoll(() => getMergeHealth(props.projectId, 30), HEALTH_POLL_MS);
  // While the Setup chat writes, the Proposal view follows its working copy closely.
  createEffect(() => {
    if (props.at.view !== "proposal" || map.data()?.chat?.state !== "working") return;
    const t = setInterval(() => map.refetch(), 2000);
    return () => clearInterval(t);
  });
  const [wide, wideRef] = createWide(880);
  const scope = () => props.at.scope;
  const v = () => queue.data();
  const target = () => v()?.target ?? map.data()?.main.target ?? "main";
  const chat = () => props.setup.data()?.chat ?? null;
  const prop = createMemo(() => proposalState(map.data(), props.setup.data(), scope()));
  const views = () => PIPELINE_VIEWS[scope()] as readonly PipelineView[];
  const label = (w: PipelineView) => (scope() === "releases" ? (RELEASE_LABEL[w] ?? VIEW_LABEL[w]) : VIEW_LABEL[w]);
  const stages = createMemo(() => {
    const m = map.data()?.main;
    if (!m) return [];
    return scope() === "releases" ? releaseStages(m) : queueStages(m, health.data());
  });
  // The head's live facts: what's in line, what's landing, what landed this week.
  const inLine = () => (v()?.waiting.length ?? 0) + (v()?.checking.length ?? 0);
  const forYou = () => v()?.needsYou.length ?? 0;
  const landedWeek = () => (v()?.recent ?? []).filter((l) => l.entry.landed && Date.now() - Date.parse(l.entry.landed.at) < 7 * DAY).length;
  const lastLanded = () => v()?.recent[0]?.entry.landed?.at;
  const rel = () => props.releases.data();
  return (
    <section class="card orgs-section pl-screen" aria-labelledby="pl-title" ref={wideRef}>
      <header class="pl-head">
        <p class="pl-eyebrow">
          {props.name} · target {target()}
        </p>
        <div class="pl-title-row">
          <h2 class="pl-title" id="pl-title">
            {scope() === "releases" ? "Releases" : "Merge queue"}
          </h2>
          <nav class="pl-segmented" aria-label="Merge queue or releases">
            <a href={pipelineHref(props.projectId, "queue")} aria-current={scope() === "queue" ? "page" : undefined}>
              <Icon name="branch" small />
              Merge queue
            </a>
            <a href={pipelineHref(props.projectId, "releases")} aria-current={scope() === "releases" ? "page" : undefined}>
              <Icon name="arrow-right" small />
              Releases
            </a>
          </nav>
        </div>
        <Show
          when={scope() === "queue"}
          fallback={
            <p class="pl-summary">
              <Show when={rel()} fallback={<span>Reading the releases.</span>}>
                {(r) => (
                  <>
                    <span>{r().open ? `Release ${r().open!.version ?? ""} in progress`.replace("  ", " ") : "No release in progress"}</span>
                    <span class="pl-sep">·</span>
                    <span>
                      <span class="text-num">{r().history.length}</span> {r().history.length === 1 ? "release" : "releases"}
                    </span>
                    <Show when={r().latest}>
                      <span class="pl-sep">·</span>
                      <span>
                        latest <span class="pl-mono">{r().latest}</span>
                      </span>
                    </Show>
                    <Show when={r().landingsSince !== null}>
                      <span class="pl-sep">·</span>
                      <span>
                        <span class="text-num">{r().landingsSince}</span> landings since
                      </span>
                    </Show>
                  </>
                )}
              </Show>
            </p>
          }
        >
          <p class="pl-summary" aria-live="polite">
            <span>
              <span class="text-num">{inLine()}</span> {inLine() === 1 ? "branch" : "branches"} in the queue
            </span>
            <Show when={forYou()}>
              <span class="pl-sep">·</span>
              <span>
                <span class="text-num">{forYou()}</span> waiting for you
              </span>
            </Show>
            <span class="pl-sep">·</span>
            <span>{v()?.current ? "1 landing now" : v()?.state === "paused" ? "paused" : "nothing landing"}</span>
            <span class="pl-sep">·</span>
            <span>
              <span class="text-num">{landedWeek()}</span> landed this week
            </span>
            <Show when={lastLanded()}>
              <span class="pl-sep">·</span>
              <span>last landed {relativeTime(lastLanded()!)}</span>
            </Show>
          </p>
        </Show>
        <p class="pl-setup-line">
          <Show when={scope() === "queue" || map.data()?.main.release} fallback={<span>{map.data() ? "Releases aren’t set up yet." : "Reading the setup."}</span>}>
          <Show when={map.data()?.version} fallback={<span>{map.data() ? `Setup read from ${target()}` : "Reading the setup."}</span>}>
            {(ver) => (
              <>
                <span>
                  Setup <span class="pl-mono">v{ver().n}</span> · in force since {relativeTime(ver().at)}
                </span>
                <Show when={ver().earlier > 0}>
                  <span class="pl-sep">·</span>
                  <a href={pipelineHref(props.projectId, scope(), "history")}>
                    {ver().earlier} earlier {ver().earlier === 1 ? "version" : "versions"}
                  </a>
                </Show>
              </>
            )}
          </Show>
          </Show>
        </p>
        <div class="pl-head-actions">
          <Show when={chat()}>
            {(c) => (
              <a class="button button-sm" href={c().path ? projectSessionHref(props.projectId, c().path!) : `#/sid/${encodeURIComponent(c().sessionId)}`}>
                <Icon name="chat" small />
                Back to Setup Chat
              </a>
            )}
          </Show>
          <a class="button button-sm button-ghost" href={scope() === "releases" ? projectTabHref(props.projectId, "releases") : mergeQueueTabHref(props.projectId)}>
            {scope() === "releases" ? "Open Releases Tab" : "Open Merge Queue Tab"}
          </a>
        </div>
      </header>

      <Show when={prop().state !== "none"}>
        <div class="pl-band" classList={{ "is-drafting": prop().state === "drafting" }} role="status">
          <span class="pl-band-mark" aria-hidden="true">
            <Icon name={prop().state === "drafting" ? "pencil" : "settings"} />
          </span>
          <div class="pl-band-text">
            <p class="pl-band-title">{prop().state === "drafting" ? "The Setup chat is drafting changes" : `Setup v${(map.data()?.version?.n ?? 0) + 1} is ready to review`}</p>
            <p class="pl-band-body">{prop().line}</p>
          </div>
          <a class={`button${prop().state === "ready" ? " button-primary" : ""}`} href={pipelineHref(props.projectId, scope(), "proposal")}>
            {prop().state === "drafting" ? "Review Draft" : "Review Proposal"}
          </a>
        </div>
      </Show>

      <nav class="tabs pl-tabs" role="tablist" aria-label={scope() === "releases" ? "Release views" : "Merge queue views"}>
        <For each={views()}>
          {(w) => (
            <a
              class="tab"
              role="tab"
              href={pipelineHref(props.projectId, scope(), w)}
              aria-selected={props.at.view === w ? "true" : "false"}
              aria-controls="pl-panel"
              id={`pl-tab-${w}`}
            >
              {label(w)}
              <Show when={w === "runs" && v()}>
                <span class="pl-tab-count">{(v()?.checking.length ?? 0) + (v()?.waiting.length ?? 0) + (v()?.recent.length ?? 0)}</span>
              </Show>
              <Show when={w === "proposal" && prop().state !== "none"}>
                <span class={`chip chip-solid${prop().state === "ready" ? " chip-accent" : ""}`}>
                  <i class="chip-dot" />
                  {prop().state === "ready" ? "Ready" : "Drafting"}
                </span>
              </Show>
            </a>
          )}
        </For>
      </nav>

      <div class="pl-panel" role="tabpanel" id="pl-panel" aria-labelledby={`pl-tab-${props.at.view}`}>
        <Show when={!map.error() || map.data()} fallback={<p class="orgs-empty">Couldn't read this project's setup. {map.error()}</p>}>
          <Switch>
            <Match when={props.at.view === "setup"}>
              <Show when={map.data()} fallback={<p class="orgs-empty">Reading the setup.</p>}>
                {(m) => (
                  <Show
                    when={scope() === "queue" || m().main.release}
                    fallback={
                      <p class="orgs-empty">
                        Releases aren’t set up for this project. <a href={projectTabHref(props.projectId, "releases")}>Set them up on the Releases tab.</a>
                      </p>
                    }
                  >
                    <SetupFlow
                      title={scope() === "releases" ? "The release pipeline" : "The pipeline"}
                      sub={scope() === "releases" ? "Started by you. Every stage finishes before the next one starts. Select a stage for its rule." : `From your Land to ${target()}. Select a stage or a check for its rule, when it runs, and what happens when it fails.`}
                      stages={stages()}
                      wide={wide()}
                      legend={scope() === "queue"}
                      problem={m().main.problem}
                    />
                  </Show>
                )}
              </Show>
            </Match>
            <Match when={props.at.view === "runs"}>
              <Show when={v()} fallback={<p class="orgs-empty">{queue.error() ? `Couldn't read the merge queue. ${queue.error()}` : "Reading the merge queue."}</p>}>
                {(view) => <RunsView projectId={props.projectId} view={view()} item={props.at.item} wide={wide()} health={health.data()} chatOf={props.chatOf} />}
              </Show>
            </Match>
            <Match when={props.at.view === "stories"}>
              <Show when={v()} fallback={<p class="orgs-empty">Reading the merge queue.</p>}>
                {(view) => <StoriesView projectId={props.projectId} view={view()} item={props.at.item} wide={wide()} health={health.data()} chatOf={props.chatOf} />}
              </Show>
            </Match>
            <Match when={props.at.view === "proposal"}>
              <ProposalView projectId={props.projectId} scope={scope()} map={map.data()} setup={props.setup} state={prop()} onChanged={() => map.refetch()} />
            </Match>
            <Match when={props.at.view === "history"}>
              <SetupHistoryView projectId={props.projectId} scope={scope()} />
            </Match>
            <Match when={props.at.view === "releases"}>
              <ReleasesView projectId={props.projectId} releases={props.releases} item={props.at.item} wide={wide()} />
            </Match>
            <Match when={props.at.view === "branches"}>
              <ReleaseBranchesView projectId={props.projectId} releases={props.releases} view={v()} chatOf={props.chatOf} />
            </Match>
          </Switch>
        </Show>
      </div>
    </section>
  );
}
