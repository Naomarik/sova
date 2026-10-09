// Draws the Vis page's examples with Sova's own vis code, to static HTML. Loaded by
// ../vis-examples.mjs through Vite's SSR loader, so the app's Solid components run on the server:
// the figure shell (Figure.tsx) and each kind's View, exactly as the chat mounts them, with no
// Source or Copy (as on a share page). Nothing here re-implements a kind.
import { createComponent, type Component } from "solid-js";
import { renderToString } from "solid-js/web";
import type { VisBase } from "../../../src/vis/core/grammar";
import { Figure } from "../../../src/vis/Figure";
import type { FrameSpec } from "../../../src/vis/kinds/frame/parse";
import { parseVis } from "../../../src/vis/parse";
import { KINDS } from "../../../src/vis/registry";
import type { ViewProps } from "../../../src/vis/types";
import * as views from "../../../src/vis/views";

export interface Example {
  kind: string;
  source: string;
}

export interface Rendered {
  kind: string;
  /** The figure's HTML, or null for a kind shown as source only. */
  figure: string | null;
}

/**
 * `vis svg`: the frame's document drawn in place. The chat puts it in a sandboxed frame (srcdoc.ts)
 * whose body pads it by 12px and centres it at its natural size; this is the same box, without the
 * frame, for an example the page wrote itself. Its colours are the theme tokens, so it follows the
 * site's theme like the frame does.
 */
const SvgInPlace: Component<ViewProps<FrameSpec>> = (props) => <div class="vis-frame-static" innerHTML={props.spec.source} />;

/** Which View draws each fence word, as registry.ts maps them (state is flow's View). */
const VIEW_OF = {
  flow: views.flow,
  state: views.flow,
  sequence: views.sequence,
  layers: views.layers,
  tree: views.tree,
  chart: views.chart,
  timeline: views.timeline,
  steps: views.steps,
  wireframe: views.wireframe,
  matrix: views.matrix,
  code: views.code,
  svg: SvgInPlace,
} as unknown as Record<string, Component<ViewProps<VisBase>>>;

/** Kinds the page shows as source only: an html block's first state is whatever its script draws. */
export const SOURCE_ONLY = new Set(["html"]);

/**
 * The widths a View lays out for, as the content box of `.vis-body` it would measure in the
 * browser: the docs column, and a 320px phone. ../vis-examples.mjs feeds the View the width
 * (`__VIS_WIDTH__`) where the app measures it, and the page shows the one that fits its pane.
 */
export const WIDTHS = { wide: 640, narrow: 270 } as const;

const BODY = "\u0000vis-body\u0000";
const Placeholder: Component = () => BODY;

declare global {
  // eslint-disable-next-line no-var
  var __VIS_WIDTH__: number;
}

function drawAt(view: Component<ViewProps<VisBase>>, spec: VisBase, label: string, width: number): string {
  globalThis.__VIS_WIDTH__ = width;
  return renderToString(() => createComponent(view, { spec, label }));
}

export function renderExamples(examples: Example[]): Rendered[] {
  const seen = new Set<string>();
  return examples.map(({ kind, source }) => {
    if (!Object.hasOwn(KINDS, kind)) throw new Error(`vis ${kind}: not a kind in the registry`);
    if (seen.has(kind)) throw new Error(`vis ${kind}: a second example of the same kind`);
    seen.add(kind);
    const r = parseVis(kind, source);
    if (!r.ok) throw new Error(`vis ${kind}: line ${r.line}: ${r.message}`);
    if (r.warnings.length) throw new Error(`vis ${kind}: drawn with warnings: ${r.warnings.map((w) => `line ${w.line}: ${w.message}`).join("; ")}`);
    if (SOURCE_ONLY.has(kind)) return { kind, figure: null };
    const view = VIEW_OF[kind];
    if (!view) throw new Error(`vis ${kind}: no View for this kind in render.tsx`);
    // The shell once, the drawing at each width; the same label Figure gives the View.
    const shell = renderToString(() => <Figure kind={kind} spec={r.spec} view={Placeholder} />);
    if (shell.split(BODY).length !== 2) throw new Error(`vis ${kind}: the figure shell didn't draw its View once`);
    const label = r.spec.title ?? r.spec.caption ?? KINDS[kind]!.label;
    const wide = drawAt(view, r.spec, label, WIDTHS.wide);
    const narrow = drawAt(view, r.spec, label, WIDTHS.narrow);
    const body = wide === narrow ? wide : `<div class="vis-at-wide">${wide}</div><div class="vis-at-narrow">${narrow}</div>`;
    return { kind, figure: shell.replace(BODY, body) };
  });
}

/** Every kind in the registry, for the generator's check that the page covers them all. */
export const kindWords = (): string[] => Object.keys(KINDS);
