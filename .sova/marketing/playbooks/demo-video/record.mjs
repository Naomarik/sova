// Records one demo video from the running project, then verifies it (verify-video.mjs) and
// records the result in .sova/marketing/assets/video/manifest.json.
//
//   PW_PORT=<your browser> node .sova/marketing/playbooks/demo-video/record.mjs \
//     --via context|screencast [--plan .sova/marketing/assets/video/plan.json]
//
// Two recording paths; PLAYBOOK.md says which to try first and how to decide:
//   context     Playwright's recordVideo, on a NEW browser context created over the CDP
//               connection. Playwright encodes the .webm itself with its bundled ffmpeg.
//   screencast  The page's own CDP screencast (Page.startScreencast): each changed frame is
//               saved as a JPEG with its timestamp, then the system ffmpeg assembles them at
//               their real timing into a .webm (VP8).
// Either way the plan's `script` runs as the body of an async function given `page`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { brand, connect, flags, local, MARKETING, revision, run, sizeTo } from "../../lib/pw.mjs";
import { verify } from "./verify-video.mjs";

const OUT = path.join(MARKETING, "assets", "video");
const FIELDS = { baseUrl: "string|null", path: "string", width: "number", height: "number", colorScheme: "string", file: "string", shows: "string", script: "string" };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
// The last state is held this long before the reference screenshot is taken. Taking a screenshot
// repaints the page's whole surface, which hides a cropped recording from then on (measured), so
// verify() compares the reference with a frame from inside the hold, before the screenshot.
const HOLD_MS = 600;

function checkPlan(p) {
  const errs = [];
  if (!p || typeof p !== "object") return ["the plan must be a JSON object"];
  for (const k of Object.keys(p)) if (!(k in FIELDS)) errs.push(`${k}: not a plan field`);
  for (const [k, type] of Object.entries(FIELDS)) {
    if (!(k in p)) errs.push(`${k}: is missing`);
    else if (!type.split("|").some((t) => (t === "null" ? p[k] === null : typeof p[k] === t))) errs.push(`${k}: must be ${type}`);
  }
  if (typeof p.file === "string" && !/^[a-z0-9][a-z0-9-]*\.webm$/.test(p.file)) errs.push("file: must be a lowercase name ending .webm, no folders");
  if (!["light", "dark"].includes(p.colorScheme)) errs.push('colorScheme: must be "light" or "dark"');
  for (const k of ["width", "height"]) if (typeof p[k] === "number" && (p[k] % 2 || p[k] < 320)) errs.push(`${k}: must be even and at least 320 (video encoders need even sizes)`);
  return errs;
}

async function viaContext(browser, plan, url, target, reference) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demo-video-"));
  const size = { width: plan.width, height: plan.height };
  const context = await browser.newContext({ viewport: size, colorScheme: plan.colorScheme, recordVideo: { dir: tmp, size } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(url, { waitUntil: "load" });
    await sizeTo(page, plan.width, plan.height);
    await new AsyncFunction("page", plan.script)(page);
    await page.waitForTimeout(HOLD_MS);
    await page.screenshot({ path: reference }); // after the hold: see HOLD_MS
  } finally {
    await context.close(); // the video is finalised when its context closes
  }
  const video = page.video();
  if (!video) throw new Error("Playwright returned no video for the page: recordVideo did not take effect over this connection");
  fs.copyFileSync(await video.path(), target);
  fs.rmSync(tmp, { recursive: true, force: true });
  return errors;
}

async function viaScreencast(browser, plan, url, target, reference) {
  const ffmpeg = local().ffmpeg;
  if (!ffmpeg) throw new Error("the screencast path needs ffmpeg on PATH (local.json has ffmpeg: null)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "demo-screencast-"));
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const frames = [];
  try {
    await page.emulateMedia({ colorScheme: plan.colorScheme });
    await page.goto(url, { waitUntil: "load" });
    await sizeTo(page, plan.width, plan.height);
    const cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      const file = path.join(tmp, `f${String(frames.length).padStart(6, "0")}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      frames.push({ file, t: metadata.timestamp });
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: plan.width, maxHeight: plan.height, everyNthFrame: 1 });
    await new AsyncFunction("page", plan.script)(page);
    await page.waitForTimeout(HOLD_MS); // let the last change arrive as a frame
    await page.screenshot({ path: reference }); // after the hold: see HOLD_MS
    await cdp.send("Page.stopScreencast");
    const ended = Date.now() / 1000;
    if (frames.length < 2) throw new Error(`the screencast delivered ${frames.length} frame(s); nothing on the page changed, or the screencast did not start`);
    // A frame is shown until the next one arrives; the last one until the script ended.
    // metadata.timestamp is seconds since the epoch, the same clock as Date.now() / 1000.
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? ended) - f.t).toFixed(3)}`);
    list.push(`file '${frames.at(-1).file}'`); // the concat demuxer ignores the last entry's duration unless it is repeated
    fs.writeFileSync(path.join(tmp, "frames.txt"), `${list.join("\n")}\n`);
    execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(tmp, "frames.txt"), "-vf", `fps=25,scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2`, "-c:v", "libvpx", "-b:v", "2M", "-pix_fmt", "yuv420p", target]);
  } finally {
    await page.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return errors;
}

run(async () => {
  const opts = flags({ via: "string", plan: "string" });
  if (!["context", "screencast"].includes(opts.via)) throw new Error("--via context|screencast is required (see PLAYBOOK.md, step 3)");
  const planFile = path.resolve(opts.plan ?? path.join(OUT, "plan.json"));
  if (!fs.existsSync(planFile)) throw new Error(`no plan at ${planFile}; write one first (see plan.example.json beside this script)`);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const errs = checkPlan(plan);
  if (errs.length) throw new Error(`the plan is invalid:\n  - ${errs.join("\n  - ")}`);
  const url = new URL(plan.path, plan.baseUrl ?? brand().project.demoUrl).href;
  fs.mkdirSync(OUT, { recursive: true });
  const target = path.join(OUT, plan.file);
  const rev = revision();

  // The page's own screenshot at the end of the script: verify() compares the video's last frame
  // with it, the one check that sees a cropped recording. Kept beside the video for you to compare.
  const reference = target.replace(/\.webm$/, ".reference.png");
  const browser = await connect();
  let pageErrors;
  try {
    pageErrors = await (opts.via === "context" ? viaContext : viaScreencast)(browser, plan, url, target, reference);
  } finally {
    await browser.close();
  }
  const check = verify(target, { width: plan.width, height: plan.height, reference });
  if (pageErrors.length) check.problems.push(`page errors while recording: ${pageErrors.join(" | ")}`);

  const manifestFile = path.join(OUT, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { videos: [] };
  manifest.note = "Written by record.mjs. `verified` is what verify-video.mjs measured; an entry with problems is not a usable video.";
  manifest.videos = manifest.videos.filter((v) => v.file !== plan.file);
  manifest.videos.push({ file: plan.file, shows: plan.shows, url, via: opts.via, colorScheme: plan.colorScheme, revision: rev.sha, dirtyTree: rev.dirty, recordedAt: new Date().toISOString(), verified: check });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ via: opts.via, ...check }, null, 2));
  if (check.problems.length) process.exitCode = 1;
});
