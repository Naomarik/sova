import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TourMark } from "../../shared/tour";
import { tourPin } from "./tour-geometry";
const mark = (overrides: Partial<TourMark> = {}): TourMark => ({ n: 1, x: .4, y: .4, w: .1, h: .1, side: "right", label: "The target", ...overrides });

describe("tour callout geometry", () => {
  it("places the numbered pin beside—not over—the target at both recording sizes", () => {
    for (const viewport of [{ w: 1440, h: 960 }, { w: 390, h: 844 }]) {
      for (const side of ["left", "right", "top", "bottom"] as const) {
        const m = mark({ side }), p = tourPin(m, viewport);
        const overlapX = p.px + p.radius >= m.x * viewport.w && p.px - p.radius <= (m.x + m.w) * viewport.w;
        const overlapY = p.py + p.radius >= m.y * viewport.h && p.py - p.radius <= (m.y + m.h) * viewport.h;
        assert.equal(overlapX && overlapY, false, `${side} pin collides with its target at ${viewport.w}`);
        assert.equal(p.side, side);
        assert.ok(p.px !== p.tx || p.py !== p.ty, "leader has nonzero length");
      }
    }
  });
  it("switches sides near an edge instead of clipping the pin", () => {
    const p = tourPin(mark({ x: .9, side: "right" }), { w: 390, h: 844 });
    assert.notEqual(p.side, "right");
    assert.ok(p.px - p.radius >= 0 && p.px + p.radius <= 390);
  });
  it("uses the annotation gutter when the target fills the frame", () => {
    const p = tourPin(mark({ x: 0, y: 0, w: 1, h: 1 }), { w: 1440, h: 960 });
    assert.ok(p.px - p.radius > 1440 || p.px + p.radius < 0 || p.py - p.radius > 960 || p.py + p.radius < 0);
  });
});
