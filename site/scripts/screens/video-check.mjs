// The checks a video must pass before it replaces the one on the page, shared by record.mjs (which
// refuses to write a video that fails them) and verify.mjs (which runs them again on the files).
// Ported from the demo-video playbook's verify-video.mjs (decode every frame, count distinct frames,
// compare the edges with the page's own screenshot) and extended with the story's pacing rules,
// checked on the recorded timeline rather than on the story's estimate.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { meaningfulWords, PACE } from "./story-check.mjs";

/** ffprobe's view of a file's video stream, with the codec string a <source type> names. */
export function probe(file) {
  const j = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration,format_name:stream=codec_name,profile,level,width,height,avg_frame_rate,pix_fmt", "-of", "json", file]).toString(),
  );
  const s = j.streams?.[0];
  if (!s) throw new Error(`${file} has no video stream`);
  const [n, d] = String(s.avg_frame_rate).split("/").map(Number);
  return { codec: s.codec_name, profile: s.profile, level: s.level, width: s.width, height: s.height, pixFmt: s.pix_fmt, fps: d ? n / d : n, duration: Number(j.format.duration), container: j.format.format_name, bytes: statSync(file).size };
}

/** The MIME type with codecs for a <source>: `video/mp4; codecs="av01.0.08M.08"` or `"avc1.640028"`. */
export function sourceType(p) {
  if (p.codec === "av1") {
    const profile = { Main: 0, High: 1, Professional: 2 }[p.profile] ?? 0;
    const level = String(Math.max(0, p.level)).padStart(2, "0");
    return `video/mp4; codecs="av01.${profile}.${level}M.08"`;
  }
  if (p.codec === "h264") {
    const prof = { Baseline: "42E0", "Constrained Baseline": "42E0", Main: "4D40", High: "6400" }[p.profile] ?? "6400";
    return `video/mp4; codecs="avc1.${prof}${Number(p.level).toString(16).padStart(2, "0").toUpperCase()}"`;
  }
  return "video/mp4";
}

/**
 * Decode EVERY frame (a file that probes but can't be decoded fails here) and hash each one: how
 * many there are, how many are distinct (a frozen or blank recording has 1), and the longest run of
 * identical frames in seconds (a stuck page shows as a run far past any hold).
 */
export function decodeAll(file, fps = 30) {
  let out;
  try {
    out = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], { maxBuffer: 512 * 1024 * 1024 }).toString();
  } catch (e) {
    return { frames: 0, distinct: 0, longestStill: 0, error: String(e.stderr ?? e.message).slice(0, 400) };
  }
  const hashes = out.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").at(-1).trim());
  let run = 1;
  let longest = hashes.length ? 1 : 0;
  for (let i = 1; i < hashes.length; i++) {
    run = hashes[i] === hashes[i - 1] ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return { frames: hashes.length, distinct: new Set(hashes).size, longestStill: longest / fps };
}

