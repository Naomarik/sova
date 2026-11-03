/** Where a view coming back to rows gained while away stops: the scrollTop that puts the last row
    read's bottom at the bottom of the view, clamped to what the view can scroll to; or null when
    that spot is within `followPx` of the end (a transcript that fits, or overflows by less than
    `followPx`), so the view stays at the end, following. `rowBelow` is how far the row's bottom is
    below the view's bottom now (negative above it). */
export function readHoldTop(view: { scrollTop: number; scrollHeight: number; clientHeight: number }, rowBelow: number, followPx: number): number | null {
  const max = Math.max(0, view.scrollHeight - view.clientHeight);
  const land = Math.min(Math.max(0, view.scrollTop + rowBelow), max);
  return max - land < followPx ? null : land;
}
