/**
 * A sectioned `vis flow` / `vis state` (`== label ==` lines): each panel is its own graph, laid out
 * by ./layout on its own. The panels sit side by side, top-aligned, when all of them fit the pane
 * at their natural size; otherwise they stack, each fitted to the full width as a lone flow is. Each
 * panel has its label above it. Pure; the height repeats flow.css' panel metrics (keep in step).
 */

import { canvasMeasure, wrap, type Measure } from "../../core/text";
import { htmlMeasure, type WeightedMeasure } from "../tree/measure";
import { fitFlow, layoutFlow, scrolledHeight, type FlowLayout } from "./layout";
import type { FlowSpec } from "./parse";

/** flow.css: a panel's head (fs-caption 12.5 semibold, 18px lines, 4px under it); 24px between panels side by side, 16px stacked. */
export const SECTION_CSS = { px: 12.5, line: 18, below: 4, gapRow: 24, gapColumn: 16 };

export interface PlacedSection {
  label: string;
  layout: FlowLayout;
  /** The panel's width side by side: its drawing, or its head if that is wider. */
  width: number;
}
export interface SectionsLayout {
  /** Side by side, or one under another. */
  row: boolean;
  panels: PlacedSection[];
}

const sub = (spec: FlowSpec, i: number): FlowSpec => ({ kind: "flow", dir: spec.dir, nodes: spec.sections![i]!.nodes, edges: spec.sections![i]!.edges });

/** Each panel's natural layout: the View's memo, so a resize only re-fits. */
export function naturalSections(spec: FlowSpec, measure: Measure = canvasMeasure): FlowLayout[] {
  return spec.sections!.map((_, i) => layoutFlow(sub(spec, i), measure));
}

/** The panels FlowView draws in a pane `width` px wide (0: not measured yet, side by side). */
export function layoutSections(spec: FlowSpec, width: number, measure: Measure = canvasMeasure, head: WeightedMeasure = htmlMeasure, natural = naturalSections(spec, measure)): SectionsLayout {
  const secs = spec.sections!;
  const headW = (label: string) => Math.ceil(head(600)(label, SECTION_CSS.px));
  const side = secs.map((s, i) => ({ label: s.label, layout: natural[i]!, width: Math.max(natural[i]!.width, headW(s.label)) }));
  const rowWidth = side.reduce((a, p) => a + p.width, 0) + SECTION_CSS.gapRow * (secs.length - 1);
  if (width <= 0 || rowWidth <= width) return { row: true, panels: side };
  return { row: false, panels: secs.map((s, i) => ({ label: s.label, layout: fitFlow(sub(spec, i), measure, width, natural[i]!), width })) };
}

/** A panel's head height at `width`: its label, wrapped as the browser will. */
const headHeight = (label: string, width: number, head: WeightedMeasure) => wrap(label, Math.max(1, width), 99, SECTION_CSS.px, head(600)).length * SECTION_CSS.line + SECTION_CSS.below;

/** The px height FlowView renders a sectioned flow at in a body `width` px wide. */
export function sectionsHeight(spec: FlowSpec, width: number, measure: Measure = canvasMeasure, head: WeightedMeasure = htmlMeasure): number {
  const l = layoutSections(spec, width, measure, head);
  if (l.row) return Math.max(...l.panels.map((p) => headHeight(p.label, p.width, head) + p.layout.height));
  return l.panels.reduce((a, p) => a + headHeight(p.label, width, head) + scrolledHeight(p.layout, width), 0) + SECTION_CSS.gapColumn * (l.panels.length - 1);
}