/** One frame of `file` at `atSec`, or an image file, as raw RGB at w x h. */
function rgb(args, w, h) {
  return execFileSync("ffmpeg", ["-v", "error", ...args, "-frames:v", "1", "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The bottom and right edge bands of the video's frame at `atSec` against the page's own screenshot
 * taken at that moment, as mean absolute difference (0–255). A recording that is cropped or offset
 * decodes fine and has the right size, and still shows a band that was never on the page.
 */
export function edgeDiff(file, atSec, referencePng, { width: w, height: h }) {
  const page = rgb(["-i", referencePng], w, h);
  const frame = rgb(["-ss", String(atSec), "-i", file], w, h);
  const band = (x0, x1, y0, y1) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++)
        for (let c = 0; c < 3; c++) {
          const i = (y * w + x) * 3 + c;
          sum += Math.abs(page[i] - frame[i]);
          n++;
        }
    return Number((sum / n).toFixed(1));
  };
  const edge = Math.max(8, Math.round(Math.min(w, h) * 0.06));
  return { bottom: band(0, w, h - edge, h), right: band(w - edge, w, 0, h), threshold: 40 };
}

/** What a decoded file and its timeline must show; [] when the video passes. `v` is the plan's video. */
export function fileProblems(name, p, decoded, v, budget) {
  const out = [];
  if (decoded.error) out.push(`${name}: a frame failed to decode: ${decoded.error}`);
  const expected = Math.round(p.duration * p.fps);
  if (Math.abs(decoded.frames - expected) > 2) out.push(`${name}: ${decoded.frames} frames decoded, ${expected} expected from ${p.duration.toFixed(2)} s at ${p.fps} fps`);
  if (decoded.distinct < 30) out.push(`${name}: only ${decoded.distinct} distinct frames: the recording shows almost nothing happening`);
  const stillMax = PACE.read.max + 2;
  if (decoded.longestStill > stillMax) out.push(`${name}: the picture doesn't change for ${decoded.longestStill.toFixed(1)} s, longer than any hold (${stillMax} s): a frozen page?`);
  if (p.width !== v.width) out.push(`${name}: ${p.width} px wide, the story says ${v.width}`);
  if (Math.abs(p.width / p.height - v.vp.width / v.vp.height) > 0.005) out.push(`${name}: ${p.width}x${p.height} is not the ${v.vp.width}:${v.vp.height} viewport's shape`);
  if (p.duration * 1000 < v.lengthMs.min || p.duration * 1000 > v.lengthMs.max) out.push(`${name}: ${p.duration.toFixed(1)} s long, outside ${v.length.min}–${v.length.max}`);
  if (p.bytes > budget) out.push(`${name}: ${(p.bytes / 1e6).toFixed(2)} MB, over its ${(budget / 1e6).toFixed(2)} MB budget`);
  return out;
}

/**
 * The pacing rules on the recorded timeline (output seconds): every hold at least its reading time
 * and a reading hold at most 5 s, the pointer still for 1.5 s after new content, travel 0.5–0.9 s,
 * captions of at most 5 words on screen at least 2 s, the leak gate passed at the start and after
 * every beat, and the edges matching the page's own screenshot.
 */
export function timelineProblems(t, v) {
  const out = [];
  const slack = 0.06;
  for (const h of t.holds) {
    const len = h.b - h.a;
    if (len + slack < h.needMs / 1000) out.push(`beat ${h.i}: held ${len.toFixed(2)} s, under its reading time ${(h.needMs / 1000).toFixed(1)} s ("${h.read ?? ""}")`);
    if (h.read && len > PACE.read.max + 0.4) out.push(`beat ${h.i}: a reading hold of ${len.toFixed(2)} s, over ${PACE.read.max} s`);
  }
  for (const s of t.settles) if (s.gap + slack < PACE.settle) out.push(`beat ${s.next}: the pointer moved ${s.gap.toFixed(2)} s after beat ${s.after} brought something new (at least ${PACE.settle} s)`);
  for (const m of t.moves) {
    const d = m.b - m.a;
    if (d + 0.02 < PACE.travel.min || d - 0.05 > PACE.travel.max) out.push(`a pointer travel at ${m.a.toFixed(2)} s took ${d.toFixed(2)} s (${PACE.travel.min}–${PACE.travel.max} s)`);
  }
  for (const c of t.captions) {
    if (meaningfulWords(c.text) > PACE.caption.words) out.push(`caption "${c.text}" has over ${PACE.caption.words} words`);
    if (c.b - c.a + slack < PACE.caption.min) out.push(`caption "${c.text}" is on screen ${(c.b - c.a).toFixed(2)} s, under ${PACE.caption.min} s`);
  }
  if (t.privacy.checked !== t.privacy.beats + 1) out.push(`the leak gate ran ${t.privacy.checked} times, not at the start and after each of the ${t.privacy.beats} beats`);
  if (t.seconds * 1000 < v.lengthMs.min || t.seconds * 1000 > v.lengthMs.max) out.push(`the timeline is ${t.seconds.toFixed(1)} s, outside ${v.length.min}–${v.length.max}`);
  if (!t.edges) out.push("no edge check was recorded");
  else for (const side of ["bottom", "right"]) if (t.edges[side] > t.edges.threshold) out.push(`the ${side} edge differs from the page's own screenshot (mean ${t.edges[side]}/255): the recording is probably cropped or offset`);
  return out;
}
