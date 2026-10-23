#!/usr/bin/env node
// pnpm run screens:video [-- --video <name>] [--force] [--keep] [--node] [--stills <dir>]
//
// Record the story's `videos`, each in a fresh root: the director paced at the video's chunk, the
// page played beat by beat and filmed with the CDP screencast, the pointer moved by the pacing
// rules (story-check.mjs PACE) and logged as a track. Assembly (video-compose.mjs) then draws the
// pointer and ripples at a constant 30 fps, fades the end into the first frame, and encodes AV1 and
// H.264 within the video's byte budgets. Nothing else is drawn into the picture: the captions are
// page text, from the cue list this writes beside the video (each caption's start and end in the
// video's own seconds, and the "Sped up" stretches). The leak gate runs at the start and after
// every beat. Nothing reaches site/public/video until the checks pass (video-check.mjs: every
// frame decodes, not frozen, not cropped, every hold its reading time, every cue its reading time,
// the length in range, the size in budget). Its manifest entry records the input hash (captions
// left out); an unchanged video is not re-recorded unless --force. --stills <dir> saves the page
// after every beat (and the finished video at 2 frames a second); --timing records and prints the
// timeline, writing nothing; --cues rewrites only the cue lists, from the story's captions and each
// video's recorded beat times, with no filming (a caption's wording changed).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadStory, REPO } from "./load-story.mjs";
import { actionOf, bringsNewContent, PACE, readingMs } from "./story-check.mjs";
import { contextOptions, cropToViewport, leakGate, leakPatterns, modelsSeen, makeRoot, OUT_DIR, removeRoot, saveDebug, siteSharp, sleep, startBrowser, startDirector, startServer, TOKEN, ui, VIDEO_DIR, writeJson } from "./harness.mjs";
import { loadAlignModule, seed, titleStatic } from "./seed.mjs";
import { fileSha, videoHash } from "./hashes.mjs";
import { clock, compose, encodeWithin, ease } from "./video-compose.mjs";
import { cueProblems, cuesOf, decodeAll, edgeDiff, fileProblems, probe, sourceType, timelineProblems } from "./video-check.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const MANIFEST = join(OUT_DIR, "manifest.json");

const { plan, story } = await loadStory().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
} catch {
  console.error("ffmpeg is not on PATH: install it (the videos are encoded with libsvtav1 and libx264)");
  process.exit(1);
}
await loadAlignModule();

const names = opt("--video") ? [opt("--video")] : Object.keys(plan.videos);
for (const n of names) if (!plan.videos[n]) throw new Error(`no video "${n}" in story.json; videos: ${Object.keys(plan.videos).join(", ")}`);

// --cues: the cue lists again from the story's captions and the recorded beat times; no filming.
if (flag("--cues")) {
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  let bad = false;
  for (const name of names) {
    const vid = manifest?.videos?.[name];
    if (!vid?.timeline) {
      console.error(`video ${name} has no recording yet: run screens:video -- --video ${name}`);
      bad = true;
      continue;
    }
    if (vid.timeline.beats.length !== plan.videos[name].beats.length) {
      console.error(`video ${name}: the story has ${plan.videos[name].beats.length} beats, the recording ${vid.timeline.beats.length}: record it again`);
      bad = true;
      continue;
    }
    Object.assign(vid, cuesOf(plan.videos[name], vid.timeline), { line: plan.videos[name].line });
    const problems = cueProblems(vid, plan.videos[name], vid.timeline.seconds);
    if (problems.length) {
      console.error(`video ${name}: ${problems.join("; ")}`);
      bad = true;
      continue;
    }
    console.log(`video ${name}: ${vid.cues.length} cues rewritten`);
  }
  if (!bad) writeJson(MANIFEST, manifest);
  process.exit(bad ? 1 : 0);
}
const stillsDir = opt("--stills");
if (stillsDir) mkdirSync(stillsDir, { recursive: true });

