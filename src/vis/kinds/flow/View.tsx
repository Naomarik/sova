import { For, Show, createMemo, createSignal, onMount, type JSX } from "solid-js";
import { isServer } from "solid-js/web";
import { emphasisMap } from "../../core/emphasis";
import type { Emphasis } from "../../core/grammar";
import { canvasMeasure } from "../../core/text";
import { EmBadge, emClass, SvgEmBadge } from "../../emphasis";
import { Lines, SvgScroll, useMarkerId } from "../../svg";
import type { ViewProps } from "../../types";
import { htmlMeasure } from "../tree/measure";
import { createFlowFocus, kindWord, type FlowFocus, type FocusEdge, type FocusGraph, type FocusShape } from "./focus";
import { FLOW_FONT, GROUP, HEX_INSET, fitFlow, layoutFlow, placedEdgeEnds, type FlowLayout, type PlacedFlowNode } from "./layout";
import type { FlowNode, FlowSpec } from "./parse";
import { layoutSections, naturalSections, sectionSpec } from "./sections";
import { fontsLoaded, useWidth } from "./width";
import "./flow.css";

let figureSeq = 0;

/** One drawn panel: its layout and which nodes each of its edges joins (placedEdgeEnds' order). */
interface Drawn {
  layout: FlowLayout;
  ends: FocusEdge[];
  /** Its ranks advance downwards: fitFlow turns a `dir: right` one down unless it returns the natural layout. */
  down: boolean;
}

/**
 * `vis flow` / `vis state`: boxes and arrows, laid out by ./layout. A drawing that would have to
 * scroll in its pane (a phone) is laid out again to fit (fitFlow); ./layout's estimateHeight is
 * the height this draws at, for the shell's reserved box. A flow with `== sections ==` draws one
 * drawing per panel, side by side or stacked (./sections). `group` frames sit under the edges.
 *
 * Tapping a shape picks it (./focus): its neighbours stay lit, the rest fades, and a reading panel
 * opens under the drawing that holds it. The figure is one Tab stop (this View's root); the arrow
 * keys move between shapes, Enter or Space picks, Escape clears. A static render (the docs site)
 * draws the same picture with no controls.
 */
