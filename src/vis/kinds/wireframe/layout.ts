/**
 * `vis wireframe`: the strip's geometry and the drawing's height at a given `.vis-body` content
 * width, before the View draws, so the figure can reserve its space. It repeats wireframe.css's
 * fixed sizes (keep the two in step): frames 300px (phone) and 760px (desktop) wide at most, 40px apart;
 * 12.5px text on 18px lines; a fixed height per control. A row takes its tallest child, a frame the
 * taller of its page and its overlay. Pure: no DOM.
 */

import { wrap } from "../../core/text";
import { htmlMeasure, type Measure, type WeightedMeasure } from "../tree/measure";
import { isContainer, type Device, type WBlock, type WireframeSpec, type WScreen } from "./parse";

export const FRAME_WIDTH = { phone: 300, desktop: 760 } as const;
/** The figure is phone-sized at a content width up to this (vis.css: a body padding of 8px, not 12px). */
const NARROW = 402;
const MIN_WIDTH = { phone: 240, desktop: 560 } as const;
export const FRAME_GAP = 40;
/** The strip's padding, each side, for one screen (several: 14px above for the arrows' lane, 22px after the last). */
const STRIP_PAD = 6;
/** wireframe.css's frame width at a `.vis-body` content width: `clamp(min, 100cqi - inset, max)`, where 100cqi is the
 * content width plus the body's padding and the inset is that padding plus the strip's (6px each side): the width less 12. */
export const frameWidth = (device: Device, width: number) => Math.min(FRAME_WIDTH[device], Math.max(MIN_WIDTH[device], width - 2 * STRIP_PAD));
const BORDER = 3;
const SIDEBAR = 200;
const GAP = 8;
const LINE = 18;
const SMALL = 16;
const BODY_PX = 12.5;
const SMALL_PX = 11;
/** The row of screen buttons (36px). */
const NAV_ROW = 36;
const NAME_ROW = 20 + 6;

/** The strip's width with these frame widths (its natural width by default): every frame side by side, with the gaps and the padding. */
export const stripWidth = (spec: WireframeSpec, width = Infinity, widths = spec.screens.map((s) => frameWidth(s.device, width))): number =>
  widths.reduce((a, w) => a + w, 0) + FRAME_GAP * Math.max(0, spec.screens.length - 1) + (spec.screens.length > 1 ? 6 + (width <= NARROW ? 6 : 22) : 2 * STRIP_PAD);

/** Several screens are scaled to fit the pane whole when that takes them to no less than this. */
export const MIN_STRIP_SCALE = 0.75;

/**
 * How the drawing fits a pane `width` wide. A frame never pans inside itself: one wider than the pane
 * (a desktop frame at its 560px least, on a phone) is scaled to fit it (`frames`). Several screens
 * wider than the pane are scaled whole (`strip`) when that keeps them at 3/4 size or more; otherwise
 * the strip `scrolls` between screens, with the screen buttons above it.
 */
export interface Fit {
  /** Each frame's width, before any scale. */
  widths: number[];
  strip: number;
  frames: number[];
  scrolls: boolean;
}

export function fitStrip(spec: WireframeSpec, width: number): Fit {
  const widths = spec.screens.map((s) => frameWidth(s.device, width));
  const ones = spec.screens.map(() => 1);
  if (stripWidth(spec, width, widths) <= width) return { widths, strip: 1, frames: ones, scrolls: false };
  if (spec.screens.length > 1) {
    // Scaled whole, the frames at their narrowest, so the scale is as large as it can be.
    const least = spec.screens.map((s) => MIN_WIDTH[s.device]);
    const scale = Math.min(1, width / stripWidth(spec, width, least));
    if (scale >= MIN_STRIP_SCALE) return { widths: least, strip: scale, frames: ones, scrolls: false };
  }
  const room = width - 2 * STRIP_PAD;
  return { widths, strip: 1, frames: widths.map((w) => Math.min(1, room / w)), scrolls: spec.screens.length > 1 };
}

export function estimateHeight(spec: WireframeSpec, width: number, measure: WeightedMeasure = htmlMeasure): number {
  const m = { r: measure(400), b: measure(600) };
  const named = spec.screens.length > 1 || spec.screens.some((s) => s.name !== undefined);
  const names = spec.screens.map((s, i) => s.name ?? `Screen ${i + 1}`);
  const fit = fitStrip(spec, width);
  const tallest = Math.max(...spec.screens.map((s, i) => fit.frames[i]! * frameHeight(s, m, fit.widths[i]!, names)));
  // The screen buttons: one line (it scrolls sideways if it must), 8px above the strip.
  const nav = fit.scrolls ? NAV_ROW + GAP : 0;
  const pad = spec.screens.length > 1 ? 14 + 6 : 2 * STRIP_PAD;
  return Math.ceil(nav + fit.strip * (pad + (named ? NAME_ROW : 0) + tallest));
}

