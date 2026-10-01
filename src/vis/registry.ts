/**
 * THE list of `vis` kinds. A kind is a fence word mapped to its parser (pure, node-testable) and a
 * lazily imported View (Solid). Adding a kind is one line here plus its own directory under
 * kinds/; nothing else in the app changes. The View is imported lazily so this file (and
 * markdown.ts, which parses fences through it) stays free of Solid and CSS, and runs under
 * `tsx --test`.
 */

import type { Component } from "solid-js";
import type { VisBase } from "./core/grammar";
import type { ViewProps } from "./types";
import { estimateHeight as chartHeight } from "./kinds/chart/layout";
import { parseChart, type ChartType } from "./kinds/chart/parse";
import { estimateHeight as codeHeight } from "./kinds/code/layout";
import { parseCode } from "./kinds/code/parse";
import { estimateHeight as flowHeight } from "./kinds/flow/layout";
import { parseFlow, parseState } from "./kinds/flow/parse";
import { estimateHeight as frameHeight } from "./kinds/frame/height";
import { parseHtml, parseSvg } from "./kinds/frame/parse";
import { estimateHeight as layersHeight } from "./kinds/layers/height";
import { parseLayers } from "./kinds/layers/parse";
import { estimateHeight as matrixHeight } from "./kinds/matrix/height";
import { parseMatrix } from "./kinds/matrix/parse";
import { estimateHeight as sequenceHeight } from "./kinds/sequence/layout";
import { parseSequence } from "./kinds/sequence/parse";
import { estimateHeight as stepsHeight } from "./kinds/steps/height";
import { parseSteps } from "./kinds/steps/parse";
import { estimateHeight as timelineHeight } from "./kinds/timeline/height";
import { parseTimeline } from "./kinds/timeline/parse";
import { estimateHeight as treeHeight } from "./kinds/tree/height";
import { parseTree } from "./kinds/tree/parse";
import { estimateHeight as wireframeHeight } from "./kinds/wireframe/layout";
import { parseWireframe } from "./kinds/wireframe/parse";

export interface KindEntry<S extends VisBase = VisBase> {
  /** Throws VisError (core/grammar `fail`) on anything it doesn't understand. */
  parse: (body: string) => S;
  view: () => Promise<{ default: Component<ViewProps<S>> }>;
  /** The figure's eyebrow when the spec has no title, and its accessible name fallback. */
  label: string;
  /** Free-form kinds: model-written documents in a sandboxed frame; Source shows them as HTML. */
  framed?: boolean;
  /**
   * Not ready to be taught: its file in pi-config/extensions/mode/vis/ must carry the `<!-- stub -->` marker (so the
   * model never hears of it; guide.test.ts checks), and its View may be `() => import("./StubView")`.
   */
  stub?: boolean;
  /**
   * The drawing's height in px when `.vis-body`'s content box is `width` wide: the shell reserves
   * it before the View mounts, so nothing below moves. Pure (the kind's parse/layout side).
   */
  size?: (spec: S, width: number) => number;
}

type Opts<S extends VisBase> = { framed?: boolean; stub?: boolean; size?: KindEntry<S>["size"] };
type ViewName = keyof typeof import("./views");
/** One View out of views.ts: every kind shares that one chunk, loaded the first time any is drawn. */
const view =
  (name: ViewName) =>
  () =>
    import("./views").then((m) => ({ default: m[name] as Component<ViewProps<VisBase>> }));
const kind = <S extends VisBase>(parse: KindEntry<S>["parse"], view: KindEntry<S>["view"], label: string, opts: Opts<S> = {}): KindEntry =>
  ({ parse, view, label, ...opts }) as unknown as KindEntry;

// One line per fence word, in the order the guide presents them. `state` reuses flow's parser and View.
export const KINDS: Record<string, KindEntry> = {
  flow: kind(parseFlow, view("flow"), "Diagram", { size: flowHeight }),
  sequence: kind(parseSequence, view("sequence"), "Sequence", { size: sequenceHeight }),
  state: kind(parseState, view("flow"), "State machine", { size: flowHeight }),
  layers: kind(parseLayers, view("layers"), "Layers", { size: (spec, width) => layersHeight(spec, width) }),
  tree: kind(parseTree, view("tree"), "Tree", { size: (spec, width) => treeHeight(spec, width) }),
  chart: kind(parseChart, view("chart"), "Chart", { size: (spec, width) => chartHeight(spec, width) }),
  timeline: kind(parseTimeline, view("timeline"), "Timeline", { size: (spec, width) => timelineHeight(spec, width) }),
  steps: kind(parseSteps, view("steps"), "Steps", { size: (spec, width) => stepsHeight(spec, width) }),
  wireframe: kind(parseWireframe, view("wireframe"), "Wireframe", { size: (spec, width) => wireframeHeight(spec, width) }),
  matrix: kind(parseMatrix, view("matrix"), "Matrix", { size: (spec, width) => matrixHeight(spec, width) }),
  code: kind(parseCode, view("code"), "Code", { size: codeHeight }),
  html: kind(parseHtml, view("frame"), "Interactive", { framed: true, size: frameHeight }),
  svg: kind(parseSvg, view("frame"), "Drawing", { framed: true, size: frameHeight }),
};

export const KIND_WORDS = Object.keys(KINDS);

/**
 * Other words models write for a kind (`vis flowchart`, `vis table`): drawn as that kind, never
 * taught. A chart type's word draws a chart of that type unless its `type:` says otherwise.
 */
const chartOf = (type: ChartType) => (body: string) => parseChart(body, type);
export const KIND_ALIASES: Readonly<Record<string, { kind: string; parse?: (body: string) => VisBase }>> = {
  flowchart: { kind: "flow" }, graph: { kind: "flow" }, diagram: { kind: "flow" }, architecture: { kind: "flow" },
  sequencediagram: { kind: "sequence" }, seq: { kind: "sequence" },
  statediagram: { kind: "state" }, "statediagram-v2": { kind: "state" }, states: { kind: "state" }, fsm: { kind: "state" }, statemachine: { kind: "state" },
  stack: { kind: "layers" },
  hierarchy: { kind: "tree" }, filetree: { kind: "tree" }, files: { kind: "tree" },
  table: { kind: "matrix" }, comparison: { kind: "matrix" }, compare: { kind: "matrix" },
  mockup: { kind: "wireframe" }, ui: { kind: "wireframe" }, screen: { kind: "wireframe" }, wire: { kind: "wireframe" },
  journey: { kind: "steps" }, scenarios: { kind: "steps" },
  bar: { kind: "chart" }, line: { kind: "chart", parse: chartOf("line") }, scatter: { kind: "chart", parse: chartOf("scatter") }, stacked: { kind: "chart", parse: chartOf("stacked") }, parts: { kind: "chart", parse: chartOf("parts") }, pie: { kind: "chart", parse: chartOf("parts") },
};

/** The registry word a fence word draws as (itself, or an alias's kind); unknown words are returned as they are. */
export const canonicalKind = (word: string): string => (Object.hasOwn(KINDS, word) ? word : Object.hasOwn(KIND_ALIASES, word) ? KIND_ALIASES[word]!.kind : word);
