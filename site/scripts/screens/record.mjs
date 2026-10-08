#!/usr/bin/env node
// pnpm run screens:video [-- --force] [--keep] [--node]
//
// Record the story's `video`: a fresh root, the director paced at video.chunk, the session typed in
// and played beat by beat, filmed with the CDP screencast, then assembled by ffmpeg into an H.264
// MP4 (no audio) at site/public/video/session-desk.mp4. The leak gate runs at every beat. Its entry
// in manifest.json records the input hash; an unchanged video is not re-recorded unless --force.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStory, REPO } from "./load-story.mjs";
import { durationMs, text } from "./story-check.mjs";
import { FREEZE_CSS, leakGate, leakPatterns, makeRoot, OUT_DIR, removeRoot, startBrowser, startDirector, startServer, TOKEN, VIDEO_DIR, VIEWPORTS, writeJson } from "./harness.mjs";
import { loadAlignModule, seed } from "./seed.mjs";
import { fileSha, videoHash } from "./hashes.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const MANIFEST = join(OUT_DIR, "manifest.json");
const FILE = "session-desk.mp4";

const { plan, story } = await loadStory().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
if (!plan.video) {
  console.error("story.json has no video");
  process.exit(1);
}
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.error("ffmpeg is not on PATH: install it (the video is encoded with libx264)");
  process.exit(1);
}
await loadAlignModule();

const v = plan.video;
const hash = videoHash(story, plan);
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
if (!flag("--force") && manifest?.video?.hash === hash && existsSync(join(VIDEO_DIR, FILE))) {
  console.log("the video is up to date (its input hash matches manifest.json); --force records it again");
  process.exit(0);
}

