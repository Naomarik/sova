#!/usr/bin/env node
// pnpm run screens:verify [-- --no-build] [--no-browser]
//
// After `pnpm run screens` / `screens:video`: is what the pages show what the story says?
//   - every pageShots slot resolves to a manifest entry whose file exists and whose sha matches
//     the file on disk (a hand-edited or half-written output fails), and whose alt and input hash
//     match the story (a story edited since the capture fails: run the capture again)
//   - the video's file and sha, when the story has a video
//   - which images differ from the last commit, by changed-pixel count, so a reviewer looks at those
//   - the build (pnpm run build, docs leak guard included) and the built images' byte budgets
//   - no sideways page scroll at 320, 360, 390, 768, 1119 and 1120 px (needs the playwright skill's
//     browser; --no-browser skips it)

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadStory, REPO, SITE } from "./load-story.mjs";
import { freePort, OUT_DIR, sleep, startBrowser, VIDEO_DIR, waitFor } from "./harness.mjs";
import { fileSha, inputHashes } from "./hashes.mjs";

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
if (plan.video) {
  const vid = manifest.video;
  if (!vid) bad("the story has a video but manifest.json has none (run pnpm run screens:video)");
  else {
    const file = join(VIDEO_DIR, vid.file.replace(/^\/video\//, ""));
    if (!existsSync(file)) bad(`${vid.file} is missing (run pnpm run screens:video)`);
    else if (vid.sha !== sha(readFileSync(file))) bad(`${vid.file} doesn't match its manifest entry (run pnpm run screens:video -- --force)`);
    if (vid.alt !== plan.video.alt) bad("the video's alt text changed in story.json since the recording (run pnpm run screens:video)");
    if (vid.bytes > 2_500_000) bad(`${vid.file} is ${(vid.bytes / 1e6).toFixed(2)} MB, over the 2.5 MB budget`);
  }
}

// Which images changed since the last commit, by pixels.
try {
  const sharp = createRequire(join(SITE, "package.json"))("sharp");
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
  try {
    await waitFor(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok), { what: "astro preview", timeout: 30_000 });
    browser = await startBrowser();
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
    try { process.kill(-preview.pid, "SIGTERM"); } catch {}
  }
}

if (problems.length) {
  console.error(`\n${problems.map((p) => `- ${p}`).join("\n")}\n\n${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exit(1);
}
console.log("screens: ok");
