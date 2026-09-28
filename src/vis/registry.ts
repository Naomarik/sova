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
import { parseCompare } from "./kinds/compare/parse";
import { parseFlow, parseState } from "./kinds/flow/parse";
import { parseHtml, parseSvg } from "./kinds/frame/parse";
import { parseSequence } from "./kinds/sequence/parse";
import { parseStack } from "./kinds/stack/parse";
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
}

const kind = <S extends VisBase>(parse: KindEntry<S>["parse"], view: KindEntry<S>["view"], label: string, framed = false): KindEntry =>
  ({ parse, view, label, ...(framed ? { framed } : {}) }) as unknown as KindEntry;

// One line per fence word. Aliases are just more lines (state = flow with round nodes; bar/hbar/line = chart with a preset type).
export const KINDS: Record<string, KindEntry> = {
  flow: kind(parseFlow, () => import("./kinds/flow/View"), "Diagram"),
  state: kind(parseState, () => import("./kinds/flow/View"), "State diagram"),
  sequence: kind(parseSequence, () => import("./kinds/sequence/View"), "Sequence"),
  tree: kind(parseTree, () => import("./kinds/tree/View"), "Tree"),
  timeline: kind(parseTimeline, () => import("./kinds/timeline/View"), "Timeline"),
  chart: kind(parseChart(null), () => import("./kinds/chart/View"), "Chart"),
  bar: kind(parseChart("bar"), () => import("./kinds/chart/View"), "Chart"),
  hbar: kind(parseChart("hbar"), () => import("./kinds/chart/View"), "Chart"),
  line: kind(parseChart("line"), () => import("./kinds/chart/View"), "Chart"),
  stack: kind(parseStack, () => import("./kinds/stack/View"), "Layers"),
  compare: kind(parseCompare, () => import("./kinds/compare/View"), "Comparison"),
  html: kind(parseHtml, () => import("./kinds/frame/View"), "Interactive", true),
  svg: kind(parseSvg, () => import("./kinds/frame/View"), "Drawing", true),
};

export const KIND_WORDS = Object.keys(KINDS);