type M = { r: Measure; b: Measure };

const lines = (s: string, w: number, px: number, measure: Measure) => (s ? wrap(s, Math.max(20, w), 99, px, measure).length : 0);

function frameHeight(s: WScreen, m: M, frame: number, names: string[]): number {
  const desktop = s.device === "desktop";
  const chrome = desktop ? 22 : 18;
  const side = desktop ? s.blocks.find((b) => b.type === "sidebar") : undefined;
  const inner = frame - BORDER;
  const pad = side ? 12 : 10;
  const mainW = inner - (side ? SIDEBAR : 0) - 2 * pad;
  const overlay = s.blocks.filter((b) => b.type === "modal" || b.type === "sheet" || b.type === "toast");
  const bottom = s.blocks.filter((b) => b.type === "tabbar" || b.type === "footer");
  // A header before the sidebar spans the frame, over the sidebar and the page.
  const top = side && s.blocks[0]?.type === "header" ? s.blocks[0] : undefined;
  const flow = s.blocks.filter((b) => b !== side && b !== top && !overlay.includes(b) && !bottom.includes(b));
  const ctx: Ctx = { m, desktop, names };
  // A header bleeds into the page's padding, so it adds its own height less that padding.
  let main = stack(flow, mainW, ctx) + 2 * pad;
  if (flow[0]?.type === "header" || flow[0]?.type === "sidebar") main -= pad;
  if (bottom.length) main += -pad + bottom.reduce((h, b) => h + block(b, mainW, ctx), 0);
  const sideH = side ? 24 + stack(side.children, SIDEBAR - 20, ctx) + (side.texts[0] ? LINE + GAP : 0) : 0;
  const over = Math.max(0, ...overlay.map((b) => (b.type === "sheet" ? 40 : b.type === "toast" ? 60 : 32) + block(b, b.type === "modal" ? (desktop ? 360 : inner - 36) : inner - 24, ctx)));
  const topH = top ? block(top, inner - 24, ctx) : 0;
  return chrome + BORDER + Math.max(topH + Math.max(main, sideH), over);
}

type Ctx = { m: M; desktop: boolean; names: string[] };

/** The width of a block's "→ 2 Name" chip and the 6px before it (0 without one): 120px at most. */
const goWidth = (b: WBlock, ctx: Ctx) =>
  b.to !== undefined ? 6 + Math.min(120, 16 + ctx.m.b(`→ ${b.to + 1} `, SMALL_PX) + ctx.m.r(ctx.names[b.to] ?? "", SMALL_PX)) : b.toName ? 6 + Math.min(120, 16 + ctx.m.r(`→ ${b.toName}`, SMALL_PX)) : 0;

/**
 * A button: its label inside 14px padding, 4px above and below, and a 1.5px border. A chip that doesn't fit
 * beside the label wraps under it (2px apart). `oneLine` (in a row): the label never wraps, it is cut short.
 */
function button(b: WBlock, w: number, ctx: Ctx, oneLine: boolean): number {
  const label = b.texts.join(" · ") || "Button";
  const go = goWidth(b, ctx);
  const under = go > 0 && 31 + ctx.m.b(label, BODY_PX) + go > w;
  const n = oneLine ? 1 : lines(label, w - 31 - (under ? 0 : go), BODY_PX, ctx.m.b);
  return Math.max(34, 3 + 8 + LINE * n + (under ? 2 + 18 : 0));
}

/** Blocks one under another, 8px apart; the chip of a badge or an avatar is a block of its own beside them. */
const stack = (bs: WBlock[], w: number, ctx: Ctx) =>
  bs.length ? bs.reduce((h, b) => h + block(b, w, ctx) + ((b.type === "badge" || b.type === "avatar") && goWidth(b, ctx) ? GAP + CHIP : 0), 0) + GAP * (bs.length - 1) : 0;

const CHIP = 18;
/** The gap between an item's blocks at its right, and between those of a row among them. */
const TRAIL_GAP = 6;

