// Assembly: the screencast's frames (which arrive only when the page changes) become a constant
// 30 fps picture, and the pointer, its click ripples, the captions and the "sped up" tag are drawn
// onto it here rather than in the page, so they move smoothly whatever the page's frame rate was.
// Then the closing fade into the first frame (the loop has no seam), and the encodes: AV1 first,
// H.264 as the fallback, each at the best quality that fits its byte budget.
//
// Times: the recorder logs everything on the screencast's clock (seconds since the epoch, the
// "recording" clock). A sped-up stretch plays k times faster, so the video's own clock ("output",
// seconds from the first frame) runs slower than it there; toOut/fromOut convert.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE } from "./load-story.mjs";
import { siteSharp } from "./harness.mjs";
import { PACE } from "./story-check.mjs";

export const FPS = 30;
const ACCENT = [0x8e, 0x88, 0xff]; // --color-accent in Sova's dark theme
const CAPTION_FADE = 0.25;

export const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** The recording → output clock: piecewise linear between the recorder's anchors [{ r, o }]
    (recording seconds → output seconds, both rising). */
export function clock(anchors) {
  const toOut = (r) => {
    if (r <= anchors[0].r) return anchors[0].o - (anchors[0].r - r);
    for (let k = 0; k < anchors.length - 1; k++) {
      const [p, q] = [anchors[k], anchors[k + 1]];
      if (r <= q.r) return q.r === p.r ? q.o : p.o + ((r - p.r) / (q.r - p.r)) * (q.o - p.o);
    }
    return anchors.at(-1).o + (r - anchors.at(-1).r);
  };
  const fromOut = (o) => {
    if (o <= anchors[0].o) return anchors[0].r;
    for (let k = 0; k < anchors.length - 1; k++) {
      const [p, q] = [anchors[k], anchors[k + 1]];
      if (o < q.o) return p.r + ((o - p.o) / (q.o - p.o)) * (q.r - p.r);
    }
    return anchors.at(-1).r;
  };
  return { toOut, fromOut };
}

/** The pointer's position (CSS px) at recording time r: eased along each logged travel. */
export function pointerAt(track, r) {
  let p = track.p0;
  for (const m of track.moves) {
    if (r < m.a) break;
    if (r >= m.b) p = m.to;
    else {
      const e = ease((r - m.a) / (m.b - m.a));
      return { x: m.from.x + (m.to.x - m.from.x) * e, y: m.from.y + (m.to.y - m.from.y) * e };
    }
  }
  return p;
}

// ---- sprites ----------------------------------------------------------------------------------

async function svgRaw(sharp, svg) {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** An arrow pointer `scale` px per CSS px, with a soft shadow; its tip is at (hx, hy). */
async function arrowSprite(sharp, scale) {
  const size = Math.round(28 * scale);
  const pad = Math.round(4 * scale);
  const path = "M4 2 L4 21 L8.6 16.6 L11.6 23.2 L14.6 21.9 L11.7 15.4 L18.2 15.4 Z";
  const svg = (fill, stroke, dx, dy, blur) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size + 2 * pad}" height="${size + 2 * pad}" viewBox="${-pad / scale} ${-pad / scale} ${(size + 2 * pad) / scale} ${(size + 2 * pad) / scale}">` +
    (blur ? `<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>` : "") +
    `<g transform="translate(${dx} ${dy})"${blur ? ' filter="url(#b)"' : ""}><path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/></g></svg>`;
  const shadow = await sharp(Buffer.from(svg("rgba(0,0,0,0.55)", "rgba(0,0,0,0.55)", 0.8, 1.6, 1.1))).png().toBuffer();
  const { data, info } = await sharp(shadow)
    .composite([{ input: Buffer.from(svg("#ffffff", "#15151c", 0, 0, 0)) }])
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, hx: Math.round(pad + 4 * scale), hy: Math.round(pad + 2 * scale) };
}

