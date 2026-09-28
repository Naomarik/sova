import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import type { Emphasis } from "../../core/grammar";
import { canvasMeasure } from "../../core/text";
import { emClass, SvgEmBadge } from "../../emphasis";
import { createStepper } from "../../stepper";
import { SvgScroll, useMarkerId } from "../../svg";
import type { ViewProps } from "../../types";
import { GIT_FONT, layoutGitgraph, type GitChip, type PlacedCommit } from "./layout";
import type { GitgraphSpec } from "./parse";
import "./gitgraph.css";

/**
 * `vis gitgraph`: lanes down the left, one row per commit, the text beside them, laid out at the
 * pane's width. A rebase leaves its originals as dashed ghosts next to their copies; a cherry-pick
 * or squash carries a dashed arrow from what it copies. Step Through replays the history row by row.
 */
export default function GitgraphView(props: ViewProps<GitgraphSpec>) {
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(560);
  onMount(() => {
    const read = () => setWidth(Math.max(260, Math.min(720, Math.floor(box.clientWidth || 560))));
    const ro = new ResizeObserver(read);
    ro.observe(box);
    read();
    onCleanup(() => ro.disconnect());
  });
  const em = createMemo(() => emphasisMap(props.spec));
  const count = () => props.spec.commits.length;
  const stepper = createStepper(count);
  const at = () => stepper.at() ?? count() - 1;
  const badged = createMemo(() => new Set([...em().values()].filter((e) => e.n !== undefined).map((e) => e.key)));
  const layout = createMemo(() => layoutGitgraph(props.spec, width(), at(), canvasMeasure, badged()));
  const markedLane = createMemo(() => new Set(props.spec.branches.flatMap((b, i) => (em().has(`branch:${b.name}`) ? [i] : []))));
  const arrow = useMarkerId();
  const future = (row: number) => !stepper.shown(row);
  return (
    <div class="vis-gitgraph" ref={box}>
      <Show when={count() >= 4}>
        <stepper.Controls />
      </Show>
      <SvgScroll width={layout().width} height={layout().height} label={props.label}>
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" class="vis-arrowhead" />
          </marker>
        </defs>
        <For each={layout().commits}>{(p) => <Band p={p} em={em().get(p.commit.id)} width={layout().width} future={future(p.row)} />}</For>
        <g class="vis-git-edges">
          <For each={layout().edges}>
            {(e) => (
              <path
                d={e.path}
                class={`vis-git-edge vis-git-lane-${e.lane % 6}`}
                classList={{ "vis-git-ghost": e.ghost, "vis-git-link": e.link, "vis-git-lane-em": markedLane().has(e.lane), "vis-future": future(e.row) }}
                marker-end={e.link ? `url(#${arrow})` : undefined}
              />
            )}
          </For>
        </g>
        <For each={layout().commits}>{(p) => <Commit p={p} em={em().get(p.commit.id)} future={future(p.row)} />}</For>
        <For each={layout().commits.flatMap((p) => p.chips.map((c) => ({ c, row: p.row })))}>
          {({ c, row }) => <Chip c={c} spec={props.spec} em={c.kind === "branch" ? em().get(`branch:${c.name}`) : undefined} future={future(row)} />}
        </For>
      </SvgScroll>
    </div>
  );
}

/** A marked row's band, under everything else. */
function Band(props: { p: PlacedCommit; em: Emphasis | undefined; width: number; future: boolean }) {
  return (
    <Show when={props.em}>
      <rect class={`vis-git-band ${emClass(props.em)}`} classList={{ "vis-future": props.future }} x="0" y={props.p.top + 1} width={props.width} height={props.p.h - 2} rx="6" />
    </Show>
  );
}

function Commit(props: { p: PlacedCommit; em: Emphasis | undefined; future: boolean }) {
  const p = () => props.p;
  const c = () => props.p.commit;
  const tone = () => (props.em ? emClass(props.em) : c().tone ? `vis-tone-${c().tone}` : "");
  const title = () => [c().named ? c().id : "", c().message ?? "", p().meta?.text ?? ""].filter(Boolean).join(" · ");
  return (
    <g
      class={`vis-git-commit vis-git-lane-${c().lane % 6} ${tone()}`}
      classList={{ "vis-git-ghost": p().ghost, "vis-git-toned": !!(props.em || c().tone), "vis-git-merge": c().parents.length > 1, "vis-future": props.future }}
    >
      <title>{title()}</title>
      <circle class="vis-git-dot" cx={p().x} cy={p().y} r={c().parents.length > 1 ? 7 : 6} />
      <SvgEmBadge e={props.em} x={p().tx - 11} y={p().y} />
      <Show when={p().id}>
        <text class="vis-git-id" x={p().id!.x} y={p().id!.y} font-size={String(GIT_FONT.id)} dominant-baseline="central">
          {c().id}
        </text>
      </Show>
      <For each={p().lines}>
        {(l) => (
          <text class="vis-git-msg" x={l.x} y={l.y} font-size={String(GIT_FONT.message)} dominant-baseline="central">
            {l.text}
          </text>
        )}
      </For>
      <Show when={p().meta}>
        <text class="vis-git-meta" x={p().meta!.x} y={p().meta!.y} font-size={String(GIT_FONT.meta)} dominant-baseline="central">
          {p().meta!.text}
        </text>
      </Show>
    </g>
  );
}

function Chip(props: { c: GitChip; spec: GitgraphSpec; em: Emphasis | undefined; future: boolean }) {
  const c = () => props.c;
  const top = () => c().y - 9;
  const tag = () => c().kind === "tag";
  const tone = () => (props.em ? emClass(props.em) : "");
  const current = () => c().kind === "branch" && props.spec.current === c().name;
  return (
    <g
      class={`vis-git-chip ${tag() ? "vis-git-tag" : `vis-git-lane-${c().lane % 6}`} ${tone()}`}
      classList={{ "vis-git-head": current(), "vis-future": props.future }}
    >
      <title>{tag() ? `tag ${c().name}` : `branch ${c().name}${current() ? " (checked out)" : ""}`}</title>
      {tag() ? (
        <path d={`M${c().x},${c().y} L${c().x + 6},${top()} H${c().x + c().w} V${top() + 18} H${c().x + 6} Z`} />
      ) : (
        <rect x={c().x} y={top()} width={c().w} height="18" rx="9" />
      )}
      <text x={c().x + c().w / 2 + (tag() ? 2.5 : 0)} y={c().y} font-size={String(GIT_FONT.chip)} text-anchor="middle" dominant-baseline="central">
        {c().label}
      </text>
      <SvgEmBadge e={props.em} x={c().x + c().w} y={top()} />
    </g>
  );
}
