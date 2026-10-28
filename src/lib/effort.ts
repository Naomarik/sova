import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/profiles";
import { modelLabel, modelProvider } from "./format";
import { RING_ARC } from "./waiting";

/**
 * The effort ring (§chat.composer/behavior): the waiting badge's 270° open ring, small, its arc
 * filled on one seven-step scale for every model (off empty, max the full arc), with a mark in the
 * middle. Pure: the step, the arc's length and the mark.
 */

export type EffortMark = { kind: "none" } | { kind: "dot" } | { kind: "letter"; text: string } | { kind: "bolt" };

/** The level's step on the scale, 0 (off) to 6 (max); null for a level the scale doesn't know. */
export function effortStep(level: string | null | undefined): number | null {
  const i = (THINKING_LEVELS as readonly string[]).indexOf(level ?? "");
  return i >= 0 ? i : null;
}

/** How much of the 270° arc the level fills, 0 (off) to 1 (max); 0 for an unknown level. */
export function effortFill(level: string | null | undefined): number {
  const step = effortStep(level);
  return step === null ? 0 : step / (THINKING_LEVELS.length - 1);
}

/** The filled arc's length in the ring's units (RING_ARC is the whole 270°). */
export const effortArcLength = (level: string | null | undefined): number => effortFill(level) * RING_ARC;

const LETTERS: Partial<Record<ThinkingLevel, string>> = { low: "L", medium: "M", high: "H", xhigh: "X" };

/** The middle mark: off none, minimal a dot, low L, medium M, high H, xhigh X, max a bolt. */
export function effortMark(level: string | null | undefined): EffortMark {
  if (level === "minimal") return { kind: "dot" };
  if (level === "max") return { kind: "bolt" };
  const text = LETTERS[level as ThinkingLevel];
  return text ? { kind: "letter", text } : { kind: "none" };
}

/**
 * The model panel's summary line (§chat.composer/composer-flyout): "{model} · {backend} · {effort}"
 * ("Opus 5.5 · claude-code-cli · high"); the effort left out when `level` is null (no choice of it).
 * Null with no model.
 */
export function modelSummaryLine(ref: string | null | undefined, level: string | null | undefined): string | null {
  if (!ref) return null;
  return [modelLabel(ref) ?? ref, modelProvider(ref) || null, level || null].filter(Boolean).join(" · ");
}