/** A block's own width on one line: a button or a badge its label's, a toggle its switch and label; a row the sum of its blocks. */
function ownWidth(c: WBlock, ctx: Ctx): number {
  const { m } = ctx;
  const label = c.texts.join(" · ");
  const go = goWidth(c, ctx);
  switch (c.type) {
    case "button":
      return 31 + m.b(label || "Button", BODY_PX) + go;
    case "badge":
      return 16 + m.r(label, SMALL_PX) + go;
    case "toggle":
    case "checkbox":
    case "radio":
      return (c.type === "toggle" ? 30 : 14) + (label ? 8 + m.r(label, BODY_PX) : 0);
    case "icon":
      return 16 + go;
    case "avatar":
      return 32 + go;
    case "link":
      return m.r(label, BODY_PX) + go;
    case "row":
      return widthOf(c.children, TRAIL_GAP, ctx) + go;
    default:
      return 60;
  }
}

const widthOf = (bs: WBlock[], gap: number, ctx: Ctx) => bs.reduce((a, c) => a + ownWidth(c, ctx), 0) + gap * Math.max(0, bs.length - 1);

/** Blocks at their own widths, wrapping into lines `w` wide, 6px apart; a line is as tall as its tallest, a row wraps inside itself. */
function packed(bs: WBlock[], w: number, ctx: Ctx): number {
  const lines: number[] = [];
  let x = Infinity;
  for (const c of bs) {
    const cw = Math.min(w, ownWidth(c, ctx));
    const h = c.type === "row" ? packed(c.children, cw, ctx) : c.type === "button" ? button(c, cw, ctx, true) : block(c, cw, ctx);
    if (x + TRAIL_GAP + cw > w) {
      lines.push(h);
      x = cw;
    } else {
      lines[lines.length - 1] = Math.max(lines[lines.length - 1]!, h);
      x += TRAIL_GAP + cw;
    }
  }
  return lines.reduce((a, h) => a + h, 0) + TRAIL_GAP * Math.max(0, lines.length - 1);
}
/** Where a block's chip goes on a line of its own under its content: the gap before it. */
const CHIP_UNDER: Record<string, number> = { stat: 0, chart: 4, progress: 4, input: 3, select: 3, search: 3, empty: 4, loading: 6, list: 0, table: 3 };

function block(b: WBlock, w: number, ctx: Ctx): number {
  const h = blockOwn(b, w, ctx);
  const under = CHIP_UNDER[b.type];
  if (under !== undefined && goWidth(b, ctx)) return h + under + CHIP;
  // A row with nothing in it but its chip is as tall as the chip.
  if (b.type === "row" && goWidth(b, ctx)) return Math.max(h, CHIP);
  return h;
}

