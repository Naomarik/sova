#!/usr/bin/env node
// pnpm run screens:verify [-- --no-build] [--no-browser]
//
// After `pnpm run screens` / `screens:video`: is what the pages show what the story says?
//   - every pageShots slot resolves to a manifest entry whose file exists and whose sha matches
//     the file on disk (a hand-edited or half-written output fails), and whose alt and input hash
//     match the story (a story edited since the capture fails: run the capture again)
//   - each video: its AV1 and H.264 files and their shas, every frame decoded, not frozen, its
//     length, size and shape, its poster, and its recorded timeline against the pacing rules (every
//     hold its reading time, the leak gate at every beat, the edge check against the page); its
//     cue list (the page's captions) against the story's captions, in order, inside the video, each
//     on the page at least its reading time
//   - which images differ from the last commit, by changed-pixel count, so a reviewer looks at those
//   - the build (pnpm run build, docs leak guard included) and the built images' byte budgets
//   - no sideways page scroll at 320, 360, 390, 768, 1119 and 1120 px (needs the playwright skill's
//     browser; --no-browser skips it)

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadStory, REPO, SITE } from "./load-story.mjs";
import { freePort, makeRoot, siteSharp, OUT_DIR, removeRoot, sleep, startBrowser, VIDEO_DIR, waitFor } from "./harness.mjs";
import { fileSha, inputHashes, videoHash } from "./hashes.mjs";
import { cueProblems, cuesOf, decodeAll, fileProblems, probe, sourceType, timelineProblems } from "./video-check.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const problems = [];
const bad = (m) => problems.push(m);
const sha = fileSha;