const root = makeRoot();
const stops = [];
let failed = false;
try {
  const director = await startDirector(root, { chunkMs: v.chunkMs });
  stops.push(director.stop);
  const seeded = await seed(plan, root, { directorPort: director.port });
  const server = await startServer(root, { node: flag("--node") });
  stops.push(server.stop);
  const browser = await startBrowser();
  stops.push(browser.stop);
  const patterns = leakPatterns();

  const s = plan.sessions.find((x) => x.id === v.session);
  const created = await server.call("POST", "/api/sessions", { cwd: seeded.repo });
  await fetch(`${director.url}/bind`, { method: "POST", body: JSON.stringify({ id: s.id, uuid: created.id }) });
  await server.call("POST", "/api/sessions/configure", {
    path: created.path,
    model: s.model,
    ...(s.effort ? { thinking: s.effort } : {}),
    mode: s.modes.includes("delegate") ? "delegate" : "normal",
    minorModes: s.modes.filter((m) => m !== "delegate"),
  });
  await server.call("POST", "/api/sessions/title", { path: created.path, title: s.title });
  await server.call("POST", `/api/sandbox?path=${encodeURIComponent(created.path)}`, { state: "off" }).catch(() => {});

  const vp = VIEWPORTS.video;
  const ctx = await browser.browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, colorScheme: "dark", timezoneId: "UTC", locale: "en-US" });
  // Headless draws no pointer: a small dot that follows the mouse and pulses on a click.
  await ctx.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const dot = document.createElement("div");
      dot.style.cssText = "position:fixed;z-index:2147483647;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 2px rgba(0,0,0,.35);pointer-events:none;left:-40px;top:-40px;transition:transform .12s";
      document.body.append(dot);
      addEventListener("mousemove", (e) => ((dot.style.left = `${e.clientX}px`), (dot.style.top = `${e.clientY}px`)), true);
      addEventListener("mousedown", () => (dot.style.transform = "scale(.6)"), true);
      addEventListener("mouseup", () => (dot.style.transform = ""), true);
    });
  });
  const page = await ctx.newPage();
  await page.goto(`${server.base}/#t=${TOKEN}`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.evaluate((h) => (location.hash = h), `#/s/${encodeURIComponent(created.path)}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.addStyleTag({ content: FREEZE_CSS.replace("animation-duration: 0s !important; animation-delay: 0s !important; ", "") });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
  await leakGate(page, patterns, "video start");

  // The screencast: every frame with its timestamp, acknowledged so the next one comes.
  const framesDir = join(root, "frames");
  mkdirSync(framesDir);
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    const file = join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: Math.round(vp.width * vp.deviceScaleFactor), maxHeight: Math.round(vp.height * vp.deviceScaleFactor) });
  await page.waitForTimeout(700);

  const script = story.sessions.find((x) => x.id === v.session).script;
  const moveTo = async (locator) => {
    const box = await locator.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  };
  for (const [i, beat] of v.beats.entries()) {
    console.log(`beat ${i}: ${JSON.stringify(beat)}`);
    if (beat.do === "type") {
      const input = page.locator("textarea.composer-input").first();
      await moveTo(input);
      await input.click();
      await input.pressSequentially(text(script[beat.step].user), { delay: v.typingMs });
    } else if (beat.do === "send") {
      const button = page.locator(".composer-actions button[type=submit]").first();
      await moveTo(button);
      await button.click();
    } else if (beat.do === "release") {
      for (const h of (await director.api.state()).waiting) await director.api.release(h);
      if (beat.until === "end") await director.api.idle(v.session, 180_000);
      else await director.api.reached(beat.until, 180_000);
      await page.waitForTimeout(600);
    } else if (beat.do === "click") {
      if (beat.target === "show_changes") {
        const b = page.getByRole("button", { name: "Review Changes" }).last();
        await b.scrollIntoViewIfNeeded();
        await moveTo(b);
        await b.click();
      } else {
        const trigger = page.locator("button.run-status-link:not(.run-status-align):not(.run-status-running)").first();
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await moveTo(trigger);
          await trigger.click();
          await page.waitForTimeout(500);
        }
        if (beat.target === "worker") {
          const row = page.locator(".subagent-row", { hasText: plan.workers[beat.worker].name }).first();
          await moveTo(row);
          await row.click();
        }
      }
    } else if (beat.do === "pause") await page.waitForTimeout(durationMs(beat.for));
    await leakGate(page, patterns, `video beat ${i}`);
  }
  await cdp.send("Page.stopScreencast");
  await page.waitForTimeout(300);
  await ctx.close();

  // Frames → constant 30 fps H.264, each frame held until the next one's timestamp.
  if (frames.length < 10) throw new Error(`only ${frames.length} screencast frames arrived`);
  const list = frames.map((f, k) => `file '${f.file}'\nduration ${Math.max(0.001, ((frames[k + 1]?.t ?? f.t + 1 / 30) - f.t)).toFixed(4)}`).join("\n");
  writeFileSync(join(root, "frames.txt"), `${list}\nfile '${frames.at(-1).file}'\n`);
  mkdirSync(VIDEO_DIR, { recursive: true });
  const out = join(VIDEO_DIR, FILE);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(root, "frames.txt"), "-vf", "fps=30,scale=1600:-2:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-profile:v", "high", "-movflags", "+faststart", "-an", out], { stdio: "inherit" });
  const seconds = frames.at(-1).t - frames[0].t;
  const bytes = statSync(out).size;
  const [w, h] = [1600, Math.round((1600 * vp.height) / vp.width / 2) * 2];
  console.log(`wrote ${out.slice(REPO.length + 1)}: ${w}x${h}, ${seconds.toFixed(1)}s, ${(bytes / 1e6).toFixed(2)} MB from ${frames.length} frames`);
  if (bytes > 2_500_000) console.warn(`warning: ${(bytes / 1e6).toFixed(2)} MB is over the 2.5 MB budget`);

  const next = manifest ?? { _generated: "by site/scripts/screens (pnpm run screens); edit story.json instead", shots: {}, slots: plan.pageShots };
  next.video = { file: `/video/${FILE}`, width: w, height: h, seconds: Number(seconds.toFixed(1)), bytes, sha: fileSha(readFileSync(out)), alt: v.alt, poster: v.poster, hash };
  writeJson(MANIFEST, next);
} catch (e) {
  failed = true;
  console.error(`\nrecording failed: ${e.stack ?? e.message}`);
  console.error(`logs: ${join(root, "logs")}${flag("--keep") ? "" : " (pass --keep to keep them)"}`);
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  if (!flag("--keep")) removeRoot(root);
  else console.log(`kept ${root}`);
}
process.exit(failed ? 1 : 0);
