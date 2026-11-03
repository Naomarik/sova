/**
 * The model name is the last thing to shrink, on a profile card's caption and in the composer
 * foot: where a row of glyphs runs out of room, its mode icons fold to the
 * first one and a "+N" before the model's short name loses a letter.
 *
 * The decision is always taken from the UNFOLDED layout: unfold, measure, fold again only if the
 * unfolded row doesn't fit. So it is a function of the row's width alone, the same at every
 * measurement, and a row can never oscillate between the two states (folding doesn't change the
 * box being measured, only what is drawn in it).
 */

/** One element's measured box: its content width against the width it was given. */
export type Box = { scrollWidth: number; clientWidth: number };

/**
 * How far a box's content overflows it, in px, with `slack` px of tolerance for rounding:
 * `scrollWidth` is rounded to a whole pixel, so a name that fits to a fraction can read 1px over.
 */
export const overflowOf = (b: Box | null | undefined, slack = 0): number => (b ? Math.max(0, b.scrollWidth - b.clientWidth - slack) : 0);

/**
 * Whether the unfolded row needs its mode icons folded: something it holds overflows its box (the
 * name ellipsized, a trigger clipping its icons, the row itself spilling over), and folding has
 * something to fold (more than one mode icon). Measured with the row unfolded.
 */
export function shouldFold(unfolded: readonly (Box | null | undefined)[], modeCount: number, slack = 0): boolean {
  if (foldedRest(modeCount) === 0) return false;
  return unfolded.some((b) => overflowOf(b, slack) > 0);
}

/** How many mode icons a fold hides behind "+N": all but the first, or 0 when there's nothing to fold. */
export const foldedRest = (modeCount: number): number => (modeCount > 1 ? modeCount - 1 : 0);

/** The count's text: "+3". */
export const foldLabel = (modeCount: number): string => `+${foldedRest(modeCount)}`;
