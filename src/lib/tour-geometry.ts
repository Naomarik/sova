import type { TourMark } from "../../shared/tour";

/** Position a pin entirely outside its target; change sides if the preferred edge has no room. */
export function tourPin(mark: TourMark, viewport: { w: number; h: number }) {
  const { w, h } = viewport;
  const radius = w < 768 ? 14 : 20;
  const gap = radius + (w < 768 ? 12 : 22);
  const x = mark.x * w, y = mark.y * h, right = (mark.x + mark.w) * w, bottom = (mark.y + mark.h) * h;
  const cx = (x + right) / 2, cy = (y + bottom) / 2;
  const sides = {
    left: { px: x - gap, py: cy, tx: x, ty: cy, room: x },
    right: { px: right + gap, py: cy, tx: right, ty: cy, room: w - right },
    top: { px: cx, py: y - gap, tx: cx, ty: y, room: y },
    bottom: { px: cx, py: bottom + gap, tx: cx, ty: bottom, room: h - bottom },
  };
  const candidates = [mark.side, ...(["right", "left", "bottom", "top"] as const).filter(s => s !== mark.side)];
  const side = candidates.find(s => sides[s].room >= gap + radius) ?? candidates.reduce((a, b) => sides[a].room > sides[b].room ? a : b);
  const pin = sides[side];
  // If a target fills the frame, keep the pin outside it in the figure's annotation gutter.
  return { ...pin, radius, side };
}