const { plan, story } = await loadStory().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
const MANIFEST = join(OUT_DIR, "manifest.json");
if (!existsSync(MANIFEST)) {
  console.error(`${MANIFEST.slice(REPO.length + 1)} is missing: run pnpm run screens`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

const hashes = inputHashes(story, plan);

for (const [slot, id] of Object.entries(plan.pageShots)) {
  const entry = manifest.shots?.[id];
  if (!entry) {
    bad(`slot ${slot}: shot ${id} has no image yet (run pnpm run screens -- --shot ${id})`);
    continue;
  }
  const file = join(OUT_DIR, entry.file);
  if (!existsSync(file)) bad(`slot ${slot}: ${entry.file} is missing`);
  else if (entry.sha !== sha(readFileSync(file))) bad(`${entry.file} doesn't match its manifest entry: edited by hand or half-written; run pnpm run screens -- --shot ${id} --all`);
  const shot = plan.shots.find((s) => s.id === id);
  if (entry.alt !== shot.alt) bad(`${id}: its alt text changed in story.json since the capture (run pnpm run screens -- --shot ${id})`);
  if (entry.hash !== hashes[id]) bad(`${id}: its inputs changed since the capture (story, app or capture scripts); run pnpm run screens -- --shot ${id}`);
}
for (const id of Object.keys(manifest.shots ?? {})) if (!plan.shots.some((s) => s.id === id)) bad(`manifest.json lists shot ${id}, which story.json no longer has (run pnpm run screens)`);
for (const [name, pv] of Object.entries(plan.videos)) {
  const vid = manifest.videos?.[name];
  const v = { ...pv, vp: plan.viewports[pv.viewport] };
  if (!vid) {
    bad(`the story has video ${name} but manifest.json has none (run pnpm run screens:video -- --video ${name})`);
    continue;
  }
  if (vid.hash !== videoHash(story, plan, name)) bad(`video ${name}: its inputs changed since the recording (story, app or scripts); run pnpm run screens:video -- --video ${name}`);
  if (vid.alt !== pv.alt) bad(`video ${name}: its alt text changed in story.json since the recording`);
  if (vid.slot !== pv.slot) bad(`video ${name}: its slot changed in story.json since the recording`);
  const poster = join(OUT_DIR, vid.poster.file);
  if (!existsSync(poster)) bad(`video ${name}: its poster ${vid.poster.file} is missing`);
  else if (vid.poster.sha !== sha(readFileSync(poster))) bad(`video ${name}: ${vid.poster.file} doesn't match its manifest entry`);
  for (const p of timelineProblems(vid.timeline, v)) bad(`video ${name}: ${p}`);
  // The page's captions: the cue list matches the story's captions and the recorded beat times.
  for (const p of cueProblems(vid, v, vid.timeline.seconds)) bad(`video ${name}: ${p}`);
  const fresh = cuesOf(v, vid.timeline);
  if (JSON.stringify({ cues: fresh.cues, tags: fresh.tags }) !== JSON.stringify({ cues: vid.cues, tags: vid.tags })) bad(`video ${name}: its cue list isn't what the story's captions and its recorded beats give: run pnpm run screens:video -- --cues`);
  if (vid.line !== pv.line) bad(`video ${name}: its fixed line changed in story.json: run pnpm run screens:video -- --cues`);
  else console.log(`cues     ${name}: ${vid.cues.length} captions${vid.tags.length ? `, ${vid.tags.length} sped-up tag` : ""}, in order, each at least its reading time`);
  const kinds = vid.sources.map((x) => (x.type.includes("av01") ? "av1" : x.type.includes("avc1") ? "h264" : "?"));
  if (kinds[0] !== "av1" || kinds[1] !== "h264") bad(`video ${name}: its sources should be AV1 first, then H.264 (have ${kinds.join(", ")})`);
  for (const [k, src] of vid.sources.entries()) {
    const file = join(VIDEO_DIR, src.file.replace(/^\/video\//, ""));
    if (!existsSync(file)) {
      bad(`${src.file} is missing (run pnpm run screens:video -- --video ${name} --force)`);
      continue;
    }
    if (src.sha !== sha(readFileSync(file))) bad(`${src.file} doesn't match its manifest entry (run pnpm run screens:video -- --video ${name} --force)`);
    const p = probe(file);
    const decoded = decodeAll(file);
    for (const x of fileProblems(src.file, p, decoded, v, kinds[k] === "av1" ? pv.budget.modern : pv.budget.fallback)) bad(x);
    if (sourceType(p) !== src.type) bad(`${src.file}: its type is ${sourceType(p)}, the manifest says ${src.type}`);
    console.log(`video    ${src.file}: ${p.width}x${p.height}, ${p.duration.toFixed(1)} s, ${(p.bytes / 1e6).toFixed(2)} MB, ${decoded.frames} frames decoded (${decoded.distinct} distinct)`);
  }
}

// Which images changed since the last commit, by pixels.
try {
  const sharp = siteSharp();
  for (const entry of Object.values(manifest.shots ?? {})) {
    const rel = join("site", "src", "assets", "screens", entry.file);
    let old;
    try {
      old = execFileSync("git", ["show", `HEAD:${rel}`], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64e6 });
    } catch {
      console.log(`new      ${entry.file}`);
      continue;
    }
    const cur = readFileSync(join(OUT_DIR, entry.file));
    if (old.equals(cur)) continue;
    const [a, b] = await Promise.all([old, cur].map((x) => sharp(x).raw().toBuffer({ resolveWithObject: true })));
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
      console.log(`changed  ${entry.file}: size ${a.info.width}x${a.info.height} -> ${b.info.width}x${b.info.height}`);
      continue;
    }
    let n = 0;
    const ch = a.info.channels;
    for (let i = 0; i < a.data.length; i += ch) for (let c = 0; c < ch; c++) if (a.data[i + c] !== b.data[i + c]) { n++; break; }
    console.log(`changed  ${entry.file}: ${n} of ${a.info.width * a.info.height} pixels`);
  }
} catch (e) {
  console.warn(`pixel diff skipped: ${e.message}`);
}

// The build, then the built images' sizes.
if (!flag("--no-build")) {
  try {
    execFileSync("pnpm", ["run", "build"], { cwd: SITE, stdio: ["ignore", "pipe", "pipe"] });
    console.log("build: ok (docs leak guard included)");
  } catch (e) {
    bad(`pnpm run build failed:\n${String(e.stdout ?? "").slice(-2000)}${String(e.stderr ?? "").slice(-2000)}`);
  }
}
const astroDir = join(SITE, "dist", "_astro");
if (existsSync(astroDir)) {
  for (const [slot, id] of Object.entries(plan.pageShots)) {
    const built = readdirSync(astroDir).filter((f) => f.startsWith(`${id}.`) && f.endsWith(".avif"));
    if (!built.length) continue;
    const sizes = built.map((f) => statSync(join(astroDir, f)).size).sort((x, y) => x - y);
    // The variant a 1x screen at the frame's width picks is about the middle one; the budget is on it.
    const typical = sizes[Math.floor((sizes.length - 1) / 2)];
    const budget = slot.startsWith("hero.") ? 350_000 : 120_000;
    console.log(`built    ${id}: ${built.length} AVIF widths, ${sizes.map((x) => `${Math.round(x / 1000)}k`).join(" ")}`);
    if (typical > budget) bad(`${id}: its middle AVIF variant is ${Math.round(typical / 1000)} kB, over the ${budget / 1000} kB budget`);
  }
}

// No sideways scroll, measured on the built site.
if (!flag("--no-browser") && existsSync(join(SITE, "dist", "index.html"))) {
  const port = await freePort();
  const preview = spawn("pnpm", ["exec", "astro", "preview", "--port", String(port), "--host", "127.0.0.1"], { cwd: SITE, stdio: "ignore", detached: true });
  let browser;
  let browserRoot = null;
  try {
    await waitFor(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok), { what: "astro preview", timeout: 30_000 });
    browserRoot = makeRoot();
    browser = await startBrowser({ root: browserRoot });
    for (const path of ["/", "/mesh", "/orgs"])
      for (const width of [320, 360, 390, 768, 1119, 1120]) {
        const ctx = await browser.browser.newContext({ viewport: { width, height: 800 } });
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: "load" });
        await sleep(300);
        const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
        if (sw > iw) bad(`${path} at ${width}px scrolls sideways: scrollWidth ${sw} > ${iw}`);
        await ctx.close();
      }
    console.log("sideways scroll: checked /, /mesh, /orgs at 320, 360, 390, 768, 1119, 1120 px");
  } catch (e) {
    bad(`sideways-scroll check could not run: ${e.message}`);
  } finally {
    await browser?.stop();
    removeRoot(browserRoot);
    try { process.kill(-preview.pid, "SIGTERM"); } catch {}
  }
}

if (problems.length) {
  console.error(`\n${problems.map((p) => `- ${p}`).join("\n")}\n\n${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("screens: ok");
