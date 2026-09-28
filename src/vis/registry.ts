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
import { parseChart } from "./kinds/chart/parse";
import { parseCode } from "./kinds/code/parse";
import { estimateHeight as flowHeight } from "./kinds/flow/layout";
import { parseFlow, parseState } from "./kinds/flow/parse";
import { parseHtml, parseSvg } from "./kinds/frame/parse";
import { parseLayers } from "./kinds/layers/parse";
import { parseMatrix } from "./kinds/matrix/parse";
import { estimateHeight as sequenceHeight } from "./kinds/sequence/layout";
import { parseSequence } from "./kinds/sequence/parse";
import { parseTimeline } from "./kinds/timeline/parse";
import { parseTree } from "./kinds/tree/parse";

export interface KindEntry<S extends VisBase = VisBase> {
  /** Throws VisError (core/grammar `fail`) on anything it doesn't understand. */
  parse: (body: string) => S;
  view: () => Promise<{ default: Component<ViewProps<S>> }>;
  /** The figure's eyebrow when the spec has no title, and its accessible name fallback. */
  label: string;
  /** Free-form kinds: model-written documents in a sandboxed frame; Source shows them as HTML. */
  framed?: boolean;
  /**
   * Not ready to be taught: its vis-mode.md section must carry the `<!-- stub -->` marker (so the
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
  layers: kind(parseLayers, view("layers"), "Layers"),
  tree: kind(parseTree, view("tree"), "Tree"),
  chart: kind(parseChart, view("chart"), "Chart"),
  timeline: kind(parseTimeline, view("timeline"), "Timeline"),
  matrix: kind(parseMatrix, view("matrix"), "Matrix"),
  code: kind(parseCode, view("code"), "Code"),
  html: kind(parseHtml, view("frame"), "Interactive", { framed: true }),
  svg: kind(parseSvg, view("frame"), "Drawing", { framed: true }),
};

export const KIND_WORDS = Object.keys(KINDS);