let failed = false;
for (const name of names) {
  const v = { ...plan.videos[name], vp: plan.viewports[plan.videos[name].viewport] };
  const hash = videoHash(story, plan, name);
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null;
  const have = manifest?.videos?.[name];
  if (!flag("--force") && have?.hash === hash && have.sources.every((x) => existsSync(join(VIDEO_DIR, x.file.replace(/^\/video\//, ""))))) {
    console.log(`video ${name} is up to date (its input hash matches manifest.json); --force records it again`);
    continue;
  }
  console.log(`recording video ${name}`);
  if (!(await recordOne(name, v, hash))) failed = true;
}
process.exit(failed ? 1 : 0);

async function recordOne(name, v, hash) {
  const root = makeRoot();
  const stops = [];
  let page = null;
  let patterns = null;
  let beatNow = "setup";
  try {
    const director = await startDirector(root, { chunkMs: v.chunkMs });
    stops.push(director.stop);
    const seeded = await seed(plan, root, { directorPort: director.port });
    const server = await startServer(root, { node: flag("--node") });
    stops.push(server.stop);
    await titleStatic(server, plan, seeded);
    // The Overseer's memory summarizer needs a real login; off, so no notice says it failed.
    await server.call("PUT", "/api/overseer/memory", { on: false });
    if (plan.overseer) await server.call("PUT", "/api/settings/overseer", { ...(await server.call("GET", "/api/settings/overseer")).settings, model: plan.overseer.model, thinking: plan.overseer.effort });
    // Filmed at 2x pixels (the page's own scale for a phone's 3x), whatever the screen's scale.
    const browser = await startBrowser({ root, deviceScale: Math.min(2, v.vp.scale) === v.vp.scale ? v.vp.scale : 2 });
    stops.push(browser.stop);
    patterns = leakPatterns(root, plan.models);

    // The session: a live one is created empty (and titled); a static one with `then` is its file.
    const s = plan.sessions.find((x) => x.id === v.session);
    let path;
    let sessionId;
    if (s.live) {
      const created = await server.call("POST", "/api/sessions", { cwd: seeded.repo });
      [path, sessionId] = [created.path, created.id];
      await fetch(`${director.url}/bind`, { method: "POST", body: JSON.stringify({ id: s.id, uuid: created.id }) });
      await server.call("POST", "/api/sessions/title", { path, title: s.title });
    } else [path, sessionId] = [seeded.sessions[s.id], s.uuid];
    await server.call("POST", "/api/sessions/configure", {
      path,
      // A static session's file already names its model and modes (seed.mjs): only a live one
      // is told them, so the Timeline shows no switch that never happened.
      ...(s.live ? { model: s.model, ...(s.effort ? { thinking: s.effort } : {}) } : {}),
      mode: s.modes.includes("delegate") ? "delegate" : "normal",
      minorModes: s.modes.filter((m) => m !== "delegate"),
    });
    await server.call("POST", `/api/sandbox?path=${encodeURIComponent(path)}`, { state: "off" }).catch(() => {});

    // The summaries the director answers during the video, in order (a `release` with `summary`
    // waits until the next one shows in the Current goal strip).
    const told = story.sessions.find((x) => x.id === s.id);
    const summaries = (told.script ?? told.then ?? []).filter((st) => actionOf(st) === "summary").map((st) => st.summary);
    let summariesSeen = 0;

    const ctx = await browser.browser.newContext(contextOptions(v.vp));
    page = await ctx.newPage();
    await page.goto(`${server.base}/#t=${TOKEN}`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    beatNow = "opening the first screen";
    // #/sid/<id> asks the server for a session the list doesn't carry (an empty one).
    const startHash = v.start === "overseer" ? "#/overseer" : v.start === "sessions" ? "#/" : `#/sid/${sessionId}`;
    await page.evaluate((h) => (location.hash = h), startHash);
    await page.waitForLoadState("networkidle").catch(() => {});
    if (v.start !== "sessions") await ui.composer(page).waitFor({ state: "visible", timeout: 20_000 });
    // The app's own animations stay on. Hidden: scrollbars, spell-check marks, the browser's tap
    // highlight (the drawn ring is the tap), toasts and the Jump to Latest pill (notices that would
    // stack over what the video points at).
    await page.addStyleTag({ content: "::-webkit-scrollbar { display: none; } .toast, .jump-latest { display: none !important; } ::spelling-error, ::grammar-error { text-decoration: none; } * { -webkit-tap-highlight-color: transparent !important; }" });
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(1, 1);
    if (v.prefill) await ui.composer(page).fill(v.prefillText);
    await page.waitForTimeout(1500);

    // The screencast: every frame with its timestamp, acknowledged so the next one comes. The
    // window is made larger than the viewport and each frame cropped to it (cropToViewport).
    const framesDir = join(root, "frames");
    mkdirSync(framesDir);
    const frames = [];
    const cdp = await ctx.newCDPSession(page);
    try {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: v.vp.width + 200, height: v.vp.height + 300 } });
      await page.waitForTimeout(300);
    } catch (e) {
      console.warn(`could not size the browser window (${e.message}); each frame is still checked and cropped`);
    }
    cdp.on("Page.screencastFrame", async (f) => {
      const file = join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(f.data, "base64"));
      frames.push({ file, t: f.metadata.timestamp, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight, top: f.metadata.offsetTop ?? 0 });
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    // The caps are the whole window's, at its pixel scale: a cap at the viewport's size would shrink
    // every frame of the larger window, and the crop would then hold fewer pixels than the viewport.
    const { winW, winH, dpr } = await page.evaluate(() => ({ winW: outerWidth, winH: outerHeight, dpr: devicePixelRatio }));
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: Math.round(Math.max(winW, v.vp.width + 200) * dpr), maxHeight: Math.round(Math.max(winH, v.vp.height + 300) * dpr) });
    await page.waitForTimeout(800);

    // ---- the beats, logged as a track on the screencast's clock --------------------------------
    const now = () => Date.now() / 1000;
    const p0 = v.pointer === "arrow" ? await page.evaluate(() => {
      const m = document.querySelector("main")?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
      return { x: Math.round(m.left + m.width * 0.58), y: Math.round(m.top + m.height * 0.42) };
    }) : { x: -100, y: -100 };
    const stillsAt = [];
    const track = { t0: 0, end: 0, p0, anchors: [], moves: [], clicks: [], taps: [], speed: [], holds: [], beats: [], privacy: { checked: 0, beats: v.beats.length } };
    // The video's own clock: every event is an anchor, and the stretch before it lasts its nominal
    // time in the video (a hold its length, a travel its duration, a rest 0.3 s...), whatever this
    // machine took; only a reply streaming in keeps its real length (divided by any speed-up).
    const mark = (r, d) => {
      const prev = track.anchors.at(-1);
      track.anchors.push({ r: Math.max(r, prev?.r ?? r), o: (prev?.o ?? 0) + Math.max(0, d) });
    };
    const sinceMark = (r) => r - (track.anchors.at(-1)?.r ?? r);
    let pos = { ...p0 };
    if (v.pointer === "arrow") await page.mouse.move(p0.x, p0.y);
    await leakGate(page, patterns, `video ${name} start`);
    track.privacy.checked++;

    const travel = async (to) => {
      const from = { ...pos };
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      if (d < 3) return;
      const dur = Math.min(PACE.travel.max, PACE.travel.min + (PACE.travel.max - PACE.travel.min) * Math.min(1, d / 1400));
      const a = now();
      mark(a, Math.min(sinceMark(a), 0.8));
      const steps = Math.round(dur * 60);
      for (let i = 1; i <= steps; i++) {
        const e = ease(i / steps);
        await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
        const wait = a + (dur * i) / steps - now();
        if (wait > 0) await sleep(wait * 1000);
      }
      const b = now();
      mark(b, dur);
      track.moves.push({ a, b, from, to });
      pos = to;
    };
    const visibleBox = async (loc, what) => {
      await loc.waitFor({ state: "visible", timeout: 15_000 });
      let box = await loc.boundingBox();
      if (!box || box.y < 0 || box.y + box.height > v.vp.height || box.x < 0 || box.x + box.width > v.vp.width) {
        await loc.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
        await sleep(700);
        box = await loc.boundingBox();
      }
      if (!box) throw new Error(`${what} has no box on screen`);
      return box;
    };
    const press = async (loc, what, at = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })) => {
      const box = await visibleBox(loc, what);
      const to = at(box);
      to.x = Math.round(to.x);
      to.y = Math.round(to.y);
      if (v.pointer === "arrow") {
        await travel(to);
        await sleep(PACE.rest * 1000);
        const t = now();
        mark(t, PACE.rest);
        track.clicks.push({ t, x: to.x, y: to.y });
        await page.mouse.down();
        await page.mouse.up();
      } else {
        mark(now(), Math.min(sinceMark(now()), 0.8));
        await sleep(PACE.rest * 1000);
        const t = now();
        mark(t, PACE.rest);
        track.taps.push({ t, x: to.x, y: to.y });
        await page.touchscreen.tap(to.x, to.y);
      }
      await sleep((PACE.ripple + PACE.after) * 1000);
    };
    const target = (b) => {
      switch (b.target) {
        case "composer":
          return ui.composer(page);
        case "send":
          return ui.send(page);
        case "link":
          return page.locator("a.md-app-link", { hasText: b.text }).last();
        case "session-row":
          return page.locator("li.session-row-shell", { hasText: b.text }).first();
        case "align-option":
          return page.locator("label.align-q-pick", { has: page.locator(`input[aria-label^="Answer ${b.q} with ${String.fromCharCode(97 + b.option)}:"]`) }).last();
        case "go-with-recommendations":
          return page.getByRole("button", { name: "Go With Recommendations" }).last();
        case "workers":
          return page.locator("main button.run-status-link:has(.run-status-wide)").first();
        case "worker":
          return page.locator("#session-tabpanel .subagent-row", { hasText: plan.workers[b.worker].name }).first();
        case "close-panel":
          return page.locator("#session-pane button.subagents-close").first();
        case "review-changes":
          return ui.reviewChanges(page);
        case "close-changes":
          return page.locator("[role=dialog]").last().getByRole("button", { name: "Close", exact: true });
        case "changes-step":
          return page.locator(".changes-step-row").filter({ has: page.locator(".changes-step-n", { hasText: new RegExp(`^${b.n}$`) }) }).first();
        case "pane-tab":
          return page.locator("#session-pane [role=tab]", { hasText: b.text }).first();
        default:
          throw new Error(`no target ${b.target}`);
      }
    };
    const sceneOf = (b) => (b.scene === "overseer" ? v.overseerScene : v.session);
    // A hold where a turn ends (before a user step or at the end): its reply may still be streaming.
    const endsTurn = (h) => (plan.holds[h] ?? []).some((x) => x.kind === "idle" && x.scene === v.session);

    track.t0 = now();
    mark(track.t0, 0);
    for (const b of v.beats) {
      beatNow = `beat ${b.index} (${b.do}${b.target ? ` ${b.target}` : ""})`;
      console.log(`  ${beatNow}`);
      const a = now();
      // Between beats: the leak gate (and any still) take real time the video doesn't need.
      mark(a, Math.min(sinceMark(a), 0.04));
      if (b.do === "type") {
        const input = ui.composer(page);
        await press(input, "the composer", (box) => ({ x: box.x + Math.min(60, box.width / 4), y: box.y + box.height / 2 }));
        mark(now(), PACE.ripple + PACE.after);
        await input.pressSequentially(b.text, { delay: v.typingMs });
        mark(now(), (b.text.length * v.typingMs) / 1000);
        await sleep(300);
        mark(now(), 0.3);
      } else if (b.do === "click" || b.do === "tap") {
        const viewer = b.target === "close-changes" ? await page.locator("[role=dialog]").last().elementHandle() : null;
        await press(target(b), b.target);
        if (viewer) await viewer.waitForElementState("hidden", { timeout: 10_000 });
        if (b.target === "workers") await page.locator("#session-tabpanel").waitFor({ state: "visible", timeout: 10_000 });
        if (b.target === "review-changes") await page.locator("[role=dialog]").last().waitFor({ timeout: 10_000 });
        mark(now(), Math.min(1, Math.max(PACE.ripple + PACE.after, sinceMark(now()))));
      } else if (b.do === "release") {
        // Every hold the director waits at lets go, except the one this beat runs to: the
        // director may have got there first.
        for (const h of (await director.api.state()).waiting) if (h !== b.until) await director.api.release(h);
        if (b.until === "end") await director.api.idle(sceneOf(b), 180_000);
        else await director.api.reached(b.until, 180_000);
        if ((b.until === "end" || endsTurn(b.until)) && b.scene !== "overseer")
          for (let i = 0; i < 60; i++) {
            const row = (await server.call("GET", "/api/sessions")).find((x) => x.path === path);
            if (!row?.streaming) break;
            await sleep(100);
          }
        if (b.summary) {
          // Sova's summarizer runs once the turn has settled; the director answers it with the
          // next summary step. Done when the Current goal strip shows it.
          const want = summaries[summariesSeen++];
          await page.locator(".outline-now", { hasText: want.now }).first().waitFor({ state: "attached", timeout: 60_000 }).catch(async () => {
            throw new Error(`the summary "${want.now}" never reached the Current goal strip; director: ${JSON.stringify((await director.api.state()).summaries)}`);
          });
        }
        await sleep(350);
        mark(now(), sinceMark(now()) / (b.speed ?? 1));
        if (b.speed) track.speed.push({ a, b: now(), k: b.speed });
      } else if (b.do === "hold") {
        await sleep(b.ms);
        mark(now(), b.ms / 1000);
        track.holds.push({ i: b.index, a, b: now(), needMs: b.read ? readingMs(b.read) : 0, read: b.read });
      } else if (b.do === "scroll") {
        if (b.to === "latest") await page.evaluate(() => document.querySelector("main .transcript, main [data-transcript]")?.scrollTo({ top: 1e9, behavior: "smooth" }));
        else if (b.to === "vis") {
          const fig = page.locator("main figure.vis").last();
          await fig.waitFor({ state: "visible", timeout: 10_000 });
          await fig.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
        } else {
          const card = page.locator("article.align-doc").last();
          await card.waitFor({ state: "visible", timeout: 10_000 });
          await card.evaluate((el, block) => el.scrollIntoView({ block, behavior: "smooth" }), b.to === "align" ? "start" : "end");
        }
        await sleep(PACE.scroll * 1000);
        mark(now(), PACE.scroll);
      } else if (b.do === "home") {
        if (v.pointer === "arrow") await travel(p0);
        await sleep(PACE.rest * 1000);
        mark(now(), PACE.rest);
      }
      track.beats.push({ i: b.index, do: b.do, a, b: track.anchors.at(-1).r, news: bringsNewContent(b), moves: ["type", "click", "tap", "home"].includes(b.do) });
      await leakGate(page, patterns, `video ${name} ${beatNow}`);
      track.privacy.checked++;
      // The page after the beat, from the screencast's own latest frame: a page.screenshot here
      // repaints the page mid-film, and that repaint reached the video as a frame flashing zoomed
      // in or out at the next beat's start.
      if (stillsDir) {
        await sleep(120);
        stillsAt.push({ t: frames.at(-1)?.t ?? 0, file: join(stillsDir, `${name}-${String(b.index).padStart(2, "0")}-${b.do}${b.target ? `-${b.target}` : ""}.png`) });
      }
    }
    track.end = track.anchors.at(-1).r;
    // The page's own picture at the end, for the edge check (taken after the end, so its repaint
    // can't hide a crop from the frames before it).
    await sleep(200);
    const reference = join(root, "reference.png");
    await page.screenshot({ path: reference });
    await cdp.send("Page.stopScreencast");
    await page.waitForTimeout(300);
    await ctx.close();

    // The timeline in the video's own seconds, for the checks.
    const { toOut } = clock(track.anchors);
    const timeline = {
      seconds: toOut(track.end) + v.loopMs / 1000,
      holds: track.holds.map((h) => ({ ...h, a: toOut(h.a), b: toOut(h.b) })),
      moves: track.moves.map((m) => ({ a: toOut(m.a), b: toOut(m.b) })),
      sped: track.speed.map((x) => ({ a: toOut(x.a), b: toOut(x.b), k: x.k })),
      settles: settles(track, toOut),
      privacy: track.privacy,
      beats: track.beats.map((x) => ({ i: x.i, do: x.do, a: Number(toOut(x.a).toFixed(2)), b: Number(toOut(x.b).toFixed(2)) })),
    };
    console.log(`model names on screen (each one of the story's models): ${[...modelsSeen].sort().join(", ") || "(none)"}`);
    console.log(`timeline (output s): ${timeline.beats.map((x) => `${x.i}:${x.do} ${(x.b - x.a).toFixed(1)}`).join(" · ")}`);
    const cues = cuesOf(v, timeline);
    console.log(`cues: ${cues.cues.map((c) => `${c.a.toFixed(1)}–${c.b.toFixed(1)} ${c.text}`).join(" | ")}${cues.tags.length ? `; tags ${cues.tags.map((x) => `${x.a.toFixed(1)}–${x.b.toFixed(1)} ${x.text}`).join(", ")}` : ""}`);
    if (flag("--timing")) {
      console.log(`timing only: ${timeline.seconds.toFixed(1)} s; ${[...timelineProblems({ ...timeline, edges: { bottom: 0, right: 0, threshold: 40 } }, v), ...cueProblems(cues, v, timeline.seconds)].join("; ") || "no pacing problems"}`);
      return true;
    }
    if (frames.length < 10) throw new Error(`only ${frames.length} screencast frames arrived`);
    beatNow = "assembly";
    const cropped = await cropToViewport(frames, v.vp, join(root, "frames-viewport"));
    console.log(`frames: ${frames.length}, ${Math.round(frames[0].w)}x${Math.round(frames[0].h)} CSS px filmed at ${cropped.scale}x, cropped to ${cropped.width}x${cropped.height} px`);
    if (cropped.dropped.length) console.log(`dropped ${cropped.dropped.length} frame(s) at another pixel scale: ${cropped.dropped.map((d) => `#${d.i} ${d.size} px for ${d.css} CSS px at ${toOut(d.t).toFixed(2)} s`).join("; ")}`);
    for (const s of stillsAt) {
      const at = cropped.frames.filter((f) => f.t <= s.t).at(-1) ?? cropped.frames[0];
      copyFileSync(at.file, s.file);
    }
    // Filmed at least at the encoded size: never an upscaled picture.
    if (cropped.width < v.width) throw new Error(`the frames hold ${cropped.width} px across the viewport, under the ${v.width} px the video is encoded at: the screencast filmed at too low a scale`);
    const composed = await compose({ frames: cropped.frames, track, v, root });
    console.log(`composed ${composed.frames} frames, ${composed.seconds.toFixed(1)} s at ${composed.width}x${composed.height}`);

    const base = name === "desk" ? "session-desk" : `session-${name}`;
    const outs = { av1: join(root, `${base}.av1.mp4`), h264: join(root, `${base}.mp4`) };
    const av1 = encodeWithin("av1", composed.file, outs.av1, v.budget.modern, console.log);
    const h264 = encodeWithin("h264", composed.file, outs.h264, v.budget.fallback, console.log);

    timeline.edges = edgeDiff(outs.h264, Math.max(0, composed.endOut - 0.25), reference, { width: composed.width, height: composed.height });
    const problems = [...timelineProblems(timeline, v), ...cueProblems(cues, v, timeline.seconds)];
    const files = {};
    for (const [kind, file] of Object.entries(outs)) {
      const p = probe(file);
      const decoded = decodeAll(file);
      files[kind] = { p, decoded };
      console.log(`  ${kind}: ${p.width}x${p.height}, ${p.duration.toFixed(2)} s, ${(p.bytes / 1e6).toFixed(2)} MB, ${decoded.frames} frames decoded (${decoded.distinct} distinct, longest still ${decoded.longestStill.toFixed(1)} s, ${decoded.flickers?.length ?? 0} flicker(s))`);
      problems.push(...fileProblems(`${base}${kind === "av1" ? ".av1" : ""}.mp4`, p, decoded, v, kind === "av1" ? v.budget.modern : v.budget.fallback));
    }
    if (problems.length) {
      if (flag("--keep")) for (const f of Object.values(outs)) copyFileSync(f, join(stillsDir ?? root, f.split("/").at(-1).replace(".mp4", ".failed.mp4")));
      throw new Error(`the video fails its checks; nothing was written:\n${problems.map((x) => `  - ${x}`).join("\n")}`);
    }

    // Passed: the files, the poster (frame 0, which the loop fades back into) and the manifest.
    mkdirSync(VIDEO_DIR, { recursive: true });
    const sources = [];
    for (const kind of ["av1", "h264"]) {
      const file = outs[kind].split("/").at(-1);
      copyFileSync(outs[kind], join(VIDEO_DIR, file));
      const buf = readFileSync(join(VIDEO_DIR, file));
      sources.push({ file: `/video/${file}`, type: sourceType(files[kind].p), bytes: buf.length, sha: fileSha(buf), crf: kind === "av1" ? av1.crf : h264.crf });
    }
    const sharp = siteSharp();
    const posterFile = `video-${name}.webp`;
    const posterBuf = await sharp(composed.poster, { raw: { width: composed.width, height: composed.height, channels: 3 } }).webp({ quality: 88, effort: 6 }).toBuffer();
    writeFileSync(join(OUT_DIR, posterFile), posterBuf);
    if (stillsDir) execFileSync("ffmpeg", ["-y", "-v", "error", "-i", outs.h264, "-vf", "fps=2", join(stillsDir, `${name}-out-%03d.png`)]);

    const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { _generated: "by site/scripts/screens (pnpm run screens); edit story.json instead", shots: {}, slots: plan.pageShots };
    delete manifest.video;
    // A video the story no longer has leaves the manifest (its files are deleted by hand).
    const kept = Object.fromEntries(Object.entries(manifest.videos ?? {}).filter(([n]) => plan.videos[n]));
    manifest.videos = { ...kept, [name]: {
      sources,
      width: composed.width,
      height: composed.height,
      seconds: Number(composed.seconds.toFixed(2)),
      alt: v.alt,
      slot: v.slot,
      poster: { file: posterFile, sha: fileSha(posterBuf) },
      hash,
      line: v.line,
      ...cues,
      timeline,
    } };
    writeJson(MANIFEST, manifest);
    console.log(`wrote ${sources.map((x) => `site/public${x.file} (${(x.bytes / 1e6).toFixed(2)} MB)`).join(", ")} and ${posterFile}: ${composed.width}x${composed.height}, ${composed.seconds.toFixed(1)} s`);
    return true;
  } catch (e) {
    console.error(`\nvideo ${name} failed at ${beatNow}: ${e.stack ?? e.message}`);
    console.error(await saveDebug(page, patterns ?? leakPatterns(root), `video-${name}-${beatNow.replace(/\W+/g, "-")}`));
    console.error(`logs: ${join(root, "logs")}${flag("--keep") ? "" : " (pass --keep to keep them)"}`);
    return false;
  } finally {
    for (const stop of stops.reverse()) await stop().catch(() => {});
    if (!flag("--keep")) removeRoot(root);
    else console.log(`kept ${root}`);
  }
}

/** For each beat that brought something new, how long until the pointer next moved (output s). */
function settles(track, toOut) {
  const out = [];
  track.beats.forEach((b, k) => {
    if (!b.news) return;
    const next = track.beats.slice(k + 1).find((x) => x.moves);
    if (!next) return;
    // From the moment the new thing came: a click's press, else the beat's end.
    const click = [...track.clicks, ...track.taps].filter((c) => c.t >= b.a && c.t <= b.b).at(-1);
    const from = click ? click.t : b.b;
    const move = track.moves.find((m) => m.a >= next.a) ?? { a: next.a };
    out.push({ after: b.i, next: next.i, gap: toOut(Math.min(move.a, next.b)) - toOut(from) });
  });
  return out;
}