/** A ring of radius r CSS px at `scale`, stroke `sw`, colour rgb, alpha a; optionally filled. */
async function ringSprite(sharp, scale, r, sw, rgb, a, fill = 0) {
  const R = Math.ceil((r + sw) * scale) + 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * R}" height="${2 * R}"><circle cx="${R}" cy="${R}" r="${r * scale}" fill="rgba(${rgb.join(",")},${fill})" stroke="rgba(${rgb.join(",")},${a})" stroke-width="${sw * scale}"/></svg>`;
  const s = await svgRaw(sharp, svg);
  return { ...s, hx: R, hy: R };
}

/** The ripple after a click (arrow) or the ring and ripple of a tap, as frames over its life. */
async function pressSprites(sharp, scale, pointer) {
  const steps = 14;
  const ripple = [];
  for (let i = 0; i < steps; i++) {
    const p = i / (steps - 1);
    const r = pointer === "tap" ? 20 + 18 * ease(p) : 6 + 20 * ease(p);
    ripple.push(await ringSprite(sharp, scale, r, pointer === "tap" ? 3 : 2.5, ACCENT, 0.95 * (1 - p), pointer === "tap" ? 0.12 * (1 - p) : 0));
  }
  const touch = pointer === "tap" ? await ringSprite(sharp, scale, 20, 3, [255, 255, 255], 0.9, 0.18) : null;
  return { ripple, touch };
}

/**
 * Caption and tag images, drawn by Chromium in the site's own Inter (so they read as the page's
 * type), at the video's pixels per CSS px. Returns text → { data (RGBA), w, h } and the CSS size.
 */
export async function renderLabels(browser, labels, scale, fontPx) {
  const sharp = siteSharp();
  const font = readFileSync(join(SITE, "public", "fonts", "Inter-Variable.woff2")).toString("base64");
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 300 }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  const out = new Map();
  try {
    for (const { text, kind } of labels) {
      const esc = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
      await page.setContent(
        `<style>@font-face{font-family:InterSite;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}` +
          `html,body{margin:0;background:transparent}` +
          `#l{display:inline-block;margin:12px;font-family:InterSite;letter-spacing:-0.01em;white-space:nowrap}` +
          `.caption{font-weight:600;font-size:${fontPx}px;line-height:1.25;color:#fff;background:rgba(17,17,24,.86);padding:${Math.round(fontPx * 0.5)}px ${Math.round(fontPx * 0.8)}px;border-radius:${Math.round(fontPx * 0.6)}px;border:1px solid rgba(255,255,255,.14);box-shadow:0 3px 14px rgba(0,0,0,.4)}` +
          `.tag{font-weight:600;font-size:${Math.round(fontPx * 0.76)}px;line-height:1.2;color:#fff;background:rgba(74,67,216,.92);padding:${Math.round(fontPx * 0.32)}px ${Math.round(fontPx * 0.62)}px;border-radius:999px;box-shadow:0 3px 12px rgba(0,0,0,.35)}</style>` +
          `<span id="l" class="${kind}">${esc}</span>`,
      );
      await page.evaluate(() => document.fonts.ready);
      const family = await page.evaluate(() => document.fonts.check("600 16px InterSite"));
      if (!family) throw new Error("the site's Inter font didn't load for the captions");
      const png = await page.locator("#l").screenshot({ omitBackground: true });
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      out.set(`${kind}:${text}`, { data, w: info.width, h: info.height, cssW: info.width / scale, cssH: info.height / scale });
    }
  } finally {
    await ctx.close();
  }
  return out;
}

// ---- drawing ----------------------------------------------------------------------------------