export default function FlowView(props: ViewProps<FlowSpec>) {
  const [width, measure] = useWidth();
  const em = createMemo(() => emphasisMap(props.spec));
  const live = !isServer;
  const figure = ++figureSeq;
  const nodeOf = createMemo(() => new Map(props.spec.nodes.map((n) => [n.id, n])));
  // A spec never gains or loses sections while mounted (a new fence is a new drawing).
  const sectioned = !!props.spec.sections;
  const natural = createMemo(() => (fontsLoaded(), sectioned ? null : layoutFlow(props.spec, canvasMeasure)));
  const naturalPanels = createMemo(() => (fontsLoaded(), sectioned ? naturalSections(props.spec, canvasMeasure) : null));
  const sections = createMemo(() => (sectioned ? layoutSections(props.spec, width(), canvasMeasure, htmlMeasure, naturalPanels()!) : null));
  const drawn = createMemo((): Drawn[] => {
    const s = sections();
    const right = props.spec.dir === "right";
    if (s) return s.panels.map((p, i) => ({ layout: p.layout, ends: placedEdgeEnds(sectionSpec(props.spec, i)), down: !(right && p.layout === naturalPanels()![i]) }));
    const layout = fitFlow(props.spec, canvasMeasure, width(), natural()!);
    return [{ layout, ends: placedEdgeEnds(props.spec), down: !(right && layout === natural()) }];
  });
  const graph = createMemo(
    (): FocusGraph => ({
      shapes: drawn().flatMap((d, panel) => d.layout.nodes.map((n): FocusShape => ({ id: n.id, panel, x: n.x, y: n.y, shape: n.shape, label: nodeOf().get(n.id)?.label ?? n.id, down: d.down }))),
      edges: drawn().flatMap((d) => d.ends),
    }),
  );

  let root: HTMLDivElement | undefined;
  const [machine, setMachine] = createSignal(false);
  // A node key may hold any character an id allows; the DOM id is its index in the figure.
  const domIds = createMemo(() => new Map(graph().shapes.map((s, i) => [s.id, `vis-flow-${figure}-${i}`])));
  const shapeEl = (id: string) => {
    const dom = domIds().get(id);
    return dom ? (root?.querySelector<SVGGElement>(`[id="${dom}"]`) ?? null) : null;
  };
  const focus = createFlowFocus(graph, {
    machine,
    reveal: (id) => shapeEl(id)?.scrollIntoView({ block: "nearest", inline: "nearest" }),
    // The panel opens below the drawing, perhaps below the fold: bring it into view once drawn.
    opened: () => requestAnimationFrame(() => root?.querySelector(".vis-flow-read")?.scrollIntoView({ block: "nearest" })),
  });
  // The kind word every shape is named by, from its arrows (Question, Start, Step, Outcome; State in a machine).
  const kinds = createMemo(() => {
    const g = graph();
    const real = g.edges.filter((e) => e.from !== e.to);
    return new Map(g.shapes.map((s) => [s.id, kindWord(s.shape, real.filter((e) => e.to === s.id).length, real.filter((e) => e.from === s.id).length, machine())]));
  });
  onMount(() => setMachine(!!root?.closest(".vis-kind-state")));

  const onKeyDown = (e: KeyboardEvent) => {
    // Escape clears from anywhere in the figure (a panel button too); the rest only on the Tab stop itself.
    if (e.key !== "Escape" && e.target !== root) return;
    focus.key(e);
  };
  const move = (id: string) => {
    focus.moveTo(id);
    // The pressed button is gone with the old panel: the figure keeps focus, its cursor on the new pick.
    root?.focus({ preventScroll: true });
  };
  const ctx = (): Ctx => ({ live, em: em(), focus, kinds: kinds(), domIds: domIds() });
  const panelFor = (i: number) => (
    <Show when={live}>
      <div class="vis-flow-live" aria-live="polite">
        <Show when={focus.reading() && graph().shapes.find((s) => s.id === focus.reading()!.id)?.panel === i}>
          <Reading node={nodeOf().get(focus.reading()!.id)!} em={em().get(focus.reading()!.id)} focus={focus} move={move} />
        </Show>
      </div>
    </Show>
  );
  return (
    <div
      ref={(el) => {
        root = el;
        measure(el);
      }}
      class="vis-flow"
      classList={{ "vis-flow-sections": sectioned, "vis-flow-sections-row": !!sections()?.row, "vis-flow-on": live }}
      tabindex={live ? "0" : undefined}
      role={live ? "group" : undefined}
      aria-label={live ? `${props.label}: arrow keys move between shapes, Enter picks one` : undefined}
      aria-activedescendant={live && focus.active() !== null ? domIds().get(focus.active()!) : undefined}
      // A listener on the element itself, not Solid's delegated one at the document: Escape's
      // stopPropagation must keep it from every listener above (the side pane's, the app's keys).
      on:keydown={live ? onKeyDown : undefined}
      onFocus={live ? (e) => e.target === root && focus.focused() : undefined}
    >
      <Show
        when={sections()}
        fallback={
          <>
            <FlowDrawing d={drawn()[0]!} label={props.label} ctx={ctx()} />
            {panelFor(0)}
          </>
        }
      >
        {(s) => (
          <For each={s().panels}>
            {(p, i) => (
              <section class="vis-flow-section" style={s().row ? { width: `${p.width}px` } : undefined}>
                <h4 class="vis-flow-section-head">{p.label}</h4>
                <FlowDrawing d={drawn()[i()]!} label={`${props.label}: ${p.label}`} ctx={ctx()} />
                {panelFor(i())}
              </section>
            )}
          </For>
        )}
      </Show>
    </div>
  );
}

