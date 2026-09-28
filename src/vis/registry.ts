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
import { parseFlow, parseState } from "./kinds/flow/parse";
import { parseHtml, parseSvg } from "./kinds/frame/parse";
import { parseGitgraph } from "./kinds/gitgraph/parse";
import { parseLayers } from "./kinds/layers/parse";
import { parseMatrix } from "./kinds/matrix/parse";
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
   * model never hears of it; guide.test.ts checks), and its View may be StubView.
   */
  stub?: boolean;
}

type Opts = { framed?: boolean; stub?: boolean };
const kind = <S extends VisBase>(parse: KindEntry<S>["parse"], view: KindEntry<S>["view"], label: string, opts: Opts = {}): KindEntry =>
  ({ parse, view, label, ...opts }) as unknown as KindEntry;
const stubView = () => import("./StubView");

// One line per fence word, in the order the guide presents them. `state` reuses flow's parser and View.
export const KINDS: Record<string, KindEntry> = {
  flow: kind(parseFlow, () => import("./kinds/flow/View"), "Diagram"),
  sequence: kind(parseSequence, () => import("./kinds/sequence/View"), "Sequence"),
  state: kind(parseState, () => import("./kinds/flow/View"), "State machine"),
  layers: kind(parseLayers, () => import("./kinds/layers/View"), "Layers"),
  tree: kind(parseTree, () => import("./kinds/tree/View"), "Tree"),
  gitgraph: kind(parseGitgraph, stubView, "Git history", { stub: true }),
  chart: kind(parseChart, () => import("./kinds/chart/View"), "Chart"),
  timeline: kind(parseTimeline, () => import("./kinds/timeline/View"), "Timeline"),
  matrix: kind(parseMatrix, () => import("./kinds/matrix/View"), "Matrix"),
  code: kind(parseCode, stubView, "Code", { stub: true }),
  html: kind(parseHtml, () => import("./kinds/frame/View"), "Interactive", { framed: true }),
  svg: kind(parseSvg, () => import("./kinds/frame/View"), "Drawing", { framed: true }),
};

export const KIND_WORDS = Object.keys(KINDS);