/** src (RGBA) over dst (RGB, W x H) with its top-left at (x, y), times `opacity`. */
function over(dst, W, H, src, x, y, opacity = 1) {
  if (opacity <= 0) return;
  x = Math.round(x);
  y = Math.round(y);
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(W, x + src.w);
  const y1 = Math.min(H, y + src.h);
  for (let yy = y0; yy < y1; yy++) {
    let si = ((yy - y) * src.w + (x0 - x)) * 4;
    let di = (yy * W + x0) * 3;
    for (let xx = x0; xx < x1; xx++, si += 4, di += 3) {
      const a = (src.data[si + 3] / 255) * opacity;
      if (a <= 0) continue;
      dst[di] = dst[di] * (1 - a) + src.data[si] * a;
      dst[di + 1] = dst[di + 1] * (1 - a) + src.data[si + 1] * a;
      dst[di + 2] = dst[di + 2] * (1 - a) + src.data[si + 2] * a;
    }
  }
}

function mix(a, b, t) {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** Fade in over the first CAPTION_FADE s of [a, b] and out over its last. */
const fade = (o, a, b) => (o < a || o >= b ? 0 : Math.min(1, (o - a) / CAPTION_FADE, (b - o) / CAPTION_FADE));

/** Where a caption sits (CSS px), and where the tag sits after it. */
export function captionBox(v, label) {
  const m = 14;
  const x = m;
  const y = v.captions === "top-left" ? v.captionTop : v.vp.height - m - label.cssH;
  return { x, y, w: label.cssW, h: label.cssH };
}

/**
 * Compose the video: every output frame at FPS, piped as raw RGB into a lossless intermediate.
 * `frames` are the screencast's frames cropped to the viewport ({ file, t }), `track` what the
 * recorder logged. Returns the intermediate's path, its size and length, and frame 0 (the poster).
 */
export async function compose({ frames, track, v, labels, root }) {
  const sharp = siteSharp();
  const W = v.width;
  const H = Math.round((W * v.vp.height) / v.vp.width / 2) * 2;
  const s = W / v.vp.width;
  const { toOut, fromOut } = clock(track.anchors);
  const endOut = toOut(track.end);
  const loop = v.loopMs / 1000;
  const total = endOut + loop;
  const n = Math.round(total * FPS);

  const arrow = v.pointer === "arrow" ? await arrowSprite(sharp, s) : null;
  const press = await pressSprites(sharp, s, v.pointer);
  const presses = (v.pointer === "tap" ? track.taps : track.clicks).map((c) => ({ ...c, o: toOut(c.t) }));
  const caps = track.captions.map((c) => ({ ...c, oa: toOut(c.a), ob: toOut(c.b), img: labels.get(`caption:${c.text}`) }));
  // The tag shows over the sped-up stretch, and stays long enough to read (a short stretch of
  // three times the speed is over in well under a second).
  const tags = track.speed.map((x) => ({ oa: toOut(x.a), ob: Math.max(toOut(x.b), toOut(x.a) + PACE.caption.min), img: labels.get(`tag:${v.tagText}`) }));

  // Each screencast frame, scaled once to the output size; frames sorted by time.
  const times = frames.map((f) => f.t);
  const indexAt = (r) => {
    let lo = 0;
    let hi = times.length - 1;
    if (r < times[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= r) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const cache = new Map();
  const base = async (i) => {
    if (!cache.has(i)) {
      if (cache.size > 3) cache.delete(cache.keys().next().value);
      cache.set(i, await sharp(frames[i].file).removeAlpha().resize(W, H, { kernel: "lanczos3" }).raw().toBuffer());
    }
    return cache.get(i);
  };
  const first = Buffer.from(await base(indexAt(track.t0)));
  const last = Buffer.from(await base(indexAt(track.end)));

  const file = join(root, `${v.name}.intermediate.mkv`);
  const ff = spawn("ffmpeg", ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264rgb", "-qp", "0", "-preset", "ultrafast", file], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => ff.on("exit", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg (intermediate) exited ${c}`)))));
  const write = (buf) => (ff.stdin.write(buf) ? Promise.resolve() : new Promise((r) => ff.stdin.once("drain", r)));

  let poster = null;
  for (let k = 0; k < n; k++) {
    const o = k / FPS;
    let r;
    let frame;
    if (o < endOut) {
      r = fromOut(o);
      frame = Buffer.from(await base(indexAt(r)));
    } else {
      r = track.end;
      frame = mix(last, first, ease(clamp((o - endOut) / loop, 0, 1)));
    }
    for (const c of caps) if (c.img) over(frame, W, H, c.img, c.box.x * s, c.box.y * s, fade(o, c.oa, c.ob));
    for (const t of tags) {
      const cap = caps.find((c) => c.oa <= o && o < c.ob);
      if (!t.img || !cap?.img) continue;
      const x = (cap.box.x + cap.box.w + 8) * s;
      const y = (cap.box.y + (cap.box.h - t.img.cssH) / 2) * s;
      over(frame, W, H, t.img, x, y, fade(o, t.oa, t.ob));
    }
    for (const p of presses) {
      if (v.pointer === "tap" && o >= p.o - PACE.rest && o < p.o) over(frame, W, H, press.touch, p.x * s - press.touch.hx, p.y * s - press.touch.hy, ease((o - (p.o - PACE.rest)) / PACE.rest));
      if (o >= p.o && o < p.o + PACE.ripple + 0.15) {
        const sp = press.ripple[Math.min(press.ripple.length - 1, Math.floor(((o - p.o) / (PACE.ripple + 0.15)) * press.ripple.length))];
        over(frame, W, H, sp, p.x * s - sp.hx, p.y * s - sp.hy);
      }
    }
    if (arrow) {
      const p = pointerAt(track, r);
      over(frame, W, H, arrow, p.x * s - arrow.hx, p.y * s - arrow.hy);
    }
    if (k === 0) poster = Buffer.from(frame);
    await write(frame);
  }
  ff.stdin.end();
  await done;
  return { file, width: W, height: H, seconds: n / FPS, frames: n, endOut, poster, toOut };
}

/**
 * Encode the intermediate at the lowest CRF (best quality) in `crfs` whose file fits `budget`.
 * kind "av1": libsvtav1 in MP4; "h264": libx264 High in MP4. BT.709, faststart, no audio.
 */
export function encodeWithin(kind, src, out, budget, log = () => {}) {
  const crfs = kind === "av1" ? [30, 34, 38, 42, 46, 50] : [20, 23, 26, 29, 32, 35];
  const color = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];
  const vf = "scale=out_color_matrix=bt709:out_range=tv:flags=lanczos,format=yuv420p";
  const run = (crf) => {
    const codec = kind === "av1" ? ["-c:v", "libsvtav1", "-preset", "5", "-crf", String(crf), "-g", "240", "-svtav1-params", "tune=0:enable-overlays=1:scd=1"] : ["-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-profile:v", "high", "-g", "60", "-tune", "animation"];
    // SVT-AV1 reports to stderr at every run (its own log level, not ffmpeg's): kept, shown on failure.
    try {
      execFileSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-vf", vf, ...codec, ...color, "-movflags", "+faststart", "-an", out], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SVT_LOG: "1" } });
    } catch (e) {
      throw new Error(`ffmpeg (${kind}, crf ${crf}) failed:\n${String(e.stderr ?? "").slice(-2000)}`);
    }
    const bytes = Number(execFileSync("stat", ["-c", "%s", out]).toString());
    log(`  ${kind} crf ${crf}: ${(bytes / 1e6).toFixed(2)} MB`);
    return bytes;
  };
  // From the middle: under budget, step to better quality until the next would not fit (then
  // encode the last one that did again, since the failed try overwrote it); over it, step down.
  let i = Math.floor(crfs.length / 2) - 1;
  let bytes = run(crfs[i]);
  if (bytes <= budget) {
    while (i > 0) {
      const b = run(crfs[i - 1]);
      if (b > budget) {
        bytes = run(crfs[i]);
        break;
      }
      i--;
      bytes = b;
    }
  } else while (bytes > budget && i < crfs.length - 1) bytes = run(crfs[++i]);
  return { crf: crfs[i], bytes };
}