interface Ctx {
  live: boolean;
  em: Map<string, Emphasis>;
  focus: FlowFocus;
  kinds: Map<string, string>;
  domIds: Map<string, string>;
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ");

/** The reading panel: the picked shape's kind, whole text, mark note, and buttons to its neighbours. */
function Reading(props: { node: FlowNode; em: Emphasis | undefined; focus: FlowFocus; move: (id: string) => void }) {
  const r = () => props.focus.reading()!;
  const Row = (row: { head: string; chips: { id: string; text: string }[] }) => (
    <Show when={row.chips.length}>
      <div class="vis-flow-read-row">
        <span class="vis-flow-read-head">{row.head}</span>
        <div class="vis-flow-read-chips">
          <For each={row.chips}>
            {(c) => (
              <button class="button button-sm" type="button" onClick={() => props.move(c.id)}>
                {c.text}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
  return (
    <div class="vis-flow-read">
      <span class="vis-flow-read-kind">{r().kind}</span>
      {/* A line break written for the drawing's box is no break in a panel's running text. */}
      <p class="vis-flow-read-text">{oneLine(props.node.label)}</p>
      <Show when={props.node.note}>
        <p class="vis-flow-read-sub">{oneLine(props.node.note!)}</p>
      </Show>
      <Show when={props.em?.note}>
        <p class={`vis-flow-read-mark vis-tone-${props.em!.tone}`}>
          <EmBadge e={props.em} />
          <span>{props.em!.note}</span>
        </p>
      </Show>
      <Row head="From" chips={r().from} />
      <Row head="Leads to" chips={r().to} />
    </div>
  );
}

/** One laid-out graph: group frames, edges, their labels, the frames' titles, then the nodes on top. */
function FlowDrawing(props: { d: Drawn; label: string; ctx: Ctx }) {
  const arrow = useMarkerId();
  const arrowLit = useMarkerId();
  const f = () => props.ctx.focus;
  const edgeState = (i: number) => (props.ctx.live ? f().edgeState(props.d.ends[i]!) : undefined);
  const marker = (i: number) => `url(#${edgeState(i) === "near" ? arrowLit : arrow})`;
  return (
    <SvgScroll width={props.d.layout.width} height={props.d.layout.height} label={props.label} controls={props.ctx.live}>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" class="vis-arrowhead" />
        </marker>
        <Show when={props.ctx.live}>
          <marker id={arrowLit} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" class="vis-arrowhead vis-flow-arrowhead-lit" />
          </marker>
        </Show>
      </defs>
      <For each={props.d.layout.groups ?? []}>
        {(g) => (
          <g class="vis-flow-group">
            <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="8" />
          </g>
        )}
      </For>
      <g class="vis-edges">
        <For each={props.d.layout.edges}>
          {(e, i) => (
            <path
              d={e.path}
              class="vis-edge"
              classList={{ "vis-dashed": e.dashed, "vis-flow-near": edgeState(i()) === "near", "vis-flow-dim": edgeState(i()) === "dim" }}
              marker-end={marker(i())}
              marker-start={e.both ? marker(i()) : undefined}
            />
          )}
        </For>
      </g>
      <For each={props.d.layout.edges}>
        {(e, i) => (
          <Show when={e.label}>
            <g class="vis-edge-label" classList={{ "vis-flow-near": edgeState(i()) === "near", "vis-flow-dim": edgeState(i()) === "dim" }}>
              <rect x={e.label!.x - e.label!.w / 2} y={e.label!.y - e.label!.h / 2} width={e.label!.w} height={e.label!.h} rx="4" />
              <Lines lines={e.label!.lines} x={e.label!.x} y={e.label!.y} size={FLOW_FONT.edge} lh={15} />
            </g>
          </Show>
        )}
      </For>
      {/* Frame titles over the edges (their halo keeps them legible where an edge enters), under the nodes. */}
      <For each={props.d.layout.groups ?? []}>
        {(g) => <Lines lines={g.titleLines} x={g.x + GROUP.pad} y={g.y + GROUP.title / 2 + 2} size={GROUP.font} lh={GROUP.line} top anchor="start" class="vis-flow-group-title" />}
      </For>
      <For each={props.d.layout.nodes}>{(n) => <Node n={n} ctx={props.ctx} />}</For>
    </SvgScroll>
  );
}

/** A node's outline: drawn once as the shape, and again (outline only) for its pick or cursor ring. */
function outline(n: PlacedFlowNode, solid: boolean): JSX.Element {
  const x0 = n.x - n.w / 2;
  const y0 = n.y - n.h / 2;
  switch (n.shape) {
    case "round":
      return <rect x={x0} y={y0} width={n.w} height={n.h} rx={Math.min(n.h / 2, 18)} />;
    case "decision":
      // A wide hexagon: flat top and bottom, pointed sides.
      return <polygon points={`${x0 + HEX_INSET},${y0} ${x0 + n.w - HEX_INSET},${y0} ${x0 + n.w},${n.y} ${x0 + n.w - HEX_INSET},${y0 + n.h} ${x0 + HEX_INSET},${y0 + n.h} ${x0},${n.y}`} />;
    case "circle":
      return <circle cx={n.x} cy={n.y} r={n.w / 2} />;
    case "start":
      return <circle cx={n.x} cy={n.y} r={n.w / 2} class={solid ? "vis-solid" : undefined} />;
    case "end":
      return solid ? (
        <>
          <circle cx={n.x} cy={n.y} r={n.w / 2} />
          <circle cx={n.x} cy={n.y} r={n.w / 2 - 5} class="vis-solid" />
        </>
      ) : (
        <circle cx={n.x} cy={n.y} r={n.w / 2} />
      );
    case "store": {
      const ry = 5;
      const body = `M${x0},${y0 + ry} A${n.w / 2},${ry} 0 0 0 ${x0 + n.w},${y0 + ry} V${y0 + n.h - ry} A${n.w / 2},${ry} 0 0 1 ${x0},${y0 + n.h - ry} Z`;
      return solid ? (
        <>
          <path d={body} />
          <path d={`M${x0},${y0 + ry} A${n.w / 2},${ry} 0 0 1 ${x0 + n.w},${y0 + ry}`} class="vis-cap" />
        </>
      ) : (
        <path d={body} />
      );
    }
    default:
      return <rect x={x0} y={y0} width={n.w} height={n.h} rx="6" />;
  }
}

/** Start and end dots are 18–22px: a tap gets at least this much room around them. */
const MIN_HIT = 32;

function Node(props: { n: PlacedFlowNode; ctx: Ctx }) {
  const n = props.n;
  const em = () => props.ctx.em.get(n.id);
  const x0 = n.x - n.w / 2;
  const y0 = n.y - n.h / 2;
  const textH = n.lines.length * 17 + n.noteLines.length * 15;
  const top = n.y - textH / 2 + (n.shape === "store" ? 3 : 0);
  const tiny = n.shape === "start" || n.shape === "end";
  const state = () => (props.ctx.live ? props.ctx.focus.nodeState(n.id) : undefined);
  const cursor = () => props.ctx.live && props.ctx.focus.active() === n.id;
  const ring = () => state() === "sel" || cursor();
  const name = () => `${props.ctx.kinds.get(n.id) ?? "Step"}: ${oneLine(n.full)}`;
  return (
    <g
      class={`vis-node ${em() ? emClass(em()) : `vis-tone-${n.tone ?? "none"}`}`}
      classList={{ "vis-flow-sel": state() === "sel", "vis-flow-near": state() === "near", "vis-flow-dim": state() === "dim", "vis-flow-cursor": cursor() }}
      id={props.ctx.live ? props.ctx.domIds.get(n.id) : undefined}
      role={props.ctx.live ? "button" : undefined}
      aria-pressed={props.ctx.live ? (state() === "sel" ? "true" : "false") : undefined}
      aria-label={props.ctx.live ? name() : undefined}
      onClick={props.ctx.live ? () => props.ctx.focus.toggle(n.id) : undefined}
    >
      <Show when={props.ctx.live && tiny}>
        <rect class="vis-flow-hit" x={n.x - Math.max(MIN_HIT, n.w) / 2} y={n.y - Math.max(MIN_HIT, n.h) / 2} width={Math.max(MIN_HIT, n.w)} height={Math.max(MIN_HIT, n.h)} />
      </Show>
      {/* The ring: an accent outline with a gap of the drawing's surface between it and the shape. */}
      <Show when={ring()}>
        <g class="vis-flow-ring" aria-hidden="true">
          {outline(n, false)}
        </g>
        <g class="vis-flow-ring-gap" aria-hidden="true">
          {outline(n, false)}
        </g>
      </Show>
      {outline(n, true)}
      <Lines lines={n.lines} x={n.x} y={top + 17 / 2} size={FLOW_FONT.label} lh={17} top class="vis-node-label" />
      <Show when={n.noteLines.length}>
        <Lines lines={n.noteLines} x={n.x} y={top + n.lines.length * 17 + 15 / 2} size={FLOW_FONT.note} lh={15} top class="vis-node-note" />
      </Show>
      <SvgEmBadge e={em()} x={n.shape === "decision" ? x0 + n.w - HEX_INSET : x0 + n.w - 3} y={y0 + 3} />
    </g>
  );
}
