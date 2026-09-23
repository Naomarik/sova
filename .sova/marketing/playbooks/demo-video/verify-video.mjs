// Proves a video file plays: ffprobe reads its container and stream, ffmpeg decodes EVERY frame
// (a file that probes but can't be decoded fails here), and the decoded frames are hashed to
// count how many are distinct (a recording of a frozen or blank page has 1). Three stills, at
// 10%, 50% and 90%, are written beside the video for you to look at.
//
// With a reference (record.mjs passes the page's own screenshot, taken after holding the last
// state), a frame from 0.5s before the end is compared with it along the bottom and right edges: a recording that is
// cropped or offset decodes fine, has the right size and many distinct frames, and still shows a
// band that was never on the page. Measured when this was written (Playwright 1.54.1, headless
// Chromium over CDP): `--via context` lost the bottom 142px of the page after any navigation.
//
//   node .sova/marketing/playbooks/demo-video/verify-video.mjs <file> [--width N --height N] [--reference page.png]
//
// Prints JSON; exits 1 when the file fails. record.mjs calls verify() itself.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { local, run } from "../../lib/pw.mjs";

const bin = (name) => {
  const found = local()[name];
  if (!found) throw new Error(`${name} is not on PATH (local.json has ${name}: null); install it, re-run the generator, and verify again`);
  return found;
};

export function verify(file, expect = {}) {
  if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
  const probe = JSON.parse(execFileSync(bin("ffprobe"), ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "format=duration,format_name:stream=codec_name,width,height,nb_read_frames,avg_frame_rate", "-of", "json", file], { encoding: "utf8" }));
  const stream = probe.streams?.[0];
  if (!stream) throw new Error(`${file} has no video stream`);
  const hashes = execFileSync(bin("ffmpeg"), ["-v", "error", "-i", file, "-map", "0:v:0", "-f", "framemd5", "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(",").at(-1).trim());
  const duration = Number(probe.format.duration);
  const result = {
    file: path.relative(process.cwd(), file),
    bytes: fs.statSync(file).size,
    container: probe.format.format_name,
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    durationSeconds: Number(duration.toFixed(3)),
    framesDecoded: hashes.length,
    distinctFrames: new Set(hashes).size,
    stills: [],
    problems: [],
  };
  if (!(duration >= 1)) result.problems.push(`duration ${duration}s is under 1 second`);
  if (hashes.length < 2) result.problems.push(`only ${hashes.length} frame(s) decoded`);
  if (result.distinctFrames < 2) result.problems.push("every frame is identical: the recording shows nothing happening");
  if (expect.width && stream.width !== expect.width) result.problems.push(`width ${stream.width}, expected ${expect.width}`);
  if (expect.height && stream.height !== expect.height) result.problems.push(`height ${stream.height}, expected ${expect.height}`);
  if (expect.reference) {
    // Both images as raw RGB at the video's size; mean absolute difference per edge band (0–255).
    const raw = (args) => execFileSync(bin("ffmpeg"), ["-v", "error", ...args, "-frames:v", "1", "-vf", `scale=${stream.width}:${stream.height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 256 * 1024 * 1024 });
    const page = raw(["-i", expect.reference]);
    // 0.5s before the end: inside record.mjs's 600ms hold, before its reference screenshot, which
    // repaints the page and would hide a crop from every later frame.
    const last = raw(["-sseof", "-0.5", "-i", file]);
    const w = stream.width;
    const h = stream.height;
    const band = (x0, x1, y0, y1) => {
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++)
          for (let c = 0; c < 3; c++) {
            const i = (y * w + x) * 3 + c;
            sum += Math.abs(page[i] - last[i]);
            n++;
          }
      return Number((sum / n).toFixed(1));
    };
    const edge = Math.max(8, Math.round(Math.min(w, h) * 0.06));
    result.edges = { top: band(0, w, 0, edge), bottom: band(0, w, h - edge, h), right: band(w - edge, w, 0, h), threshold: 40 };
    for (const side of ["bottom", "right"])
      if (result.edges[side] > 40) result.problems.push(`the ${side} edge of the frame 0.5s before the end differs from the page's own screenshot (mean ${result.edges[side]}/255): the recording is probably cropped or offset. Compare ${path.basename(expect.reference)} with the 90% still`);
  }
  const stem = file.replace(/\.[^.]+$/, "");
  for (const pct of [10, 50, 90]) {
    const still = `${stem}.check-${pct}.png`;
    execFileSync(bin("ffmpeg"), ["-v", "error", "-y", "-ss", String((duration * pct) / 100), "-i", file, "-frames:v", "1", still]);
    result.stills.push(path.relative(process.cwd(), still));
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(async () => {
    const [file, ...rest] = process.argv.slice(2);
    if (!file) throw new Error("usage: verify-video.mjs <file> [--width N --height N]");
    const expect = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === "--reference" && rest[i + 1]) expect.reference = path.resolve(rest[i + 1]);
      else if (["--width", "--height"].includes(rest[i]) && /^\d+$/.test(rest[i + 1] ?? "")) expect[rest[i].slice(2)] = Number(rest[i + 1]);
      else throw new Error(`unexpected argument ${rest[i]}`);
    }
    const result = verify(path.resolve(file), expect);
    console.log(JSON.stringify(result, null, 2));
    if (result.problems.length) process.exitCode = 1;
  });
}