function blockOwn(b: WBlock, w: number, ctx: Ctx): number {
  const { m } = ctx;
  const t = b.texts;
  const body = (s: string | undefined, width = w) => LINE * lines(s ?? "", width, BODY_PX, m.r);
  const small = (s: string | undefined, width = w) => SMALL * lines(s ?? "", width, SMALL_PX, m.r);
  const kids = (width: number) => (b.children.length ? stack(b.children, width, ctx) : 0);
  switch (b.type) {
    case "header": {
      // The title takes what the icons and buttons beside it leave (the header bleeds 10px into the page's padding).
      // The controls at its right take their labels' width, 70% at most; the title wraps between words in the rest.
      const trail = b.children.filter((c) => !(c.type === "icon" && /^(back|menu|←|hamburger|arrow-left)$/i.test(c.texts[0] ?? "")));
      const lead = b.children.filter((c) => !trail.includes(c));
      const end = Math.min(0.7 * w, trail.reduce((a, c) => a + 8 + goWidth(c, ctx) + (c.type === "button" ? 23 + m.b(c.texts.join(" · ") || "Button", BODY_PX) : c.type === "avatar" ? 32 : 16), 0));
      const tw = Math.max(40, w - end - goWidth(b, ctx) - lead.reduce((a, c) => a + 8 + 16 + goWidth(c, ctx), 0));
      return Math.max(40, 12 + 22 * Math.max(1, lines(t[0] ?? "", tw, 14.5, m.b)) + small(t[1], tw));
    }
    case "tabs":
      return 30;
    case "tabbar":
      return 48;
    case "footer":
      return Math.max(34, 12 + (t.length ? 14 : 0) + (b.children.length ? Math.max(...b.children.map((c) => block(c, w / b.children.length, ctx))) : 0));
    case "sidebar":
    case "col":
    case "modal":
    case "sheet": {
      const padY = b.type === "modal" ? 24 + 3 : b.type === "sheet" ? 30 + 1.5 : b.type === "sidebar" ? 20 : 0;
      const padX = b.type === "modal" || b.type === "sheet" ? 24 : b.type === "sidebar" ? 20 : 0;
      const parts = [t[0] ? body(t[0], w - padX) : 0, t[1] ? small(t.slice(1).join(" · "), w - padX) : 0, kids(w - padX)].filter((h) => h > 0);
      return padY + parts.reduce((a, h) => a + h, 0) + GAP * Math.max(0, parts.length - 1);
    }
    case "row": {
      if (!b.children.length) return 0;
      const per = Math.min(4, b.children.length);
      // Beside other blocks a button or a badge takes its label's width (up to half the row); the rest share what's left.
      const mixed = b.children.some((c) => c.type !== "button");
      const own = (c: WBlock) => (mixed && (c.type === "button" || c.type === "badge") ? Math.min(0.5 * w, ownWidth(c, ctx)) : 0);
      let h = 0;
      for (let i = 0; i < b.children.length; i += per) {
        const line = b.children.slice(i, i + per);
        const fixed = line.reduce((a, c) => a + own(c), 0);
        const shares = line.reduce((a, c) => a + (own(c) ? 0 : c.wide ? 2 : 1), 0) || 1;
        const each = (w - GAP * (per - 1) - fixed) / shares;
        // Past 4 the row wraps, and every block takes a quarter.
        const width = (c: WBlock) => (b.children.length > 4 ? (w - GAP * 3) / 4 : own(c) || each * (c.wide ? 2 : 1));
        h += (i ? GAP : 0) + Math.max(...line.map((c) => (c.type === "button" ? button(c, width(c), ctx, true) : block(c, width(c), ctx))));
      }
      return h;
    }
    case "grid": {
      // Tiles fill rows of 2 (phone) or 4 (desktop) in order; a wide one spans 2, and starts a new row
      // if it doesn't fit the rest of this one. The grid's own chip takes the next cell.
      const cols = ctx.desktop ? 4 : 2;
      const cw = (w - GAP * (cols - 1)) / cols;
      const cells = b.children.map((c) => ({ span: c.wide ? Math.min(2, cols) : 1, h: (span: number) => block(c, cw * span + GAP * (span - 1), ctx) }));
      if (goWidth(b, ctx)) cells.push({ span: 1, h: () => CHIP });
      const rows: number[] = [];
      let used = cols;
      for (const cell of cells) {
        if (used + cell.span > cols) {
          rows.push(0);
          used = 0;
        }
        rows[rows.length - 1] = Math.max(rows[rows.length - 1]!, cell.h(cell.span));
        used += cell.span;
      }
      return rows.reduce((a, h) => a + h, 0) + GAP * Math.max(0, rows.length - 1);
    }
    case "card": {
      const iw = w - 22;
      const parts = [t[0] || b.to !== undefined || b.toName ? body(t[0] || " ", iw - goWidth(b, ctx)) : 0, t[1] ? small(t.slice(1).join(" · "), iw) - 6 : 0, kids(iw)].filter((h) => h > 0);
      return 18 + parts.reduce((a, h) => a + h, 0) + GAP * Math.max(0, parts.length - 1);
    }
    case "list":
      return 2 + (t[0] ? 22 : 0) + b.children.reduce((h, c) => h + (c.type === "item" ? block(c, w - 2, ctx) : 12 + block(c, w - 22, ctx)), 0) + Math.max(0, b.children.length - 1);
    case "item": {
      // One line: the lead blocks (40px each with the gap), the text (12ch at least), the right text, then the
      // other blocks, at their own widths. When they don't fit beside the text they take a line of their own under it.
      const lead = b.children.filter((c) => ["avatar", "icon", "image", "checkbox", "radio"].includes(c.type));
      const trail = b.children.filter((c) => !lead.includes(c));
      const inner = w - 20;
      const endW = t[2] ? Math.min(0.4 * w, m.r(t.slice(2).join(" · "), SMALL_PX) + 8) : 0;
      const leadW = lead.length * 40;
      const trailW = trail.length ? GAP + widthOf(trail, TRAIL_GAP, ctx) : 0;
      const beside = leadW + m.r("0".repeat(12), BODY_PX) + endW + trailW <= inner;
      const mw = Math.max(40, inner - leadW - endW - (beside ? trailW : 0));
      // The chip sits under the title and detail.
      const text = Math.max(body(t[0], mw) + (t[1] ? small(t[1], mw) : 0) + (goWidth(b, ctx) ? 2 + 18 : 0), ...lead.map((c) => block(c, 40, ctx)));
      if (!trail.length) return Math.max(40, 12 + text);
      return Math.max(40, 12 + (beside ? Math.max(text, packed(trail, trailW - GAP, ctx)) : text + GAP + packed(trail, inner, ctx)));
    }
    case "table": {
      // Equal columns (table-layout: fixed); a row's own blocks and its chip wrap under its last cell's text.
      const cols = Math.max(1, b.items?.length ?? 3);
      const cw = w / cols - 16;
      const under = (r: WBlock) => {
        if (!r.children.length && r.to === undefined && !r.toName) return 0;
        let rows = 1;
        let x = 0;
        for (const iw of [...r.children.map((c) => (c.type === "button" ? 18 + m.b(c.texts.join(" · ") || "Button", SMALL_PX) : c.type === "badge" ? 16 + m.r(c.texts.join(" · "), SMALL_PX) : 40)), goWidth(r, ctx) - 6].filter((v) => v > 0)) {
          const bw = Math.min(iw, cw);
          if (x && x + 4 + bw > cw) {
            rows++;
            x = bw;
          } else x += (x ? 4 : 0) + bw;
        }
        return 4 + rows * 22 + (rows - 1) * 4;
      };
      const rowH = (r: WBlock) => Math.max(26, 11 + Math.max(...(b.items ?? [""]).map((_, i) => small(r.texts[i] ?? "", cw) + (i === cols - 1 ? under(r) : 0))));
      const head = b.items?.length ? Math.max(26, 10 + Math.max(...b.items.map((c) => SMALL * lines(c, cw, SMALL_PX, m.b)))) : 0;
      return 2 + head + (b.children.length ? b.children.reduce((h, r) => h + rowH(r), 0) : 3 * 26);
    }
    case "heading": {
      // Its leading buttons, links and icons sit at its right (a 28px button at most); the rest under it.
      const lead = b.children.findIndex((c) => !["button", "link", "icon"].includes(c.type));
      const end = lead < 0 ? b.children : b.children.slice(0, lead);
      const below = b.children.slice(end.length);
      const endW = end.reduce((a, c) => a + 6 + (c.type === "button" ? 23 + m.b(c.texts.join(" · ") || "Button", BODY_PX) : c.type === "icon" ? 16 : m.r(c.texts.join(" "), BODY_PX)), 0);
      const own = Math.max(22 * Math.max(1, lines(t.join(" "), Math.max(40, w - endW - goWidth(b, ctx)), 14.5, m.b)), end.some((c) => c.type === "button") ? 28 : 0);
      return own + (below.length ? GAP + stack(below, w, ctx) : 0);
    }
    case "text":
      return t.length ? body(t.join(" ")) : 3 * 7 + 2 * 5 + 6;
    case "image":
      return 96;
    case "avatar":
      return 32;
    case "icon":
      return 16;
    case "badge":
      return 18;
    case "stat":
      return 14 + SMALL * lines(t[0] ?? "", w - 22, SMALL_PX, m.r) + 26 + (t[2] ? SMALL : 0);
    case "chart":
      return 16 + (t[0] ? SMALL + 4 : 0) + 72;
    case "progress":
      return LINE + 4 + 8;
    case "button":
      return button(b, w, ctx, false);
    case "link":
      return LINE;
    case "input":
    case "select":
      return (t[0] ? SMALL + 3 : 0) + 34 + (t[2] ? 3 + small(t.slice(2).join(" · ")) : 0);
    case "search":
      return 34;
    case "checkbox":
    case "radio":
    case "toggle":
      return Math.max(20, body(t.join(" "), w - (b.type === "toggle" ? 38 : 22)));
    case "empty": {
      const inner = w - 27;
      const parts = [44, body(t[0] ?? "Nothing here yet", inner), t[1] ? small(t.slice(1).join(" · "), inner) : 0, ...b.children.map((c) => 6 + block(c, inner, ctx))].filter((h) => h > 0);
      return 35 + parts.reduce((a, h) => a + h, 0) + 4 * (parts.length - 1);
    }
    case "loading":
      return (t[0] ? SMALL + 6 : 0) + 2 * 25 + 6;
    case "alert":
      return 16 + body(t.join(" "), w - 22);
    case "toast":
      return 16 + body(t.join(" "), w - 24);
    case "divider":
      return 1;
    default: {
      const parts = [SMALL, t.length ? body(t.join(" · "), w - 19) : 0, isContainer(b.type) || b.children.length ? kids(w - 19) : 0].filter((h) => h > 0);
      return 15 + parts.reduce((a, h) => a + h, 0) + 6 * (parts.length - 1);
    }
  }
}
