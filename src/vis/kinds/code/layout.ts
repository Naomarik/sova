/**
 * `vis code` geometry, shared by View.tsx (which sets it as the block's height) and the shell (which
 * reserves it before the View loads). The height depends only on the line count: the block's bottom
 * padding is deep enough to hold a horizontal scrollbar, so a long line never changes it, whatever the
 * platform's scrollbar. Keep these in step with code.css and tokens.css (--fs-mono, --lh-mono).
 */
import type { CodeSpec } from "./parse";

/** --fs-mono × --lh-mono: one code line. */
export const LINE_PX = 12.5 * 1.5;
export const PAD_TOP_PX = 8;
/** At least a classic scrollbar's thickness (thin: 8–11px), which overlays it instead of growing the block. */
export const PAD_BOTTOM_PX = 12;
/** The block's bottom border (--stroke-thin). */
export const BORDER_PX = 1;

/** The drawing's height in px; the same at every width. */
export function estimateHeight(spec: CodeSpec, _width: number): number {
  return Math.ceil(PAD_TOP_PX + spec.lines.length * LINE_PX + PAD_BOTTOM_PX + BORDER_PX);
}
